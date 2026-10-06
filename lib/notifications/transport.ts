import type { DeliveryError } from "./vocabulary.ts";

/**
 * The one way a Stage G notification will leave the application (G1).
 *
 * Small on purpose: exactly what a message needs and nothing a provider calls
 * it. `resend-transport.ts` implements it for Resend; tests use a recording
 * fake. No Resend object, error or response ever crosses this boundary — a
 * success is an optional message id, a failure is one class from the
 * vocabulary, and the provider's own words stay on the far side.
 *
 * **Nothing calls a transport in G1.** Sign-in links, invitations and the
 * contact form keep their own senders in `lib/emails.ts` and the contact
 * route; this is for notifications only.
 */
export type MailMessage = {
  to: string;
  from: string;
  /** For a client's notification, `CONTACT_EMAIL` — so a reply reaches a person. */
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  /** `providerIdempotencyKey(delivery.id)`: one row, one key, every retry. */
  idempotencyKey: string;
};

export type SendOutcome = { ok: true; providerMessageId: string | null } | { ok: false; error: DeliveryError };

export interface MailTransport {
  send(message: MailMessage): Promise<SendOutcome>;
}
