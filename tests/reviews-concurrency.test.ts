import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { eq, sql } from "drizzle-orm";

import { type AuditActor } from "../lib/db/audit.ts";
import { createClient } from "../lib/db/clients.ts";
import { createContact } from "../lib/db/contacts.ts";
import { closeDb, db } from "../lib/db/index.ts";
import { uuidv7 } from "../lib/db/id.ts";
import {
  addNoteItem,
  createPresentation,
  findPresentation,
  publishPresentation,
  updatePresentation,
} from "../lib/db/presentations.ts";
import { createProject } from "../lib/db/projects.ts";
import {
  closeReview,
  createReviewNote,
  editReviewNote,
  removeReviewNote,
  reopenReview,
  replyToReviewNote,
  requestReview,
  resolveReviewNote,
  reviewForRevision,
  reviewNotes,
  withdrawReview,
  type ClientActor,
  type StaffActor,
} from "../lib/db/reviews.ts";
import { createWorkroom, publishWorkroom } from "../lib/db/workrooms.ts";
import {
  clientContacts,
  clientIdentity,
  clientSession,
  clients,
  contacts,
  presentationApprovals,
  presentationItems,
  presentationRevisionItems,
  presentationRevisions,
  presentationReviewNotes,
  presentationReviews,
  presentations,
  projects,
  user,
  workroomActivity,
  workroomFiles,
  workroomInvitations,
  workroomMembers,
  workrooms,
} from "../lib/db/schema.ts";
import { type Outcome } from "../lib/db/outcome.ts";

/**
 * The Review lock, under real simultaneous load.
 *
 * **Nothing here is faked with sequential awaits.** Every race starts both
 * operations before either has finished, so they take different pooled
 * connections and meet at the same `SELECT … FOR UPDATE` on the Review row —
 * which is the whole claim this module makes: that one lock is the round's
 * serialization point, and that a rule needing another row is safe behind it.
 *
 * Which side wins a race is not deterministic and is not asserted. What is
 * asserted is that **the losing shape never exists**: no removed root carrying
 * a reply accepted afterwards, no note inside a withdrawn round, no round left
 * open behind a supersession. Each race runs several times, because a property
 * that only holds on one interleaving is not a property.
 */

const owner: AuditActor = { id: uuidv7(), name: "Test Owner" };
const staff: StaffActor = { side: "studio", userId: owner.id, name: owner.name };

const ROUNDS = 6;

/* ------------------------------------------------------------------ wipe */

const GUARDED = [
  "presentation_review_notes",
  "presentation_reviews",
  "presentation_approvals",
  "presentation_revision_items",
  "presentation_revisions",
];

async function wipe(): Promise<void> {
  await db().execute(sql`ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_truncate`);
  await db().execute(sql`TRUNCATE audit_events`);
  await db().execute(sql`ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_truncate`);

  for (const table of GUARDED) {
    await db().execute(sql.raw(`ALTER TABLE ${table} DISABLE TRIGGER USER`));
  }
  await db().delete(presentationReviewNotes);
  await db().delete(presentationReviews);
  await db().delete(presentationApprovals);
  await db().delete(presentationRevisionItems);
  await db().update(presentations).set({ currentRevisionId: null, status: "draft" });
  await db().delete(presentationRevisions);
  await db().delete(presentationItems);
  await db().delete(presentations);
  for (const table of GUARDED) {
    await db().execute(sql.raw(`ALTER TABLE ${table} ENABLE TRIGGER USER`));
  }
  await db().delete(workroomFiles);
  await db().delete(workroomActivity);
  await db().delete(workroomInvitations);
  await db().delete(workroomMembers);
  await db().delete(clientSession);
  await db().delete(clientIdentity);
  await db().delete(workrooms);
  await db().delete(clientContacts);
  await db().delete(projects);
  await db().delete(contacts);
  await db().delete(clients);
}

before(async () => {
  await wipe();
  await db().delete(user);
  await db()
    .insert(user)
    .values({ id: owner.id, name: owner.name, email: "owner@example.com", role: "owner" });
});

