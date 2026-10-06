import { and, eq, inArray, sql } from "drizzle-orm";

import { ABANDONED_CLAIM_MS, MAX_ATTEMPTS } from "../notifications/rules.ts";
import type { DeliveryIntent } from "../notifications/recipients.ts";
import type { ReceivedFacts, RequestedFacts } from "../notifications/rules.ts";
import type {
  DeliveryError,
  NotificationKind,
  RecipientKind,
  SuppressionReason,
} from "../notifications/vocabulary.ts";
import { db, type Tx } from "./index.ts";
import { uuidv7 } from "./id.ts";
import { notificationDeliveries } from "./schema.ts";

/**
 * Stage G's outbox, and the primitives its dispatcher will use (G1).
 *
 * **Nothing calls these from a product path yet.** G2 wires `enqueue` into the
 * Review actions' own transactions and builds the dispatcher on the rest; G3
 * schedules it. Until then the table stays empty and nothing is sent.
 *
 * The rules a dispatcher must keep, and that these make hard to break:
 *
 * - **Enqueue inside the domain transaction.** `enqueueDeliveries` takes the
 *   caller's `Tx`, so the action and its notification commit or vanish
 *   together — never an email about something that rolled back. The unique
 *   `dedupe_key` and `ON CONFLICT DO NOTHING` make a repeated event one row.
 * - **Claim, commit, then talk to the provider.** `claimDue` is one statement:
 *   it locks due rows with `FOR UPDATE SKIP LOCKED`, marks them `sending` and
 *   commits before it returns, so no lock is ever held across a network call
 *   and two dispatchers never own one row.
 * - **Only the owner of a claim may settle it.** A claim is the row's id and
 *   the attempt number the claim gave it; every `mark…` requires both, so a
 *   dispatcher whose abandoned claim was taken over cannot overwrite the
 *   newer attempt's outcome.
 * - **An abandoned claim is recoverable** after `ABANDONED_CLAIM_MS`, and the
 *   provider's idempotency key — the row's own id — makes the re-send the same
 *   request rather than a second email.
 */

/** Anything that can run a statement: the pool, a transaction, or a test's own connection. */
type Executor = { execute: ReturnType<typeof db>["execute"] };
type Writer = ReturnType<typeof db> | Tx;

/* --------------------------------------------------------------- enqueue */

/**
 * The rows an event raises, written by the transaction that raised it. Returns
 * the ids actually inserted — an event already enqueued inserts nothing.
 */
export async function enqueueDeliveries(on: Writer, intents: DeliveryIntent[]): Promise<string[]> {
  if (intents.length === 0) return [];
  const rows = await on
    .insert(notificationDeliveries)
    .values(intents.map((intent) => ({ id: uuidv7(), ...intent })))
    .onConflictDoNothing({ target: notificationDeliveries.dedupeKey })
    .returning({ id: notificationDeliveries.id });
  return rows.map((row) => row.id);
}

/* ----------------------------------------------------------------- claim */

export type ClaimedDelivery = {
  id: string;
  kind: NotificationKind;
  workroomId: string;
  presentationReviewId: string;
  requestedAt: Date | null;
  noteNumber: number | null;
  recipientKind: RecipientKind;
  clientIdentityId: string | null;
  /** This claim's attempt number — with the id, what proves the claim is still yours. */
  attempts: number;
};

export type Claim = { id: string; attempts: number };

/**
 * Takes up to `limit` deliveries that are due — pending and past their
 * `next_attempt_at`, or `sending` but abandoned for longer than
 * `ABANDONED_CLAIM_MS` with attempts still left — and marks them `sending`,
 * one attempt further on. **One statement, committed before it returns.**
 *
 * `FOR UPDATE SKIP LOCKED` keeps two concurrent dispatchers off each other's
 * rows, and PostgreSQL re-checks a locked row against the conditions once it
 * has it, so a row another dispatcher has just claimed no longer qualifies.
 */
