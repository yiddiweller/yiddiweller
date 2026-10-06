import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { and, eq, sql } from "drizzle-orm";

import { closeDb, db } from "../lib/db/index.ts";
import { uuidv7 } from "../lib/db/id.ts";
import { addNoteItem, findPresentation, publishPresentation } from "../lib/db/presentations.ts";
import {
  closeReview,
  createReviewNote,
  editReviewNote,
  removeReviewNote,
  reopenReview,
  reopenReviewNote,
  replyToReviewNote,
  requestReview,
  resolveReviewNote,
  withdrawReview,
  type NotificationsRaised,
} from "../lib/db/reviews.ts";
import { setFileVisibility } from "../lib/db/files.ts";
import {
  auditEvents,
  clientIdentity,
  notificationDeliveries,
  presentationReviewNotes,
  presentationReviews,
  workroomActivity,
  workroomFiles,
  workroomMembers,
} from "../lib/db/schema.ts";
import { revokeMembership } from "../lib/db/workrooms.ts";
import { requestedDedupeKey } from "../lib/notifications/dedupe.ts";
import { clearOwner, file, owner, person, seedOwner, stage, staff, type Stage } from "./support/review-stage.ts";

/**
 * Stage G2: what the Review actions write into the outbox, against a real
 * PostgreSQL. Every row is written **inside the action's own transaction** —
 * proved by refusing the insert and watching the whole action vanish — and
 * only the two V1 events write anything: a request for feedback (a new round,
 * or a withdrawn one asked again) and a round's first root feedback note.
 *
 * Nothing here sends: no hook is passed, so the rows wait as the scheduled
 * dispatcher would find them. Sending is `notifications-dispatch.test.ts`.
 */

before(seedOwner);
beforeEach(async () => {
  await db().delete(notificationDeliveries);
});
after(async () => {
  await clearOwner();
  await closeDb();
});

/* ------------------------------------------------------------- helpers */

type Delivery = typeof notificationDeliveries.$inferSelect;

const deliveries = (reviewId?: string): Promise<Delivery[]> =>
  reviewId
    ? db().select().from(notificationDeliveries).where(eq(notificationDeliveries.presentationReviewId, reviewId))
    : db().select().from(notificationDeliveries);

const currentRevision = async (s: Stage) => (await findPresentation(s.presentationId))!.currentRevisionId!;
const presentationVersion = async (s: Stage) => (await findPresentation(s.presentationId))!.version;

async function publishNewer(s: Stage): Promise<void> {
  assert.ok((await addNoteItem(owner, s.presentationId, await presentationVersion(s), { caption: "More", body: "More." })).ok);
  assert.ok((await publishPresentation(owner, s.presentationId, await presentationVersion(s))).ok);
}

async function request(s: Stage, hook?: (raised: NotificationsRaised) => void) {
  const made = await requestReview(staff, await currentRevision(s), hook);
  assert.ok(made.ok, made.ok ? "" : made.message);
  return made.value;
}

/** A trigger that refuses every outbox insert — the enqueue failing, mid-transaction. */
async function refusingOutbox<T>(work: () => Promise<T>): Promise<T> {
  await db().execute(sql`
    CREATE OR REPLACE FUNCTION g2_test_refuse_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'g2 test: the outbox refused'; END $$`);
  await db().execute(sql`
    CREATE TRIGGER g2_test_refuse_outbox AFTER INSERT ON notification_deliveries
    FOR EACH ROW EXECUTE FUNCTION g2_test_refuse_outbox()`);
  try {
    return await work();
  } finally {
    await db().execute(sql`DROP TRIGGER IF EXISTS g2_test_refuse_outbox ON notification_deliveries`);
    await db().execute(sql`DROP FUNCTION IF EXISTS g2_test_refuse_outbox()`);
  }
}

/** Every line written to the console while `work` runs. */
async function logged<T>(work: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const level of ["log", "warn", "error"] as const) {
    console[level] = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  }
  try {
    return { value: await work(), lines };
  } finally {
    Object.assign(console, original);
  }
}

