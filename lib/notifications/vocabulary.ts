/**
 * Every word Stage G's notification deliveries may contain, in one place
 * (G1). The schema's CHECKs, the pure rules and the safe-log builder all read
 * these lists, so a value one of them accepts is a value all of them know.
 *
 * Deliberately narrow. V1 notifies about two things and nothing else — a
 * round being asked for, and the first feedback in a round — so there is no
 * kind for a reply, a resolution, a close, a withdrawal, a supersession, a
 * publish or a shared file, and adding one is a product decision rather than
 * an edit. Replies never send email in V1 (`docs/delivery.md`, *Stage G*).
 *
 * No imports: the schema depends on this, and nothing here may depend back.
 */

/** What happened. Two kinds, ever, in V1. */
export const NOTIFICATION_KINDS = ["review.requested", "review.received"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/**
 * Who it is for. A client member, named by their client identity; or the
 * studio's own inbox, which is `CONTACT_EMAIL` as configured **when the
 * message is sent** — never a person, never an address stored here.
 */
export const RECIPIENT_KINDS = ["client", "studio_inbox"] as const;
export type RecipientKind = (typeof RECIPIENT_KINDS)[number];

/** Which recipient each kind is for. One each, and the schema holds it. */
export const KIND_RECIPIENT: Record<NotificationKind, RecipientKind> = {
  "review.requested": "client",
  "review.received": "studio_inbox",
};

/**
 * Where a delivery stands.
 *
 *   pending     waiting for its `next_attempt_at`
 *   sending     claimed by a dispatcher, which is talking to the provider
 *   sent        accepted by the provider — terminal
 *   suppressed  decided against, for one `SUPPRESSION_REASONS` — terminal
 *   failed      gave up, for one `DELIVERY_ERRORS` — terminal
 */
export const DELIVERY_STATUSES = ["pending", "sending", "sent", "suppressed", "failed"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * Why a delivery was decided against, at the moment it would have been sent.
 * A fixed vocabulary — never free text — and each word is a decision the
 * rules in `rules.ts` actually make.
 */
export const SUPPRESSION_REASONS = [
  /** Preview with no redirect: captured, never sent. */
  "preview_capture",
  /** The client identity was switched off. */
  "recipient_inactive",
  /** Their Workroom membership was revoked. */
  "membership_revoked",
  /** The Workroom is unpublished or archived. */
  "workroom_unavailable",
  /** The Presentation is unpublished or archived. */
  "presentation_unavailable",
  /** The request was taken back — or replaced by a later request episode. */
  "withdrawn",
  /** The studio closed the round. */
  "closed",
  /** A newer version was published; this request no longer stands. */
  "superseded",
  /** The feedback it announced was taken back and nothing else remains. */
  "retracted",
  /** It would have told somebody about their own action. */
  "self_notification",
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/**
 * Why a send did not succeed — a **class**, never the provider's words. Each
 * is either retried on the schedule in `rules.ts` or terminal at once.
 */
export const DELIVERY_ERRORS = [
  "network",
  "rate_limited",
  "provider_5xx",
  "concurrent_idempotent_requests",
  "validation_error",
  "invalid_from_address",
  "invalid_api_key",
  "restricted_api_key",
  "quota",
  "unknown",
] as const;
export type DeliveryError = (typeof DELIVERY_ERRORS)[number];

/** Classes no retry can fix: the message, the sender or the account is wrong. */
export const TERMINAL_ERRORS: readonly DeliveryError[] = [
  "validation_error",
  "invalid_from_address",
  "invalid_api_key",
  "restricted_api_key",
  "quota",
];