export async function claimDue(
  options: { now?: Date; limit?: number } = {},
  on: Executor = db(),
): Promise<ClaimedDelivery[]> {
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(100, options.limit ?? 10));
  const abandonedBefore = new Date(now.getTime() - ABANDONED_CLAIM_MS);

  const rows = (await on.execute(sql`
    UPDATE notification_deliveries AS d
       SET status = 'sending', claimed_at = ${now.toISOString()}::timestamptz, attempts = d.attempts + 1
     WHERE d.id IN (
       SELECT id FROM notification_deliveries
        WHERE (status = 'pending' AND next_attempt_at <= ${now.toISOString()}::timestamptz)
           OR (status = 'sending' AND claimed_at <= ${abandonedBefore.toISOString()}::timestamptz AND attempts < ${MAX_ATTEMPTS})
        ORDER BY created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING d.id, d.kind, d.workroom_id, d.presentation_review_id, d.requested_at,
              d.note_number, d.recipient_kind, d.client_identity_id, d.attempts
  `)) as unknown as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id),
    kind: row.kind as NotificationKind,
    workroomId: String(row.workroom_id),
    presentationReviewId: String(row.presentation_review_id),
    requestedAt: row.requested_at ? new Date(row.requested_at as string | Date) : null,
    noteNumber: row.note_number === null ? null : Number(row.note_number),
    recipientKind: row.recipient_kind as RecipientKind,
    clientIdentityId: row.client_identity_id === null ? null : String(row.client_identity_id),
    attempts: Number(row.attempts),
  }));
}

/* ---------------------------------------------------------------- settle */

const owned = (claim: Claim) =>
  and(
    eq(notificationDeliveries.id, claim.id),
    eq(notificationDeliveries.status, "sending"),
    eq(notificationDeliveries.attempts, claim.attempts),
  );

/** The provider accepted it. Terminal. */
export async function markSent(claim: Claim, providerMessageId: string | null, now: Date = new Date()): Promise<boolean> {
  const rows = await db()
    .update(notificationDeliveries)
    .set({
      status: "sent",
      sentAt: now,
      providerMessageId,
      claimedAt: null,
      nextAttemptAt: null,
      lastError: null,
    })
    .where(owned(claim))
    .returning({ id: notificationDeliveries.id });
  return rows.length === 1;
}

/** It failed in a way worth trying again, at `retryAt` — see `afterFailure`. */
export async function markRetry(claim: Claim, error: DeliveryError, retryAt: Date): Promise<boolean> {
  const rows = await db()
    .update(notificationDeliveries)
    .set({ status: "pending", nextAttemptAt: retryAt, lastError: error, claimedAt: null })
    .where(owned(claim))
    .returning({ id: notificationDeliveries.id });
  return rows.length === 1;
}

/** It failed for good. Terminal. */
export async function markFailed(claim: Claim, error: DeliveryError): Promise<boolean> {
  const rows = await db()
    .update(notificationDeliveries)
    .set({ status: "failed", lastError: error, claimedAt: null, nextAttemptAt: null })
    .where(owned(claim))
    .returning({ id: notificationDeliveries.id });
  return rows.length === 1;
}

/**
 * Decided against, for one reason. A claimed row needs its claim; a pending
 * one can be suppressed without being claimed. Terminal either way.
 */
export async function suppressDelivery(target: Claim | { id: string }, reason: SuppressionReason): Promise<boolean> {
  const where =
    "attempts" in target
      ? owned(target)
      : and(eq(notificationDeliveries.id, target.id), eq(notificationDeliveries.status, "pending"));
  const rows = await db()
    .update(notificationDeliveries)
    .set({ status: "suppressed", suppressedReason: reason, claimedAt: null, nextAttemptAt: null })
    .where(where)
    .returning({ id: notificationDeliveries.id });
  return rows.length === 1;
}

/**
 * Abandoned claims with no attempts left are failed as `unknown`: whether the
 * provider accepted the last one cannot be known, and a seventh try is not
 * allowed. Returns how many.
 */
export async function failExhaustedClaims(now: Date = new Date()): Promise<number> {
  const abandonedBefore = new Date(now.getTime() - ABANDONED_CLAIM_MS);
  const rows = (await db().execute(sql`
    UPDATE notification_deliveries
       SET status = 'failed', last_error = 'unknown', claimed_at = NULL, next_attempt_at = NULL
     WHERE status = 'sending' AND claimed_at <= ${abandonedBefore.toISOString()}::timestamptz AND attempts >= ${MAX_ATTEMPTS}
    RETURNING id
  `)) as unknown as unknown[];
  return rows.length;
}

/** One delivery's state — for tests and for G2's operational reads. Never content. */
export async function findDeliveries(ids: string[]) {
  if (ids.length === 0) return [];
  return db().select().from(notificationDeliveries).where(inArray(notificationDeliveries.id, ids));
}

/* -------------------------------------------------- recipients and facts */

/**
 * The client members a request for this round would reach **now**: an active
 * identity whose contact is not archived — exactly what signing in requires —
 * with an active membership of the round's Workroom; the Workroom published
 * and not archived; the Presentation published and not archived; the round
 * open on its current Revision. Identity ids, in a stable order.
 */