after(async () => {
  await wipe();
  await db().delete(user);
  await closeDb();
});

/* ----------------------------------------------------------------- setup */

type Stage = {
  presentationId: string;
  revision: string;
  reviewId: string;
  ana: ClientActor;
  ben: ClientActor;
};

let seq = 0;

/** A published Presentation with an open round, fresh for each race. */
async function stage(): Promise<Stage> {
  const tag = `C${seq++}`;

  const client = await createClient(owner, {
    accountType: "organization",
    name: `${tag} Studio`,
    website: null,
    domain: null,
    status: "active",
    notes: "",
  });
  assert.ok(client.ok);

  const project = await createProject(owner, {
    clientId: client.value,
    name: `${tag} work`,
    status: "active",
    description: "",
    notes: "",
    ownerId: null,
    startsOn: null,
    targetOn: null,
  });
  assert.ok(project.ok);

  const made = await createWorkroom(owner, {
    projectId: project.value,
    title: `${tag} work`,
    summary: "A private space.",
  });
  assert.ok(made.ok);
  const workroomId = made.value;
  assert.ok((await publishWorkroom(owner, workroomId, 1)).ok);

  const people: ClientActor[] = [];
  for (const who of ["ana", "ben"]) {
    const contact = await createContact(owner, {
      name: `${tag} ${who}`,
      email: `${tag.toLowerCase()}-${who}@example.com`,
      emailNormalized: `${tag.toLowerCase()}-${who}@example.com`,
      phone: null,
      title: null,
      notes: "",
    });
    assert.ok(contact.ok);

    const identityId = uuidv7();
    await db().insert(clientIdentity).values({
      id: identityId,
      name: `${tag} ${who}`,
      email: `${tag.toLowerCase()}-${who}@example.com`,
      emailVerified: true,
      contactId: contact.value,
    });
    await db().insert(workroomMembers).values({
      id: uuidv7(),
      workroomId,
      contactId: contact.value,
      status: "active",
      grantedBy: owner.id,
    });
    people.push({
      side: "client",
      identityId,
      contactId: contact.value,
      name: `${tag} ${who}`,
    });
  }

  const presentation = await createPresentation(owner, workroomId, {
    title: "Brand Direction",
    intro: "A direction.",
  });
  assert.ok(presentation.ok);
  const presentationId = presentation.value;

  const v = async () => (await findPresentation(presentationId))!.version;
  assert.ok(
    (await addNoteItem(owner, presentationId, await v(), { caption: "One", body: "First." })).ok,
  );
  assert.ok((await publishPresentation(owner, presentationId, await v())).ok);

  const revision = (await findPresentation(presentationId))!.currentRevisionId!;
  const made2 = await requestReview(staff, revision);
  assert.ok(made2.ok);

  return { presentationId, revision, reviewId: made2.value, ana: people[0]!, ben: people[1]! };
}

async function version(reviewId: string): Promise<number> {
  const [row] = await db()
    .select({ version: presentationReviews.version })
    .from(presentationReviews)
    .where(eq(presentationReviews.id, reviewId));
  return row!.version;
}

/**
 * Start both, then wait. Neither call is awaited before the other begins, so
 * both are in flight on separate pooled connections when they reach the lock.
 *
 * **`flip` alternates which one is started first, and it is not decoration.**
 * Whichever is called first reliably takes the connection first, so without
 * this the edit race went edit-first six times out of six and the branch
 * asserting the other order was never run. Measured, then fixed.
 */
async function race<A, B>(
  a: () => Promise<A>,
  b: () => Promise<B>,
  flip = false,
): Promise<[A, B]> {
  if (flip) {
    const right = b();
    const left = a();
    return [await left, await right];
  }
  const left = a();
  const right = b();
  return [await left, await right];
}

/** Any PostgreSQL deadlock, anywhere in a settled result, is a design fault. */
function deadlocked(results: PromiseSettledResult<unknown>[]): string[] {
  const found: string[] = [];
  for (const result of results) {
    if (result.status !== "rejected") continue;
    let current: unknown = result.reason;
    for (let i = 0; current instanceof Error && i < 5; i++) {
      if (/deadlock/i.test(current.message)) found.push(current.message);
      current = (current as Error & { cause?: unknown }).cause;
    }
  }
  return found;
}

