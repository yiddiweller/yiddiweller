/**
 * How long a signed URL for **viewing** a file lives — the one place it is
 * decided (Stage F6.1).
 *
 * **Fifteen minutes, and nothing may lengthen it.** Viewing is a session: a
 * player comes back for more bytes minutes after the page loaded, so sixty
 * seconds would make a video unseekable after the first minute. Fifteen minutes
 * is still short-lived and worthless once it lapses. It is not a permanent URL
 * and must never become one.
 *
 * **A shorten-only override, for beta alone.** `VIEW_TTL_OVERRIDE_SECONDS` lets
 * the automated tests and a real-beta walk watch a URL expire without waiting a
 * quarter of an hour. It is honoured only where the service says it is the
 * preview (`SITE_ENV=preview`, read at the moment of use), so production cannot
 * be shortened even if the variable reaches it by mistake — and
 * `npm run env:check` refuses it outside the preview by name. It must be a
 * whole number of seconds from 30 to 900. Anything else — blank, zero,
 * negative, a fraction, words, or more than 900 — is ignored and the default
 * applies: a value that cannot be read never makes a URL live longer, and
 * never makes one live so briefly that nothing can load.
 *
 * Downloads (sixty seconds) and uploads (fifteen minutes) are not this, and
 * the override does not touch them.
 *
 * Pure: it reads the environment it is given and nothing else, so the rule is
 * tested as data.
 */

/** The view TTL everywhere, unless the preview has been shortened. */
export const VIEW_TTL_SECONDS = 15 * 60;

export const VIEW_TTL_OVERRIDE_KEY = "VIEW_TTL_OVERRIDE_SECONDS";

/** The shortest a view URL may be made to live: long enough to load a file at all. */
export const VIEW_TTL_OVERRIDE_MIN = 30;

/** What the override amounts to in an environment — said, never guessed. */
export type ViewTtlOverride =
  | { status: "absent" }
  /** Set, but this is not the preview: production is never shortened. */
  | { status: "ignored_outside_preview" }
  /** Set, in the preview, to something that is not an allowed number of seconds. */
  | { status: "invalid" }
  | { status: "applied"; seconds: number };

type Env = Record<string, string | undefined>;

// A whole number, as the variable is written: digits only, no sign, no point,
// no exponent, no leading zero — surrounding whitespace aside.
const WHOLE_SECONDS = /^[1-9][0-9]{0,5}$/;

export function readViewTtlOverride(env: Env = process.env): ViewTtlOverride {
  const raw = env[VIEW_TTL_OVERRIDE_KEY];
  if (raw === undefined) return { status: "absent" };
  if (env.SITE_ENV !== "preview") return { status: "ignored_outside_preview" };

  const value = raw.trim();
  if (!WHOLE_SECONDS.test(value)) return { status: "invalid" };
  const seconds = Number(value);
  if (seconds < VIEW_TTL_OVERRIDE_MIN || seconds > VIEW_TTL_SECONDS) return { status: "invalid" };
  return { status: "applied", seconds };
}

/** How long a view URL signed now will live, in seconds. Never more than 900. */
export function effectiveViewTtlSeconds(env: Env = process.env): number {
  const override = readViewTtlOverride(env);
  return override.status === "applied" ? Math.min(override.seconds, VIEW_TTL_SECONDS) : VIEW_TTL_SECONDS;
}
