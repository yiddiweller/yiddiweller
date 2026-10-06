/**
 * The two keys a notification delivery carries (G1). Pure, and built only
 * from immutable identifiers and the moment an event happened — never from an
 * address, a name, a title, a body or anything somebody can edit.
 *
 * **`dedupe_key`** makes *one row per event and recipient, ever* a database
 * fact: it is `UNIQUE`, and enqueueing inserts with `ON CONFLICT DO NOTHING`,
 * so the same event raised twice — a retried request, a doubled transaction —
 * leaves one row.
 *
 *   review.requested  one per request **episode** per client. An episode is
 *                     the round's `requested_at`, which a re-request after a
 *                     withdrawal moves — so asking again may notify again,
 *                     and asking once never notifies twice.
 *   review.received   one per round, to the studio inbox — the round's first
 *                     feedback, and nothing after it.
 *
 * **The provider key** is what Resend is handed as `Idempotency-Key`: the
 * delivery's own id, so every retry of one row is the same request to the
 * provider, and two recipients are two requests.
 */

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function id(value: string, what: string): string {
  if (!ID.test(value)) throw new Error(`${what} is not an identifier`);
  return value.toLowerCase();
}

/**
 * One request episode, for one client identity. The episode is the request's
 * moment to the millisecond — the precision a JavaScript `Date` carries, and
 * the precision the dispatcher compares at, so the two always agree.
 */
export function requestedDedupeKey(input: {
  reviewId: string;
  requestedAt: Date;
  clientIdentityId: string;
}): string {
  const episode = input.requestedAt.getTime();
  if (!Number.isSafeInteger(episode)) throw new Error("requestedAt is not a moment");
  return `review.requested/${id(input.reviewId, "reviewId")}/${episode}/client/${id(input.clientIdentityId, "clientIdentityId")}`;
}

/** The round's feedback, to the studio inbox — once per round, whatever is said after. */
export function receivedDedupeKey(input: { reviewId: string }): string {
  return `review.received/${id(input.reviewId, "reviewId")}/studio_inbox`;
}

/** Resend's `Idempotency-Key` for one delivery: the same row, the same key, forever. */
export function providerIdempotencyKey(deliveryId: string): string {
  return `yw-notification/${id(deliveryId, "deliveryId")}`;
}
