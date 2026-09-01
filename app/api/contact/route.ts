import { NextResponse } from "next/server";
import { Resend } from "resend";

import { validate, type ContactFields } from "@/lib/contact";
import { ownerEmail, visitorEmail } from "@/lib/emails";
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

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function POST(request: Request) {
  const { RESEND_API_KEY, RESEND_FROM_EMAIL, CONTACT_EMAIL } = process.env;

  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL || !CONTACT_EMAIL) {
    console.error("Contact form is missing Resend environment variables.");
    return NextResponse.json(
      { error: "The contact form is not configured yet." },
      { status: 503 },
    );
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";

  if (rateLimited(ip)) {
    return NextResponse.json(
      { error: "Too many messages. Please try again shortly." },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, unknown>;

  // Honeypot: only a bot fills a field no human can see. Answer as if sent.
  if (asString(payload.company).trim()) {
    return NextResponse.json({ ok: true });
  }

  const fields: ContactFields = {
    name: asString(payload.name).trim(),
    email: asString(payload.email).trim(),
    message: asString(payload.message).trim(),
  };

  const errors = validate(fields);
  if (Object.keys(errors).length > 0) {
    return NextResponse.json(
      { error: "Please check the highlighted fields.", fields: errors },
      { status: 400 },
    );
  }

  // Show the name rather than a bare address in the recipient's inbox.
  const from = RESEND_FROM_EMAIL.includes("<")
    ? RESEND_FROM_EMAIL
    : `${site.name} <${RESEND_FROM_EMAIL}>`;

  const resend = new Resend(RESEND_API_KEY);
  const owner = ownerEmail(fields);

  try {
    const { error } = await resend.emails.send({
      from,
      to: CONTACT_EMAIL,
      replyTo: fields.email,
      subject: owner.subject,
      text: owner.text,
      html: owner.html,
    });

    if (error) {
      console.error("Resend rejected the message:", error);
      return NextResponse.json(
        { error: "The message could not be sent. Please try again." },
        { status: 502 },
      );
    }
  } catch (cause) {
    console.error("Contact form failed:", cause);
    return NextResponse.json(
      { error: "The message could not be sent. Please try again." },
      { status: 500 },
    );
  }

  // The visitor's receipt is a courtesy. Their message is already delivered,
  // so a failure here must never be reported back as a failed submission.
  try {
    const receipt = visitorEmail();
    const { error } = await resend.emails.send({
      from,
      to: fields.email,
      replyTo: CONTACT_EMAIL,
      subject: receipt.subject,
      text: receipt.text,
      html: receipt.html,
    });
    if (error) console.error("Auto-reply rejected:", error);
  } catch (cause) {
    console.error("Auto-reply failed:", cause);
  }

  return NextResponse.json({ ok: true });
}
