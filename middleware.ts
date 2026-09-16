import { NextResponse, type NextRequest } from "next/server";

import { classifyHost, studioPathAllowed, STUDIO_PREFIX, WORKROOM_PREFIX } from "@/lib/hosts";

/**
 * Host routing, and nothing else.
 *
 * Runs on the Edge runtime, so it must not touch the database. Authorization
 * is deliberately not done here: every Studio route and action checks the
 * session server-side against Postgres. This decides only which world a
 * request belongs to.
 *
 *   studio.yiddiweller.com/x   ->  rewritten to /studio/x, so Studio lives at
 *                                  the root of its own host
 *   yiddiweller.com/studio     ->  404. Not a doorway into internal software.
 *   beta or localhost /studio  ->  served as-is, which is how Studio is
 *                                  developed while the subdomain is
 *                                  deliberately disconnected
 *
 * Client Workrooms need no routing of their own: they live at `/workrooms` on
 * the public and client host, and the rewrite above already means the Studio
 * host never reaches them — `studio.yiddiweller.com/workrooms` becomes
 * `/studio/workrooms`, which is staff software and asks for a staff session.
 */
export function middleware(request: NextRequest) {
  const kind = classifyHost(request.headers.get("host"));
  const { pathname } = request.nextUrl;

  if (kind === "studio") {
    // Auth endpoints are shared infrastructure and must not be rewritten.
    if (pathname.startsWith("/api/")) return NextResponse.next();
    if (pathname.startsWith(STUDIO_PREFIX)) return NextResponse.next();

    const url = request.nextUrl.clone();
    url.pathname = `${STUDIO_PREFIX}${pathname === "/" ? "" : pathname}`;
    return NextResponse.rewrite(url);
  }

  /**
   * Client Workrooms are one person's private information, so nothing between
   * us and them may store a copy.
   *
   * Set here rather than in `next.config.ts` because Next writes its own
   * `Cache-Control` for a dynamic page after a configured header, and wins.
   * Middleware runs last and does not. `no-cache` alone would only stop a cache
   * *reusing* the response; `no-store` stops it being written down at all.
   */
  if (pathname.startsWith(WORKROOM_PREFIX)) {
    const response = NextResponse.next();
    response.headers.set("Cache-Control", "private, no-store, max-age=0, must-revalidate");
    response.headers.set("Referrer-Policy", "same-origin");
    return response;
  }

  if (pathname.startsWith(STUDIO_PREFIX) && !studioPathAllowed(kind)) {
    // Rewriting to a 404 rather than redirecting, so the public host gives no
    // signal that Studio exists behind it.
    const url = request.nextUrl.clone();
    url.pathname = "/_not-found";
    return NextResponse.rewrite(url, { status: 404 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
