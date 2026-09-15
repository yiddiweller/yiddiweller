import { isPreview, studioHost } from "./env.ts";
import { site } from "./site.ts";

/**
 * Which of the two worlds a request belongs to, decided by Host.
 *
 * The platform has exactly two: the public and client world at
 * yiddiweller.com, and the private team world at studio.yiddiweller.com. One
 * application serves both, so every request has to be classified before
 * anything else happens.
 *
 *   studio      the Studio host. `/` is Studio's root.
 *   public      the real public site. Studio paths must not resolve at all.
 *   internal    beta preview or localhost. Studio is reachable at /studio,
 *               because the Studio subdomain is deliberately not connected yet.
 */
export type HostKind = "studio" | "public" | "internal";

export const STUDIO_PREFIX = "/studio";

function hostname(host: string | null): string {
  if (!host) return "";
  // Strip the port; Host carries it on localhost and in some proxies.
  return host.split(":")[0].trim().toLowerCase();
}

/** The canonical public hostname, derived from the one place it is configured. */
export function publicHostname(): string {
  try {
    return new URL(site.url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function classifyHost(host: string | null): HostKind {
  const name = hostname(host);
  const studio = studioHost();

  if (studio && name === studio) return "studio";

  // Local development. Studio is reachable at /studio.
  if (!name || name === "localhost" || name === "127.0.0.1" || name.endsWith(".localhost")) {
    return "internal";
  }

  // The beta preview deployment. Non-indexable, and the only place Studio is
  // exercised until the subdomain is connected.
  if (isPreview) return "internal";

  // Anything else reaching this deployment in production is the public site,
  // including the apex, www, and any Railway-generated hostname pointed at it.
  return name === publicHostname() || name === `www.${publicHostname()}` ? "public" : "public";
}

/**
 * Whether a Studio path may resolve for this host.
 *
 * False on the real public host. That is not the security boundary — every
 * Studio route and action authorises server-side regardless — it is what stops
 * yiddiweller.com/studio from being a doorway into internal software at all.
 */
export function studioPathAllowed(kind: HostKind): boolean {
  return kind === "internal";
}
