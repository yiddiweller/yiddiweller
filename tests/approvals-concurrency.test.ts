import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { and, eq, sql } from "drizzle-orm";
import postgres from "postgres";

import { askForApproval, decideApproval, withdrawApproval, type ClientApprovalRef, type StaffApprovalRef } from "../lib/db/approvals.ts";
import { closeDb, db } from "../lib/db/index.ts";
import { findPresentation, publishPresentation, unpublishPresentation } from "../lib/db/presentations.ts";
import { type ClientActor } from "../lib/db/reviews.ts";
import { workroomActivity, workroomMembers } from "../lib/db/schema.ts";
import { revokeMembership } from "../lib/db/workrooms.ts";
import { clearOwner, owner, person, seedOwner, stage, staff, type Stage } from "./support/review-stage.ts";

/**
 * Stage H2 — Approvals under real simultaneous load.
 *
 * Every race starts both operations before either finishes, so they take
 * different pooled connections and meet at the locks `lib/db/approvals.ts`
 * documents. Which side wins is not asserted where PostgreSQL may choose; what
 * is asserted is that **the contradictory shape never exists** — a decision
 * inside a withdrawn or superseded request, two outcomes for one request, an
 * Activity row for something that did not end, a decision by somebody whose
 * revoke had already committed. Each race runs several times. One race is
 * forced into a known order with a second connection, so the revoke rule is
 * proved rather than hoped for.
 */

const ROUNDS = 5;

const ref = (s: Stage, version = 2): StaffApprovalRef => ({ workroomId: s.workroomId, presentationId: s.presentationId, version });
const handles = (s: Stage, version = 2): ClientApprovalRef => ({ room: s.room, presentation: s.presentation, version });

async function memberId(s: Stage, who: ClientActor): Promise<string> {
  const [row] = await db()
    .select({ id: workroomMembers.id })
    .from(workroomMembers)
    .where(and(eq(workroomMembers.workroomId, s.workroomId), eq(workroomMembers.contactId, who.contactId)));
  return row!.id;
}

async function ask(s: Stage, people: ClientActor[]) {
  const asked = await askForApproval(staff, ref(s), await Promise.all(people.map((p) => memberId(s, p))));
  assert.ok(asked.ok, asked.ok ? "" : asked.message);
}

async function publish(s: Stage) {
  return publishPresentation(owner, s.presentationId, (await findPresentation(s.presentationId))!.version);
}

async function state(s: Stage, version = 2) {
  const [row] = (await db().execute(sql`
    SELECT a.status,
           count(ap.*) FILTER (WHERE ap.decision = 'approved')::int AS approved,
           count(ap.*) FILTER (WHERE ap.decision = 'changes_requested')::int AS changes,
           count(ap.*)::int AS total
      FROM presentation_approvals a
      JOIN presentation_revisions r ON r.id = a.presentation_revision_id
      JOIN presentation_approval_approvers ap ON ap.presentation_approval_id = a.id
     WHERE r.presentation_id = ${s.presentationId} AND r.revision_number = ${version}
     GROUP BY a.id, a.status, a.requested_at
     ORDER BY a.requested_at DESC LIMIT 1
  `)) as unknown as Array<{ status: string; approved: number; changes: number; total: number }>;
  return row ?? null;
}

async function kinds(s: Stage): Promise<string[]> {
  const rows = await db().select({ kind: workroomActivity.kind }).from(workroomActivity).where(eq(workroomActivity.workroomId, s.workroomId));
  return rows.map((r) => r.kind).filter((k) => k.startsWith("approval.")).sort();
}

async function auditCount(s: Stage, action: string): Promise<number> {
  const [row] = (await db().execute(sql`
    SELECT count(*)::int AS n FROM audit_events
     WHERE action = ${action} AND metadata->>'workroom_id' = ${s.workroomId}
  `)) as unknown as Array<{ n: number }>;
  return row!.n;
}

/** Nothing threw — every refusal came back as an Outcome — and nothing deadlocked. */
function settledCleanly(results: PromiseSettledResult<unknown>[]) {
  const threw = results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason?.message ?? r));
  assert.deepEqual(threw, [], "an operation threw (deadlock or unhandled error)");
}

function value<T>(result: PromiseSettledResult<T>): T {
  assert.equal(result.status, "fulfilled");
  return (result as PromiseFulfilledResult<T>).value;
}

