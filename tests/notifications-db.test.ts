import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { closeDb, db } from "../lib/db/index.ts";
import { uuidv7 } from "../lib/db/id.ts";
import {
  claimDue,
  eligibleClientIdentityIds,
  enqueueDeliveries,
  failExhaustedClaims,
  findDeliveries,
  markFailed,
  markRetry,
  markSent,
  receivedFacts,
  requestedFacts,
  suppressDelivery,
} from "../lib/db/notifications.ts";
import { addNoteItem, findPresentation, publishPresentation } from "../lib/db/presentations.ts";
import {
  closeReview,
  createReviewNote,
  removeReviewNote,
  reopenReview,
  replyToReviewNote,
  requestReview,
  reviewForRevision,
  withdrawReview,
} from "../lib/db/reviews.ts";
import { clientIdentity, notificationDeliveries, presentationReviews, workroomMembers } from "../lib/db/schema.ts";
import { revokeMembership } from "../lib/db/workrooms.ts";
import { receivedIntents, requestedIntents } from "../lib/notifications/recipients.ts";
import { decideReceived, decideRequested, MAX_ATTEMPTS } from "../lib/notifications/rules.ts";
import { clearOwner, owner, person, round, seedOwner, stage, staff, type Stage } from "./support/review-stage.ts";

/**
 * Stage G1 against a real PostgreSQL: the delivery table's shape rules, its
 * cross-Workroom foreign key and dedupe key, the dispatcher's claim and
 * settle primitives — raced over separate connections — the dispatch-time
 * facts, and the proof that **no Review action writes a delivery yet**.
 */

const MINUTE = 60_000;
const NOW = new Date("2026-10-06T12:00:00.000Z");

let a: Stage;
let b: Stage;
let roundA = "";
let roundB = "";

before(async () => {
  await seedOwner();
  a = await stage("NA");
  b = await stage("NB");
  roundA = await round(a);
  roundB = await round(b);
});

beforeEach(async () => {
  await db().delete(notificationDeliveries);
});

after(async () => {
  await db().delete(notificationDeliveries);
  await clearOwner();
  await closeDb();
});

/* ------------------------------------------------------------- helpers */

let seq = 0;
const key = () => `test/${Date.now()}/${seq++}`;

type Row = typeof notificationDeliveries.$inferInsert;

/** A valid client delivery for round A, with whatever a test overrides. */
const clientRow = (over: Partial<Row> = {}): Row => ({
  id: uuidv7(),
  kind: "review.requested",
  workroomId: a.workroomId,
  presentationReviewId: roundA,
  requestedAt: NOW,
  recipientKind: "client",
  clientIdentityId: a.ana.identityId,
  dedupeKey: key(),
  ...over,
});

/** A valid studio-inbox delivery for round A. */
const inboxRow = (over: Partial<Row> = {}): Row => ({
  id: uuidv7(),
  kind: "review.received",
  workroomId: a.workroomId,
  presentationReviewId: roundA,
  noteNumber: 1,
  recipientKind: "studio_inbox",
  clientIdentityId: null,
  dedupeKey: key(),
  ...over,
});

/**
 * Asserts PostgreSQL refused the statement with exactly this constraint — or
 * one of these, where a row breaks two rules at once and PostgreSQL names the
 * first it checks.
 */
async function refusedBy(work: Promise<unknown>, constraint: string | string[]): Promise<void> {
  const names = ([] as string[]).concat(constraint);
  try {
    await work;
  } catch (error) {
    let cause: unknown = error;
    const seen: string[] = [];
    for (let depth = 0; cause && depth < 5; depth++) {
      const name = (cause as { constraint_name?: string }).constraint_name;
      if (name) seen.push(name);
      if (name && names.includes(name)) return;
      cause = (cause as { cause?: unknown }).cause;
    }
    assert.fail(`refused, but by ${seen.join(", ") || "no constraint"} rather than ${names.join(" or ")}`);
  }
  assert.fail(`accepted what ${names.join(" or ")} exists to refuse`);
}

const one = async (id: string) => (await findDeliveries([id]))[0]!;

/* ------------------------------------------------------------- the schema */

test("a client delivery and a studio-inbox delivery are each accepted in their own shape", async () => {
  const client = clientRow();
  const inbox = inboxRow();
  await db().insert(notificationDeliveries).values([client, inbox]);
  const rows = await findDeliveries([client.id!, inbox.id!]);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.status, "pending");
    assert.equal(row.attempts, 0);
    assert.ok(row.nextAttemptAt, "a new delivery is not due");
  }
});

