import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { and, eq, sql } from "drizzle-orm";

import {
  approvalHistoryForStaff,
  approvalPanelForStaff,
  approvalPanelForViewer,
  askForApproval,
  decideApproval,
  eligibleApprovers,
  pendingApprovalOnCurrentRevision,
  withdrawApproval,
  type ClientApprovalRef,
  type StaffApprovalRef,
} from "../lib/db/approvals.ts";
import { closeDb, db } from "../lib/db/index.ts";
import { uuidv7 } from "../lib/db/id.ts";
import { findPresentation, publishPresentation, unpublishPresentation } from "../lib/db/presentations.ts";
import { reviewForRevision, type ClientActor, type StaffActor } from "../lib/db/reviews.ts";
import { clientIdentity, contacts, workroomActivity, workroomMembers } from "../lib/db/schema.ts";
import { revokeMembership, unpublishWorkroom } from "../lib/db/workrooms.ts";
import { toClientActivity } from "../lib/workrooms/view.ts";
import { clearOwner, owner, person, round, seedOwner, stage, staff, UUID, type Stage } from "./support/review-stage.ts";

/**
 * Stage H2 — the Approvals domain, against real PostgreSQL, through the domain
 * functions only. Every refusal is matched on its reason; every success is
 * checked in the rows it wrote, Audit and Activity included. Races are in
 * `approvals-concurrency.test.ts`.
 */

/* ---------------------------------------------------------------- helpers */

const ref = (s: Stage, version = 2): StaffApprovalRef => ({ workroomId: s.workroomId, presentationId: s.presentationId, version });
const handles = (s: Stage, version = 2): ClientApprovalRef => ({ room: s.room, presentation: s.presentation, version });

async function memberId(s: Stage, who: ClientActor): Promise<string> {
  const [row] = await db()
    .select({ id: workroomMembers.id })
    .from(workroomMembers)
    .where(and(eq(workroomMembers.workroomId, s.workroomId), eq(workroomMembers.contactId, who.contactId)));
  return row!.id;
}

async function ask(s: Stage, people: ClientActor[], version = 2) {
  const ids = await Promise.all(people.map((p) => memberId(s, p)));
  const asked = await askForApproval(staff, ref(s, version), ids);
  assert.ok(asked.ok, asked.ok ? "" : asked.message);
  return asked.value;
}

async function publishAgain(s: Stage): Promise<number> {
  const version = (await findPresentation(s.presentationId))!.version;
  const published = await publishPresentation(owner, s.presentationId, version);
  assert.ok(published.ok, published.ok ? "" : published.message);
  return published.value.revision;
}

type RequestState = { status: string; closedByUser: string | null; closedByRevision: number | null; closedAt: Date | null };

/** The latest request on one version of the stage's Presentation. */
async function request(s: Stage, version = 2): Promise<RequestState | null> {
  const found = (await db().execute(sql`
    SELECT a.status, a.closed_by_user_id AS "closedByUser", a.closed_at AS "closedAt",
           (SELECT nr.revision_number FROM presentation_revisions nr WHERE nr.id = a.closed_by_revision_id) AS "closedByRevision"
      FROM presentation_approvals a
      JOIN presentation_revisions r ON r.id = a.presentation_revision_id
     WHERE r.presentation_id = ${s.presentationId} AND r.revision_number = ${version}
     ORDER BY a.requested_at DESC LIMIT 1
  `)) as unknown as RequestState[];
  return found[0] ?? null;
}

async function decisions(s: Stage, version = 2): Promise<Record<string, string | null>> {
  const found = (await db().execute(sql`
    SELECT ap.display_name AS name, ap.decision
      FROM presentation_approval_approvers ap
      JOIN presentation_approvals a ON a.id = ap.presentation_approval_id
      JOIN presentation_revisions r ON r.id = a.presentation_revision_id
     WHERE r.presentation_id = ${s.presentationId} AND r.revision_number = ${version}
       AND a.requested_at = (SELECT max(a2.requested_at) FROM presentation_approvals a2 WHERE a2.presentation_revision_id = r.id)
  `)) as unknown as Array<{ name: string; decision: string | null }>;
  return Object.fromEntries(found.map((row) => [row.name, row.decision]));
}

