/**
 * Where a Studio authentication flow is allowed to land.
 *
 * The staff twin of `lib/client-auth/redirect.ts`, and deliberately a copy of
 * the rule rather than a shared helper: the client world and Studio are two
 * security boundaries on one origin, and a function that knew about both would
 * be one edit away from letting either sign-in land in the other.
 *
 * `/studio` is the path on every host. On the Studio host, Studio is served at
 * its root and `/studio/...` also resolves as-is — which is how `/studio/login`
 * has always worked there — so a destination is always written with the prefix
 * and means the same thing wherever it is followed.
 */

/** Where anything not allowed is sent instead. */
export const STUDIO_HOME = "/studio";

/** The Studio entrance. Never itself a destination to come back to. */
export const STUDIO_LOGIN = "/studio/login";

/** Longer than any real Studio URL by an order of magnitude. */
const MAX_LENGTH = 2048;

/** C0 controls and DEL — CR and LF among them. Never part of a real path. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * A destination a Studio sign-in may send somebody to: a path, on this origin,
 * inside Studio, with its own query if it has one.
 *
 * Refuses anything absolute, protocol-relative, carrying a scheme, a backslash,
 * a control character or a `..` — judged on the raw value and again on the
 * decoded one, because Better Auth decodes a callback once more before it
 * follows it, and what is judged here has to be what is followed there.
 */
export function isStudioPath(value: string): boolean {
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
    decoded === STUDIO_HOME ||
    decoded.startsWith(`${STUDIO_HOME}/`) ||
    decoded.startsWith(`${STUDIO_HOME}?`)
  );
}

/** The destination to actually use: the one asked for, or Studio's root. */
export function studioRedirect(value: unknown): string {
  return typeof value === "string" && isStudioPath(value) ? value : STUDIO_HOME;
}

/**
 * Where to go back to once signed in: `studioRedirect`, except that the
 * entrance itself is never a place to come back to.
 */
export function studioReturn(value: unknown): string {
  const destination = studioRedirect(value);
  return isEntrance(destination) ? STUDIO_HOME : destination;
}

/**
 * The entrance, carrying the page somebody was refused from — or the bare
 * entrance when there is nothing worth coming back to.
 *
 * `next` only says where to land. It grants nothing: the page at the other end
 * runs `requireStaff` and its own checks when it is reached.
 */
export function studioLoginPath(returnTo: unknown): string {
  const destination = studioReturn(returnTo);
  return destination === STUDIO_HOME
    ? STUDIO_LOGIN
    : `${STUDIO_LOGIN}?next=${encodeURIComponent(destination)}`;
}

function isEntrance(path: string): boolean {
  return path === STUDIO_LOGIN || path.startsWith(`${STUDIO_LOGIN}?`) || path.startsWith(`${STUDIO_LOGIN}/`);
}