test("a client delivery must name its client, and the studio inbox must name nobody", async () => {
  await refusedBy(db().insert(notificationDeliveries).values(clientRow({ clientIdentityId: null })), "notification_deliveries_recipient_shape_check");
  await refusedBy(
    db().insert(notificationDeliveries).values(inboxRow({ clientIdentityId: a.ana.identityId })),
    "notification_deliveries_recipient_shape_check",
  );
});

test("V1's two kinds, each with its own recipient and event fields — and nothing else", async () => {
  await refusedBy(db().insert(notificationDeliveries).values(clientRow({ kind: "review.replied" as never })), "notification_deliveries_kind_check");
  await refusedBy(
    db().insert(notificationDeliveries).values(clientRow({ recipientKind: "studio_inbox", clientIdentityId: null })),
    "notification_deliveries_kind_shape_check",
  );
  await refusedBy(db().insert(notificationDeliveries).values(clientRow({ requestedAt: null })), "notification_deliveries_kind_shape_check");
  await refusedBy(db().insert(notificationDeliveries).values(clientRow({ noteNumber: 1 })), "notification_deliveries_kind_shape_check");
  await refusedBy(db().insert(notificationDeliveries).values(inboxRow({ noteNumber: 0 })), "notification_deliveries_kind_shape_check");
  await refusedBy(db().insert(notificationDeliveries).values(inboxRow({ requestedAt: NOW })), "notification_deliveries_kind_shape_check");
  await refusedBy(db().insert(notificationDeliveries).values(clientRow({ recipientKind: "everyone" as never })), [
    "notification_deliveries_recipient_kind_check",
    "notification_deliveries_kind_shape_check",
  ]);
});

test("each status carries exactly its own evidence, and words come only from the vocabulary", async () => {
  const cases: Array<[Partial<Row>, string]> = [
    [{ status: "queued" as never }, "notification_deliveries_status_check"],
    [{ status: "pending", nextAttemptAt: null }, "notification_deliveries_status_shape_check"],
    [{ status: "pending", suppressedReason: "closed" }, "notification_deliveries_status_shape_check"],
    [{ status: "sending", attempts: 1 }, "notification_deliveries_status_shape_check"], // no claimed_at
    [{ status: "sent", attempts: 1 }, "notification_deliveries_status_shape_check"], // no sent_at
    [{ status: "sent", attempts: 1, sentAt: NOW, lastError: "network" }, "notification_deliveries_status_shape_check"],
    [{ status: "suppressed" }, "notification_deliveries_status_shape_check"], // no reason
    [{ status: "suppressed", suppressedReason: "because I said so" as never }, "notification_deliveries_suppressed_reason_check"],
    [{ status: "failed", attempts: 1 }, "notification_deliveries_status_shape_check"], // no error
    [{ status: "failed", attempts: 1, lastError: "422: to ana@example.com" as never }, "notification_deliveries_last_error_check"],
    [{ attempts: -1 }, "notification_deliveries_attempts_check"],
    [{ dedupeKey: "" }, "notification_deliveries_dedupe_key_check"],
  ];
  for (const [over, constraint] of cases) {
    await refusedBy(db().insert(notificationDeliveries).values(clientRow(over)), constraint);
  }
});

test("one row per event and recipient: a duplicate dedupe key is refused, and enqueue makes it a no-op", async () => {
  const dedupe = key();
  await db().insert(notificationDeliveries).values(clientRow({ dedupeKey: dedupe }));
  await refusedBy(db().insert(notificationDeliveries).values(clientRow({ dedupeKey: dedupe })), "notification_deliveries_dedupe_key");

  const intents = requestedIntents({
    workroomId: a.workroomId,
    reviewId: roundA,
    requestedAt: NOW,
    eligibleClientIdentityIds: [a.ana.identityId, a.ben.identityId],
    actor: { side: "studio", userId: staff.userId },
  });
  const first = await enqueueDeliveries(db(), intents);
  const again = await enqueueDeliveries(db(), intents);
  assert.equal(first.length, 2);
  assert.deepEqual(again, [], "the same event enqueued twice made more rows");
  const [{ count }] = (await db().execute(sql`SELECT count(*)::int AS count FROM notification_deliveries WHERE dedupe_key LIKE 'review.requested/%'`)) as unknown as [{ count: number }];
  assert.equal(count, 2);
});