let seq = 0;
async function fresh(): Promise<Stage & { carl: ClientActor }> {
  const tag = `HR${seq++}`;
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

test("two approvers decide at once: both count, the request approves once", async () => {
  for (let i = 0; i < ROUNDS; i++) {
    const s = await fresh();
    await ask(s, [s.ana, s.ben]);
    const results = await Promise.allSettled([decideApproval(s.ana, handles(s), "approved"), decideApproval(s.ben, handles(s), "approved")]);
    settledCleanly(results);
    assert.ok(results.every((r) => value(r).ok), "a valid decision was refused");
    assert.deepEqual(await state(s), { status: "approved", approved: 2, changes: 0, total: 2 });
    assert.deepEqual(await kinds(s), ["approval.approved", "approval.requested"]);
  }
});

test("one approver presses twice at once: one decision, one Audit row, one calm refusal", async () => {
  for (let i = 0; i < ROUNDS; i++) {
    const s = await fresh();
    await ask(s, [s.ana, s.ben]);
    const results = await Promise.allSettled([decideApproval(s.ana, handles(s), "approved"), decideApproval(s.ana, handles(s), "approved")]);
    settledCleanly(results);
    const outcomes = results.map((r) => value(r));
    assert.equal(outcomes.filter((o) => o.ok).length, 1);
    assert.equal(outcomes.find((o) => !o.ok)!.ok === false && (outcomes.find((o) => !o.ok) as { reason: string }).reason, "already_done");
    assert.deepEqual(await state(s), { status: "requested", approved: 1, changes: 0, total: 2 });
    assert.equal(await auditCount(s, "approval.approved"), 1);
  }
});

test("the last approval and a request for changes at once: changes requested, every time, once", async () => {
  for (let i = 0; i < ROUNDS; i++) {
    const s = await fresh();
    await ask(s, [s.ana, s.ben]);
    const [approve, change] = await Promise.allSettled([
      decideApproval(s.ana, handles(s), "approved"),
      decideApproval(s.ben, handles(s), "changes_requested"),
    ]);
    settledCleanly([approve!, change!]);
    assert.ok(value(change!).ok, "the request for changes was refused");
    const final = (await state(s))!;
    assert.equal(final.status, "changes_requested");
    assert.equal(final.changes, 1);
    // Whether the approval landed first is PostgreSQL's choice; both are honest.
    assert.equal(final.approved, value(approve!).ok ? 1 : 0);
    assert.deepEqual(await kinds(s), ["approval.changes_requested", "approval.requested"]);
  }
});

test("a decision and a publish at once: approved and left alone, or superseded and refused — never both", async () => {
  for (let i = 0; i < ROUNDS; i++) {
    const s = await fresh();
    await ask(s, [s.ana]);
    const [decided, published] = await Promise.allSettled([decideApproval(s.ana, handles(s), "approved"), publish(s)]);
    settledCleanly([decided!, published!]);
    assert.ok(value(published!).ok, "the publish failed");
    const final = (await state(s))!;
    if (value(decided!).ok) {
      assert.equal(final.status, "approved");
      assert.equal(await auditCount(s, "approval.superseded"), 0);
      assert.deepEqual(await kinds(s), ["approval.approved", "approval.requested"]);
    } else {
      assert.equal(final.status, "superseded");
      assert.equal(final.approved, 0);
      assert.deepEqual(await kinds(s), ["approval.requested"]);
    }
    assert.equal(await state(s, 3), null, "the new version inherited a request");
  }
});

test("a decision and a withdrawal at once: one wins, cleanly", async () => {
  for (let i = 0; i < ROUNDS; i++) {
    const s = await fresh();
    await ask(s, [s.ana]);
    const [decided, withdrawn] = await Promise.allSettled([decideApproval(s.ana, handles(s), "approved"), withdrawApproval(staff, ref(s))]);
    settledCleanly([decided!, withdrawn!]);
    assert.notEqual(value(decided!).ok, value(withdrawn!).ok, "both or neither succeeded");
    const final = (await state(s))!;
    assert.deepEqual(final, value(decided!).ok
      ? { status: "approved", approved: 1, changes: 0, total: 1 }
      : { status: "withdrawn", approved: 0, changes: 0, total: 1 });
  }
});

test("a decision and a revoke at once: a decision that wins stands; one that loses writes nothing", async () => {
  for (let i = 0; i < ROUNDS; i++) {
    const s = await fresh();
    await ask(s, [s.ana, s.ben]);
    const id = await memberId(s, s.ana);
    const [v] = await db().select({ v: workroomMembers.version }).from(workroomMembers).where(eq(workroomMembers.id, id));
    const [decided, revoked] = await Promise.allSettled([decideApproval(s.ana, handles(s), "approved"), revokeMembership(owner, id, v!.v)]);
    settledCleanly([decided!, revoked!]);
    assert.ok(value(revoked!).ok, "the revoke failed");
    const final = (await state(s))!;
    assert.equal(final.approved, value(decided!).ok ? 1 : 0);
    if (!value(decided!).ok) assert.equal((value(decided!) as { reason: string }).reason, "not_found");
  }
});

test("a revoke that commits first is seen: the waiting decision is refused, not written", async () => {
  const s = await fresh();
  await ask(s, [s.ana, s.ben]);
  const id = await memberId(s, s.ana);
  const blocker = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    let settledEarly = false;
    let pending: ReturnType<typeof decideApproval> | null = null;
    await blocker.begin(async (tx) => {
      // The revoke is written and holds the membership row, uncommitted.
      await tx`UPDATE workroom_members SET status = 'revoked', revoked_at = now() WHERE id = ${id}`;
      pending = decideApproval(s.ana, handles(s), "approved");
      void pending.then(() => (settledEarly = true));
      await new Promise((resolve) => setTimeout(resolve, 600));
      assert.equal(settledEarly, false, "the decision did not wait for the revoke");
    });
    const outcome = await pending!;
    assert.equal(outcome.ok, false);
    assert.equal((outcome as { reason: string }).reason, "not_found");
    assert.deepEqual(await state(s), { status: "requested", approved: 0, changes: 0, total: 2 });
  } finally {
    await blocker.end({ timeout: 5 });
  }
});

