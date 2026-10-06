import { Resend } from "resend";

import { classifyProviderError } from "./rules.ts";
import type { MailMessage, MailTransport, SendOutcome } from "./transport.ts";

/**
 * Resend, behind `MailTransport` (G1). **Not called from any product path
 * yet** — G2's dispatcher will be its only caller, and only in the mode
 * `notificationMode` allows.
 *
 * Every send carries its `Idempotency-Key`, so a retry of the same delivery is
 * the same request to Resend and is not sent twice within Resend's 24-hour
 * window, which the retry schedule sits well inside. What comes back is
 * reduced at once: the message id on success, an error **class** on failure.
 * The provider's message, its response body and its headers are never kept,
 * returned or logged here.
 *
 * Built from the existing configuration — the same `RESEND_API_KEY` the
 * application already holds — and nothing new. `baseUrl` exists so a test can
 * point it at a local server; product code never passes it.
 */
export function resendTransport(options: { apiKey: string; baseUrl?: string }): MailTransport {
  const client = new Resend(options.apiKey, options.baseUrl ? { baseUrl: options.baseUrl } : undefined);
  // The SDK prints the provider's raw error — which can quote an address or
  // the request — to the console whenever NODE_ENV is not "production".
  // Production and beta run with it set, but a rule that depends on an
  // environment variable is not a rule: this instance never logs, anywhere.
  (client as unknown as { logError: () => void }).logError = () => {};

  return {
    async send(message: MailMessage): Promise<SendOutcome> {
      try {
        const { data, error } = await client.emails.send(
          {
            from: message.from,
            to: message.to,
            ...(message.replyTo ? { replyTo: message.replyTo } : {}),
            subject: message.subject,
            html: message.html,
            text: message.text,
          },
          { idempotencyKey: message.idempotencyKey },
        );
        if (error) return { ok: false, error: classifyProviderError(error) };
        const id = typeof data?.id === "string" && data.id.length > 0 && data.id.length <= 200 ? data.id : null;
        return { ok: true, providerMessageId: id };
      } catch {
        // The SDK reports an unreachable network itself; anything thrown past
        // it is still a request that did not arrive.
        return { ok: false, error: "network" };
      }
    },
  };
}