test("enqueue commits or vanishes with its transaction", async () => {
  const intents = receivedIntents({ workroomId: a.workroomId, reviewId: roundA, noteNumber: 1, actor: { side: "client", identityId: a.ana.identityId } });
  await assert.rejects(
    db().transaction(async (tx) => {
      await enqueueDeliveries(tx, intents);
      throw new Error("the action failed");
    }),
  );
  assert.equal((await db().select().from(notificationDeliveries)).length, 0, "a delivery outlived its rolled-back action");
});

test("a delivery can never point at another Workroom's round", async () => {
  await refusedBy(
    db().insert(notificationDeliveries).values(clientRow({ workroomId: b.workroomId, presentationReviewId: roundA })),
    "notification_deliveries_review_fk",
  );
  await refusedBy(
    db().insert(notificationDeliveries).values(inboxRow({ workroomId: a.workroomId, presentationReviewId: roundB })),
    "notification_deliveries_review_fk",
  );
});

test("deliveries hold their references: an identity they name cannot be deleted from under them", async () => {
  // Somebody named by nothing but this delivery, so the refusal can only be its.
  const lone = await person("NL", null, `nl-lone-${Date.now()}@example.test`);
  const row = clientRow({ clientIdentityId: lone.identityId });
  await db().insert(notificationDeliveries).values(row);
  await refusedBy(
    db().delete(clientIdentity).where(eq(clientIdentity.id, lone.identityId)),
    "notification_deliveries_client_identity_fk",
  );
  // Operational rows themselves may go.
  await db().delete(notificationDeliveries).where(eq(notificationDeliveries.id, row.id!));
  assert.equal((await findDeliveries([row.id!])).length, 0);
});

test("a row stores intent and state only — no address, subject, body, title, name or URL", async () => {
  const columns = (await db().execute(sql`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'notification_deliveries' ORDER BY column_name
  `)) as unknown as Array<{ column_name: string }>;
  const names = columns.map((c) => c.column_name);
  assert.deepEqual(names, [
    "attempts", "claimed_at", "client_identity_id", "created_at", "dedupe_key", "id", "kind", "last_error",
    "next_attempt_at", "note_number", "presentation_review_id", "provider_message_id", "recipient_kind",
    "requested_at", "sent_at", "status", "suppressed_reason", "workroom_id",
  ]);
  for (const name of names) assert.doesNotMatch(name, /email|address|subject|html|text|body|title|name|url|anchor/);
});

/* ------------------------------------------------------------- claiming */

async function seed(over: Partial<Row>): Promise<string> {
  const row = clientRow(over);
  await db().insert(notificationDeliveries).values(row);
  return row.id!;
}

test("only a pending, due row is claimed — never a future, sent, suppressed or failed one", async () => {
  const due = await seed({ nextAttemptAt: new Date(NOW.getTime() - MINUTE) });
  await seed({ nextAttemptAt: new Date(NOW.getTime() + MINUTE) });
  await seed({ status: "sent", attempts: 1, sentAt: NOW, nextAttemptAt: null });
  await seed({ status: "suppressed", suppressedReason: "closed", nextAttemptAt: null });
  await seed({ status: "failed", attempts: 6, lastError: "network", nextAttemptAt: null });

  const claimed = await claimDue({ now: NOW, limit: 10 });
  assert.deepEqual(claimed.map((c) => c.id), [due]);
  assert.equal(claimed[0]!.attempts, 1);
  const row = await one(due);
  assert.equal(row.status, "sending");
  assert.equal(row.claimedAt!.getTime(), NOW.getTime());
  // Committed before it returned: another connection already sees the claim.
  assert.deepEqual(await claimDue({ now: NOW }), [], "a claimed row was claimed twice");
});

test("an abandoned claim is recoverable after ten minutes, and not one moment before", async () => {
  const id = await seed({ nextAttemptAt: NOW });
  const first = await claimDue({ now: NOW });
  assert.equal(first.length, 1);

  assert.deepEqual(await claimDue({ now: new Date(NOW.getTime() + 9 * MINUTE) }), [], "a live claim was taken over");
  const second = await claimDue({ now: new Date(NOW.getTime() + 10 * MINUTE) });
  assert.deepEqual(second.map((c) => c.id), [id]);
  assert.equal(second[0]!.attempts, 2);

  // The first claimer, back from the dead, can settle nothing.
  assert.equal(await markSent({ id, attempts: 1 }, "re_late"), false);
  assert.equal(await markSent({ id, attempts: 2 }, "re_ok", NOW), true);
  const row = await one(id);
  assert.equal(row.status, "sent");
  assert.equal(row.providerMessageId, "re_ok");
});

