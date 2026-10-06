/**
 * The three places a Better Auth magic link can send somebody, rewritten by a
 * world's own redirect rule.
 *
 * The verify endpoint redirects to `callbackURL` on success, to
 * `errorCallbackURL` on a refused or expired link, and to `newUserCallbackURL`
 * for a first sign-in. All three arrive in the link's query string and all
 * three are followed, so a rule that judged only the first would leave two
 * open. This only applies whichever rule it is given — the client's or
 * Studio's — and knows nothing about either namespace itself.
 */
const CALLBACK_KEYS = ["callbackURL", "errorCallbackURL", "newUserCallbackURL"] as const;

export function sanitiseCallbacks(carrier: unknown, rule: (value: unknown) => string): void {
  if (!carrier || typeof carrier !== "object") return;
  const fields = carrier as Record<string, unknown>;
  for (const key of CALLBACK_KEYS) {
    if (typeof fields[key] === "string") fields[key] = rule(fields[key]);
  }
}
