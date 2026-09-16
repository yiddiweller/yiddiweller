import { site } from "@/lib/site";

/** Inline styles and table layout only: email clients strip <style> blocks. */
const BG = "#000000";
const WHITE = "#ffffff";
const MUTED = "#b3b3b3"; // white at 70% over black
const FAINT = "#6b6b6b";
const RULE = "#262626";
const FONT =
  "-apple-system,BlinkMacSystemFont,'Helvetica Neue',Helvetica,Arial,sans-serif";

/** Subject lines must stay a single line: strip control characters and
    collapse whitespace. Resend sends JSON so this cannot inject headers,
    but a multi-line subject renders badly and reads as spoofed. */
function oneLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Wraps the body in a black, centred, 560px shell. */
function shell(inner: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${site.name}</title>
</head>
<body style="margin:0;padding:0;background:${BG};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BG};">
<tr><td align="center" style="padding:56px 24px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;max-width:100%;">
${inner}
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** The wordmark, set as type so it renders even with images blocked. */
const MARK = `<tr><td style="font-family:${FONT};font-size:12px;letter-spacing:0.3em;color:${MUTED};text-transform:uppercase;padding:0 0 56px;">Yiddi&nbsp;Weller</td></tr>`;

/* Grey so the mark holds up whether a client renders on black or forces
   white, and small enough that a blocked image costs nothing. */
const FOOTER = `<tr><td style="padding:56px 0 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="height:1px;line-height:1px;font-size:0;background:${RULE};">&nbsp;</td></tr></table></td></tr>
<tr><td style="padding:24px 0 0;"><img src="${site.url}/email-mark.png" width="28" height="10" alt="Yiddi Weller" style="display:block;width:28px;height:10px;border:0;outline:none;text-decoration:none;"></td></tr>
<tr><td style="font-family:${FONT};font-size:12px;letter-spacing:0.04em;color:${FAINT};padding:16px 0 0;"><a href="${site.url}" style="color:${FAINT};text-decoration:none;">yiddiweller.com</a></td></tr>`;

/** Auto-reply to the person who wrote in. */
export function visitorEmail() {
  const html = shell(`${MARK}
<tr><td style="font-family:${FONT};font-size:30px;line-height:1.25;font-weight:300;letter-spacing:-0.01em;color:${WHITE};padding:0 0 20px;">Thank you.</td></tr>
<tr><td style="font-family:${FONT};font-size:15px;line-height:1.65;color:${MUTED};">Your message has arrived. We&rsquo;ll reply shortly.</td></tr>
${FOOTER}`);

  const text = `YIDDI WELLER

Thank you.

Your message has arrived. We'll reply shortly.

${site.url}`;

  return { subject: "Thank you", html, text };
}

/** Notification to the site owner, carrying the submission. */
export function ownerEmail(fields: {
  name: string;
  email: string;
  message: string;
}) {
  const row = (label: string, value: string) =>
    `<tr><td style="font-family:${FONT};font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:${FAINT};padding:0 0 6px;">${label}</td></tr>
<tr><td style="font-family:${FONT};font-size:15px;line-height:1.5;color:${WHITE};padding:0 0 26px;">${value}</td></tr>`;

  const html = shell(`${MARK}
${row("Name", escapeHtml(fields.name))}
${row("Email", `<a href="mailto:${escapeHtml(fields.email)}" style="color:${WHITE};text-decoration:none;">${escapeHtml(fields.email)}</a>`)}
<tr><td style="font-family:${FONT};font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:${FAINT};padding:0 0 6px;">Message</td></tr>
<tr><td style="font-family:${FONT};font-size:15px;line-height:1.65;color:${WHITE};white-space:pre-wrap;">${escapeHtml(fields.message)}</td></tr>
${FOOTER}`);

  const text = `Name: ${fields.name}\nEmail: ${fields.email}\n\nMessage:\n${fields.message}`;

  return { subject: `New message from ${oneLine(fields.name)}`, html, text };
}

/**
 * The Studio sign-in link. Deliberately bare: an internal entrance, not a
 * marketing email. The URL is never logged anywhere, because possession of it
 * is possession of the session it would create.
 */
export async function sendMagicLinkEmail(input: {
  to: string;
  url: string;
  minutes: number;
}): Promise<void> {
  const { Resend } = await import("resend");
  const { emailConfig } = await import("./env.ts");
  const { apiKey, from: fromAddress } = emailConfig();

  const from = fromAddress.includes("<")
    ? fromAddress
    : `${site.name} Studio <${fromAddress}>`;

  const html = shell(`<tr><td style="font-family:${FONT};font-size:12px;letter-spacing:0.3em;color:${MUTED};text-transform:uppercase;padding:0 0 8px;">Yiddi&nbsp;Weller</td></tr>
<tr><td style="font-family:${FONT};font-size:12px;letter-spacing:0.3em;color:${FAINT};text-transform:uppercase;padding:0 0 56px;">Studio</td></tr>
<tr><td style="font-family:${FONT};font-size:30px;line-height:1.25;font-weight:300;letter-spacing:-0.01em;color:${WHITE};padding:0 0 20px;">Sign in.</td></tr>
<tr><td style="font-family:${FONT};font-size:15px;line-height:1.65;color:${MUTED};padding:0 0 32px;">This link opens Studio and expires in ${input.minutes} minutes. If you did not ask for it, nothing happens &mdash; ignore it.</td></tr>
<tr><td style="padding:0 0 8px;"><a href="${input.url}" style="display:inline-block;font-family:${FONT};font-size:15px;color:${BG};background:${WHITE};padding:14px 28px;text-decoration:none;">Open Studio</a></td></tr>`);

  const text = `YIDDI WELLER STUDIO

Sign in.

This link opens Studio and expires in ${input.minutes} minutes.
If you did not ask for it, ignore this message.

${input.url}`;

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from,
    to: input.to,
    subject: "Sign in to Studio",
    html,
    text,
  });

  if (error) throw new Error(`magic link delivery rejected: ${error.name}`);
}

