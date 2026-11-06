import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { eq, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import postgres from "postgres";

import { closeDb, db } from "../lib/db/index.ts";
import { uuidv7 } from "../lib/db/id.ts";
import {
  addNoteItem,
  createPresentation,
  findPresentation,
  publishPresentation,
} from "../lib/db/presentations.ts";
import {
  ACTIVITY_KINDS,
  clientIdentity,
  presentationApprovalApprovers,
  presentationApprovals,
  user,
  workroomMembers,
} from "../lib/db/schema.ts";
import {
  APPROVAL_STATUSES,
  APPROVER_DECISIONS,
  agreesWithApprovers,
  type ApprovalStatus,
  type ApproverState,
} from "../lib/workrooms/approval-rules.ts";
import { clearOwner, owner, person, seedOwner, stage, type Stage } from "./support/review-stage.ts";

/**
 * Stage H1 — the Approvals foundation, asserted against PostgreSQL rather than
 * read off the migration.
 *
 * Every write here is raw SQL, so the database is the only thing deciding:
 * there is no domain module yet (H2), and a test that went through one would
 * be testing the module's manners rather than the schema's promises. Each
 * refusal is matched on the reason PostgreSQL gave, so a test cannot pass
 * because something unrelated happened to fail.
 *
 * Needs `DATABASE_URL` pointing at a migrated database, exactly as every other
 * database suite does.
 */

/* --------------------------------------------------------------- helpers */

/** Drizzle wraps driver errors, so what PostgreSQL said is down the chain. */
function chain(error: unknown): string {
  const seen: string[] = [];
  let current: unknown = error;
  for (let i = 0; current instanceof Error && i < 5; i++) {
    seen.push(current.message);
    current = (current as Error & { cause?: unknown }).cause;
  }
  return seen.join(" | ");
}

/** Assert the database refused, and refused for the stated reason. */
async function refused(run: () => Promise<unknown>, because: RegExp): Promise<void> {
  let raised: unknown;
  try {
    await run();
  } catch (error) {
    raised = error;
  }
  assert.ok(raised, `PostgreSQL accepted what it must refuse (${because})`);
  assert.match(chain(raised), because);
}

type Tx = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];

type Revision = { id: string; number: number; hash: string };

async function revisionsOf(s: Stage): Promise<Revision[]> {
  const rows = (await db().execute(sql`
    SELECT id, revision_number, content_hash FROM presentation_revisions
     WHERE presentation_id = ${s.presentationId}::uuid ORDER BY revision_number
  `)) as unknown as Array<{ id: string; revision_number: number; content_hash: string }>;
  return rows.map((r) => ({ id: r.id, number: Number(r.revision_number), hash: r.content_hash }));
}

/** Publish the Presentation once more. Every publish makes a new Revision. */
async function publishAgain(s: Stage): Promise<Revision> {
  const version = (await findPresentation(s.presentationId))!.version;
  assert.ok((await publishPresentation(owner, s.presentationId, version)).ok);
  return (await revisionsOf(s)).at(-1)!;
}

type Ask = {
  workroomId: string;
  revision: Revision;
  identities: string[];
  hash?: string;
  requestedBy?: string | null;
};

type Asked = { id: string; approvers: string[] };

async function insertRequest(tx: Tx, input: Ask, id = uuidv7()): Promise<string> {
  await tx.execute(sql`
    INSERT INTO presentation_approvals (id, workroom_id, presentation_revision_id, requested_by, content_hash)
    VALUES (${id}::uuid, ${input.workroomId}::uuid, ${input.revision.id}::uuid,
            ${input.requestedBy === undefined ? owner.id : input.requestedBy}, ${input.hash ?? input.revision.hash})
  `);
  return id;
}

async function insertApprover(
  tx: Tx,
  request: string,
  workroomId: string,
  identity: string,
  name = "Named Person",
): Promise<string> {
  const id = uuidv7();
  await tx.execute(sql`
    INSERT INTO presentation_approval_approvers (id, workroom_id, presentation_approval_id, client_identity_id, display_name)
    VALUES (${id}::uuid, ${workroomId}::uuid, ${request}::uuid, ${identity}, ${name})
  `);
  return id;
}

/** One request and its named approvers, in one transaction, as H2 will write it. */
async function ask(input: Ask): Promise<Asked> {
  return db().transaction(async (tx) => {
    const id = await insertRequest(tx, input);
    const approvers: string[] = [];
    for (const identity of input.identities) approvers.push(await insertApprover(tx, id, input.workroomId, identity));
    named.set(id, approvers);
    return { id, approvers };
  });
}

type Decision = "approved" | "changes_requested";