type AuditRow = { action: string; actorType: string; metadata: Record<string, unknown>; entityLabel: string | null };

async function audits(s: Stage): Promise<AuditRow[]> {
  return (await db().execute(sql`
    SELECT action, actor_type AS "actorType", metadata, entity_label AS "entityLabel"
      FROM audit_events
     WHERE entity_type = 'presentation_approval' AND metadata->>'workroom_id' = ${s.workroomId}
     ORDER BY occurred_at, id
  `)) as unknown as AuditRow[];
}

async function activity(s: Stage) {
  const found = await db()
    .select({ kind: workroomActivity.kind, actorLabel: workroomActivity.actorLabel, subject: workroomActivity.subject })
    .from(workroomActivity)
    .where(eq(workroomActivity.workroomId, s.workroomId))
    .orderBy(workroomActivity.occurredAt, workroomActivity.id);
  return found.filter((row) => row.kind.startsWith("approval."));
}

async function refusedWith<T>(work: Promise<{ ok: true; value: T } | { ok: false; reason: string; message: string }>, reason: string, message?: RegExp) {
  const outcome = await work;
  assert.equal(outcome.ok, false, "the domain accepted what it must refuse");
  if (!outcome.ok) {
    assert.equal(outcome.reason, reason, outcome.message);
    if (message) assert.match(outcome.message, message);
  }
}

let seq = 0;
async function fresh(): Promise<Stage & { carl: ClientActor }> {
  const tag = `H2${seq++}`;
  const s = await stage(tag);
  const carl = await person(`${tag}cy`, s.workroomId, `${tag.toLowerCase()}-carl@example.com`);
  return { ...s, carl };
}

before(async () => {
  await seedOwner();
});

after(async () => {
  await clearOwner();
  await closeDb();
});

/* -------------------------------------------------------------------- ask */

test("ask: one eligible approver — the request, its approver, one Audit and one Activity row", async () => {
  const s = await fresh();
  assert.deepEqual(await ask(s, [s.ana]), { version: 2, approvers: 1 });
  assert.equal((await request(s))!.status, "requested");
  assert.deepEqual(await decisions(s), { [s.ana.name]: null });
  const [audit] = await audits(s);
  assert.equal(audit!.action, "approval.requested");
  assert.equal(audit!.actorType, "team_user");
  assert.deepEqual(audit!.metadata, { workroom_id: s.workroomId, revision: 2, approvers: 1 });
  assert.deepEqual(await activity(s), [{ kind: "approval.requested", actorLabel: null, subject: "Brand Direction, Version 2" }]);
});

test("ask: several eligible approvers", async () => {
  const s = await fresh();
  assert.deepEqual(await ask(s, [s.ana, s.ben, s.carl]), { version: 2, approvers: 3 });
  assert.deepEqual(Object.values(await decisions(s)), [null, null, null]);
});

test("ask: nobody, the same person twice, and malformed ids are refused before anything is written", async () => {
  const s = await fresh();
  await refusedWith(askForApproval(staff, ref(s), []), "invalid", /at least one/);
  const ana = await memberId(s, s.ana);
  await refusedWith(askForApproval(staff, ref(s), [ana, ana]), "invalid", /only be asked once/);
  await refusedWith(askForApproval(staff, ref(s), ["not-an-id"]), "invalid");
  assert.equal(await request(s), null);
});

test("ask: an inactive sign-in, a revoked member, an archived contact, another Workroom's member or a guess refuses the whole request", async () => {
  const s = await fresh();
  const other = await fresh();
  const ana = await memberId(s, s.ana);

  await db().update(clientIdentity).set({ status: "inactive" }).where(eq(clientIdentity.id, s.ben.identityId));
  await refusedWith(askForApproval(staff, ref(s), [ana, await memberId(s, s.ben)]), "invalid", /active access/);
  await db().update(clientIdentity).set({ status: "active" }).where(eq(clientIdentity.id, s.ben.identityId));

  await db().update(workroomMembers).set({ status: "revoked" }).where(eq(workroomMembers.id, await memberId(s, s.ben)));
  await refusedWith(askForApproval(staff, ref(s), [ana, await memberId(s, s.ben)]), "invalid", /active access/);

  await db().update(contacts).set({ archivedAt: new Date() }).where(eq(contacts.id, s.carl.contactId));
  await refusedWith(askForApproval(staff, ref(s), [ana, await memberId(s, s.carl)]), "invalid", /active access/);

  await refusedWith(askForApproval(staff, ref(s), [ana, await memberId(other, other.ana)]), "invalid", /active access/);
  await refusedWith(askForApproval(staff, ref(s), [ana, uuidv7()]), "invalid", /active access/);
  assert.equal(await request(s), null, "a partial request was written");
});