/* ------------------------------------------------------ review.requested */

test("A/B: a request writes one delivery per eligible member, each its own key and id", async () => {
  const s = await stage("WA");
  const made = await request(s);
  assert.equal(made.notified, 2);

  const rows = await deliveries(made.reviewId);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.clientIdentityId).sort(), [s.ana.identityId, s.ben.identityId].sort());
  for (const row of rows) {
    assert.equal(row.kind, "review.requested");
    assert.equal(row.recipientKind, "client");
    assert.equal(row.workroomId, s.workroomId);
    assert.equal(row.status, "pending");
    assert.equal(row.noteNumber, null);
    assert.equal(row.attempts, 0);
  }
  assert.notEqual(rows[0]!.dedupeKey, rows[1]!.dedupeKey);
  assert.notEqual(rows[0]!.id, rows[1]!.id);
});

test("C: nobody eligible — the round still opens, zero rows, and the answer says zero", async () => {
  const s = await stage("WC");
  for (const contactId of [s.ana.contactId, s.ben.contactId]) {
    const [member] = await db().select().from(workroomMembers).where(eq(workroomMembers.contactId, contactId));
    assert.ok((await revokeMembership(owner, member!.id, member!.version)).ok);
  }
  const made = await request(s);
  assert.equal(made.notified, 0);
  const [roundRow] = await db().select().from(presentationReviews).where(eq(presentationReviews.id, made.reviewId));
  assert.equal(roundRow!.status, "open");
  assert.equal((await deliveries()).length, 0);
});

test("D: a member revoked, or whose sign-in is off, before the request is not written for", async () => {
  const s = await stage("WD");
  const [ben] = await db().select().from(workroomMembers).where(eq(workroomMembers.contactId, s.ben.contactId));
  assert.ok((await revokeMembership(owner, ben!.id, ben!.version)).ok);
  const made = await request(s);
  assert.equal(made.notified, 1);
  assert.deepEqual((await deliveries(made.reviewId)).map((row) => row.clientIdentityId), [s.ana.identityId]);

  const t = await stage("WD2");
  await db().update(clientIdentity).set({ status: "inactive" }).where(eq(clientIdentity.id, t.ana.identityId));
  const second = await request(t);
  assert.deepEqual((await deliveries(second.reviewId)).map((row) => row.clientIdentityId), [t.ben.identityId]);
});

test("E: when the outbox refuses, the request rolls back whole — no round, no audit, no activity, no row", async () => {
  const s = await stage("WE");
  const revision = await currentRevision(s);
  const audits = (await db().select().from(auditEvents)).length;
  const activity = (await db().select().from(workroomActivity)).length;
  let called = false;

  await refusingOutbox(() =>
    assert.rejects(() => requestReview(staff, revision, () => (called = true)), /Failed query|outbox refused/),
  );

  assert.equal((await db().select().from(presentationReviews).where(eq(presentationReviews.presentationRevisionId, revision))).length, 0);
  assert.equal((await db().select().from(auditEvents)).length, audits);
  assert.equal((await db().select().from(workroomActivity)).length, activity);
  assert.equal((await deliveries()).length, 0);
  assert.equal(called, false, "the after-commit hook ran for a transaction that rolled back");

  // And with the outbox accepting again, the same request goes through.
  assert.equal((await request(s)).notified, 2);
});

test("F: a refused or repeated request writes nothing more", async () => {
  const s = await stage("WF");
  const made = await request(s);
  const again = await requestReview(staff, await currentRevision(s));
  assert.equal(again.ok, false);
  assert.equal((await deliveries()).length, 2, "an already-open round was announced twice");

  assert.ok((await closeReview(staff, made.reviewId)).ok);
  const refused = await requestReview(staff, await currentRevision(s));
  assert.equal(refused.ok, false);
  const reopenedTwice = await reopenReview(staff, made.reviewId, 1);
  assert.equal(reopenedTwice.ok, false, "a stale version reopened");
  assert.equal((await deliveries()).length, 2);
});

