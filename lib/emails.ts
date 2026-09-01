import { site } from "@/lib/site";

/** Inline styles and table layout only: email clients strip <style> blocks. */
const BG = "#000000";
const WHITE = "#ffffff";
const MUTED = "#b3b3b3"; // white at 70% over black
const FAINT = "#6b6b6b";
const RULE = "#262626";
const FONT =
  "-apple-system,BlinkMacSystemFont,'Helvetica Neue',Helvetica,Arial,sans-serif";

export function escapeHtml(value: string): string {
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

const FOOTER = `<tr><td style="padding:56px 0 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="height:1px;line-height:1px;font-size:0;background:${RULE};">&nbsp;</td></tr></table></td></tr>
<tr><td style="font-family:${FONT};font-size:12px;letter-spacing:0.04em;color:${FAINT};padding:20px 0 0;"><a href="${site.url}" style="color:${FAINT};text-decoration:none;">yiddiweller.com</a></td></tr>`;

/** Auto-reply to the person who wrote in. */
export function visitorEmail() {
  const html = shell(`${MARK}
<tr><td style="font-family:${FONT};font-size:30px;line-height:1.25;font-weight:300;letter-spacing:-0.01em;color:${WHITE};padding:0 0 20px;">Thank you.</td></tr>
<tr><td style="font-family:${FONT};font-size:15px;line-height:1.65;color:${MUTED};">Your message has arrived. I&rsquo;ll reply shortly.</td></tr>
${FOOTER}`);

  const text = `YIDDI WELLER

Thank you.

Your message has arrived. I'll reply shortly.

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

  return { subject: `New message from ${fields.name}`, html, text };
}