test("ask: the wrong Workroom, a historical version, an unpublished Presentation and a closed Workroom are refused", async () => {
  const s = await fresh();
  const other = await fresh();
  const ana = await memberId(s, s.ana);
  await refusedWith(askForApproval(staff, { ...ref(s), workroomId: other.workroomId }, [ana]), "not_found");
  await refusedWith(askForApproval(staff, ref(s, 1), [ana]), "blocked", /Version 2/);
  await refusedWith(askForApproval(staff, ref(s, 3), [ana]), "blocked");

  assert.ok((await unpublishPresentation(owner, s.presentationId, (await findPresentation(s.presentationId))!.version)).ok);
  await refusedWith(askForApproval(staff, ref(s), [ana]), "blocked", /Publish/);

  const t = await fresh();
  const [room] = (await db().execute(sql`SELECT version FROM workrooms WHERE id = ${t.workroomId}`)) as unknown as Array<{ version: number }>;
  const closed = await unpublishWorkroom(owner, t.workroomId, room!.version);
  assert.ok(closed.ok, closed.ok ? "" : closed.message);
  await refusedWith(askForApproval(staff, ref(t), [await memberId(t, t.ana)]), "blocked", /workroom/);
});

test("ask: a client cannot ask, whatever shape it arrives in", async () => {
  const s = await fresh();
  await refusedWith(askForApproval(s.ana as unknown as StaffActor, ref(s), [await memberId(s, s.ana)]), "not_found");
  assert.equal(await request(s), null);
});

test("ask: once per version — refused while one stands, allowed again after a withdrawal, never after a decision", async () => {
  const s = await fresh();
  await ask(s, [s.ana]);
  await refusedWith(askForApproval(staff, ref(s), [await memberId(s, s.ben)]), "already_done");

  assert.ok((await withdrawApproval(staff, ref(s))).ok);
  await ask(s, [s.ben]);
  assert.equal((await request(s))!.status, "requested");
  // The re-ask is Audited, and the timeline is not told twice.
  assert.deepEqual((await audits(s)).map((a) => a.action), ["approval.requested", "approval.withdrawn", "approval.requested"]);
  assert.equal((await audits(s))[2]!.metadata.after, "withdrawn");
  assert.equal((await activity(s)).length, 1);

  assert.ok((await decideApproval(s.ben, handles(s), "approved")).ok);
  await refusedWith(askForApproval(staff, ref(s), [await memberId(s, s.ana)]), "blocked", /already approved/);

  const t = await fresh();
  await ask(t, [t.ana]);
  assert.ok((await decideApproval(t.ana, handles(t), "changes_requested")).ok);
  await refusedWith(askForApproval(staff, ref(t), [await memberId(t, t.ana)]), "blocked", /Changes were requested/);
});

test("ask: an old version superseded by a newer one cannot be asked again; the newer one can", async () => {
  const s = await fresh();
  await ask(s, [s.ana]);
  assert.equal(await publishAgain(s), 3);
  assert.equal((await request(s, 2))!.status, "superseded");
  await refusedWith(askForApproval(staff, ref(s, 2), [await memberId(s, s.ana)]), "blocked");
  await ask(s, [s.ana], 3);
});

/* ----------------------------------------------------------------- decide */

test("decide: one approver approves — the request is approved, Audited as the client, and the timeline says who", async () => {
  const s = await fresh();
  await ask(s, [s.ana]);
  const decided = await decideApproval(s.ana, handles(s), "approved");
  assert.deepEqual(decided, { ok: true, value: { decision: "approved", outcome: "approved", version: 2 } });
  const row = (await request(s))!;
  assert.equal(row.status, "approved");
  assert.ok(row.closedAt);
  const audit = (await audits(s)).at(-1)!;
  assert.equal(audit.action, "approval.approved");
  assert.equal(audit.actorType, "client_user");
  assert.deepEqual(audit.metadata, { workroom_id: s.workroomId, revision: 2, outcome: "approved" });
  const rows = await activity(s);
  assert.deepEqual(rows.at(-1), { kind: "approval.approved", actorLabel: s.ana.name, subject: "Brand Direction, Version 2" });
});

