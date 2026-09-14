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