test("G: withdrawn then asked again is a new episode — new rows, new keys, the old ones untouched", async () => {
  const s = await stage("WG");
  const first = await request(s);
  const before = await deliveries(first.reviewId);
  await db().update(notificationDeliveries).set({ status: "suppressed", suppressedReason: "withdrawn", nextAttemptAt: null });

  assert.ok((await withdrawReview(staff, first.reviewId)).ok);
  assert.equal((await deliveries()).length, 2, "withdrawing wrote a delivery");

  const again = await request(s);
  assert.equal(again.reviewId, first.reviewId, "a second round was made");
  assert.equal(again.notified, 2);
  const after = await deliveries(first.reviewId);
  assert.equal(after.length, 4);
  const fresh = after.filter((row) => !before.some((old) => old.id === row.id));
  assert.equal(fresh.length, 2);
  for (const row of fresh) {
    assert.equal(row.status, "pending");
    assert.ok(!before.some((old) => old.dedupeKey === row.dedupeKey), "the new episode reused an old key");
  }
  for (const old of before) {
    const now = after.find((row) => row.id === old.id)!;
    assert.equal(now.status, "suppressed", "an old episode's row was resurrected");
  }

  // Reopening a withdrawal is asking again by the other door: one more episode.
  assert.ok((await withdrawReview(staff, first.reviewId)).ok);
  const reopened = await reopenReview(staff, first.reviewId);
  assert.ok(reopened.ok);
  assert.deepEqual(reopened.value, { asked: true, notified: 2 });
  assert.equal((await deliveries(first.reviewId)).length, 6);
});

test("H: an ordinary reopen after the studio closed it writes nothing", async () => {
  const s = await stage("WH");
  const made = await request(s);
  assert.ok((await closeReview(staff, made.reviewId)).ok);
  const reopened = await reopenReview(staff, made.reviewId);
  assert.ok(reopened.ok);
  assert.deepEqual(reopened.value, { asked: false, notified: 0 });
  assert.equal((await deliveries()).length, 2);
});

test("K: two Workrooms never cross recipient sets", async () => {
  const a = await stage("WKA");
  const b = await stage("WKB");
  const outsider = await person("WKO", null, "wko-outsider@example.com");
  const ra = await request(a);
  const rb = await request(b);
  const forA = (await deliveries(ra.reviewId)).map((row) => row.clientIdentityId).sort();
  const forB = (await deliveries(rb.reviewId)).map((row) => row.clientIdentityId).sort();
  assert.deepEqual(forA, [a.ana.identityId, a.ben.identityId].sort());
  assert.deepEqual(forB, [b.ana.identityId, b.ben.identityId].sort());
  assert.ok(!forA.includes(outsider.identityId) && !forB.includes(outsider.identityId));
  for (const row of await deliveries(ra.reviewId)) assert.equal(row.workroomId, a.workroomId);

  // And the database itself refuses a row pairing one Workroom with another's round.
  await assert.rejects(() =>
    db().insert(notificationDeliveries).values({
      id: uuidv7(),
      kind: "review.received",
      workroomId: a.workroomId,
      presentationReviewId: rb.reviewId,
      noteNumber: 1,
      recipientKind: "studio_inbox",
      dedupeKey: `test/cross/${uuidv7()}`,
    }),
  );
});

/* ------------------------------------------------- the episode timestamp */

