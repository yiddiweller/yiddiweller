import { BG, escapeHtml, FAINT, FONT, FOOTER, MARK, MUTED, oneLine, shell, WHITE } from "../emails.ts";
import type { NotificationKind } from "./vocabulary.ts";

/**
 * The two Stage G messages, as subject, HTML and plain text (G1). Pure: no
 * provider, no database, no clock — a view in, a message out. Nothing sends
 * them yet; G2's dispatcher will render one at the moment it sends, from what
 * is true then.
 *
 * **What a message may say is narrow on purpose.** A subject names no
 * Presentation, no Workroom, no person and no feedback: it is the part of an
 * email that shows on a lock screen. A body may name the Presentation and its
 * version, and the studio's may name the client — escaped, every one — and
 * never carries what anybody wrote, where it points, or any address but the
 * one link it was handed. The link is already the authoritative app URL —
 * the exact immutable version, which G0 carries through signing in — and this
 * module never builds one, least of all to a file.
 *
 * The house style is the transactional mail `lib/emails.ts` already sends:
 * black and white, one column, one button, type rather than images, no
 * tracking. One small renderer, not a template system.
 */

export type RenderedMail = { subject: string; html: string; text: string };

/** A client asked for their thoughts on one version. */
export type RequestedView = {
  presentationTitle: string;
  version: number;
  /** The client's immutable Revision page. */
  url: string;
};

/** The studio, told a round has feedback. */
export type ReceivedView = {
  presentationTitle: string;
  version: number;
  /** The client's name as the round knows it, or null to say "A client". */
  clientName: string | null;
  /** Studio's immutable Revision page, with `?note=N`. */
  url: string;
};

export const SUBJECTS: Record<NotificationKind, string> = {
  "review.requested": "Your thoughts are requested — Yiddi Weller",
  "review.received": "New feedback in a workroom",
};

/** The only link a message carries: absolute, http(s), no credentials in it. */
function link(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("a notification link must be an absolute URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("a notification link must be http(s)");
  }
  if (parsed.username || parsed.password) throw new Error("a notification link carries no credentials");
  return url;
}

function version(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("a version is a positive whole number");
  return value;
}

const HEADING = (words: string) =>
  `<tr><td style="font-family:${FONT};font-size:30px;line-height:1.25;font-weight:300;letter-spacing:-0.01em;color:${WHITE};padding:0 0 20px;">${words}</td></tr>`;

const PARAGRAPH = (html: string) =>
  `<tr><td style="font-family:${FONT};font-size:15px;line-height:1.65;color:${MUTED};padding:0 0 32px;">${html}</td></tr>`;

const BUTTON = (href: string, label: string) =>
  `<tr><td style="padding:0 0 24px;"><a href="${escapeHtml(href)}" style="display:inline-block;font-family:${FONT};font-size:15px;color:${BG};background:${WHITE};padding:14px 28px;text-decoration:none;">${label}</a></td></tr>`;

const SMALL = (html: string) =>
  `<tr><td style="font-family:${FONT};font-size:13px;line-height:1.6;color:${FAINT};">${html}</td></tr>`;

/** Studio's two-line mark, as its sign-in mail draws it. */
const STUDIO_MARK = `<tr><td style="font-family:${FONT};font-size:12px;letter-spacing:0.3em;color:${MUTED};text-transform:uppercase;padding:0 0 8px;">Yiddi&nbsp;Weller</td></tr>
<tr><td style="font-family:${FONT};font-size:12px;letter-spacing:0.3em;color:${FAINT};text-transform:uppercase;padding:0 0 56px;">Studio</td></tr>`;

/** A label for HTML: one line, escaped. */
const label = (value: string) => escapeHtml(oneLine(value));

function requested(view: RequestedView): RenderedMail {
  const url = link(view.url);
  const n = version(view.version);
  const title = oneLine(view.presentationTitle);

  const html = shell(`${MARK}
${HEADING("Your thoughts are requested.")}
${PARAGRAPH(`The studio would like your thoughts on <span style="color:${WHITE};">${label(title)}</span>, Version&nbsp;${n}. Say as much or as little as you like.`)}
${BUTTON(url, "Open the presentation")}
${SMALL("Write your thoughts in your workroom. A reply to this email reaches the studio, but it is not added to the feedback.")}
${FOOTER}`);

  const text = `YIDDI WELLER

Your thoughts are requested.

The studio would like your thoughts on ${title}, Version ${n}.
Say as much or as little as you like.

${url}

Write your thoughts in your workroom. A reply to this email reaches the
studio, but it is not added to the feedback.`;

  return { subject: oneLine(SUBJECTS["review.requested"]), html, text };
}

function received(view: ReceivedView): RenderedMail {
  const url = link(view.url);
  const n = version(view.version);
  const title = oneLine(view.presentationTitle);
  const who = view.clientName && oneLine(view.clientName) ? oneLine(view.clientName) : "A client";

  const html = shell(`${STUDIO_MARK}
${HEADING("New feedback.")}
${PARAGRAPH(`${label(who)} left feedback on <span style="color:${WHITE};">${label(title)}</span>, Version&nbsp;${n}.`)}
${BUTTON(url, "Open in Studio")}
${SMALL("What they wrote is in Studio, not in this email.")}`);

  const text = `YIDDI WELLER STUDIO

New feedback.

${who} left feedback on ${title}, Version ${n}.

${url}

What they wrote is in Studio, not in this email.`;

  return { subject: oneLine(SUBJECTS["review.received"]), html, text };
}

export function renderNotification(kind: "review.requested", view: RequestedView): RenderedMail;
export function renderNotification(kind: "review.received", view: ReceivedView): RenderedMail;
export function renderNotification(kind: NotificationKind, view: RequestedView | ReceivedView): RenderedMail {
  if (kind === "review.requested") return requested(view as RequestedView);
  if (kind === "review.received") return received(view as ReceivedView);
  throw new Error("no template for that kind");
}