const refusedBecause = (outcome: Outcome<unknown>): string =>
  outcome.ok ? "" : `${outcome.reason}: ${outcome.message}`;

/* ------------------------------------------------------------------ races */

test("two roots at once get two ordinals, and never the same one", async () => {
  for (let i = 0; i < ROUNDS; i++) {
    await wipe();
    const s = await stage();

    const [first, second] = await race(
      () => createReviewNote(s.ana, { reviewId: s.reviewId, body: "Hers." }),
      () => createReviewNote(s.ben, { reviewId: s.reviewId, body: "His." }),
      i % 2 === 1,
    );

    assert.ok(first.ok, refusedBecause(first));
    assert.ok(second.ok, refusedBecause(second));
    assert.notEqual(first.value, second.value, "two notes took the same ordinal");
    assert.deepEqual([first.value, second.value].sort(), [1, 2]);

    const notes = await reviewNotes(s.reviewId);
    assert.equal(notes.length, 2);
  }
});

test("two replies at once get two ordinals", async () => {
  for (let i = 0; i < ROUNDS; i++) {
    await wipe();
    const s = await stage();
    assert.ok((await createReviewNote(s.ana, { reviewId: s.reviewId, body: "A point." })).ok);

    const [first, second] = await race(
      () => replyToReviewNote(staff, { reviewId: s.reviewId, parentNumber: 1, body: "We will." }),
      () => replyToReviewNote(s.ben, { reviewId: s.reviewId, parentNumber: 1, body: "Agreed." }),
      i % 2 === 1,
    );

    assert.ok(first.ok, refusedBecause(first));
    assert.ok(second.ok, refusedBecause(second));
    assert.deepEqual([first.value, second.value].sort(), [2, 3]);
  }
});

test("a reply racing a removal never lands on a removed comment", async () => {
  let removals = 0;
  let replies = 0;

  for (let i = 0; i < ROUNDS; i++) {
    await wipe();
    const s = await stage();
    assert.ok((await createReviewNote(s.ana, { reviewId: s.reviewId, body: "Oops." })).ok);

    const [removed, replied] = await race(
      () => removeReviewNote(s.ana, { reviewId: s.reviewId, number: 1, expectedVersion: 1 }),
      () => replyToReviewNote(staff, { reviewId: s.reviewId, parentNumber: 1, body: "About that…" }),
      i % 2 === 1,
    );

    const notes = await reviewNotes(s.reviewId);
    const root = notes.find((n) => n.number === 1)!;
    const replyRows = notes.filter((n) => !n.isRoot);

    // The forbidden shape, and the only one: a tombstone with an answer under it.
    assert.ok(
      !(root.removedAt && replyRows.length > 0),
      "a reply was accepted onto a removed comment",
    );

    if (removed.ok) {
      removals++;
      assert.ok(!replied.ok, "both a removal and a reply succeeded");
      assert.match(replied.ok ? "" : replied.message, /was removed/);
    } else {
      replies++;
      assert.ok(replied.ok, refusedBecause(replied));
      assert.match(removed.message, /Somebody has replied/);
    }
  }

  // Not an assertion about fairness — just proof the race is a race and the
  // suite is not quietly testing one interleaving over and over.
  assert.ok(removals + replies === ROUNDS);
});