test("the round's requested_at and every delivery's are the same instant, exactly — in every episode", async () => {
  const s = await stage("WT");
  const exact = async (reviewId: string) =>
    (await db().execute(sql`
      SELECT d.requested_at = r.requested_at AS same, extract(epoch FROM r.requested_at) AS episode
        FROM notification_deliveries d
        JOIN presentation_reviews r ON r.id = d.presentation_review_id
       WHERE d.presentation_review_id = ${reviewId} AND d.status = 'pending'
    `)) as unknown as Array<{ same: boolean; episode: string }>;

  const first = await request(s);
  const a = await exact(first.reviewId);
  assert.equal(a.length, 2);
  assert.ok(a.every((row) => row.same === true), "episode A: the delivery carries a different instant");
  const [roundA] = await db().select().from(presentationReviews).where(eq(presentationReviews.id, first.reviewId));
  const keyA = requestedDedupeKey({ reviewId: first.reviewId, requestedAt: roundA!.requestedAt, clientIdentityId: s.ana.identityId });
  assert.ok((await deliveries(first.reviewId)).some((row) => row.dedupeKey === keyA));

  await db().update(notificationDeliveries).set({ status: "suppressed", suppressedReason: "withdrawn", nextAttemptAt: null });
  assert.ok((await withdrawReview(staff, first.reviewId)).ok);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await request(s);
  const b = await exact(first.reviewId);
  assert.equal(b.length, 2);
  assert.ok(b.every((row) => row.same === true), "episode B: the delivery carries a different instant");
  assert.ok(Number(b[0]!.episode) > Number(a[0]!.episode), "episode B did not move on");
  const [roundB] = await db().select().from(presentationReviews).where(eq(presentationReviews.id, first.reviewId));
  const keyB = requestedDedupeKey({ reviewId: first.reviewId, requestedAt: roundB!.requestedAt, clientIdentityId: s.ana.identityId });
  assert.notEqual(keyB, keyA);
  assert.ok((await deliveries(first.reviewId)).some((row) => row.dedupeKey === keyB));

  // The reopen door too.
  await db().update(notificationDeliveries).set({ status: "suppressed", suppressedReason: "withdrawn", nextAttemptAt: null });
  assert.ok((await withdrawReview(staff, first.reviewId)).ok);
  assert.ok((await reopenReview(staff, first.reviewId)).ok);
  const c = await exact(first.reviewId);
  assert.equal(c.length, 2);
  assert.ok(c.every((row) => row.same === true), "reopen: the delivery carries a different instant");

  // And across many fresh rounds, so a second clock reading cannot pass by
  // landing in the same millisecond.
  for (let i = 0; i < 6; i++) {
    const t = await stage(`WT${i}`);
    const made = await request(t);
    const rows = await exact(made.reviewId);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.same === true), `round ${i}: a delivery carries a different instant`);
  }
});

/* ------------------------------------------------------- review.received */

test("A/B: the first root note writes one studio row, naming exactly that note", async () => {
  const s = await stage("WR");
  const made = await request(s);
  await db().delete(notificationDeliveries);

  const note = await createReviewNote(s.ana, { reviewId: made.reviewId, body: "MARKER-G2-BODY", itemPosition: 1, anchor: { kind: "point", x: 0.25, y: 0.75 } });
  assert.ok(note.ok);
  const rows = await deliveries(made.reviewId);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row!.kind, "review.received");
  assert.equal(row!.recipientKind, "studio_inbox");
  assert.equal(row!.clientIdentityId, null);
  assert.equal(row!.requestedAt, null);
  assert.equal(row!.noteNumber, note.value, "the delivery names a different note");
  assert.equal(row!.noteNumber, 1);

  // H/I: the row holds which, never what or where.
  const raw = JSON.stringify(row);
  assert.ok(!raw.includes("MARKER-G2-BODY"));
  assert.ok(!raw.includes("0.25") && !raw.includes("point"), "the anchor reached the row");
  assert.ok(!raw.includes("@"), "an address reached the row");
});

