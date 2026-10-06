import { log } from "../log.ts";
import {
  DELIVERY_ERRORS,
  NOTIFICATION_KINDS,
  RECIPIENT_KINDS,
  SUPPRESSION_REASONS,
  type DeliveryError,
  type NotificationKind,
  type RecipientKind,
  type SuppressionReason,
} from "./vocabulary.ts";

/**
 * The only lines Stage G may write to the logs, and the only things each may
 * say (G1; emitted from G2 — `created` by `lib/db/reviews.ts` after commit,
 * the rest by the dispatcher).
 *
 * Every field is a kind, a count, a delivery id, an attempt number, a reason,
 * an error class or a recipient **role** — never an address, a title, a name,
 * feedback, an anchor, a link, an idempotency key or anything a provider said.
 * The types restrict what can be passed, and `notificationLogFields` checks
 * every value against its vocabulary at runtime too, because a type is not a
 * guard.
 */

type Fields = {
  "notification.created": { kind: NotificationKind; count: number };
  "notification.sent": { kind: NotificationKind; delivery: string; attempt: number };
  "notification.failed": { kind: NotificationKind; delivery: string; attempt: number; error: DeliveryError };
  "notification.suppressed": { kind: NotificationKind; delivery: string; reason: SuppressionReason };
  "notification.captured": { kind: NotificationKind; delivery: string; role: RecipientKind };
  /** One dispatcher pass, in counts (G2). */
  "notification.dispatched": {
    claimed: number;
    sent: number;
    captured: number;
    suppressed: number;
    retried: number;
    failed: number;
  };
  /** The best-effort drain could not run. Nothing else is said; the rows wait (G2). */
  "notification.drain_failed": Record<string, never>;
};

export type NotificationEvent = keyof Fields;

const ALLOWED: Record<NotificationEvent, readonly string[]> = {
  "notification.created": ["kind", "count"],
  "notification.sent": ["kind", "delivery", "attempt"],
  "notification.failed": ["kind", "delivery", "attempt", "error"],
  "notification.suppressed": ["kind", "delivery", "reason"],
  "notification.captured": ["kind", "delivery", "role"],
  "notification.dispatched": ["claimed", "sent", "captured", "suppressed", "retried", "failed"],
  "notification.drain_failed": [],
};

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;

const VALID: Record<string, (value: unknown) => boolean> = {
  kind: (value) => (NOTIFICATION_KINDS as readonly unknown[]).includes(value),
  count,
  delivery: (value) => typeof value === "string" && ID.test(value),
  attempt: (value) => Number.isSafeInteger(value) && (value as number) >= 1,
  reason: (value) => (SUPPRESSION_REASONS as readonly unknown[]).includes(value),
  error: (value) => (DELIVERY_ERRORS as readonly unknown[]).includes(value),
  role: (value) => (RECIPIENT_KINDS as readonly unknown[]).includes(value),
  claimed: count,
  sent: count,
  captured: count,
  suppressed: count,
  retried: count,
  failed: count,
};

/** The fields for one line, exactly as allowed — or an error, never a looser line. */
export function notificationLogFields<E extends NotificationEvent>(
  event: E,
  fields: Fields[E],
): Record<string, string | number> {
  const allowed = ALLOWED[event];
  if (!allowed) throw new Error("not a notification log event");
  const given = fields as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    if (!allowed.includes(key)) throw new Error(`a notification log line may not carry "${key}"`);
  }
  const out: Record<string, string | number> = {};
  for (const key of allowed) {
    if (!VALID[key]!(given[key])) throw new Error(`a notification log line's "${key}" is not allowed`);
    out[key] = given[key] as string | number;
  }
  return out;
}

/** Writes one line through the application's log. Failures warn; the rest inform. */
export function logNotification<E extends NotificationEvent>(event: E, fields: Fields[E]): void {
  const safe = notificationLogFields(event, fields);
  if (event === "notification.failed" || event === "notification.drain_failed") log.warn(event, safe);
  else log.info(event, safe);
}