test("decide: one approver asks for changes — no reason required", async () => {
  const s = await fresh();
  await ask(s, [s.ana]);
  assert.deepEqual(await decideApproval(s.ana, handles(s), "changes_requested"), {
    ok: true,
    value: { decision: "changes_requested", outcome: "changes_requested", version: 2 },
  });
  assert.equal((await request(s))!.status, "changes_requested");
  assert.deepEqual((await activity(s)).at(-1), {
    kind: "approval.changes_requested",
    actorLabel: s.ana.name,
    subject: "Brand Direction, Version 2",
  });
});

test("decide: partial approvals stay requested with no Activity; the last approval approves, named by the request", async () => {
  const s = await fresh();
  await ask(s, [s.ana, s.ben, s.carl]);
  assert.equal((await decideApproval(s.ana, handles(s), "approved")).ok && (await request(s))!.status, "requested");
  assert.ok((await decideApproval(s.ben, handles(s), "approved")).ok);
  assert.equal((await request(s))!.status, "requested");
  assert.equal((await activity(s)).length, 1, "a partial approval reached the timeline");
  const last = await decideApproval(s.carl, handles(s), "approved");
  assert.ok(last.ok && last.value.outcome === "approved");
  const rows = await activity(s);
  assert.deepEqual(rows.at(-1), { kind: "approval.approved", actorLabel: null, subject: "Brand Direction, Version 2" });
  assert.equal(
    toClientActivity([{ id: "x", occurredAt: new Date(), ...rows.at(-1)! }])[0]!.text,
    "Brand Direction, Version 2 was approved",
  );
  // One Audit row per decision, with where the request stood after it.
  assert.deepEqual(
    (await audits(s)).filter((a) => a.action === "approval.approved").map((a) => a.metadata.outcome),
    ["requested", "requested", "approved"],
  );
});

test("decide: the first request for changes ends it, after some approvals; the rest can no longer decide", async () => {
  const s = await fresh();
  await ask(s, [s.ana, s.ben, s.carl]);
  assert.ok((await decideApproval(s.ana, handles(s), "approved")).ok);
  const changes = await decideApproval(s.ben, handles(s), "changes_requested");
  assert.ok(changes.ok && changes.value.outcome === "changes_requested");
  await refusedWith(decideApproval(s.carl, handles(s), "approved"), "already_done");
  assert.deepEqual(await decisions(s), { [s.ana.name]: "approved", [s.ben.name]: "changes_requested", [s.carl.name]: null });
  assert.deepEqual((await activity(s)).map((a) => a.kind), ["approval.requested", "approval.changes_requested"]);
});

test("decide: a second press, or a reversal, changes nothing and writes nothing", async () => {
  const s = await fresh();
  await ask(s, [s.ana, s.ben]);
  assert.ok((await decideApproval(s.ana, handles(s), "approved")).ok);
  const before = (await audits(s)).length;
  await refusedWith(decideApproval(s.ana, handles(s), "approved"), "already_done");
  await refusedWith(decideApproval(s.ana, handles(s), "changes_requested"), "already_done");
  assert.equal((await audits(s)).length, before);
  assert.equal((await decisions(s))[s.ana.name], "approved");
  assert.equal((await request(s))!.status, "requested");
});

test("decide: an unnamed member, a revoked member, a switched-off sign-in and an archived contact cannot decide", async () => {
  const s = await fresh();
  await ask(s, [s.ana, s.ben]);
  await refusedWith(decideApproval(s.carl, handles(s), "approved"), "blocked", /not asked/);

  const version = (await db().select({ v: workroomMembers.version }).from(workroomMembers).where(eq(workroomMembers.id, await memberId(s, s.ana))))[0]!.v;
  assert.ok((await revokeMembership(owner, await memberId(s, s.ana), version)).ok);
  await refusedWith(decideApproval(s.ana, handles(s), "approved"), "not_found");

  await db().update(clientIdentity).set({ status: "inactive" }).where(eq(clientIdentity.id, s.ben.identityId));
  await refusedWith(decideApproval(s.ben, handles(s), "approved"), "not_found");
  await db().update(clientIdentity).set({ status: "active" }).where(eq(clientIdentity.id, s.ben.identityId));

  await db().update(contacts).set({ archivedAt: new Date() }).where(eq(contacts.id, s.ben.contactId));
  await refusedWith(decideApproval(s.ben, handles(s), "approved"), "not_found");
  assert.deepEqual(Object.values(await decisions(s)), [null, null]);
});