test("an unpublish that commits first is seen: the decision waiting on it is refused, not written", async () => {
  const s = await fresh();
  await ask(s, [s.ana]);
  const blocker = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    let settledEarly = false;
    let pending: ReturnType<typeof decideApproval> | null = null;
    await blocker.begin(async (tx) => {
      // The unpublish is written and holds the Presentation row, uncommitted —
      // so the decision's lookup still sees it published and goes on to wait
      // at the Presentation's share lock.
      await tx`UPDATE presentations SET status = 'unpublished' WHERE id = ${s.presentationId}`;
      pending = decideApproval(s.ana, handles(s), "approved");
      void pending.then(() => (settledEarly = true));
      await new Promise((resolve) => setTimeout(resolve, 600));
      assert.equal(settledEarly, false, "the decision did not wait for the unpublish");
    });
    const outcome = await pending!;
    assert.equal(outcome.ok, false);
    assert.equal((outcome as { reason: string }).reason, "not_found");
    assert.deepEqual(await state(s), { status: "requested", approved: 0, changes: 0, total: 1 });
  } finally {
    await blocker.end({ timeout: 5 });
  }
});

test("a decision and an unpublish at once: decided and kept, or refused and still awaiting", async () => {
  for (let i = 0; i < ROUNDS; i++) {
    const s = await fresh();
    await ask(s, [s.ana]);
    const version = (await findPresentation(s.presentationId))!.version;
    const [decided, unpublished] = await Promise.allSettled([
      decideApproval(s.ana, handles(s), "approved"),
      unpublishPresentation(owner, s.presentationId, version),
    ]);
    settledCleanly([decided!, unpublished!]);
    assert.ok(value(unpublished!).ok, "the unpublish failed");
    assert.deepEqual(await state(s), value(decided!).ok
      ? { status: "approved", approved: 1, changes: 0, total: 1 }
      : { status: "requested", approved: 0, changes: 0, total: 1 });
  }
});

test("an ask and a publish at once: the ask lands and is superseded, or is refused — never left on an old version", async () => {
  for (let i = 0; i < ROUNDS; i++) {
    const s = await fresh();
    const ids = [await memberId(s, s.ana)];
    const [asked, published] = await Promise.allSettled([askForApproval(staff, ref(s), ids), publish(s)]);
    settledCleanly([asked!, published!]);
    assert.ok(value(published!).ok);
    const old = await state(s, 2);
    if (value(asked!).ok) assert.equal(old!.status, "superseded");
    else assert.equal(old, null);
    assert.equal(await state(s, 3), null);
  }
});

test("a storm of every approval operation at once deadlocks nothing and leaves one legal state", async () => {
  for (let i = 0; i < ROUNDS; i++) {
    const s = await fresh();
    await ask(s, [s.ana, s.ben, s.carl]);
    const results = await Promise.allSettled([
      decideApproval(s.ana, handles(s), "approved"),
      decideApproval(s.ben, handles(s), "approved"),
      decideApproval(s.carl, handles(s), "changes_requested"),
      withdrawApproval(staff, ref(s)),
      publish(s),
      askForApproval(staff, ref(s), [await memberId(s, s.ana)]),
    ]);
    settledCleanly(results);
    const final = (await state(s))!;
    assert.ok(["requested", "approved", "changes_requested", "withdrawn", "superseded"].includes(final.status));
    // The 0008 agreement, restated: whatever happened, the request agrees with its approvers.
    if (final.status === "approved") assert.equal(final.approved, final.total);
    if (final.status === "changes_requested") assert.equal(final.changes, 1);
    if (["requested", "withdrawn", "superseded"].includes(final.status)) {
      assert.equal(final.changes, 0);
      assert.ok(final.approved < final.total);
    }
  }
});