/** The one route into Studio. Sent by an Owner, single use, expiring. */
export async function sendInvitationEmail(input: {
  to: string;
  url: string;
  invitedBy: string;
}): Promise<void> {
  const { Resend } = await import("resend");
  const { emailConfig } = await import("./env.ts");
  const { apiKey, from: fromAddress } = emailConfig();

  const from = fromAddress.includes("<")
    ? fromAddress
    : `${site.name} Studio <${fromAddress}>`;

  const html = shell(`<tr><td style="font-family:${FONT};font-size:12px;letter-spacing:0.3em;color:${MUTED};text-transform:uppercase;padding:0 0 8px;">Yiddi&nbsp;Weller</td></tr>
<tr><td style="font-family:${FONT};font-size:12px;letter-spacing:0.3em;color:${FAINT};text-transform:uppercase;padding:0 0 56px;">Studio</td></tr>
<tr><td style="font-family:${FONT};font-size:30px;line-height:1.25;font-weight:300;letter-spacing:-0.01em;color:${WHITE};padding:0 0 20px;">You have been invited.</td></tr>
<tr><td style="font-family:${FONT};font-size:15px;line-height:1.65;color:${MUTED};padding:0 0 32px;">${escapeHtml(input.invitedBy)} has given you access to Yiddi Weller Studio. This invitation is single use and expires in seven days.</td></tr>
<tr><td style="padding:0 0 8px;"><a href="${input.url}" style="display:inline-block;font-family:${FONT};font-size:15px;color:${BG};background:${WHITE};padding:14px 28px;text-decoration:none;">Accept invitation</a></td></tr>`);

  const text = `YIDDI WELLER STUDIO

You have been invited.

${input.invitedBy} has given you access to Yiddi Weller Studio.
This invitation is single use and expires in seven days.

${input.url}`;

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from,
    to: input.to,
    subject: "You have been invited to Yiddi Weller Studio",
    html,
    text,
  });

  if (error) throw new Error(`invitation delivery rejected: ${error.name}`);
}