test("decide: a Studio session, another Workroom's client and mixed handles reach nothing", async () => {
  const s = await fresh();
  const other = await fresh();
  await ask(s, [s.ana]);
  await refusedWith(decideApproval(staff as unknown as ClientActor, handles(s), "approved"), "not_found");
  await refusedWith(decideApproval(other.ana, handles(s), "approved"), "not_found");
  await refusedWith(decideApproval(s.ana, { ...handles(s), presentation: other.presentation }, "approved"), "not_found");
  await refusedWith(decideApproval(s.ana, { ...handles(s), room: other.room }, "approved"), "not_found");
  await refusedWith(decideApproval(s.ana, handles(s, 1), "approved"), "not_found");
  await refusedWith(decideApproval(s.ana, handles(s), "granted" as never), "invalid");
  assert.equal((await request(s))!.status, "requested");
});

test("decide: a request on an older version is stale once a newer one is published", async () => {
  const s = await fresh();
  await ask(s, [s.ana]);
  await publishAgain(s);
  await refusedWith(decideApproval(s.ana, handles(s, 2), "approved"), "blocked", /newer version/);
  await refusedWith(decideApproval(s.ana, handles(s, 3), "approved"), "not_found");
});

test("decide: a content hash that no longer matches is refused, never repaired", async () => {
  const s = await fresh();
  await ask(s, [s.ana]);
  // Simulate the impossible: rewrite the request's recorded hash behind every
  // trigger's back, for this one transaction only (replica mode).
  await db().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.execute(sql`
      UPDATE presentation_approvals a SET content_hash = repeat('0', 64)
        FROM presentation_revisions r
       WHERE r.id = a.presentation_revision_id AND r.presentation_id = ${s.presentationId}
    `);
  });
  const errors: string[] = [];
  const original = console.error;
  console.error = (line: string) => errors.push(line);
  try {
    await refusedWith(decideApproval(s.ana, handles(s), "approved"), "blocked", /verified/);
  } finally {
    console.error = original;
  }
  assert.deepEqual(errors.map((e) => JSON.parse(e).event), ["approval.hash_mismatch"]);
  assert.deepEqual(Object.values(await decisions(s)), [null]);
  assert.equal((await request(s))!.status, "requested");
});

/* --------------------------------------------------------------- withdraw */

test("withdraw: with no decisions — closed by the studio, Audited, nothing on the timeline, absent to the client", async () => {
  const s = await fresh();
  await ask(s, [s.ana]);
  assert.deepEqual(await withdrawApproval(staff, ref(s)), { ok: true, value: { version: 2, decided: 0, approvers: 1 } });
  const row = (await request(s))!;
  assert.equal(row.status, "withdrawn");
  assert.equal(row.closedByUser, owner.id);
  assert.deepEqual((await audits(s)).map((a) => a.action), ["approval.requested", "approval.withdrawn"]);
  assert.deepEqual((await activity(s)).map((a) => a.kind), ["approval.requested"]);
  assert.equal(await approvalPanelForViewer(s.ana, s.room, s.presentation), null);
});

test("withdraw: with partial approvals — every decision stays, visible as history", async () => {
  const s = await fresh();
  await ask(s, [s.ana, s.ben]);
  assert.ok((await decideApproval(s.ana, handles(s), "approved")).ok);
  const withdrawn = await withdrawApproval(staff, ref(s));
  assert.ok(withdrawn.ok && withdrawn.value.decided === 1);
  assert.deepEqual(await decisions(s), { [s.ana.name]: "approved", [s.ben.name]: null });
  const panel = (await approvalPanelForViewer(s.ben, s.room, s.presentation))!;
  assert.equal(panel.approval.state, "withdrawn");
  assert.equal(panel.capabilities.canDecide, false);
  // Nothing stands on the version any more, so there is nothing to decide —
  // the same calm refusal as anything else out of reach.
  await refusedWith(decideApproval(s.ben, handles(s), "approved"), "not_found");
});