test("an abandoned claim with no attempts left is failed, not retried a seventh time", async () => {
  const id = await seed({ status: "sending", attempts: MAX_ATTEMPTS, claimedAt: NOW, nextAttemptAt: null });
  const later = new Date(NOW.getTime() + 11 * MINUTE);
  assert.deepEqual(await claimDue({ now: later }), []);
  assert.equal(await failExhaustedClaims(later), 1);
  const row = await one(id);
  assert.equal(row.status, "failed");
  assert.equal(row.lastError, "unknown");
});

test("settling: retry, fail and suppress each need the live claim, and leave the right state", async () => {
  const retry = await seed({ nextAttemptAt: NOW });
  const fail = await seed({ nextAttemptAt: NOW });
  const quiet = await seed({ nextAttemptAt: NOW });
  const pending = await seed({ nextAttemptAt: new Date(NOW.getTime() + 60 * MINUTE) });
  const claims = await claimDue({ now: NOW, limit: 10 });
  const claim = (id: string) => ({ id, attempts: claims.find((c) => c.id === id)!.attempts });

  const retryAt = new Date(NOW.getTime() + 5 * MINUTE);
  assert.equal(await markRetry({ id: retry, attempts: 99 }, "network", retryAt), false, "a wrong claim settled a row");
  assert.equal(await markRetry(claim(retry), "network", retryAt), true);
  const retried = await one(retry);
  assert.equal(retried.status, "pending");
  assert.equal(retried.nextAttemptAt!.getTime(), retryAt.getTime());
  assert.equal(retried.lastError, "network");
  assert.equal(retried.claimedAt, null);

  assert.equal(await markFailed(claim(fail), "invalid_from_address"), true);
  assert.equal((await one(fail)).status, "failed");

  assert.equal(await suppressDelivery({ id: quiet }, "closed"), false, "a claimed row was suppressed without its claim");
  assert.equal(await suppressDelivery(claim(quiet), "closed"), true);
  assert.equal((await one(quiet)).suppressedReason, "closed");

  assert.equal(await suppressDelivery({ id: pending }, "withdrawn"), true, "a pending row could not be suppressed");
  assert.equal((await one(pending)).status, "suppressed");
  assert.equal(await markSent(claim(fail), "re_x"), false, "a terminal row was settled again");
});

/** Independent connections, each its own dispatcher. A statement that waits on a lock gives up rather than hangs. */
async function withDispatchers(count: number, work: (clients: ReturnType<typeof postgres>[], dispatchers: ReturnType<typeof drizzle>[]) => Promise<void>) {
  const url = process.env.DATABASE_URL!;
  const clients = Array.from({ length: count }, () =>
    postgres(url, { max: 1, onnotice: () => {}, connection: { statement_timeout: 5000 } }),
  );
  try {
    await work(clients, clients.map((client) => drizzle(client)));
  } finally {
    await Promise.all(clients.map((client) => client.end({ timeout: 5 })));
  }
}

test("a row another dispatcher holds is skipped, not waited on", async () => {
  await withDispatchers(2, async ([blocker], [, dispatcher]) => {
    const held = await seed({ nextAttemptAt: NOW });
    await blocker!.begin(async (tx) => {
      await tx`SELECT id FROM notification_deliveries WHERE id = ${held} FOR UPDATE`;
      assert.deepEqual(await claimDue({ now: NOW }, dispatcher!), [], "a locked row was claimed");
    });
    assert.deepEqual((await claimDue({ now: NOW }, dispatcher!)).map((c) => c.id), [held]);
  });
});

test("dispatchers racing over separate connections never own the same row", async () => {
  await withDispatchers(4, async (_clients, dispatchers) => {
    const ids = new Set<string>();
    for (let i = 0; i < 60; i++) ids.add(await seed({ nextAttemptAt: NOW }));
    const owned: string[] = [];
    await Promise.all(
      dispatchers.map(async (dispatcher) => {
        for (let round = 0; round < 40; round++) {
          const batch = await claimDue({ now: NOW, limit: 7 }, dispatcher);
          if (batch.length === 0) return;
          owned.push(...batch.map((c) => c.id));
        }
      }),
    );
    assert.equal(owned.length, ids.size, "a row was claimed twice, or not at all");
    assert.deepEqual(new Set(owned), ids);
    const attempts = (await findDeliveries([...ids])).map((row) => row.attempts);
    assert.ok(attempts.every((n) => n === 1), "a row was claimed by two dispatchers");
  });
});