/** One approver decides; optionally the request moves in the same transaction. */
async function decide(request: string, approver: string, decision: Decision, then?: ApprovalStatus): Promise<void> {
  await db().transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE presentation_approval_approvers SET decision = ${decision}, decided_at = now() WHERE id = ${approver}::uuid
    `);
    if (then) {
      await tx.execute(sql`UPDATE presentation_approvals SET status = ${then}, closed_at = now() WHERE id = ${request}::uuid`);
    }
  });
}

async function withdraw(request: string, by = owner.id): Promise<void> {
  await db().execute(sql`
    UPDATE presentation_approvals SET status = 'withdrawn', closed_at = now(), closed_by_user_id = ${by}
     WHERE id = ${request}::uuid
  `);
}

async function supersede(request: string, by: Revision): Promise<void> {
  await db().execute(sql`
    UPDATE presentation_approvals SET status = 'superseded', closed_at = now(), closed_by_revision_id = ${by.id}::uuid
     WHERE id = ${request}::uuid
  `);
}

async function statusOf(request: string): Promise<ApprovalStatus> {
  const rows = await db().select({ status: presentationApprovals.status }).from(presentationApprovals)
    .where(eq(presentationApprovals.id, request));
  return rows[0]!.status;
}

/**
 * Every approver's decision, in the order they were named. Not ordered by `id`:
 * UUIDv7 orders by millisecond only, and approvers named in the same
 * millisecond would come back in random order — a flake found by running this
 * suite repeatedly, not a property of the schema.
 */
async function decisionsOf(request: string): Promise<ApproverState[]> {
  const rows = await db()
    .select({ id: presentationApprovalApprovers.id, decision: presentationApprovalApprovers.decision })
    .from(presentationApprovalApprovers)
    .where(eq(presentationApprovalApprovers.presentationApprovalId, request));
  const order = named.get(request);
  if (order) {
    assert.equal(rows.length, order.length, "the approvers named are not the approvers stored");
    return order.map((id) => rows.find((r) => r.id === id)!.decision ?? null);
  }
  return rows.map((r) => r.decision ?? null).sort();
}

/** The order each request's approvers were named in, by request id. */
const named = new Map<string, string[]>();

/** Its database state agrees with the pure rule — the same sentence, twice. */
async function agrees(request: string): Promise<void> {
  assert.ok(agreesWithApprovers(await statusOf(request), await decisionsOf(request)));
}

/* ----------------------------------------------------------------- setup */

let a: Stage;
let b: Stage;
let carl: string;
let outsider: string;
let revoked: string;
let inactive: string;

before(async () => {
  await seedOwner();
  a = await stage("HA");
  b = await stage("HB");
  carl = (await person("HAcarl", a.workroomId, "ha-carl@example.com")).identityId;
  outsider = (await person("HAout", null, "ha-out@example.com")).identityId;

  const gone = await person("HAgone", a.workroomId, "ha-gone@example.com");
  await db().update(workroomMembers).set({ status: "revoked", revokedAt: new Date() })
    .where(eq(workroomMembers.contactId, gone.contactId));
  revoked = gone.identityId;

  const off = await person("HAoff", a.workroomId, "ha-off@example.com");
  await db().update(clientIdentity).set({ status: "inactive" }).where(eq(clientIdentity.id, off.identityId));
  inactive = off.identityId;
});

after(async () => {
  await clearOwner();
  await closeDb();
});

/* ------------------------------------------------- request: valid shapes */

test("a request is accepted in every status, each in its own shape", async () => {
  const requested = await ask({ workroomId: a.workroomId, revision: await publishAgain(a), identities: [a.ana.identityId] });
  assert.equal(await statusOf(requested.id), "requested");

  const approved = await ask({ workroomId: a.workroomId, revision: await publishAgain(a), identities: [a.ana.identityId] });
  await decide(approved.id, approved.approvers[0]!, "approved", "approved");
  assert.equal(await statusOf(approved.id), "approved");

  const changes = await ask({ workroomId: a.workroomId, revision: await publishAgain(a), identities: [a.ana.identityId] });
  await decide(changes.id, changes.approvers[0]!, "changes_requested", "changes_requested");
  assert.equal(await statusOf(changes.id), "changes_requested");

  const withdrawn = await ask({ workroomId: a.workroomId, revision: await publishAgain(a), identities: [a.ana.identityId] });
  await withdraw(withdrawn.id);
  assert.equal(await statusOf(withdrawn.id), "withdrawn");

  const old = await publishAgain(a);
  const superseded = await ask({ workroomId: a.workroomId, revision: old, identities: [a.ana.identityId] });
  await supersede(superseded.id, await publishAgain(a));
  assert.equal(await statusOf(superseded.id), "superseded");

  for (const request of [requested, approved, changes, withdrawn, superseded]) await agrees(request.id);

  // The defaults are the model's: born requested, at the transaction's time.
  const row = (await db().select().from(presentationApprovals).where(eq(presentationApprovals.id, requested.id)))[0]!;
  assert.equal(row.closedAt, null);
  assert.equal(row.closedByUserId, null);
  assert.equal(row.closedByRevisionId, null);
  assert.equal(row.requestedBy, owner.id);
});

/* --------------------------------------------- request: malformed shapes */

test("every malformed closure is refused, status by status", async () => {
  const later = await publishAgain(a);
  const r = await ask({ workroomId: a.workroomId, revision: (await revisionsOf(a)).at(-2)!, identities: [a.ana.identityId, a.ben.identityId] });
  const set = (assignments: ReturnType<typeof sql>) =>
    db().execute(sql`UPDATE presentation_approvals SET ${assignments} WHERE id = ${r.id}::uuid`);
  const shape = /presentation_approvals_closure_shape_check/;
  const user = owner.id;
  const rev = later.id;

  // requested carries no closure at all
  await refused(() => set(sql`closed_at = now()`), shape);
  await refused(() => set(sql`closed_by_user_id = ${user}`), shape);
  await refused(() => set(sql`closed_by_revision_id = ${rev}::uuid`), shape);

  // withdrawn: when, and by whom — never by a Revision
  await refused(() => set(sql`status = 'withdrawn'`), shape);
  await refused(() => set(sql`status = 'withdrawn', closed_at = now()`), shape);
  await refused(() => set(sql`status = 'withdrawn', closed_by_user_id = ${user}`), shape);
  await refused(
    () => set(sql`status = 'withdrawn', closed_at = now(), closed_by_user_id = ${user}, closed_by_revision_id = ${rev}::uuid`),
    shape,
  );

  // superseded: when, and by which Revision — never by a person
  await refused(() => set(sql`status = 'superseded', closed_at = now()`), shape);
  await refused(() => set(sql`status = 'superseded', closed_by_revision_id = ${rev}::uuid`), shape);
  await refused(
    () => set(sql`status = 'superseded', closed_at = now(), closed_by_revision_id = ${rev}::uuid, closed_by_user_id = ${user}`),
    shape,
  );

  // approved and changes_requested: when, and nothing else
  for (const status of ["approved", "changes_requested"]) {
    await refused(() => set(sql`status = ${status}`), shape);
    await refused(() => set(sql`status = ${status}, closed_at = now(), closed_by_user_id = ${user}`), shape);
    await refused(() => set(sql`status = ${status}, closed_at = now(), closed_by_revision_id = ${rev}::uuid`), shape);
  }

  // the vocabulary: 0004's words, Review words, invented words, nothing
  for (const word of ["granted", "declined", "open", "closed", "pending", "Approved", ""]) {
    await refused(() => set(sql`status = ${word}, closed_at = now()`), /presentation_approvals_(status|closure_shape)_check/);
  }
  await refused(() => set(sql`status = NULL`), /null value in column "status"/);

  // a closure cannot come before the request it closes
  await refused(
    () => set(sql`status = 'withdrawn', closed_at = requested_at - interval '1 second', closed_by_user_id = ${user}`),
    /presentation_approvals_closed_after_request_check/,
  );

  // and none of that touched the request
  assert.equal(await statusOf(r.id), "requested");
  await agrees(r.id);
});

test("a request is born requested, now, with no closure", async () => {
  const revision = await publishAgain(a);
  for (const status of ["approved", "changes_requested", "withdrawn", "superseded"]) {
    await refused(
      () =>
        db().transaction(async (tx) => {
          await tx.execute(sql`
            INSERT INTO presentation_approvals (id, workroom_id, presentation_revision_id, content_hash, status, closed_at)
            VALUES (${uuidv7()}::uuid, ${a.workroomId}::uuid, ${revision.id}::uuid, ${revision.hash}, ${status}, now())
          `);
        }),
      /an approval request begins as requested/,
    );
  }
  await refused(
    () =>
      db().execute(sql`
        INSERT INTO presentation_approvals (id, workroom_id, presentation_revision_id, content_hash, closed_at)
        VALUES (${uuidv7()}::uuid, ${a.workroomId}::uuid, ${revision.id}::uuid, ${revision.hash}, now())
      `),
    /presentation_approvals_closure_shape_check/,
  );
  await refused(
    () =>
      db().execute(sql`
        INSERT INTO presentation_approvals (id, workroom_id, presentation_revision_id, content_hash, requested_at)
        VALUES (${uuidv7()}::uuid, ${a.workroomId}::uuid, ${revision.id}::uuid, ${revision.hash}, now() - interval '1 day')
      `),
    /requested at the moment it is written/,
  );
  // A request about another Workroom's Revision does not exist to be asked.
  await refused(
    async () => ask({ workroomId: a.workroomId, revision: (await revisionsOf(b)).at(-1)!, identities: [a.ana.identityId] }),
    /presentation_approvals_revision_fk/,
  );
});

test("a supersession names a newer Revision of the same Presentation, in the same Workroom", async () => {
  const older = await publishAgain(a);
  const mine = await publishAgain(a);
  const newer = await publishAgain(a);
  const r = await ask({ workroomId: a.workroomId, revision: mine, identities: [a.ana.identityId] });

  await refused(() => supersede(r.id, older), /superseded only by a newer revision of the same presentation/);
  await refused(() => supersede(r.id, mine), /superseded only by a newer revision of the same presentation/);

  // Another Presentation in the same Workroom, published after this one.
  const other = await createPresentation(owner, a.workroomId, { title: "Other", intro: "Other." });
  assert.ok(other.ok);
  const v = async () => (await findPresentation(other.value))!.version;
  assert.ok((await addNoteItem(owner, other.value, await v(), { caption: "One", body: "Words." })).ok);
  assert.ok((await publishPresentation(owner, other.value, await v())).ok);
  const theirs = (await findPresentation(other.value))!.currentRevisionId!;
  await refused(
    () => supersede(r.id, { id: theirs, number: 99, hash: "" }),
    /superseded only by a newer revision of the same presentation/,
  );

  // Another Workroom's Revision: the trigger reaches it first, and the
  // composite foreign key refuses it on its own once the trigger is out of the
  // way — inside a transaction that rolls back, trigger and all.
  const theirsInB = (await revisionsOf(b)).at(-1)!;
  await refused(() => supersede(r.id, theirsInB), /superseded only by a newer revision of the same presentation/);
  await refused(
    () =>
      db().transaction(async (tx) => {
        await tx.execute(sql`ALTER TABLE presentation_approvals DISABLE TRIGGER presentation_approvals_guard_row`);
        await tx.execute(sql`
          UPDATE presentation_approvals SET status = 'superseded', closed_at = now(), closed_by_revision_id = ${theirsInB.id}::uuid
           WHERE id = ${r.id}::uuid
        `);
      }),
    /presentation_approvals_closed_by_revision_fk/,
  );

  await supersede(r.id, newer);
  assert.equal(await statusOf(r.id), "superseded");
});

test("the shape CHECKs hold even with every trigger switched off", async () => {
  // Replica mode silences triggers — foreign keys included — and leaves CHECKs
  // standing. So these are the rules that would still hold if a trigger were
  // ever dropped, and the two a trigger otherwise reaches first.
  const revision = await publishAgain(a);
  const raw = (columns: ReturnType<typeof sql>) =>
    db().transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(columns);
    });
  await refused(
    () =>
      raw(sql`
        INSERT INTO presentation_approvals (id, workroom_id, presentation_revision_id, content_hash, status, closed_at, closed_by_revision_id)
        VALUES (${uuidv7()}::uuid, ${a.workroomId}::uuid, ${revision.id}::uuid, ${revision.hash}, 'superseded', now(), ${revision.id}::uuid)
      `),
    /presentation_approvals_superseded_by_other_check/,
  );
  await refused(
    () =>
      raw(sql`
        INSERT INTO presentation_approvals (id, workroom_id, presentation_revision_id, content_hash)
        VALUES (${uuidv7()}::uuid, ${a.workroomId}::uuid, ${revision.id}::uuid, ${"0".repeat(63)})
      `),
    /presentation_approvals_hash_length_check/,
  );
  await refused(
    () =>
      raw(sql`
        INSERT INTO presentation_approvals (id, workroom_id, presentation_revision_id, content_hash, status, closed_at)
        VALUES (${uuidv7()}::uuid, ${a.workroomId}::uuid, ${revision.id}::uuid, ${revision.hash}, 'granted', now())
      `),
    /presentation_approvals_(status|closure_shape)_check/,
  );
});

/* ------------------------------------------------------------ uniqueness */

test("one requested request at a time per Revision", async () => {
  const revision = await publishAgain(a);
  await ask({ workroomId: a.workroomId, revision, identities: [a.ana.identityId] });
  await refused(
    () => ask({ workroomId: a.workroomId, revision, identities: [a.ben.identityId] }),
    /presentation_approvals_one_standing_idx/,
  );
  // A different Revision is a different question.
  await ask({ workroomId: a.workroomId, revision: await publishAgain(a), identities: [a.ana.identityId] });
});

test("a withdrawn request may be asked again, and again; its partial decisions stay", async () => {
  const revision = await publishAgain(a);
  const first = await ask({ workroomId: a.workroomId, revision, identities: [a.ana.identityId, a.ben.identityId] });
  await decide(first.id, first.approvers[0]!, "approved"); // one of two: still requested
  assert.equal(await statusOf(first.id), "requested");
  await withdraw(first.id);

  const second = await ask({ workroomId: a.workroomId, revision, identities: [a.ana.identityId] });
  await withdraw(second.id);
  const third = await ask({ workroomId: a.workroomId, revision, identities: [a.ben.identityId] });

  const rows = await db().select({ status: presentationApprovals.status }).from(presentationApprovals)
    .where(eq(presentationApprovals.presentationRevisionId, revision.id));
  assert.deepEqual(rows.map((r) => r.status).sort(), ["requested", "withdrawn", "withdrawn"]);
  // The withdrawn request is history exactly as it stood.
  assert.deepEqual(await decisionsOf(first.id), ["approved", null]);
  await agrees(first.id);
  await agrees(third.id);
});

test("a Revision is never asked again after approved, changes_requested or superseded", async () => {
  const approved = await publishAgain(a);
  const r1 = await ask({ workroomId: a.workroomId, revision: approved, identities: [a.ana.identityId] });
  await decide(r1.id, r1.approvers[0]!, "approved", "approved");

  const changes = await publishAgain(a);
  const r2 = await ask({ workroomId: a.workroomId, revision: changes, identities: [a.ana.identityId] });
  await decide(r2.id, r2.approvers[0]!, "changes_requested", "changes_requested");

  const superseded = await publishAgain(a);
  const r3 = await ask({ workroomId: a.workroomId, revision: superseded, identities: [a.ana.identityId] });
  await supersede(r3.id, await publishAgain(a));

  for (const revision of [approved, changes, superseded]) {
    await refused(
      () => ask({ workroomId: a.workroomId, revision, identities: [a.ben.identityId] }),
      /presentation_approvals_one_standing_idx/,
    );
  }
});

test("two simultaneous requests for one Revision: one request, one clean refusal", async () => {
  const revision = await publishAgain(a);
  const url = process.env.DATABASE_URL!;
  const clients = [0, 1].map(() => postgres(url, { max: 1, onnotice: () => {}, connection: { statement_timeout: 10000 } }));
  try {
    const attempt = (client: ReturnType<typeof postgres>, identity: string, hold: number) =>
      client.begin(async (tx) => {
        const id = uuidv7();
        await tx`
          INSERT INTO presentation_approvals (id, workroom_id, presentation_revision_id, requested_by, content_hash)
          VALUES (${id}, ${a.workroomId}, ${revision.id}, ${owner.id}, ${revision.hash})
        `;
        await tx`
          INSERT INTO presentation_approval_approvers (id, workroom_id, presentation_approval_id, client_identity_id, display_name)
          VALUES (${uuidv7()}, ${a.workroomId}, ${id}, ${identity}, 'Named Person')
        `;
        await new Promise((resolve) => setTimeout(resolve, hold));
      });
    const first = attempt(clients[0]!, a.ana.identityId, 400);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = attempt(clients[1]!, a.ben.identityId, 0);
    const results = await Promise.allSettled([first, second]);
    assert.deepEqual(results.map((r) => r.status), ["fulfilled", "rejected"]);
    assert.match(chain((results[1] as PromiseRejectedResult).reason), /presentation_approvals_one_standing_idx/);
  } finally {
    await Promise.all(clients.map((client) => client.end({ timeout: 5 })));
  }
  const rows = await db().select().from(presentationApprovals).where(eq(presentationApprovals.presentationRevisionId, revision.id));
  assert.equal(rows.length, 1);
});

/* ---------------------------------------------------------- content hash */

test("a request carries its Revision's own content hash, permanently", async () => {
  const revision = await publishAgain(a);
  const other = (await revisionsOf(a))[0]!;
  assert.notEqual(other.hash, revision.hash);
  await refused(
    () => ask({ workroomId: a.workroomId, revision, hash: other.hash, identities: [a.ana.identityId] }),
    /carries its revision's own content hash/,
  );
  const r = await ask({ workroomId: a.workroomId, revision, identities: [a.ana.identityId] });
  const stored = (await db().select().from(presentationApprovals).where(eq(presentationApprovals.id, r.id)))[0]!;
  assert.equal(stored.contentHash, revision.hash);
  await refused(
    () => db().execute(sql`UPDATE presentation_approvals SET content_hash = ${other.hash} WHERE id = ${r.id}::uuid`),
    /belongs to one revision in one workroom, permanently/,
  );
});

/* ------------------------------------------------------- named approvers */

test("one named approver, or several, each named once", async () => {
  const one = await ask({ workroomId: a.workroomId, revision: await publishAgain(a), identities: [a.ana.identityId] });
  assert.equal((await decisionsOf(one.id)).length, 1);
  const three = await ask({
    workroomId: a.workroomId,
    revision: await publishAgain(a),
    identities: [a.ana.identityId, a.ben.identityId, carl],
  });
  assert.deepEqual(await decisionsOf(three.id), [null, null, null]);

  await refused(
    async () => ask({ workroomId: a.workroomId, revision: await publishAgain(a), identities: [a.ana.identityId, a.ana.identityId] }),
    /presentation_approval_approvers_identity_key/,
  );
});

test("a request that names nobody is not a request", async () => {
  const revision = await publishAgain(a);
  await refused(
    () => db().transaction(async (tx) => void (await insertRequest(tx, { workroomId: a.workroomId, revision, identities: [] }))),
    /names nobody: at least one approver is required/,
  );
  const rows = await db().select().from(presentationApprovals).where(eq(presentationApprovals.presentationRevisionId, revision.id));
  assert.equal(rows.length, 0, "the empty request was kept");
});

test("an approver is somebody with active access to this Workroom", async () => {
  // A person with no membership, a member of another Workroom, a revoked
  // member, and a member whose sign-in is switched off — each beside somebody
  // who is fine, so the refusal is about that one person.
  for (const identity of [outsider, b.ana.identityId, revoked, inactive]) {
    await refused(
      async () => ask({ workroomId: a.workroomId, revision: (await revisionsOf(a)).at(-1)!, identities: [a.ana.identityId, identity] }),
      /an approver is a person with active access to this workroom/,
    );
  }
});

test("an approver cannot be attached to another Workroom's request", async () => {
  const revision = await publishAgain(a);
  await refused(
    () =>
      db().transaction(async (tx) => {
        const id = await insertRequest(tx, { workroomId: a.workroomId, revision, identities: [] });
        await insertApprover(tx, id, a.workroomId, a.ana.identityId);
        // The same request, claimed from Workroom B, by one of B's members.
        await insertApprover(tx, id, b.workroomId, b.ana.identityId);
      }),
    /presentation_approval_approvers_approval_fk/,
  );
  await refused(
    () =>
      db().transaction(async (tx) => {
        await insertApprover(tx, uuidv7(), a.workroomId, a.ana.identityId);
      }),
    /presentation_approval_approvers_approval_fk/,
  );
});

test("approvers are named with the request, undecided, and never added after", async () => {
  const r = await ask({ workroomId: a.workroomId, revision: await publishAgain(a), identities: [a.ana.identityId] });
  await refused(
    () => db().transaction(async (tx) => void (await insertApprover(tx, r.id, a.workroomId, a.ben.identityId))),
    /named in the transaction that makes the request, and never after/,
  );
  await refused(
    () =>
      db().transaction(async (tx) => {
        const id = await insertRequest(tx, { workroomId: a.workroomId, revision: await publishAgain(a), identities: [] });
        await tx.execute(sql`
          INSERT INTO presentation_approval_approvers
            (id, workroom_id, presentation_approval_id, client_identity_id, display_name, decision, decided_at)
          VALUES (${uuidv7()}::uuid, ${a.workroomId}::uuid, ${id}::uuid, ${a.ana.identityId}, 'Ana', 'approved', now())
        `);
      }),
    /a named approver begins undecided/,
  );
  for (const name of ["", "x".repeat(161)]) {
    await refused(
      () =>
        db().transaction(async (tx) => {
          const id = await insertRequest(tx, { workroomId: a.workroomId, revision: await publishAgain(a), identities: [] });
          await insertApprover(tx, id, a.workroomId, a.ana.identityId, name);
        }),
      /presentation_approval_approvers_display_name_check/,
    );
  }
});

test("a decision and its time arrive together, from the vocabulary, after the request", async () => {
  const r = await ask({ workroomId: a.workroomId, revision: await publishAgain(a), identities: [a.ana.identityId, a.ben.identityId] });
  const approver = r.approvers[0]!;
  const set = (assignments: ReturnType<typeof sql>) =>
    db().execute(sql`UPDATE presentation_approval_approvers SET ${assignments} WHERE id = ${approver}::uuid`);
  await refused(() => set(sql`decided_at = now()`), /presentation_approval_approvers_decided_shape_check/);
  await refused(() => set(sql`decision = 'approved'`), /presentation_approval_approvers_decided_shape_check/);
  for (const word of ["granted", "declined", "rejected", "Approved", ""]) {
    await refused(() => set(sql`decision = ${word}, decided_at = now()`), /presentation_approval_approvers_decision_check/);
  }
  await refused(
    () => set(sql`decision = 'approved', decided_at = now() - interval '1 day'`),
    /a decision cannot precede the request it answers/,
  );
  assert.deepEqual(await decisionsOf(r.id), [null, null]);
});

/* ---------------------------------------------------------- immutability */

test("requests and approvers are never deleted or truncated", async () => {
  const r = await ask({ workroomId: a.workroomId, revision: await publishAgain(a), identities: [a.ana.identityId] });
  await refused(
    () => db().execute(sql`DELETE FROM presentation_approvals WHERE id = ${r.id}::uuid`),
    /approval requests are business history: DELETE is not permitted/,
  );
  await refused(
    () => db().execute(sql`DELETE FROM presentation_approval_approvers WHERE id = ${r.approvers[0]!}::uuid`),
    /a named approver is part of the request: DELETE is not permitted/,
  );
  await refused(
    () => db().execute(sql`TRUNCATE presentation_approval_approvers`),
    /a named approver is part of the request: TRUNCATE is not permitted/,
  );
  await refused(
    () => db().execute(sql`TRUNCATE presentation_approvals, presentation_approval_approvers`),
    /TRUNCATE is not permitted/,
  );
  assert.equal(await statusOf(r.id), "requested");
  assert.equal((await decisionsOf(r.id)).length, 1);
});

test("a terminal request is final: no reopening, no second outcome, no rewritten closure", async () => {
  const approved = await ask({ workroomId: a.workroomId, revision: await publishAgain(a), identities: [a.ana.identityId] });
  await decide(approved.id, approved.approvers[0]!, "approved", "approved");
  const changes = await ask({ workroomId: a.workroomId, revision: await publishAgain(a), identities: [a.ana.identityId] });
  await decide(changes.id, changes.approvers[0]!, "changes_requested", "changes_requested");
  const withdrawn = await ask({ workroomId: a.workroomId, revision: await publishAgain(a), identities: [a.ana.identityId] });
  await withdraw(withdrawn.id);
  const superseded = await ask({ workroomId: a.workroomId, revision: await publishAgain(a), identities: [a.ana.identityId] });
  const by = await publishAgain(a);
  await supersede(superseded.id, by);
  const later = await publishAgain(a);

  const final = /is already (approved|changes_requested|withdrawn|superseded), and that is final/;
  for (const r of [approved, changes, withdrawn, superseded]) {
    const set = (assignments: ReturnType<typeof sql>) =>
      db().execute(sql`UPDATE presentation_approvals SET ${assignments} WHERE id = ${r.id}::uuid`);
    await refused(() => set(sql`status = 'requested', closed_at = NULL, closed_by_user_id = NULL, closed_by_revision_id = NULL`), final);
    for (const to of APPROVAL_STATUSES) {
      if (to === (await statusOf(r.id))) continue;
      await refused(() => set(sql`status = ${to}`), final);
    }
    await refused(() => set(sql`closed_at = closed_at + interval '1 second'`), final);
  }
  await refused(
    () => db().execute(sql`UPDATE presentation_approvals SET closed_by_user_id = ${a.ana.identityId} WHERE id = ${withdrawn.id}::uuid`),
    final,
  );
  await refused(
    () => db().execute(sql`UPDATE presentation_approvals SET closed_by_revision_id = ${later.id}::uuid WHERE id = ${superseded.id}::uuid`),
    final,
  );
  assert.deepEqual(
    [await statusOf(approved.id), await statusOf(changes.id), await statusOf(withdrawn.id), await statusOf(superseded.id)],
    ["approved", "changes_requested", "withdrawn", "superseded"],
  );
});

test("a request is never repointed at other work", async () => {
  const r = await ask({ workroomId: a.workroomId, revision: await publishAgain(a), identities: [a.ana.identityId] });
  const other = await publishAgain(a);
  const moved = /belongs to one revision in one workroom, permanently/;
  const set = (assignments: ReturnType<typeof sql>) =>
    db().execute(sql`UPDATE presentation_approvals SET ${assignments} WHERE id = ${r.id}::uuid`);
  await refused(() => set(sql`presentation_revision_id = ${other.id}::uuid`), moved);
  await refused(() => set(sql`workroom_id = ${b.workroomId}::uuid`), moved);
  await refused(() => set(sql`id = ${uuidv7()}::uuid`), moved);
  await refused(() => set(sql`requested_at = requested_at - interval '1 second'`), moved);
  await refused(() => set(sql`created_at = created_at - interval '1 second'`), moved);
});

test("the requester may fall away when a staff account is deleted, and is never rewritten", async () => {
  const asker = uuidv7();
  await db().insert(user).values({ id: asker, name: "Asker", email: "h1-asker@example.com", role: "member" });
  const r = await ask({ workroomId: a.workroomId, revision: await publishAgain(a), identities: [a.ana.identityId], requestedBy: asker });
  await refused(
    () => db().execute(sql`UPDATE presentation_approvals SET requested_by = ${owner.id} WHERE id = ${r.id}::uuid`),
    /who asked for an approval does not change/,
  );
  await decide(r.id, r.approvers[0]!, "approved", "approved");
  // `ON DELETE set null` updates a terminal row; the guard lets exactly that through.
  await db().delete(user).where(eq(user.id, asker));
  const row = (await db().select().from(presentationApprovals).where(eq(presentationApprovals.id, r.id)))[0]!;
  assert.equal(row.requestedBy, null);
  assert.equal(row.status, "approved");
});

test("who withdrew, and who was asked, are kept: RESTRICT, not SET NULL", async () => {
  const withdrawer = uuidv7();
  await db().insert(user).values({ id: withdrawer, name: "Withdrawer", email: "h1-withdrawer@example.com", role: "member" });
  const r = await ask({ workroomId: a.workroomId, revision: await publishAgain(a), identities: [carl] });
  await withdraw(r.id, withdrawer);
  await refused(() => db().delete(user).where(eq(user.id, withdrawer)), /presentation_approvals_closed_by_user_fk/);
  await refused(() => db().delete(clientIdentity).where(eq(clientIdentity.id, carl)), /presentation_approval_approvers_identity_fk/);
});

test("a named approver is never moved, renamed or reassigned", async () => {
  const r = await ask({ workroomId: a.workroomId, revision: await publishAgain(a), identities: [a.ana.identityId, a.ben.identityId] });
  const elsewhere = await ask({ workroomId: a.workroomId, revision: await publishAgain(a), identities: [a.ana.identityId] });
  const approver = r.approvers[0]!;
  const stays = /a named approver stays on one request, in one workroom, as the person named/;
  const set = (assignments: ReturnType<typeof sql>) =>
    db().execute(sql`UPDATE presentation_approval_approvers SET ${assignments} WHERE id = ${approver}::uuid`);
  await refused(() => set(sql`presentation_approval_id = ${elsewhere.id}::uuid`), stays);
  await refused(() => set(sql`workroom_id = ${b.workroomId}::uuid`), stays);
  await refused(() => set(sql`client_identity_id = ${carl}`), stays);
  await refused(() => set(sql`display_name = 'Somebody Else'`), stays);
  await refused(() => set(sql`id = ${uuidv7()}::uuid`), stays);
  await refused(() => set(sql`created_at = created_at - interval '1 second'`), stays);
});

test("a decision is made once: never changed, reversed, cleared or re-timed", async () => {
  const r = await ask({ workroomId: a.workroomId, revision: await publishAgain(a), identities: [a.ana.identityId, a.ben.identityId] });
  const approver = r.approvers[0]!;
  await decide(r.id, approver, "approved");
  const once = /a decision is made once: it is never changed or cleared/;
  const set = (assignments: ReturnType<typeof sql>) =>
    db().execute(sql`UPDATE presentation_approval_approvers SET ${assignments} WHERE id = ${approver}::uuid`);
  await refused(() => set(sql`decision = 'changes_requested'`), once);
  await refused(() => set(sql`decision = NULL, decided_at = NULL`), once);
  await refused(() => set(sql`decided_at = decided_at + interval '1 minute'`), once);
  await refused(() => set(sql`decision = 'approved', decided_at = now() + interval '1 minute'`), once);
  assert.deepEqual(await decisionsOf(r.id), ["approved", null]);
});

test("a decision is made only while the request is requested", async () => {
  // Ended by somebody else's request for changes.
  const changes = await ask({ workroomId: a.workroomId, revision: await publishAgain(a), identities: [a.ana.identityId, a.ben.identityId] });
  await decide(changes.id, changes.approvers[0]!, "changes_requested", "changes_requested");
  // Withdrawn with a partial approval on it.
  const withdrawn = await ask({ workroomId: a.workroomId, revision: await publishAgain(a), identities: [a.ana.identityId, a.ben.identityId] });
  await decide(withdrawn.id, withdrawn.approvers[0]!, "approved");
  await withdraw(withdrawn.id);
  // Superseded with nobody decided.
  const superseded = await ask({ workroomId: a.workroomId, revision: await publishAgain(a), identities: [a.ana.identityId, a.ben.identityId] });
  await supersede(superseded.id, await publishAgain(a));

  for (const [r, status] of [[changes, "changes_requested"], [withdrawn, "withdrawn"], [superseded, "superseded"]] as const) {
    for (const decision of APPROVER_DECISIONS) {
      await refused(
        () => decide(r.id, r.approvers[1]!, decision),
        new RegExp(`a decision is made only while its request is requested; this one is ${status}`),
      );
    }
    await agrees(r.id);
  }
  // The partial approval on the withdrawn request is still exactly there.
  const kept = await db().select().from(presentationApprovalApprovers)
    .where(eq(presentationApprovalApprovers.id, withdrawn.approvers[0]!));
  assert.equal(kept[0]!.decision, "approved");
  assert.ok(kept[0]!.decidedAt instanceof Date);
});

/* --------------------------------------------------------- the agreement */

test("at commit, a request's status is what its approvers' decisions say", async () => {
  const otherwise = /and its approvers say otherwise/;
  const two = async () =>
    ask({ workroomId: a.workroomId, revision: await publishAgain(a), identities: [a.ana.identityId, a.ben.identityId] });

  // approved while somebody has not decided
  let r = await two();
  await refused(() => decide(r.id, r.approvers[0]!, "approved", "approved"), /approved, and its approvers say otherwise \(1 of 2 approved/);
  // approved with nobody decided
  await refused(
    () => db().execute(sql`UPDATE presentation_approvals SET status = 'approved', closed_at = now() WHERE id = ${r.id}::uuid`),
    otherwise,
  );
  // changes_requested with nobody having asked
  await refused(() => decide(r.id, r.approvers[0]!, "approved", "changes_requested"), otherwise);
  // somebody asked for changes and the request was left requested
  await refused(() => decide(r.id, r.approvers[0]!, "changes_requested"), /requested, and its approvers say otherwise/);
  assert.deepEqual(await decisionsOf(r.id), [null, null], "a refused commit left a decision behind");

  // everybody approved and the request was left requested
  r = await ask({ workroomId: a.workroomId, revision: await publishAgain(a), identities: [a.ana.identityId] });
  await refused(() => decide(r.id, r.approvers[0]!, "approved"), /requested, and its approvers say otherwise \(1 of 1 approved/);

  // two requests for changes: the first one ends it, so a second never exists
  r = await two();
  await refused(
    () =>
      db().transaction(async (tx) => {
        await tx.execute(sql`UPDATE presentation_approval_approvers SET decision = 'changes_requested', decided_at = now()
                              WHERE presentation_approval_id = ${r.id}::uuid`);
        await tx.execute(sql`UPDATE presentation_approvals SET status = 'changes_requested', closed_at = now() WHERE id = ${r.id}::uuid`);
      }),
    /2 asked for changes/,
  );

  // the last approval and a withdrawal in one breath: it was approved, not withdrawn
  r = await ask({ workroomId: a.workroomId, revision: await publishAgain(a), identities: [a.ana.identityId] });
  await refused(
    () =>
      db().transaction(async (tx) => {
        await tx.execute(sql`UPDATE presentation_approval_approvers SET decision = 'approved', decided_at = now() WHERE id = ${r.approvers[0]!}::uuid`);
        await tx.execute(sql`UPDATE presentation_approvals SET status = 'withdrawn', closed_at = now(), closed_by_user_id = ${owner.id}
                              WHERE id = ${r.id}::uuid`);
      }),
    /withdrawn, and its approvers say otherwise/,
  );
  assert.equal(await statusOf(r.id), "requested");
});

test("partial approvals stay requested; the last approval approves", async () => {
  const r = await ask({ workroomId: a.workroomId, revision: await publishAgain(a), identities: [a.ana.identityId, a.ben.identityId, carl] });
  await decide(r.id, r.approvers[0]!, "approved");
  assert.equal(await statusOf(r.id), "requested");
  await decide(r.id, r.approvers[1]!, "approved");
  assert.equal(await statusOf(r.id), "requested");
  await agrees(r.id);
  await decide(r.id, r.approvers[2]!, "approved", "approved");
  assert.equal(await statusOf(r.id), "approved");
  assert.deepEqual(await decisionsOf(r.id), ["approved", "approved", "approved"]);
  await agrees(r.id);
});

test("one request for changes after some approvals ends it; the rest never decide", async () => {
  const r = await ask({ workroomId: a.workroomId, revision: await publishAgain(a), identities: [a.ana.identityId, a.ben.identityId, carl] });
  await decide(r.id, r.approvers[0]!, "approved");
  await decide(r.id, r.approvers[1]!, "changes_requested", "changes_requested");
  assert.equal(await statusOf(r.id), "changes_requested");
  assert.deepEqual(await decisionsOf(r.id), ["approved", "changes_requested", null]);
  await refused(() => decide(r.id, r.approvers[2]!, "approved"), /only while its request is requested/);
  await agrees(r.id);
});

/* -------------------------------------------------------------- Activity */

test("Activity knows approval.approved and approval.changes_requested, and approval.decided is gone", async () => {
  for (const kind of ["approval.requested", "approval.approved", "approval.changes_requested"]) {
    await db().execute(sql`
      INSERT INTO workroom_activity (id, workroom_id, kind, actor_label, subject)
      VALUES (${uuidv7()}::uuid, ${a.workroomId}::uuid, ${kind}, 'Ana', 'Brand Direction')
    `);
  }
  await refused(
    () =>
      db().execute(sql`
        INSERT INTO workroom_activity (id, workroom_id, kind) VALUES (${uuidv7()}::uuid, ${a.workroomId}::uuid, 'approval.decided')
      `),
    /workroom_activity_kind_check/,
  );
  assert.ok(!(ACTIVITY_KINDS as readonly string[]).includes("approval.decided"));
});

/* ------------------------------------------- schema.ts is the database */

type Catalog = { name: string; type: string; def: string };

async function constraintsOf(table: string): Promise<Catalog[]> {
  return (await db().execute(sql`
    SELECT conname AS name, contype AS type, pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE conrelid = ${table}::regclass ORDER BY conname
  `)) as unknown as Catalog[];
}

test("schema.ts declares exactly what PostgreSQL holds for both tables", async () => {
  for (const table of [presentationApprovals, presentationApprovalApprovers]) {
    const config = getTableConfig(table);
    const columns = (await db().execute(sql`
      SELECT column_name, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ${config.name} ORDER BY column_name
    `)) as unknown as Array<{ column_name: string; is_nullable: string; column_default: string | null }>;
    assert.deepEqual(
      columns.map((c) => c.column_name),
      config.columns.map((c) => c.name).sort(),
      `${config.name}: columns`,
    );
    for (const column of config.columns) {
      const found = columns.find((c) => c.column_name === column.name)!;
      assert.equal(found.is_nullable === "NO", column.notNull, `${config.name}.${column.name}: nullability`);
      assert.equal(found.column_default !== null, column.hasDefault, `${config.name}.${column.name}: default`);
    }

    const catalog = await constraintsOf(config.name);
    const ofType = (type: string) => catalog.filter((c) => c.type === type).map((c) => c.name).sort();
    // Inline `.references()` take drizzle's generated name; explicit ones their own.
    assert.deepEqual(
      ofType("f"),
      config.foreignKeys.map((fk) => fk.getName()).sort(),
      `${config.name}: foreign keys`,
    );
    assert.deepEqual(ofType("c"), config.checks.map((c) => c.name).sort(), `${config.name}: checks`);
    assert.deepEqual(
      ofType("u"),
      config.uniqueConstraints.map((u) => u.getName()).sort(),
      `${config.name}: unique constraints`,
    );

    const indexes = (await db().execute(sql`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = ${config.name}
    `)) as unknown as Array<{ indexname: string; indexdef: string }>;
    const constraintIndexes = new Set([`${config.name}_pkey`, ...ofType("u")]);
    assert.deepEqual(
      indexes.map((i) => i.indexname).filter((n) => !constraintIndexes.has(n)).sort(),
      config.indexes.map((i) => i.config.name).sort(),
      `${config.name}: indexes`,
    );
  }

  const standing = (await db().execute(sql`
    SELECT indexdef FROM pg_indexes WHERE indexname = 'presentation_approvals_one_standing_idx'
  `)) as unknown as Array<{ indexdef: string }>;
  assert.match(standing[0]!.indexdef, /^CREATE UNIQUE INDEX .* \(presentation_revision_id\) WHERE \(status <> 'withdrawn'::text\)$/);
});

test("the vocabularies in the database are exactly the module's", async () => {
  const listed = (def: string) => [...def.matchAll(/'([a-z_.]+)'::text/g)].map((m) => m[1]);
  const approvals = await constraintsOf("presentation_approvals");
  assert.deepEqual(
    listed(approvals.find((c) => c.name === "presentation_approvals_status_check")!.def),
    [...APPROVAL_STATUSES],
  );
  const approvers = await constraintsOf("presentation_approval_approvers");
  assert.deepEqual(
    listed(approvers.find((c) => c.name === "presentation_approval_approvers_decision_check")!.def),
    [...APPROVER_DECISIONS],
  );
  const activity = await constraintsOf("workroom_activity");
  assert.deepEqual(listed(activity.find((c) => c.name === "workroom_activity_kind_check")!.def), [...ACTIVITY_KINDS]);
});

test("the hand-written triggers are all in place", async () => {
  const triggers = (await db().execute(sql`
    SELECT c.relname AS table, t.tgname AS name, t.tgdeferrable AS deferrable, t.tginitdeferred AS deferred
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE NOT t.tgisinternal AND c.relname IN ('presentation_approvals', 'presentation_approval_approvers')
     ORDER BY 1, 2
  `)) as unknown as Array<{ table: string; name: string; deferrable: boolean; deferred: boolean }>;
  assert.deepEqual(
    triggers.map((t) => `${t.table}.${t.name}${t.deferred ? " (deferred)" : ""}`),
    [
      "presentation_approval_approvers.presentation_approval_approvers_guard_row",
      "presentation_approval_approvers.presentation_approval_approvers_no_truncate",
      "presentation_approval_approvers.presentation_approvals_agree_approver (deferred)",
      "presentation_approvals.presentation_approvals_agree_request (deferred)",
      "presentation_approvals.presentation_approvals_guard_row",
      "presentation_approvals.presentation_approvals_insert_row",
      "presentation_approvals.presentation_approvals_no_truncate",
    ],
  );
});