test("withdraw: a decided or superseded request is refused, a second withdrawal is calm, and a client cannot", async () => {
  const s = await fresh();
  await ask(s, [s.ana]);
  await refusedWith(withdrawApproval(s.ana as unknown as StaffActor, ref(s)), "not_found");
  assert.ok((await withdrawApproval(staff, ref(s))).ok);
  await refusedWith(withdrawApproval(staff, ref(s)), "already_done");

  const t = await fresh();
  await ask(t, [t.ana]);
  assert.ok((await decideApproval(t.ana, handles(t), "approved")).ok);
  await refusedWith(withdrawApproval(staff, ref(t)), "blocked", /approved/);

  const u = await fresh();
  await ask(u, [u.ana]);
  assert.ok((await decideApproval(u.ana, handles(u), "changes_requested")).ok);
  await refusedWith(withdrawApproval(staff, ref(u)), "blocked", /Changes were requested/);

  const v = await fresh();
  await ask(v, [v.ana]);
  await publishAgain(v);
  await refusedWith(withdrawApproval(staff, ref(v)), "blocked", /newer version/);
  await refusedWith(withdrawApproval(staff, ref(v, 3)), "not_found");
});

/* ------------------------------------------------------------- supersede */

test("publish supersedes a pending request, partial decisions kept, and the new version starts with none", async () => {
  const s = await fresh();
  const reviewId = await round(s);
  await ask(s, [s.ana, s.ben]);
  assert.ok((await decideApproval(s.ana, handles(s), "approved")).ok);
  assert.equal(await pendingApprovalOnCurrentRevision(s.workroomId, s.presentationId), true);
  const next = await publishAgain(s);
  const row = (await request(s))!;
  assert.equal(row.status, "superseded");
  assert.equal(row.closedByRevision, next);
  assert.deepEqual(await decisions(s), { [s.ana.name]: "approved", [s.ben.name]: null });
  assert.equal(await request(s, next), null);
  assert.equal(await pendingApprovalOnCurrentRevision(s.workroomId, s.presentationId), false);
  const audit = (await audits(s)).at(-1)!;
  assert.equal(audit.action, "approval.superseded");
  assert.deepEqual(audit.metadata, { workroom_id: s.workroomId, revision: 2, by_revision: next, approvers: 2, decided: 1 });
  assert.ok(!(await activity(s)).some((a) => a.kind !== "approval.requested"), "supersession reached the timeline");
  // The Review round on the same version closed in the same publish.
  assert.equal((await reviewForRevision((await db().execute(sql`SELECT presentation_revision_id AS id FROM presentation_reviews WHERE id = ${reviewId}`) as unknown as Array<{ id: string }>)[0]!.id))!.status, "closed");
  const staffView = await approvalPanelForStaff(s.workroomId, s.presentationId, 2);
  assert.equal(staffView.lifecycle.state, "superseded");
  assert.equal(staffView.lifecycle.supersededBy, next);
});

test("publish leaves an approved or changes-requested request exactly as it was", async () => {
  for (const decision of ["approved", "changes_requested"] as const) {
    const s = await fresh();
    await ask(s, [s.ana]);
    assert.ok((await decideApproval(s.ana, handles(s), decision)).ok);
    const before = await request(s);
    await publishAgain(s);
    assert.deepEqual(await request(s), before);
    assert.ok(!(await audits(s)).some((a) => a.action === "approval.superseded"));
  }
});

/* -------------------------------------------------------------- unpublish */

test("unpublish after a decision erases nothing: the client loses the view, Studio keeps the record", async () => {
  for (const decision of ["approved", "changes_requested"] as const) {
    const s = await fresh();
    await ask(s, [s.ana]);
    assert.ok((await decideApproval(s.ana, handles(s), decision)).ok);
    assert.ok((await unpublishPresentation(owner, s.presentationId, (await findPresentation(s.presentationId))!.version)).ok);
    assert.equal((await request(s))!.status, decision);
    assert.equal(await approvalPanelForViewer(s.ana, s.room, s.presentation, 2), null);
    const studio = await approvalPanelForStaff(s.workroomId, s.presentationId, 2);
    assert.equal(studio.lifecycle.state, decision);
    assert.equal(studio.approval!.state, decision);
    assert.equal(studio.lifecycle.canAsk, false);
  }
});

