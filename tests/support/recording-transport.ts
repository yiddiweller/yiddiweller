import type { MailMessage, MailTransport, SendOutcome } from "../../lib/notifications/transport.ts";

/**
 * A `MailTransport` that sends nothing and remembers everything (Stage G1):
 * every message exactly as a dispatcher handed it over, and a script of
 * outcomes to answer with — success by default, or any failure class a test
 * wants to see handled. Deterministic: provider ids are `fake-1`, `fake-2`, …
 */
export class RecordingTransport implements MailTransport {
  readonly sent: MailMessage[] = [];
  private readonly script: SendOutcome[] = [];

  /** The next outcomes to answer with, in order; after them, success. */
  answer(...outcomes: SendOutcome[]): this {
    this.script.push(...outcomes);
    return this;
  }

  async send(message: MailMessage): Promise<SendOutcome> {
    this.sent.push({ ...message });
    return this.script.shift() ?? { ok: true, providerMessageId: `fake-${this.sent.length}` };
  }
}
