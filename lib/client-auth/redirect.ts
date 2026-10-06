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
 * being implied by host routing two files away. It is the only client redirect
 * rule there is: the sign-in page's `next`, the form's `callbackURL` and the
 * auth instance's hook all go through `isWorkroomPath`.
 *
 * Studio has its own, `lib/auth/redirect.ts`, deliberately not shared: the two
 * namespaces are two security boundaries, and a helper that knew about both
 * would be one edit away from letting either flow land in the other.
 */

/** Where anything not allowed is sent instead. */
export const WORKROOM_HOME = "/workrooms";

/** The client entrance. Never itself a destination to come back to. */
export const WORKROOM_LOGIN = "/workrooms/login";

/** Longer than any real Workroom URL by an order of magnitude. */
const MAX_LENGTH = 2048;

/** C0 controls and DEL — CR and LF among them. Never part of a real path. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * A destination this flow may send somebody to: a path, on this origin, inside
 * the client world.
 *
 * Rejects anything absolute, anything protocol-relative, anything carrying a
 * scheme, anything with a backslash (which some clients normalise to `/`),
 * anything with a control character, and anything using `..` to climb out —
 * checked after decoding and before the prefix, because `/workrooms/../studio`
 * starts with the right ten characters and ends somewhere else entirely. The
 * decoded form is checked as well as the raw one because Better Auth decodes a
 * callback once more before it follows it: what is judged here is what is
 * followed there.
 */
export function isWorkroomPath(value: string): boolean {
  if (value.length > MAX_LENGTH) return false;
  if (!value.startsWith("/")) return false;
  if (value.startsWith("//")) return false;
  if (value.includes("\\")) return false;
  if (CONTROL.test(value)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;

  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return false;
  }
  if (decoded.includes("..")) return false;
  if (decoded.includes("\\")) return false;
  if (CONTROL.test(decoded)) return false;

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

/**
 * Where to go back to once signed in. The same rule as `workroomRedirect`,
 * plus one thing a return address may not be: the entrance itself, which
 * would only send somebody round again.
 */
export function workroomReturn(value: unknown): string {
  const destination = workroomRedirect(value);
  return isEntrance(destination) ? WORKROOM_HOME : destination;
}

/**
 * The entrance, carrying the page somebody was refused from — or the bare
 * entrance when there is nothing worth coming back to.
 *
 * `next` only says where to land. It grants nothing: the page at the other end
 * runs its own authorization when it is reached, exactly as it would have.
 */
export function workroomLoginPath(returnTo: unknown): string {
  const destination = workroomReturn(returnTo);
  return destination === WORKROOM_HOME
    ? WORKROOM_LOGIN
    : `${WORKROOM_LOGIN}?next=${encodeURIComponent(destination)}`;
}

function isEntrance(path: string): boolean {
  return path === WORKROOM_LOGIN || path.startsWith(`${WORKROOM_LOGIN}?`) || path.startsWith(`${WORKROOM_LOGIN}/`);
}