export async function eligibleClientIdentityIds(reviewId: string, on: Executor = db()): Promise<string[]> {
  const rows = (await on.execute(sql`
    SELECT ci.id
      FROM presentation_reviews r
      JOIN workrooms w ON w.id = r.workroom_id
      JOIN presentation_revisions rv ON rv.workroom_id = r.workroom_id AND rv.id = r.presentation_revision_id
      JOIN presentations p ON p.id = rv.presentation_id
      JOIN workroom_members m ON m.workroom_id = r.workroom_id AND m.status = 'active'
      JOIN client_identities ci ON ci.contact_id = m.contact_id AND ci.status = 'active'
      JOIN contacts c ON c.id = ci.contact_id AND c.archived_at IS NULL
     WHERE r.id = ${reviewId}
       AND r.status = 'open'
       AND p.current_revision_id = r.presentation_revision_id
       AND w.status = 'published' AND w.archived_at IS NULL
       AND p.status = 'published' AND p.archived_at IS NULL
     ORDER BY ci.id
  `)) as unknown as Array<{ id: string }>;
  return rows.map((row) => String(row.id));
}

/**
 * What `decideRequested` needs about one `review.requested` delivery, read at
 * the moment of sending. The request episode is compared in SQL, column to
 * column, at millisecond precision — the precision of the dedupe key — so a
 * JavaScript round trip can never make an episode look different from itself.
 */
export async function requestedFacts(deliveryId: string, on: Executor = db()): Promise<RequestedFacts | null> {
  const rows = (await on.execute(sql`
    SELECT
      (ci.status = 'active' AND c.archived_at IS NULL) AS identity_active,
      EXISTS (
        SELECT 1 FROM workroom_members m
         WHERE m.workroom_id = d.workroom_id AND m.contact_id = ci.contact_id AND m.status = 'active'
      ) AS membership_active,
      (w.status = 'published' AND w.archived_at IS NULL) AS workroom_available,
      (p.status = 'published' AND p.archived_at IS NULL) AS presentation_available,
      r.status AS review_status,
      r.closed_reason,
      (p.current_revision_id = r.presentation_revision_id) AS revision_is_current,
      (date_trunc('milliseconds', r.requested_at) = date_trunc('milliseconds', d.requested_at)) AS episode_is_current
    FROM notification_deliveries d
    JOIN presentation_reviews r ON r.workroom_id = d.workroom_id AND r.id = d.presentation_review_id
    JOIN workrooms w ON w.id = d.workroom_id
    JOIN presentation_revisions rv ON rv.workroom_id = r.workroom_id AND rv.id = r.presentation_revision_id
    JOIN presentations p ON p.id = rv.presentation_id
    JOIN client_identities ci ON ci.id = d.client_identity_id
    JOIN contacts c ON c.id = ci.contact_id
    WHERE d.id = ${deliveryId} AND d.kind = 'review.requested'
  `)) as unknown as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  return {
    identityActive: row.identity_active === true,
    membershipActive: row.membership_active === true,
    workroomAvailable: row.workroom_available === true,
    presentationAvailable: row.presentation_available === true,
    reviewStatus: row.review_status as RequestedFacts["reviewStatus"],
    closedReason: (row.closed_reason ?? null) as RequestedFacts["closedReason"],
    revisionIsCurrent: row.revision_is_current === true,
    episodeIsCurrent: row.episode_is_current === true,
  };
}

/** What `decideReceived` needs about one `review.received` delivery, read at the moment of sending. */
export async function receivedFacts(deliveryId: string, on: Executor = db()): Promise<ReceivedFacts | null> {
  const rows = (await on.execute(sql`
    SELECT
      (SELECT n.removed_at IS NULL FROM presentation_review_notes n
        WHERE n.presentation_review_id = d.presentation_review_id AND n.number = d.note_number) AS triggering_note_live,
      (SELECT count(*) FROM presentation_review_notes n
        WHERE n.presentation_review_id = d.presentation_review_id AND n.is_root AND n.removed_at IS NULL)::int AS live_root_notes
    FROM notification_deliveries d
    WHERE d.id = ${deliveryId} AND d.kind = 'review.received'
  `)) as unknown as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  return {
    triggeringNoteLive: row.triggering_note_live === null ? null : row.triggering_note_live === true,
    liveRootNotes: Number(row.live_root_notes),
  };
}