/* ----------------------------------------------------- client workrooms */

/**
 * The two messages a client receives. Both are deliberately quiet.
 *
 * **Neither subject names the project or the client.** A subject line is
 * visible on a lock screen, in a notification, over somebody's shoulder on a
 * train, and it is the one part of an email that leaks without being opened.
 * "Your Yiddi Weller workroom" says enough.
 */
async function sendClientEmail(input: {
  to: string;
  subject: string;
  html: string;
  text: string;
  kind: string;
}): Promise<void> {
  const { Resend } = await import("resend");
  const { emailConfig } = await import("./env.ts");
  const { apiKey, from: fromAddress } = emailConfig();

  const from = fromAddress.includes("<") ? fromAddress : `${site.name} <${fromAddress}>`;

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from,
    to: input.to,
    subject: oneLine(input.subject),
    html: input.html,
    text: input.text,
  });

  if (error) throw new Error(`${input.kind} delivery rejected: ${error.name}`);
}

/** An invitation into one Workroom. The link renders a page; it consumes nothing. */
export async function sendWorkroomInvitationEmail(input: {
  to: string;
  url: string;
  /** Who is inviting them, so the message has a person behind it. */
  invitedBy: string;
  days: number;
}): Promise<void> {
  const by = escapeHtml(input.invitedBy);

  const html = shell(`${MARK}
<tr><td style="font-family:${FONT};font-size:30px;line-height:1.25;font-weight:300;letter-spacing:-0.01em;color:${WHITE};padding:0 0 20px;">Your workroom is ready.</td></tr>
<tr><td style="font-family:${FONT};font-size:15px;line-height:1.65;color:${MUTED};padding:0 0 32px;">${by} has opened a private space for your project. Everything about the work lives there, and only the people invited to it can see it.</td></tr>
<tr><td style="padding:0 0 24px;"><a href="${input.url}" style="display:inline-block;font-family:${FONT};font-size:15px;color:${BG};background:${WHITE};padding:14px 28px;text-decoration:none;">Open your workroom</a></td></tr>
<tr><td style="font-family:${FONT};font-size:13px;line-height:1.6;color:${FAINT};">This link is yours alone and expires in ${input.days} days. If you were not expecting it, ignore this message &mdash; nothing happens until you open it.</td></tr>
${FOOTER}`);

  const text = `YIDDI WELLER

Your workroom is ready.

${input.invitedBy} has opened a private space for your project.
Only the people invited to it can see it.

${input.url}

This link is yours alone and expires in ${input.days} days.
If you were not expecting it, ignore this message.`;

  await sendClientEmail({
    to: input.to,
    subject: "Your Yiddi Weller workroom",
    html,
    text,
    kind: "workroom invitation",
  });
}

/** Coming back later. Passwordless, so this is the whole sign-in. */
export async function sendWorkroomLinkEmail(input: {
  to: string;
  url: string;
  minutes: number;
}): Promise<void> {
  const html = shell(`${MARK}
<tr><td style="font-family:${FONT};font-size:30px;line-height:1.25;font-weight:300;letter-spacing:-0.01em;color:${WHITE};padding:0 0 20px;">Your sign-in link.</td></tr>
<tr><td style="font-family:${FONT};font-size:15px;line-height:1.65;color:${MUTED};padding:0 0 32px;">This opens your workroom and expires in ${input.minutes} minutes. If you did not ask for it, nothing happens &mdash; ignore it.</td></tr>
<tr><td style="padding:0 0 8px;"><a href="${input.url}" style="display:inline-block;font-family:${FONT};font-size:15px;color:${BG};background:${WHITE};padding:14px 28px;text-decoration:none;">Open your workroom</a></td></tr>
${FOOTER}`);

  const text = `YIDDI WELLER

Your sign-in link.

This opens your workroom and expires in ${input.minutes} minutes.
If you did not ask for it, ignore this message.

${input.url}`;

  await sendClientEmail({
    to: input.to,
    subject: "Your Yiddi Weller workroom",
    html,
    text,
    kind: "workroom sign-in",
  });
}
