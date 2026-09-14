/**
 * Server-only. Do not import from a "use client" component: Next.js exposes
 * only NEXT_PUBLIC_ variables to the browser, so the flag would silently read
 * false there.
 *
 * The preview service on Railway sets SITE_ENV=preview; production leaves it
 * unset. Read at build time, so changing it requires a redeploy.
 */
export const isPreview = process.env.SITE_ENV === "preview";