test("B: when the first note is not number 1 — a round whose first note came after a removed one — it is still the first root that is named", async () => {
  const s = await stage("WR2");
  const made = await request(s);
  await db().delete(notificationDeliveries);
  const first = await createReviewNote(s.ana, { reviewId: made.reviewId, body: "First." });
  assert.ok(first.ok);
  assert.equal((await deliveries(made.reviewId))[0]!.noteNumber, first.value);
  // Removing it never makes a later note the first.
  assert.ok((await removeReviewNote(s.ana, { reviewId: made.reviewId, number: first.value })).ok);
  const later = await createReviewNote(s.ben, { reviewId: made.reviewId, body: "Later." });
  assert.ok(later.ok);
  const rows = await deliveries(made.reviewId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.noteNumber, first.value);
});

test("C/D: later roots and every reply — client's and studio's — write nothing", async () => {
  const s = await stage("WS");
  const made = await request(s);
  await db().delete(notificationDeliveries);
  const first = await createReviewNote(s.ana, { reviewId: made.reviewId, body: "One." });
  assert.ok(first.ok);
  assert.ok((await createReviewNote(s.ben, { reviewId: made.reviewId, body: "Two." })).ok);
  assert.ok((await createReviewNote(s.ana, { reviewId: made.reviewId, body: "Three." })).ok);
  assert.ok((await replyToReviewNote(staff, { reviewId: made.reviewId, parentNumber: first.value, body: "Thanks." })).ok);
  assert.ok((await replyToReviewNote(s.ben, { reviewId: made.reviewId, parentNumber: first.value, body: "Agreed." })).ok);
  assert.equal((await deliveries()).length, 1);
});

test("E: when the outbox refuses, the first note rolls back with it", async () => {
  const s = await stage("WN");
  const made = await request(s);
  await db().delete(notificationDeliveries);
  await refusingOutbox(() => assert.rejects(() => createReviewNote(s.ana, { reviewId: made.reviewId, body: "Rolled back." })));
  assert.equal((await db().select().from(presentationReviewNotes).where(eq(presentationReviewNotes.presentationReviewId, made.reviewId))).length, 0);
  assert.equal((await deliveries()).length, 0);

  const note = await createReviewNote(s.ana, { reviewId: made.reviewId, body: "Kept." });
  assert.ok(note.ok);
  assert.equal(note.value, 1, "the rolled-back note spent an ordinal");
  assert.equal((await deliveries()).length, 1);
});

test("a refused note writes nothing: a stranger, a closed round, a staff actor", async () => {
  const s = await stage("WX");
  const made = await request(s);
  await db().delete(notificationDeliveries);
  const stranger = await person("WXS", null, "wxs-stranger@example.com");
  assert.equal((await createReviewNote(stranger, { reviewId: made.reviewId, body: "Hi." })).ok, false);
  assert.equal((await createReviewNote(staff as never, { reviewId: made.reviewId, body: "Hi." })).ok, false);
  assert.ok((await closeReview(staff, made.reviewId)).ok);
  assert.equal((await createReviewNote(s.ana, { reviewId: made.reviewId, body: "Hi." })).ok, false);
  assert.equal((await deliveries()).length, 0);
});

/* ------------------------------------------------ everything else is quiet */