/* ------------------------------------------------- recipients and facts */

test("eligible recipients are the active members with active identities of a live, open round", async () => {
  const s = await stage("NE");
  const r = await round(s);
  assert.deepEqual(await eligibleClientIdentityIds(r), [s.ana.identityId, s.ben.identityId].sort());

  const [ben] = await db().select().from(workroomMembers).where(eq(workroomMembers.contactId, s.ben.contactId));
  assert.ok((await revokeMembership(owner, ben!.id, ben!.version)).ok);
  assert.deepEqual(await eligibleClientIdentityIds(r), [s.ana.identityId]);

  await db().update(clientIdentity).set({ status: "inactive" }).where(eq(clientIdentity.id, s.ana.identityId));
  assert.deepEqual(await eligibleClientIdentityIds(r), []);
  await db().update(clientIdentity).set({ status: "active" }).where(eq(clientIdentity.id, s.ana.identityId));

  assert.ok((await closeReview(staff, r)).ok);
  assert.deepEqual(await eligibleClientIdentityIds(r), [], "a closed round still has someone to ask");
});

test("a pending request is suppressed once it no longer stands: revoked, withdrawn, asked again, superseded", async () => {
  const s = await stage("NF");
  const r = await round(s);
  const [roundRow] = await db().select().from(presentationReviews).where(eq(presentationReviews.id, r));
  const enqueue = async (identityId: string) =>
    (
      await enqueueDeliveries(
        db(),
        requestedIntents({
          workroomId: s.workroomId,
          reviewId: r,
          requestedAt: roundRow!.requestedAt,
          eligibleClientIdentityIds: [identityId],
          actor: { side: "studio", userId: staff.userId },
        }),
      )
    )[0]!;
  const forAna = await enqueue(s.ana.identityId);
  const forBen = await enqueue(s.ben.identityId);

  assert.deepEqual(decideRequested((await requestedFacts(forAna))!), { send: true }, "a standing request was suppressed");

  const [ben] = await db().select().from(workroomMembers).where(eq(workroomMembers.contactId, s.ben.contactId));
  assert.ok((await revokeMembership(owner, ben!.id, ben!.version)).ok);
  assert.deepEqual(decideRequested((await requestedFacts(forBen))!), { send: false, reason: "membership_revoked" });

  assert.ok((await withdrawReview(staff, r)).ok);
  assert.deepEqual(decideRequested((await requestedFacts(forAna))!), { send: false, reason: "withdrawn" });

  // Asked again: the round is open, but this delivery belongs to the old episode.
  assert.ok((await requestReview(staff, roundRow!.presentationRevisionId)).ok);
  const facts = (await requestedFacts(forAna))!;
  assert.equal(facts.reviewStatus, "open");
  assert.equal(facts.episodeIsCurrent, false);
  assert.deepEqual(decideRequested(facts), { send: false, reason: "withdrawn" }, "the old episode would have sent beside the new one");

  // The new episode's own delivery stands — until a newer version is published.
  const [reasked] = await db().select().from(presentationReviews).where(eq(presentationReviews.id, r));
  const [current] = await enqueueDeliveries(
    db(),
    requestedIntents({
      workroomId: s.workroomId,
      reviewId: r,
      requestedAt: reasked!.requestedAt,
      eligibleClientIdentityIds: [s.ana.identityId],
      actor: { side: "studio", userId: staff.userId },
    }),
  );
  assert.ok(current, "a new episode was deduplicated against the old one");
  assert.deepEqual(decideRequested((await requestedFacts(current))!), { send: true });

  const v = async () => (await findPresentation(s.presentationId))!.version;
  assert.ok((await addNoteItem(owner, s.presentationId, await v(), { caption: "Two", body: "More." })).ok);
  assert.ok((await publishPresentation(owner, s.presentationId, await v())).ok);
  assert.deepEqual(decideRequested((await requestedFacts(current))!), { send: false, reason: "superseded" });
});

test("the episode is compared at the precision of the key, so a request is always its own episode", async () => {
  const s = await stage("NG");
  const r = await round(s); // requested_at from now(): microseconds a Date cannot hold
  const [roundRow] = await db().select().from(presentationReviews).where(eq(presentationReviews.id, r));
  const [id] = await enqueueDeliveries(
    db(),
    requestedIntents({
      workroomId: s.workroomId,
      reviewId: r,
      requestedAt: roundRow!.requestedAt,
      eligibleClientIdentityIds: [s.ana.identityId],
      actor: { side: "studio", userId: staff.userId },
    }),
  );
  assert.equal((await requestedFacts(id!))!.episodeIsCurrent, true);
});

