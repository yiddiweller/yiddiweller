"use client";

import { createAuthClient } from "better-auth/react";
import { magicLinkClient } from "better-auth/client/plugins";

/**
 * The browser half of client authentication.
 *
 * Its own base path, so a request from a Workroom page can never reach Studio's
 * endpoints. Nothing secret is here — the base path is not a credential — and
 * nothing from `lib/env.ts` may be imported into a "use client" module.
 */
const client = createAuthClient({
  basePath: "/api/client-auth",
  plugins: [magicLinkClient()],
});

export const signOut = client.signOut;
export const signIn = client.signIn;
