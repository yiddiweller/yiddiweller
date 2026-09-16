import { toNextJsHandler } from "better-auth/next-js";

import { clientAuth } from "@/lib/client-auth/config";

/**
 * The client authentication endpoints, on their own path.
 *
 * Deliberately not `/api/auth`, which is Studio's. Two paths, two instances,
 * two cookie names, two secrets: a request to one cannot be answered by the
 * other, and neither can read the other's session.
 *
 * `clientAuth()` is called inside each handler rather than at module load, for
 * the same reason the database connection is: `next build` runs with no runtime
 * secrets, and a module-level instance would fail the build instead of the
 * request.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return toNextJsHandler(clientAuth()).GET(request);
}

export async function POST(request: Request) {
  return toNextJsHandler(clientAuth()).POST(request);
}