test("a pending request cannot be decided while unpublished; the next publish supersedes it", async () => {
  const s = await fresh();
  await ask(s, [s.ana]);
  assert.ok((await unpublishPresentation(owner, s.presentationId, (await findPresentation(s.presentationId))!.version)).ok);
  await refusedWith(decideApproval(s.ana, handles(s), "approved"), "not_found");
  assert.equal((await request(s))!.status, "requested");
  assert.equal((await approvalPanelForStaff(s.workroomId, s.presentationId)).lifecycle.state, "awaiting");
  const next = await publishAgain(s);
  assert.equal((await request(s))!.status, "superseded");
  assert.equal((await request(s))!.closedByRevision, next);
  assert.equal(await request(s, next), null);
});

/* ------------------------------------------------------------ Studio reads */

test("Studio's lifecycle walks none → awaiting (partial) → approved, with names and counts", async () => {
  const s = await fresh();
  let panel = await approvalPanelForStaff(s.workroomId, s.presentationId);
  assert.equal(panel.revision, 2);
  assert.equal(panel.lifecycle.state, "none");
  assert.equal(panel.lifecycle.canAsk, true);
  assert.equal(panel.approval, null);

  await ask(s, [s.ana, s.ben]);
  assert.ok((await decideApproval(s.ana, handles(s), "approved")).ok);
  panel = await approvalPanelForStaff(s.workroomId, s.presentationId);
  assert.equal(panel.lifecycle.state, "awaiting");
  assert.equal(panel.lifecycle.partial, true);
  assert.deepEqual(panel.lifecycle.progress, { approved: 1, changesRequested: 0, pending: 1, total: 2 });
  assert.equal(panel.lifecycle.canAsk, false);
  assert.equal(panel.lifecycle.canWithdraw, true);

  assert.ok((await decideApproval(s.ben, handles(s), "approved")).ok);
  panel = await approvalPanelForStaff(s.workroomId, s.presentationId);
  assert.equal(panel.lifecycle.state, "approved");
  assert.equal(panel.lifecycle.canWithdraw, false);
  assert.deepEqual(await approvalHistoryForStaff(s.workroomId, s.presentationId), [
    { version: 1, state: null },
    { version: 2, state: "approved" },
  ]);
});

test("a pending approver who lost access is reported to Studio and stays on the request", async () => {
  const s = await fresh();
  await ask(s, [s.ana, s.ben]);
  const version = (await db().select({ v: workroomMembers.version }).from(workroomMembers).where(eq(workroomMembers.id, await memberId(s, s.ben))))[0]!.v;
  assert.ok((await revokeMembership(owner, await memberId(s, s.ben), version)).ok);
  const panel = await approvalPanelForStaff(s.workroomId, s.presentationId);
  assert.deepEqual(panel.lifecycle.lostAccess, [s.ben.name]);
  assert.equal(panel.lifecycle.progress.total, 2, "the slot was removed");
  assert.equal(panel.lifecycle.state, "awaiting", "the request was resolved around them");
  assert.equal(panel.lifecycle.canWithdraw, true);
});

test("the Ask dialog lists eligible people only, and the lifecycle knows when there are none", async () => {
  const s = await fresh();
  await db().update(clientIdentity).set({ status: "inactive" }).where(eq(clientIdentity.id, s.ben.identityId));
  const names = (await eligibleApprovers(s.workroomId)).map((p) => p.name);
  assert.deepEqual(names.sort(), [s.ana.name, s.carl.name].sort());
  assert.deepEqual(await eligibleApprovers("not-an-id"), []);
  for (const who of [s.ana, s.carl]) {
    await db().update(workroomMembers).set({ status: "revoked" }).where(eq(workroomMembers.id, await memberId(s, who)));
  }
  assert.equal((await approvalPanelForStaff(s.workroomId, s.presentationId)).lifecycle.canAsk, false);
});

