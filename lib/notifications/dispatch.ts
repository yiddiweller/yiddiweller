import {
  claimDue,
  clientAddress,
  failExhaustedClaims,
  markFailed,
  markRetry,
  markSent,
  receivedContent,
  receivedFacts,
  requestedContent,
  requestedFacts,
  suppressDelivery,
  type ClaimedDelivery,
} from "../db/notifications.ts";
import { providerIdempotencyKey } from "./dedupe.ts";
import { clientRevisionUrl, studioRevisionUrl } from "./links.ts";
import { logNotification } from "./log.ts";
import { notificationMode, type NotificationMode } from "./mode.ts";
import { renderNotification, type RenderedMail } from "./render.ts";
import { resendTransport } from "./resend-transport.ts";
import { afterFailure, decideReceived, decideRequested, type Decision } from "./rules.ts";
import type { MailTransport } from "./transport.ts";
import type { DeliveryError } from "./vocabulary.ts";

/**
 * Stage G's one dispatcher (G2): the only code that turns an outbox row into
 * a message, used by the scheduled command and by the best-effort drain alike.
 * There is no second sender.
 *
 * For each row it claims, in this order:
 *
 *   1. **Claim, and commit the claim.** `claimDue` is one committed statement,
 *      so no lock and no transaction is held from here on — not while
 *      rendering, not while the provider is on the line.
 *   2. **Re-check, now.** Whatever was true when the row was written, the
 *      facts are read again: a revoked member, an unpublished Workroom, a
 *      round withdrawn, closed or asked again, a newer version, feedback taken
 *      back. A row that no longer stands is suppressed with its reason, never
 *      sent late and never counted as a provider failure.
 *   3. **Ask the environment.** Production is `live`. The preview captures by
 *      default — the row is settled `preview_capture`, nothing is rendered for
 *      a recipient and no provider is called — or, with a valid
 *      `NOTIFICATION_REDIRECT_TO`, sends to that one address alone and never
 *      reads the intended client's address at all.
 *   4. **Render** from what is true now: the Revision's frozen title and
 *      number, and the one link to that exact Revision.
 *   5. **Send** with the row's own idempotency key — the same on every retry.
 *   6. **Settle** by the claim, so a dispatcher whose claim was taken over can
 *      never overwrite a newer attempt's outcome.
 *
 * The configuration it needs — `RESEND_API_KEY`, `RESEND_FROM_EMAIL`,
 * `CONTACT_EMAIL` — is read at the moment of sending, never copied into a row.
 */

/** Rows one scheduled run claims. The rest wait for the next run. */
export const SCHEDULED_BATCH = 25;

/** Rows the post-commit drain claims: speed for the row just written, nothing more. */
export const IMMEDIATE_BATCH = 5;

export type DispatchSummary = {
  claimed: number;
  sent: number;
  captured: number;
  suppressed: number;
  retried: number;
  failed: number;
};

export type DispatchOptions = {
  limit?: number;
  now?: () => Date;
  /**
   * For tests. In every product path the transport is Resend's, built only
   * when something is actually about to be sent — capture never builds one.
   */
  transport?: MailTransport;
};

type Settled = Exclude<keyof DispatchSummary, "claimed">;

/* -------------------------------------------------------- configuration */

const CONTROL = /[\u0000-\u001f\u007f]/;

function setting(name: string): string | null {
  const value = process.env[name]?.trim();
  return value && !CONTROL.test(value) ? value : null;
}

type Sending = { apiKey: string; from: string; contact: string };

/**
 * What sending needs, or the class a provider would have given its absence.
 * A missing key is what Resend calls an invalid one; a missing sender, an
 * invalid sender; a missing studio inbox, a message it would refuse. Each is
 * terminal by G1's rules — a retry cannot fix configuration — and none of the
 * values is ever logged.
 */
function sendingConfig(): { ok: true; value: Sending } | { ok: false; error: DeliveryError } {
  const apiKey = setting("RESEND_API_KEY");
  if (!apiKey) return { ok: false, error: "invalid_api_key" };
  const from = setting("RESEND_FROM_EMAIL");
  if (!from) return { ok: false, error: "invalid_from_address" };
  const contact = setting("CONTACT_EMAIL");
  if (!contact) return { ok: false, error: "validation_error" };
  return { ok: true, value: { apiKey, from, contact } };
}

/* -------------------------------------------------------------- settling */

async function suppressed(claim: ClaimedDelivery, decision: Extract<Decision, { send: false }>): Promise<Settled> {
  await suppressDelivery(claim, decision.reason);
  logNotification("notification.suppressed", { kind: claim.kind, delivery: claim.id, reason: decision.reason });
  return "suppressed";
}

