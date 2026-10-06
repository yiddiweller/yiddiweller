import { NextResponse, type NextRequest } from "next/server";

import { classifyHost, RETURN_HEADER, studioPathAllowed, STUDIO_PREFIX, WORKROOM_PREFIX } from "@/lib/hosts";

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
  const { pathname, search } = request.nextUrl;

  if (kind === "studio") {
    // Auth endpoints are shared infrastructure and must not be rewritten.
    if (pathname.startsWith("/api/")) return NextResponse.next({ request: { headers: returning(request, null) } });
    if (pathname.startsWith(STUDIO_PREFIX)) {
      return NextResponse.next({ request: { headers: returning(request, `${pathname}${search}`) } });
    }

    // The return address is the prefixed path, which resolves on this host as
    // it is — so the guard writes one shape of Studio address on every host.
    const studioPath = `${STUDIO_PREFIX}${pathname === "/" ? "" : pathname}`;
    const url = request.nextUrl.clone();
    url.pathname = studioPath;
    return NextResponse.rewrite(url, { request: { headers: returning(request, `${studioPath}${search}`) } });
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
    const response = NextResponse.next({ request: { headers: returning(request, `${pathname}${search}`) } });
    response.headers.set("Cache-Control", "private, no-store, max-age=0, must-revalidate");
    response.headers.set("Referrer-Policy", "same-origin");
    return response;
  }

  if (pathname.startsWith(STUDIO_PREFIX) && !studioPathAllowed(kind)) {
    // Rewriting to a 404 rather than redirecting, so the public host gives no
    // signal that Studio exists behind it.
    const url = request.nextUrl.clone();
    url.pathname = "/_not-found";
    return NextResponse.rewrite(url, { status: 404, request: { headers: returning(request, null) } });
  }

  const studioPage = pathname.startsWith(STUDIO_PREFIX) ? `${pathname}${search}` : null;
  return NextResponse.next({ request: { headers: returning(request, studioPage) } });
}

/**
 * The request's headers with the return address set to the page asked for —
 * or removed, for anything that is not a Workroom or Studio page. Whatever the
 * browser sent under that name is discarded either way: only this function
 * ever writes it. See `RETURN_HEADER`.
 */
function returning(request: NextRequest, path: string | null): Headers {
  const headers = new Headers(request.headers);
  headers.delete(RETURN_HEADER);
  if (path !== null) headers.set(RETURN_HEADER, path);
  return headers;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
