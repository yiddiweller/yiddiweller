/**
 * Server-only environment access.
 *
 * Do not import from a "use client" component: Next.js exposes only
 * NEXT_PUBLIC_ variables to the browser, so every value here would read as
 * undefined there. Nothing in this file may ever be given a NEXT_PUBLIC_
 * prefix — all of it is secret or infrastructural.
 *
 * Every accessor is a function rather than a module-level constant so that a
 * missing variable fails at the point of use with a named error, instead of
 * throwing while the module graph loads. That distinction matters because
 * `next build` runs with no runtime secrets present: eager validation here
 * would break the build rather than the request.
 */

/** Thrown when required server configuration is absent. Never carries a value. */
export class MissingEnvError extends Error {
  readonly keys: string[];

  constructor(keys: string[]) {
    super(`Missing required server configuration: ${keys.join(", ")}`);
    this.name = "MissingEnvError";
    this.keys = keys;
  }
}

function read(key: string): string | undefined {
  const value = process.env[key];
  return value && value.trim() ? value.trim() : undefined;
}

function requireAll(keys: string[]): Record<string, string> {
  const found: Record<string, string> = {};
  const missing: string[] = [];

  for (const key of keys) {
    const value = read(key);
    if (value) found[key] = value;
    else missing.push(key);
  }

  if (missing.length > 0) throw new MissingEnvError(missing);
  return found;
}

/**
 * The preview service on Railway sets SITE_ENV=preview; production leaves it
 * unset. Read at build time, so changing it requires a redeploy.
 */
export const isPreview = process.env.SITE_ENV === "preview";

/** PostgreSQL connection string. Throws MissingEnvError when absent. */
export function databaseUrl(): string {
  return requireAll(["DATABASE_URL"]).DATABASE_URL;
}

export type EmailConfig = {
  apiKey: string;
  from: string;
  to: string;
};

/** Resend configuration. Throws MissingEnvError when any part is absent. */
export function emailConfig(): EmailConfig {
  const found = requireAll(["RESEND_API_KEY", "RESEND_FROM_EMAIL", "CONTACT_EMAIL"]);
  return {
    apiKey: found.RESEND_API_KEY,
    from: found.RESEND_FROM_EMAIL,
    to: found.CONTACT_EMAIL,
  };
}

/**
 * Secret used by Better Auth to sign sessions and magic-link tokens.
 * Rotating it invalidates every live session, which is the intended behaviour
 * in an incident.
 */
export function authSecret(): string {
  return requireAll(["BETTER_AUTH_SECRET"]).BETTER_AUTH_SECRET;
}

/**
 * Absolute origin this deployment is reached at, e.g. `https://example.com`.
 * Magic links are built from it, so a wrong value sends beta sign-in links to
 * production. Each environment sets its own; there is no shared default.
 */
export function appUrl(): string {
  return requireAll(["APP_URL"]).APP_URL.replace(/\/+$/, "");
}

/**
 * Secret used by the **client** Better Auth instance, which is a different
 * instance from the staff one and must never share its secret. Per
 * environment, like `BETTER_AUTH_SECRET`: one shared between beta and
 * production would make a beta client session valid in production.
 */
export function clientAuthSecret(): string {
  return requireAll(["CLIENT_AUTH_SECRET"]).CLIENT_AUTH_SECRET;
}

/**
 * The public origin clients reach, e.g. `https://yiddiweller.com`.
 *
 * Deliberately separate from `APP_URL`, which in production is the *Studio*
 * origin. Workroom invitations and client sign-in links are built from this, so
 * a wrong value sends a client a link into the other environment — or, worse,
 * to a host their session cookie was never scoped to.
 */
export function clientAuthUrl(): string {
  return requireAll(["CLIENT_AUTH_URL"]).CLIENT_AUTH_URL.replace(/\/+$/, "");
}

/** Absolute base for a link into a Workroom. */
export function workroomUrl(path = ""): string {
  return `${clientAuthUrl()}/workrooms${path}`;
}

/**
 * Host that serves Studio at its root, e.g. `studio.yiddiweller.com`.
 * Unset while the subdomain is disconnected, which is the current state: Studio
 * is then reachable only at the `/studio` path on non-public hosts.
 */
export function studioHost(): string | undefined {
  return read("STUDIO_HOST")?.toLowerCase();
}

/**
 * Absolute base for a link into Studio, e.g. an invitation.
 *
 * While STUDIO_HOST is unset — the current state — Studio lives under the
 * `/studio` path of this deployment, so that is what a link must point at.
 * Once the subdomain is connected, Studio is the root of its own host and the
 * path prefix disappears. Building invitation links from APP_URL alone would
 * be right today and silently wrong the day the subdomain exists, because
 * `/studio/join` does not resolve on the public host at all.
 *
 * Connecting the subdomain also requires Better Auth's baseURL to move to it,
 * since its session cookie is host-scoped. Recorded in docs/studio.md.
 */
export function studioUrl(): string {
  const host = studioHost();
  return host ? `https://${host}` : `${appUrl()}/studio`;
}