/** A failed attempt: retried on G1's schedule, or failed for good. */
async function failure(claim: ClaimedDelivery, error: DeliveryError, now: Date): Promise<Settled> {
  logNotification("notification.failed", { kind: claim.kind, delivery: claim.id, attempt: claim.attempts, error });
  const next = afterFailure(claim.attempts, error, now);
  if ("retryAt" in next) {
    await markRetry(claim, error, next.retryAt);
    return "retried";
  }
  await markFailed(claim, error);
  return "failed";
}

/* ------------------------------------------------------------ one delivery */

async function decide(claim: ClaimedDelivery): Promise<Decision | null> {
  if (claim.kind === "review.requested") {
    const facts = await requestedFacts(claim.id);
    return facts ? decideRequested(facts) : null;
  }
  const facts = await receivedFacts(claim.id);
  return facts ? decideReceived(facts) : null;
}

/** The message, from what is true now — or null if it cannot be built. */
async function compose(claim: ClaimedDelivery, mode: NotificationMode): Promise<RenderedMail | null> {
  const previewFor = mode.mode === "redirect" ? claim.recipientKind : undefined;

  if (claim.kind === "review.requested") {
    const content = await requestedContent(claim.id);
    if (!content) return null;
    return renderNotification(
      "review.requested",
      {
        presentationTitle: content.title,
        version: content.version,
        url: clientRevisionUrl({ room: content.room, presentation: content.presentation, version: content.version }),
      },
      { previewFor },
    );
  }

  const content = await receivedContent(claim.id);
  if (!content) return null;
  return renderNotification(
    "review.received",
    {
      presentationTitle: content.title,
      version: content.version,
      clientName: content.clientName,
      url: studioRevisionUrl({
        workroomId: content.workroomId,
        presentationId: content.presentationId,
        version: content.version,
        note: content.noteNumber,
      }),
    },
    { previewFor },
  );
}

async function deliver(
  claim: ClaimedDelivery,
  now: () => Date,
  transportFor: (apiKey: string) => MailTransport,
): Promise<Settled> {
  const decision = await decide(claim);
  if (!decision) return failure(claim, "unknown", now());
  if (!decision.send) return suppressed(claim, decision);

  const mode = notificationMode();

  if (mode.mode === "capture") {
    await suppressDelivery(claim, "preview_capture");
    logNotification("notification.captured", { kind: claim.kind, delivery: claim.id, role: claim.recipientKind });
    return "captured";
  }

  const config = sendingConfig();
  if (!config.ok) return failure(claim, config.error, now());

  const mail = await compose(claim, mode);
  if (!mail) return failure(claim, "validation_error", now());

  // Redirect: the one test inbox, and the intended client's address is never
  // even read. Live: the client's verified sign-in address as it is now, or
  // the studio inbox as configured now.
  let to: string | null;
  if (mode.mode === "redirect") to = mode.to;
  else if (claim.kind === "review.requested") to = await clientAddress(claim.id);
  else to = config.value.contact;
  if (!to) return failure(claim, "validation_error", now());

  const outcome = await transportFor(config.value.apiKey).send({
    to,
    from: config.value.from,
    // A client's reply reaches a person; the studio's own notice needs none.
    replyTo: claim.kind === "review.requested" ? config.value.contact : undefined,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    idempotencyKey: providerIdempotencyKey(claim.id),
  });

  if (!outcome.ok) return failure(claim, outcome.error, now());

  await markSent(claim, outcome.providerMessageId, now());
  logNotification("notification.sent", { kind: claim.kind, delivery: claim.id, attempt: claim.attempts });
  return "sent";
}

/* --------------------------------------------------------------- a batch */

/**
 * One bounded pass: fail what was abandoned with no attempts left, claim up to
 * `limit` due rows, deliver each. Rows are worked one at a time — a batch is
 * small, and a provider's rate limit is better met slowly than in a burst.
 *
 * A row that throws is a failed attempt of class `unknown`, retried on the
 * schedule; it never stops the rest of the batch. Only a failure to reach the
 * database at all escapes, because then nothing can be settled.
 */
export async function dispatchDue(options: DispatchOptions = {}): Promise<DispatchSummary> {
  const now = options.now ?? (() => new Date());
  const limit = Math.max(1, Math.min(SCHEDULED_BATCH, options.limit ?? SCHEDULED_BATCH));
  const summary: DispatchSummary = { claimed: 0, sent: 0, captured: 0, suppressed: 0, retried: 0, failed: 0 };

  summary.failed += await failExhaustedClaims(now());

  const claims = await claimDue({ now: now(), limit });
  summary.claimed = claims.length;

  let transport: MailTransport | null = options.transport ?? null;
  const transportFor = (apiKey: string) => (transport ??= resendTransport({ apiKey }));

  for (const claim of claims) {
    let settled: Settled;
    try {
      settled = await deliver(claim, now, transportFor);
    } catch {
      // Never the cause's message: a failed query's message carries its
      // parameters. The class is all that is recorded.
      settled = await failure(claim, "unknown", now());
    }
    summary[settled] += 1;
  }

  return summary;
}