test("resolve, reopen a note, edit, remove, close, reopen, withdraw, supersede, publish and share write nothing", async () => {
  const s = await stage("WQ");
  const made = await request(s);
  const note = await createReviewNote(s.ana, { reviewId: made.reviewId, body: "One." });
  assert.ok(note.ok);
  const second = await createReviewNote(s.ben, { reviewId: made.reviewId, body: "Two." });
  assert.ok(second.ok);
  const baseline = (await deliveries()).length;
  assert.equal(baseline, 3);

  const quiet = async (what: string, work: () => Promise<{ ok: boolean }>) => {
    const outcome = await work();
    assert.ok(outcome.ok, `${what} was refused`);
    assert.equal((await deliveries()).length, baseline, `${what} wrote a delivery`);
  };

  await quiet("edit", () => editReviewNote(s.ben, { reviewId: made.reviewId, number: second.value, body: "Two, corrected." }));
  await quiet("resolve", () => resolveReviewNote(staff, { reviewId: made.reviewId, number: note.value }));
  await quiet("reopen a note", () => reopenReviewNote(s.ana, { reviewId: made.reviewId, number: note.value }));
  await quiet("remove", () => removeReviewNote(s.ben, { reviewId: made.reviewId, number: second.value }));
  await quiet("close", () => closeReview(staff, made.reviewId));
  await quiet("reopen after close", () => reopenReview(staff, made.reviewId));

  const fresh = await file(s.workroomId, "Extra.png", "image/png");
  const [fileRow] = await db().select().from(workroomFiles).where(eq(workroomFiles.id, fresh));
  await quiet("share a file", () => setFileVisibility(owner, fresh, fileRow!.version, "shared"));
  await quiet("publish, superseding the open round", () => publishNewer(s).then(() => ({ ok: true })));
  const [superseded] = await db().select().from(presentationReviews).where(eq(presentationReviews.id, made.reviewId));
  assert.equal(superseded!.closedReason, "superseded");

  // Withdraw needs an empty round.
  const t = await stage("WQ2");
  const quietRound = await request(t);
  const before = (await deliveries()).length;
  assert.ok((await withdrawReview(staff, quietRound.reviewId)).ok);
  assert.equal((await deliveries()).length, before, "withdraw wrote a delivery");
});

/* ------------------------------------------------------- after commit */

test("notification.created is written after commit, with kind and count only — and the hook sees committed rows", async () => {
  const s = await stage("WL");
  let seen: NotificationsRaised | null = null;

  const { value: made, lines } = await logged(() => request(s, (raised) => (seen = raised)));
  assert.deepEqual(seen, { kind: "review.requested", count: 2 });
  const created = lines.filter((line) => line.includes("notification.created"));
  assert.equal(created.length, 1);
  const parsed = JSON.parse(created[0]!) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), ["at", "count", "event", "kind", "level"]);
  assert.equal(parsed.kind, "review.requested");
  assert.equal(parsed.count, 2);
  assert.equal((await deliveries(made.reviewId)).length, 2);

  // A refusal logs nothing and calls nothing.
  let called = false;
  const refused = await logged(() => requestReview(staff, uuidv7(), () => (called = true)));
  assert.equal(refused.value.ok, false);
  assert.equal(called, false);
  assert.ok(!refused.lines.some((line) => line.includes("notification.created")));

  // Zero recipients: no line, no hook.
  const t = await stage("WL2");
  for (const contactId of [t.ana.contactId, t.ben.contactId]) {
    const [member] = await db().select().from(workroomMembers).where(eq(workroomMembers.contactId, contactId));
    assert.ok((await revokeMembership(owner, member!.id, member!.version)).ok);
  }
  called = false;
  const none = await logged(() => request(t, () => (called = true)));
  assert.equal(none.value.notified, 0);
  assert.equal(called, false);
  assert.ok(!none.lines.some((line) => line.includes("notification.created")));
});

test("the hook runs only once the rows are committed, and a hook that throws never fails the action", async () => {
  const s = await stage("WM");
  const postgres = (await import("postgres")).default;
  const outside = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    let visible = -1;
    let pending: Promise<void> = Promise.resolve();
    const made = await requestReview(staff, await currentRevision(s), () => {
      pending = (async () => {
        const rows = await outside`SELECT count(*)::int AS n FROM notification_deliveries WHERE workroom_id = ${s.workroomId}`;
        visible = rows[0]!.n as number;
      })();
    });
    assert.ok(made.ok);
    await pending;
    assert.equal(visible, 2, "the hook ran before the rows were visible to anyone else");

    const note = await createReviewNote(s.ana, { reviewId: made.value.reviewId, body: "Hi." }, () => {
      throw new Error("a drain that blew up");
    });
    assert.ok(note.ok, "a throwing hook failed the action");
    assert.equal((await db().select().from(notificationDeliveries).where(and(eq(notificationDeliveries.workroomId, s.workroomId), eq(notificationDeliveries.kind, "review.received")))).length, 1);
  } finally {
    await outside.end();
  }
});
