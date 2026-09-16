/**
 * Where a client authentication flow is allowed to land.
 *
 * Better Auth already refuses a `callbackURL` on another origin, a
 * protocol-relative one and a `javascript:` one — measured. What it cannot know
 * is that on *this* origin `/studio` is a different product with a different
 * identity system, and that `/workrooms` is the only part of the site this
 * flow's sessions mean anything in.
 *
 * So the rule lives here, in one function with no dependencies, rather than
 * being implied by host routing two files away.
 */

/** Where anything not allowed is sent instead. */
export const WORKROOM_HOME = "/workrooms";

/**
 * A destination this flow may send somebody to: a path, on this origin, inside
 * the client world.
 *
 * Rejects anything absolute, anything protocol-relative, anything carrying a
 * scheme, anything with a backslash (which some clients normalise to `/`), and
 * anything using `..` to climb out — checked after decoding and before the
 * prefix, because `/workrooms/../studio` starts with the right ten characters
 * and ends somewhere else entirely.
 */
export function isWorkroomPath(value: string): boolean {
  if (!value.startsWith("/")) return false;
  if (value.startsWith("//")) return false;
  if (value.includes("\\")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;

  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return false;
  }
  if (decoded.includes("..")) return false;

  return (
    decoded === WORKROOM_HOME ||
    decoded.startsWith(`${WORKROOM_HOME}/`) ||
    decoded.startsWith(`${WORKROOM_HOME}?`)
  );
}

/** The destination to actually use: the one asked for, or home. */
export function workroomRedirect(value: unknown): string {
  return typeof value === "string" && isWorkroomPath(value) ? value : WORKROOM_HOME;
}
