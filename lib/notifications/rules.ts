import {
  TERMINAL_ERRORS,
  type DeliveryError,
  type SuppressionReason,
} from "./vocabulary.ts";

/**
 * What a dispatcher decides about one delivery, as data (G1). Pure: the facts
 * arrive as booleans and states read at send time, and the answer is a word
 * from the vocabulary. G2 reads the facts and acts on the answer; nothing
 * here touches a database, a provider or a clock it was not handed.
 */

/** Send it, or do not — and if not, the one reason why. */
export type Decision = { send: true } | { send: false; reason: SuppressionReason };

const SEND: Decision = { send: true };
const suppress = (reason: SuppressionReason): Decision => ({ send: false, reason });

/* ------------------------------------------------------ review.requested */

/**
 * Everything that decides whether a client is still asked, read immediately
 * before sending. **Eligible** means all of it: an active identity, an active
 * membership of this Workroom, the Workroom published and not archived, the
 * Presentation published and not archived — and, for a request, the round
 * still open on the Presentation's current Revision, in the same episode the
 * delivery was made for.
 */
export type RequestedFacts = {
  identityActive: boolean;
  membershipActive: boolean;
  workroomAvailable: boolean;
  presentationAvailable: boolean;
  reviewStatus: "open" | "closed" | "withdrawn";
  closedReason: "staff" | "superseded" | null;
  revisionIsCurrent: boolean;
  /** The round's `requested_at` is still the one this delivery was made for. */
  episodeIsCurrent: boolean;
};

/**
 * A request that no longer stands is never delivered late. Taken back, closed,
 * replaced by a newer version, re-requested since, or no longer reachable by
 * this person — each is a suppression, named. The person comes first: whose
 * access ended is the most useful thing to know.
 */
export function decideRequested(facts: RequestedFacts): Decision {
  if (!facts.identityActive) return suppress("recipient_inactive");
  if (!facts.membershipActive) return suppress("membership_revoked");
  if (!facts.workroomAvailable) return suppress("workroom_unavailable");
  if (!facts.presentationAvailable) return suppress("presentation_unavailable");
  if (facts.reviewStatus === "withdrawn" || !facts.episodeIsCurrent) return suppress("withdrawn");
  if (facts.reviewStatus === "closed") {
    return suppress(facts.closedReason === "superseded" ? "superseded" : "closed");
  }
  if (!facts.revisionIsCurrent) return suppress("superseded");
  return SEND;
}

/* ------------------------------------------------------ review.received */

/**
 * What decides whether the studio still hears about a round's feedback. The
 * email carries no text, so an edit can never make it wrong; only a removal
 * can make it empty.
 */
export type ReceivedFacts = {
  /** Whether the note that raised it is still there. Null when it named none. */
  triggeringNoteLive: boolean | null;
  /** Root feedback notes in the round that have not been taken back. */
  liveRootNotes: number;
};

/**
 * Sent unless the feedback it announces was taken back and nothing else in
 * the round remains. **Supersession does not stop it**: feedback on Version N
 * is still feedback on Version N, and the link names that version, frozen.
 */
export function decideReceived(facts: ReceivedFacts): Decision {
  if (facts.liveRootNotes === 0 && facts.triggeringNoteLive !== true) return suppress("retracted");
  return SEND;
}

/* ------------------------------------------------------------- retries */

const MINUTE = 60_000;

/**
 * The wait after each failed attempt: 1 minute, 5, 30, 2 hours, 6 hours. Six
 * attempts in all; the last starts about 8 h 36 m after the first.
 */
export const RETRY_DELAYS_MS: readonly number[] = [1, 5, 30, 120, 360].map((m) => m * MINUTE);

/** Attempts a delivery is given before it is failed for good. */
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

/** How long from the first attempt to the last, at most. */
export const RETRY_HORIZON_MS = RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0);

/**
 * Resend honours an `Idempotency-Key` for 24 hours. Every retry of a delivery
 * reuses its key, so the whole horizon must sit well inside that window — or
 * a late retry of something the provider already accepted could send twice.
 */
export const PROVIDER_IDEMPOTENCY_WINDOW_MS = 24 * 60 * MINUTE;

/** A `sending` claim older than this was abandoned — a dispatcher died holding it. */
export const ABANDONED_CLAIM_MS = 10 * MINUTE;

/**
 * After attempt `attempts` failed with `error`: when to try again, or give up.
 * A terminal class gives up at once — no retry fixes a rejected sender or a
 * malformed message; anything else waits its turn until the attempts run out.
 */
export function afterFailure(
  attempts: number,
  error: DeliveryError,
  now: Date,
): { retryAt: Date } | { fail: true } {
  if (TERMINAL_ERRORS.includes(error)) return { fail: true };
  if (!Number.isInteger(attempts) || attempts < 1 || attempts >= MAX_ATTEMPTS) return { fail: true };
  return { retryAt: new Date(now.getTime() + RETRY_DELAYS_MS[attempts - 1]!) };
}

/* ------------------------------------------------------ provider errors */

/** What the provider said went wrong — its error name and status, never its words. */
export type ProviderError = { name?: unknown; statusCode?: unknown };

const BY_NAME: Record<string, DeliveryError> = {
  rate_limit_exceeded: "rate_limited",
  concurrent_idempotent_requests: "concurrent_idempotent_requests",
  validation_error: "validation_error",
  missing_required_field: "validation_error",
  invalid_parameter: "validation_error",
  invalid_attachment: "validation_error",
  invalid_idempotency_key: "validation_error",
  invalid_idempotent_request: "validation_error",
  invalid_region: "validation_error",
  invalid_from_address: "invalid_from_address",
  missing_api_key: "invalid_api_key",
  invalid_api_key: "invalid_api_key",
  restricted_api_key: "restricted_api_key",
  invalid_access: "restricted_api_key",
  security_error: "restricted_api_key",
  daily_quota_exceeded: "quota",
  monthly_quota_exceeded: "quota",
  internal_server_error: "provider_5xx",
};

/**
 * A provider failure, reduced to its class. Only the error's `name` and
 * `statusCode` are read — its message can quote the request, and nothing it
 * says is ever kept. The Resend SDK reports an unreachable network as
 * `application_error` with no status, which is exactly what makes it
 * `network` rather than the provider's fault.
 */
export function classifyProviderError(error: ProviderError): DeliveryError {
  const name = typeof error.name === "string" ? error.name : "";
  const status = typeof error.statusCode === "number" ? error.statusCode : null;

  if (name in BY_NAME) return BY_NAME[name]!;
  if (status === 429) return "rate_limited";
  if (status !== null && status >= 500) return "provider_5xx";
  if (name === "application_error" && status === null) return "network";
  return "unknown";
}
