import { EMAIL } from "../contact.ts";

/**
 * Where Stage G notifications may go, by environment (G1). Pure: it reads the
 * environment it is handed and decides; it sends nothing and nothing calls it
 * yet. G2's dispatcher will ask it before every delivery.
 *
 *   production (not the preview)        live — to the real recipient;
 *                                       `NOTIFICATION_REDIRECT_TO` is never
 *                                       honoured here, and `env:check` refuses
 *                                       it by name
 *   preview, no redirect                capture — recorded, never sent
 *   preview, a valid redirect           redirect — every notification goes to
 *                                       that one address instead
 *   preview, a malformed redirect       capture — never a guess at an address
 *
 * **Notifications only.** Sign-in links, Workroom and Studio invitations and
 * the contact form keep their own paths and never consult this: a preview's
 * sign-in has to reach the person signing in, and a guard that swallowed it
 * would lock beta out of itself. A test holds that separation.
 *
 * Beta can reach real people — its sign-in mail is real — so the preview's
 * default is the one that cannot: capture.
 */

export type NotificationMode = { mode: "live" } | { mode: "capture" } | { mode: "redirect"; to: string };

export const REDIRECT_VARIABLE = "NOTIFICATION_REDIRECT_TO";

type Env = Record<string, string | undefined>;

const isPreview = (env: Env) => env.SITE_ENV?.trim() === "preview";

/** Whether a value is one email address, by the project's one rule for that. */
export function isRedirectAddress(value: string): boolean {
  return value.length <= 254 && EMAIL.test(value);
}

/** Read at the moment of use, so a redeploy is never needed to stop capturing. */
export function notificationMode(env: Env = process.env): NotificationMode {
  if (!isPreview(env)) return { mode: "live" };
  const raw = env[REDIRECT_VARIABLE]?.trim();
  if (!raw || !isRedirectAddress(raw)) return { mode: "capture" };
  return { mode: "redirect", to: raw };
}

/**
 * What is wrong with the redirect's configuration, if anything — named, never
 * quoted. `env:check` applies the same rule in plain JavaScript; a test holds
 * the two to one answer.
 */
export function redirectProblem(env: Env = process.env): "outside_preview" | "malformed" | null {
  const raw = env[REDIRECT_VARIABLE];
  if (raw === undefined) return null;
  if (!isPreview(env)) return "outside_preview";
  return isRedirectAddress(raw.trim()) ? null : "malformed";
}