test("Studio reads nothing through another Workroom's id", async () => {
  const s = await fresh();
  const other = await fresh();
  await ask(s, [s.ana]);
  const wrong = await approvalPanelForStaff(other.workroomId, s.presentationId);
  assert.equal(wrong.revision, null);
  assert.equal(wrong.approval, null);
  assert.deepEqual(await approvalHistoryForStaff(other.workroomId, s.presentationId), []);
  assert.equal(await pendingApprovalOnCurrentRevision(other.workroomId, s.presentationId), false);
});

/* ------------------------------------------------- client view and leaks */

test("the client panel: named and pending can decide; everyone else cannot, and the domain agrees", async () => {
  const s = await fresh();
  await ask(s, [s.ana, s.ben]);

  const ana = (await approvalPanelForViewer(s.ana, s.room, s.presentation))!;
  assert.deepEqual(ana.approval.you, { named: true, decided: false });
  assert.equal(ana.capabilities.canDecide, true);

  const carl = (await approvalPanelForViewer(s.carl, s.room, s.presentation))!;
  assert.deepEqual(carl.approval.you, { named: false, decided: false });
  assert.equal(carl.capabilities.canDecide, false);
  await refusedWith(decideApproval(s.carl, handles(s), "approved"), "blocked");

  assert.ok((await decideApproval(s.ana, handles(s), "approved")).ok);
  const after = (await approvalPanelForViewer(s.ana, s.room, s.presentation))!;
  assert.deepEqual(after.approval.you, { named: true, decided: true });
  assert.equal(after.capabilities.canDecide, false);
  await refusedWith(decideApproval(s.ana, handles(s), "changes_requested"), "already_done");

  const other = await fresh();
  assert.equal(await approvalPanelForViewer(other.ana, s.room, s.presentation), null);
});

test("nothing serialized for a client carries an id, a hash or an internal column", async () => {
  const s = await fresh();
  await ask(s, [s.ana, s.ben]);
  assert.ok((await decideApproval(s.ana, handles(s), "approved")).ok);
  const panels = [
    await approvalPanelForViewer(s.ana, s.room, s.presentation),
    await approvalPanelForViewer(s.ben, s.room, s.presentation),
  ];
  const hashes = (await db().execute(sql`SELECT content_hash AS h FROM presentation_revisions WHERE presentation_id = ${s.presentationId}`)) as unknown as Array<{ h: string }>;
  for (const panel of panels) {
    const wire = JSON.stringify(panel);
    assert.ok(wire.length > 100, "nothing to inspect");
    assert.ok(!UUID.test(wire), "a database id reached the client");
    assert.ok(!/[0-9a-f]{64}/.test(wire), "a content hash reached the client");
    for (const h of hashes) assert.ok(!wire.includes(h.h));
    for (const id of [s.ana.identityId, s.ben.identityId, s.ana.contactId, s.workroomId, s.presentationId, owner.id]) {
      assert.ok(!wire.includes(id), "an identifier reached the client");
    }
    for (const key of ["id", "identityId", "userId", "workroomId", "revisionId", "contentHash", "closedByUserId", "closedByRevisionId"]) {
      assert.ok(!new RegExp(`"${key}"`).test(wire), `the client view has a ${key} field`);
    }
  }
  // Studio's own panel, for completeness: the projection inside it is the same shape.
  const studio = JSON.stringify((await approvalPanelForStaff(s.workroomId, s.presentationId)).approval);
  assert.ok(!UUID.test(studio));
});

test("Audit carries ids and counts only — no names in metadata, no free text", async () => {
  const s = await fresh();
  await ask(s, [s.ana, s.ben]);
  assert.ok((await decideApproval(s.ana, handles(s), "approved")).ok);
  assert.ok((await withdrawApproval(staff, ref(s))).ok);
  for (const row of await audits(s)) {
    const meta = JSON.stringify(row.metadata);
    assert.ok(!meta.includes(s.ana.name) && !meta.includes(s.ben.name), "a person's name is in Audit metadata");
    assert.equal(row.entityLabel, "Brand Direction");
    for (const value of Object.values(row.metadata)) {
      assert.ok(typeof value === "number" || UUID.test(String(value)) || ["requested", "approved", "changes_requested", "withdrawn"].includes(String(value)), `unexpected metadata ${value}`);
    }
  }
});
