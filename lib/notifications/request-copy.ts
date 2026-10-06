import type { NotificationMode } from "./mode.ts";

/**
 * What Studio says about the email a request for feedback sends (G2). Pure,
 * so every combination is tested, and the words live in one place — the same
 * device `lib/workrooms/publish-copy.ts` uses for the publish dialog.
 *
 * **Before** asking, the dialog cannot know how many people will be emailed
 * without a second query that could disagree with the transaction, so it
 * says who: the Workroom's active client members. **After**, the action knows
 * exactly how many rows its own transaction wrote, and says that.
 *
 * The preview never claims a client was emailed. Capture says no client email
 * is sent; a redirect says it goes to the preview's test inbox — and neither
 * ever names an address.
 */

type Mode = NotificationMode["mode"];

const ASKED = "Asked the client for their thoughts on this version.";

const BEFORE: Record<Mode, string> = {
  live: "Active client members of this workroom will be emailed a link to this version.",
  capture: "Beta captures notification emails; no client email will be sent.",
  redirect: "Beta sends notification emails to its test inbox only; no client email will be sent.",
};

/** The confirmation's one sentence on the consequence. */
export function requestDialogMessage(mode: Mode): string {
  return `The client can write on it until you close it. ${BEFORE[mode]}`;
}

function members(n: number): string {
  return n === 1 ? "1 client member" : `${n} client members`;
}

/**
 * The confirmation after a request went out. Zero is not a failure: the round
 * is open, nobody can be emailed yet, and that is said plainly.
 */
export function requestedMessage(notified: number, mode: Mode): string {
  if (notified === 0) return `${ASKED} No active client members are currently available to email.`;
  if (mode === "capture") return `${ASKED} Beta captured the email for ${members(notified)}; no client email was sent.`;
  if (mode === "redirect") return `${ASKED} The email for ${members(notified)} goes to beta's test inbox only.`;
  return `${ASKED} ${members(notified)} will be emailed.`;
}
