import { NextResponse } from "next/server";
import { Resend } from "resend";

import { validate, type ContactFields } from "@/lib/contact";

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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

  const text = `Name: ${fields.name}\nEmail: ${fields.email}\n\nMessage:\n${fields.message}`;
  const html = `<table cellpadding="0" cellspacing="0" style="font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111">
<tr><td style="padding:0 0 6px"><strong>Name:</strong> ${escapeHtml(fields.name)}</td></tr>
<tr><td style="padding:0 0 6px"><strong>Email:</strong> ${escapeHtml(fields.email)}</td></tr>
<tr><td style="padding:18px 0 0"><strong>Message:</strong></td></tr>
<tr><td style="padding:6px 0 0;white-space:pre-wrap">${escapeHtml(fields.message)}</td></tr>
</table>`;

  try {
    const resend = new Resend(RESEND_API_KEY);
    const { error } = await resend.emails.send({
      from: RESEND_FROM_EMAIL,
      to: CONTACT_EMAIL,
      replyTo: fields.email,
      subject: `New message from ${fields.name}`,
      text,
      html,
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

  return NextResponse.json({ ok: true });
}
