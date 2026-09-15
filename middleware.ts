import { NextResponse, type NextRequest } from "next/server";

import { classifyHost, studioPathAllowed, STUDIO_PREFIX } from "@/lib/hosts";

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
