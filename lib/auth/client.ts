"use client";

import { magicLinkClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/**
 * Browser-side auth calls. Imported only by Studio client components, never by
 * anything the public site renders, so none of this reaches a public bundle.
 */
export const authClient = createAuthClient({
  plugins: [magicLinkClient()],
});

export const { signOut, useSession } = authClient;