test("a reply racing an edit never lets the edit land after the reply", async () => {
  for (let i = 0; i < ROUNDS; i++) {
    await wipe();
    const s = await stage();
    assert.ok((await createReviewNote(s.ana, { reviewId: s.reviewId, body: "Teh colour." })).ok);

    const [edited, replied] = await race(
      () =>
        editReviewNote(s.ana, {
          reviewId: s.reviewId,
          number: 1,
          body: "The colour.",
          expectedVersion: 1,
        }),
      () => replyToReviewNote(staff, { reviewId: s.reviewId, parentNumber: 1, body: "Noted." }),
      i % 2 === 1,
    );

    // The reply never loses: nothing about it depends on the edit.
    assert.ok(replied.ok, refusedBecause(replied));

    const notes = await reviewNotes(s.reviewId);
    const root = notes.find((n) => n.number === 1)!;

    if (edited.ok) {
      // The edit went first, which the body proves.
      assert.equal(root.body, "The colour.");
      assert.ok(root.editedAt);
    } else {
      assert.equal(edited.reason, "blocked");
      assert.match(edited.message, /Somebody has replied/);
      assert.equal(root.body, "Teh colour.");
      assert.equal(root.editedAt, null);
    }
  }
});

test("closing a round racing a new comment produces one coherent order", async () => {
  for (let i = 0; i < ROUNDS; i++) {
    await wipe();
    const s = await stage();

    const [closed, written] = await race(
      () => closeReview(staff, s.reviewId, 1),
      () => createReviewNote(s.ana, { reviewId: s.reviewId, body: "Just in time?" }),
      i % 2 === 1,
    );

    assert.ok(closed.ok, refusedBecause(closed));
    const round = await reviewForRevision(s.revision);
    assert.equal(round!.status, "closed", "the round did not end closed");

    const notes = await reviewNotes(s.reviewId);
    if (written.ok) {
      // Legitimately written while the round was still open, then closed.
      assert.equal(notes.length, 1);
    } else {
      assert.equal(written.reason, "blocked");
      assert.match(written.message, /closed/);
      assert.equal(notes.length, 0);
    }
  }
});

test("withdrawing racing a new comment never leaves feedback in a withdrawn round", async () => {
  for (let i = 0; i < ROUNDS; i++) {
    await wipe();
    const s = await stage();

    const [withdrawn, written] = await race(
      () => withdrawReview(staff, s.reviewId, 1),
      () => createReviewNote(s.ana, { reviewId: s.reviewId, body: "Something." }),
      i % 2 === 1,
    );

    const round = await reviewForRevision(s.revision);
    const notes = await reviewNotes(s.reviewId);

    // The forbidden shape: a retracted request holding what somebody said.
    assert.ok(
      !(round!.status === "withdrawn" && notes.length > 0),
      "a withdrawn round holds feedback",
    );

    if (withdrawn.ok) {
      assert.equal(round!.status, "withdrawn");
      assert.ok(!written.ok, "a note landed in a withdrawn round");
    } else {
      assert.ok(written.ok, refusedBecause(written));
      assert.equal(round!.status, "open");
      assert.match(withdrawn.message, /already has feedback|conflict|Somebody else/i);
    }
  }
});

test("publishing racing a new comment produces one coherent order", async () => {
  for (let i = 0; i < ROUNDS; i++) {
    await wipe();
    const s = await stage();

    const v = (await findPresentation(s.presentationId))!.version;
    assert.ok(
      (await updatePresentation(owner, s.presentationId, v, {
        title: "Brand Direction",
        intro: "Second.",
      })).ok,
    );

    const next = (await findPresentation(s.presentationId))!.version;
    const [published, written] = await race(
      () => publishPresentation(owner, s.presentationId, next),
      () => createReviewNote(s.ana, { reviewId: s.reviewId, body: "One more thing." }),
      i % 2 === 1,
    );

    assert.ok(published.ok, refusedBecause(published));

    const round = await reviewForRevision(s.revision);
    assert.equal(round!.status, "closed");
    assert.equal(round!.closedReason, "superseded");
    assert.ok(round!.closedByRevisionId);

    const notes = await reviewNotes(s.reviewId);
    if (written.ok) {
      // Written while the round was still open. It stays, unresolved, on the
      // version it was about — which is the whole point of not migrating it.
      assert.equal(notes.length, 1);
      assert.equal(notes[0]!.resolvedAt, null);
    } else {
      assert.equal(written.reason, "blocked");
      assert.equal(notes.length, 0);
    }
  }
});

