import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@/lib/auth/config";

/**
 * Better Auth's own endpoints: requesting a magic link, verifying one, reading
 * the session, signing out. Node runtime because the session store is Postgres.
 *
 * Reached at /api/auth/* on every host. That is deliberate and safe: the
 * endpoints authorise themselves, sign-up is disabled, and a link can only be
 * sent to an address that already has a staff record.
 *
 * `auth()` is called inside each handler rather than at module scope on
 * purpose. Next.js evaluates this module while collecting route configuration
 * during `next build`, and the build runs with no runtime configuration at all
 * — that is the property the Dockerfile depends on. Constructing the Better
 * Auth instance up here would read APP_URL and BETTER_AUTH_SECRET at build
 * time and fail the build, and the fix for that must never be to pass either
 * one in as a build argument. The instance is memoised, so this costs one
 * lookup per request.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return toNextJsHandler(auth()).GET(request);
}

export async function POST(request: Request): Promise<Response> {
  return toNextJsHandler(auth()).POST(request);
}
