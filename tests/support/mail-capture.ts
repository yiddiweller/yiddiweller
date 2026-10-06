import { createServer, type Server } from "node:http";

/**
 * Where a test server's mail goes instead of Resend.
 *
 * The SDK sends to `RESEND_BASE_URL` when it is set, so a server started with
 * that pointing here delivers every sign-in link to this process — the real
 * message, built by the real code, carrying the real link — and nothing
 * leaves the machine. Tests read it the way a person reads their inbox: wait
 * for the next message to an address, take the link out of it.
 *
 * A server whose base URL points here while nothing listens simply fails to
 * deliver, which every mail path already logs and survives.
 */
export type CapturedMail = { to: string[]; subject: string; text: string; html: string };

export class MailCapture {
  readonly mail: CapturedMail[] = [];
  private server: Server | null = null;

  async start(url: string): Promise<void> {
    const { hostname, port } = new URL(url);
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (request.method !== "POST" || !request.url?.startsWith("/emails")) {
          return void response.writeHead(404, { "content-type": "application/json" }).end("{}");
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        this.mail.push({
          to: ([] as unknown[]).concat(body.to ?? []).map(String),
          subject: String(body.subject ?? ""),
          text: String(body.text ?? ""),
          html: String(body.html ?? ""),
        });
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ id: `captured-${this.mail.length}` }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(Number(port), hostname, resolve);
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  /** How many messages have arrived so far — a mark to wait beyond. */
  get count(): number {
    return this.mail.length;
  }

  /** Messages to this address that arrived after the mark. */
  since(mark: number, to: string): CapturedMail[] {
    return this.mail.slice(mark).filter((message) => message.to.includes(to));
  }

  /** The next message to `to` after `mark`. Sign-in delivery is detached, so this polls. */
  async next(to: string, mark: number, timeoutMs = 10_000): Promise<CapturedMail> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.since(mark, to)[0];
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`no mail to ${to} within ${timeoutMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/** The sign-in link in a message's plain-text part. */
export function magicLinkIn(message: CapturedMail): string {
  const link = /https?:\/\/\S+\/magic-link\/verify\?\S+/.exec(message.text)?.[0];
  if (!link) throw new Error(`no sign-in link in "${message.subject}"`);
  return link;
}