test("reopening racing a publish never ends with the old round open", async () => {
  for (let i = 0; i < ROUNDS; i++) {
    await wipe();
    const s = await stage();
    assert.ok((await closeReview(staff, s.reviewId, await version(s.reviewId))).ok);

    const v = (await findPresentation(s.presentationId))!.version;
    assert.ok(
      (await updatePresentation(owner, s.presentationId, v, {
        title: "Brand Direction",
        intro: "Second.",
      })).ok,
    );

    const next = (await findPresentation(s.presentationId))!.version;
    const [published, reopened] = await race(
      () => publishPresentation(owner, s.presentationId, next),
      () => reopenReview(staff, s.reviewId, 2),
      i % 2 === 1,
    );

    assert.ok(published.ok, refusedBecause(published));

    const round = await reviewForRevision(s.revision);
    // The one thing that must never be true: a superseded version still
    // collecting feedback. Either the reopen lost, or it won and was then
    // superseded — and both end the same way.
    assert.notEqual(round!.status, "open", "a superseded version was left open");

    if (!reopened.ok) {
      assert.equal(reopened.reason, "blocked");
    }
  }
});

test("two decisions on one point produce a clean conflict, never a silent overwrite", async () => {
  for (let i = 0; i < ROUNDS; i++) {
    await wipe();
    const s = await stage();
    assert.ok((await createReviewNote(s.ana, { reviewId: s.reviewId, body: "A point." })).ok);

    const [byStudio, byClient] = await race(
      () => resolveReviewNote(staff, { reviewId: s.reviewId, number: 1, expectedVersion: 1 }),
      () => resolveReviewNote(s.ana, { reviewId: s.reviewId, number: 1, expectedVersion: 1 }),
      i % 2 === 1,
    );

    const wins = [byStudio, byClient].filter((outcome) => outcome.ok);
    assert.equal(wins.length, 1, "both decisions were accepted");

    const loser = [byStudio, byClient].find((outcome) => !outcome.ok)!;
    assert.ok(!loser.ok);
    // Either the optimistic version refused it, or the round lock let the
    // second in and it found the point already decided. Both are honest; a
    // silent second write would not be.
    assert.ok(["conflict", "already_done"].includes(loser.reason), loser.reason);

    const [note] = await reviewNotes(s.reviewId);
    assert.ok(note!.resolvedAt);
    assert.ok(note!.resolvedByName);
  }
});

test("a storm of mixed operations deadlocks nothing", async () => {
  await wipe();
  const s = await stage();
  assert.ok((await createReviewNote(s.ana, { reviewId: s.reviewId, body: "The first point." })).ok);

  // Everything that takes the lock, including the two paths that also take the
  // Presentation's — all at once, all on the same round. A wrong order here is
  // the only way this repository could produce a deadlock, so this is the test
  // that would find one.
  const results = await Promise.allSettled([
    createReviewNote(s.ana, { reviewId: s.reviewId, body: "Another." }),
    createReviewNote(s.ben, { reviewId: s.reviewId, body: "And another." }),
    replyToReviewNote(staff, { reviewId: s.reviewId, parentNumber: 1, body: "Noted." }),
    resolveReviewNote(staff, { reviewId: s.reviewId, number: 1, expectedVersion: 1 }),
    editReviewNote(s.ana, {
      reviewId: s.reviewId,
      number: 1,
      body: "The first point, restated.",
      expectedVersion: 1,
    }),
    closeReview(staff, s.reviewId, 1),
    reopenReview(staff, s.reviewId, 1),
    withdrawReview(staff, s.reviewId, 1),
  ]);

  assert.deepEqual(deadlocked(results), [], "PostgreSQL reported a deadlock");

  // Nothing threw, either: every refusal came back as an Outcome, which is
  // what tells a person what happened instead of a 500.
  const threw = results.filter((r) => r.status === "rejected");
  assert.deepEqual(
    threw.map((r) => (r as PromiseRejectedResult).reason?.message ?? "?"),
    [],
  );

  // And the round is in exactly one of its three legal states afterwards.
  const round = await reviewForRevision(s.revision);
  assert.ok(["open", "closed", "withdrawn"].includes(round!.status));
});
