import { NextResponse } from "next/server";
import { Resend } from "resend";

import { recordInquiry } from "@/lib/db/inquiries";
import { ownerEmail, visitorEmail } from "@/lib/emails";
import { MAX_BODY_BYTES, parsePayload, validate } from "@/lib/contact";
import { emailConfig, MissingEnvError } from "@/lib/env";
import { describeError, log, redactEmail } from "@/lib/log";
import { site } from "@/lib/site";

export const runtime = "nodejs";

/** Fixed window, per IP. Enough to blunt casual abuse without a dependency. */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 5;
const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();

  for (const [key, entry] of hits) {
    if (entry.resetAt <= now) hits.delete(key);
  }

  const entry = hits.get(ip);
  if (!entry || entry.resetAt <= now) {
    hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }

  entry.count += 1;
  return entry.count > MAX_PER_WINDOW;
}

/**
 * The rightmost X-Forwarded-For entry is the one appended by the proxy
 * directly in front of this service. Entries to its left were supplied by the
 * caller and can be invented freely, so keying a rate limiter on the leftmost
 * value — as this route previously did — lets an attacker rotate past it by
 * changing one header.
 *
 * If Railway ever runs more than one proxy hop in front of the app this needs
 * to skip that many entries from the right. `docs/architecture.md` records how
 * to check: if the limiter starts treating all visitors as one client, the
 * resolved value has become an internal address.
 */
function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");

  if (forwarded) {
    const parts = forwarded
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }

  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

function configured(read: () => unknown): boolean {
  try {
    read();
    return true;
  } catch (cause) {
    if (cause instanceof MissingEnvError) return false;
    throw cause;
  }
}

export async function POST(request: Request) {
  const hasEmail = configured(emailConfig);
  const hasDatabase = Boolean(process.env.DATABASE_URL?.trim());

  // An inquiry needs somewhere to go: a database that will keep it, or an
  // inbox that will receive it. Only when neither exists is the form genuinely
  // unusable.
  if (!hasEmail && !hasDatabase) {
    log.error("contact.unconfigured");
    return NextResponse.json(
      { error: "The contact form is not configured yet." },
      { status: 503 },
    );
  }

  const ip = clientIp(request);

  if (rateLimited(ip)) {
    log.warn("contact.rate_limited");
    return NextResponse.json(
      { error: "Too many messages. Please try again shortly." },
      { status: 429 },
    );
  }

  const raw = await request.text();

  if (raw.length > MAX_BODY_BYTES) {
    log.warn("contact.body_too_large", { bytes: raw.length });
    return NextResponse.json({ error: "That message is too long." }, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const parsed = parsePayload(body);
  if (!parsed.ok) {
    log.warn("contact.payload_rejected", { reason: parsed.reason });
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  // Honeypot: only a bot fills a field no human can see. Answer as if sent,
  // but log it — this is the one path that reports success without sending,
  // so it must never fail silently. The value itself is not recorded.
  if (parsed.honeypot) {
    log.warn("contact.honeypot", { length: parsed.honeypot.length });
    return NextResponse.json({ ok: true });
  }

  const fields = parsed.fields;
  const errors = validate(fields);

  if (Object.keys(errors).length > 0) {
    log.info("contact.validation_rejected", { fields: Object.keys(errors).join(",") });
    return NextResponse.json(
      { error: "Please check the highlighted fields.", fields: errors },
      { status: 400 },
    );
  }

  // ---------------------------------------------------------------- persist

  let persisted = false;
  let duplicate = false;

  if (hasDatabase) {
    try {
      const result = await recordInquiry(fields);
      persisted = true;
      duplicate = result.duplicate;
      log.info("contact.persisted", { id: result.id, duplicate });
    } catch (cause) {
      // Loud, because the inquiry now depends entirely on the email below.
      log.error("contact.persist_failed", {
        email: redactEmail(fields.email),
        error: describeError(cause),
      });
    }
  }

  // A resubmission of a message already stored moments ago is the same
  // inquiry. Report success without sending the notification a second time.
  if (duplicate) return NextResponse.json({ ok: true });

  // ------------------------------------------------------------------ email

  let delivered = false;

  if (hasEmail) {
    const { apiKey, from: fromAddress, to } = emailConfig();

    // Show the name rather than a bare address in the recipient's inbox.
    const from = fromAddress.includes("<")
      ? fromAddress
      : `${site.name} <${fromAddress}>`;

    const resend = new Resend(apiKey);
    const owner = ownerEmail(fields);

    try {
      const { error } = await resend.emails.send({
        from,
        to,
        replyTo: fields.email,
        subject: owner.subject,
        text: owner.text,
        html: owner.html,
      });

      if (error) log.error("contact.email_rejected", { error: String(error.message ?? error.name) });
      else delivered = true;
    } catch (cause) {
      log.error("contact.email_failed", { error: describeError(cause) });
    }

    // The visitor's receipt is a courtesy. Their message is already handled,
    // so a failure here must never be reported back as a failed submission.
    if (delivered || persisted) {
      try {
        const receipt = visitorEmail();
        const { error } = await resend.emails.send({
          from,
          to: fields.email,
          replyTo: to,
          subject: receipt.subject,
          text: receipt.text,
          html: receipt.html,
        });
        if (error) log.warn("contact.receipt_rejected");
      } catch (cause) {
        log.warn("contact.receipt_failed", { error: describeError(cause) });
      }
    }
  }

  // ----------------------------------------------------------------- answer

  // The message is safe if it was stored, or if it reached the inbox. Only
  // when neither happened has it actually been lost, and only then is the
  // visitor told so — telling someone their message failed when it did arrive
  // makes them send it again or give up.
  if (!persisted && !delivered) {
    return NextResponse.json(
      { error: "The message could not be sent. Please try again." },
      { status: 502 },
    );
  }

  if (!persisted) {
    log.error("contact.delivered_unrecorded", { email: redactEmail(fields.email) });
  }

  return NextResponse.json({ ok: true });
}