test("feedback is still announced after supersession, and not once it was taken back with nothing left", async () => {
  const s = await stage("NH");
  const r = await round(s);
  const n = await createReviewNote(s.ana, { reviewId: r, body: "MARKER-FEEDBACK-BODY", itemPosition: 1 });
  assert.ok(n.ok);
  const [id] = await enqueueDeliveries(
    db(),
    receivedIntents({ workroomId: s.workroomId, reviewId: r, noteNumber: n.value, actor: { side: "client", identityId: s.ana.identityId } }),
  );
  assert.deepEqual(decideReceived((await receivedFacts(id!))!), { send: true });

  assert.ok((await removeReviewNote(s.ana, { reviewId: r, number: n.value })).ok);
  assert.deepEqual(decideReceived((await receivedFacts(id!))!), { send: false, reason: "retracted" });

  // Another live note in the round keeps it worth telling.
  const second = await createReviewNote(s.ben, { reviewId: r, body: "Another thought." });
  assert.ok(second.ok);
  assert.deepEqual(decideReceived((await receivedFacts(id!))!), { send: true });

  // And a newer version does not stop it: feedback on Version N is still feedback.
  const v = async () => (await findPresentation(s.presentationId))!.version;
  assert.ok((await addNoteItem(owner, s.presentationId, await v(), { caption: "Two", body: "More." })).ok);
  assert.ok((await publishPresentation(owner, s.presentationId, await v())).ok);
  assert.equal((await reviewForRevision((await db().select().from(presentationReviews).where(eq(presentationReviews.id, r)))[0]!.presentationRevisionId))!.status, "closed");
  assert.deepEqual(decideReceived((await receivedFacts(id!))!), { send: true });
});

/* ----------------------------------------------------------- not wired */

test("no Review action writes a delivery yet: request, re-request, reopen, feedback, reply, publish", async () => {
  await db().delete(notificationDeliveries);
  const s = await stage("NW");
  const r = await round(s); // requestReview
  const note = await createReviewNote(s.ana, { reviewId: r, body: "First thought." });
  assert.ok(note.ok);
  assert.ok((await replyToReviewNote(staff, { reviewId: r, parentNumber: note.value, body: "Thank you." })).ok);
  assert.ok((await replyToReviewNote(s.ben, { reviewId: r, parentNumber: note.value, body: "Agreed." })).ok);
  assert.ok((await closeReview(staff, r)).ok);
  assert.ok((await reopenReview(staff, r)).ok);

  const s2 = await stage("NX");
  const r2 = await round(s2);
  const [row] = await db().select().from(presentationReviews).where(eq(presentationReviews.id, r2));
  assert.ok((await withdrawReview(staff, r2)).ok);
  assert.ok((await requestReview(staff, row!.presentationRevisionId)).ok); // openReuse
  assert.ok((await withdrawReview(staff, r2)).ok);
  assert.ok((await reopenReview(staff, r2)).ok); // reopen after withdrawal

  const v = async () => (await findPresentation(s.presentationId))!.version;
  assert.ok((await addNoteItem(owner, s.presentationId, await v(), { caption: "Two", body: "More." })).ok);
  assert.ok((await publishPresentation(owner, s.presentationId, await v())).ok);

  assert.equal((await db().select().from(notificationDeliveries)).length, 0, "a Review action wrote a delivery in G1");
});

test("nothing in a product path reaches the outbox, the dispatcher's primitives or a transport", () => {
  const strip = (file: string) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const files = ["app", "components", "lib", "middleware.ts", "scripts"].flatMap(sources);
  const reaching = files
    .filter((file) => !file.startsWith("lib/notifications/") && file !== "lib/db/notifications.ts" && file !== "lib/db/schema.ts")
    .filter((file) => /db\/notifications|notifications\/(recipients|render|transport|resend-transport|log|dedupe|rules|mode)|notificationDeliveries/.test(strip(file)));
  assert.deepEqual(reaching, [], "a product path reaches Stage G delivery");
});

function sources(root: string): string[] {
  if (statSync(root).isFile()) return [root];
  return readdirSync(root).flatMap((name) => {
    const path = `${root}/${name}`;
    if (name === "node_modules" || name.startsWith(".")) return [];
    return statSync(path).isDirectory() ? sources(path) : /\.(ts|tsx|mjs|js)$/.test(name) ? [path] : [];
  });
}
