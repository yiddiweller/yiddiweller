import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { findActiveIdentity, type ViewerIdentity } from "../db/workrooms.ts";

import { clientAuth } from "./config.ts";

/**
 * Server-side authorization for everyone outside the company.
 *
 * The same rule Studio has followed since Build 002, and for the same measured
 * reason: **call this inside the component that reads, before it reads.** A
 * guard in a parent layout does not gate its page — Next renders them
 * concurrently, so the page fetches and ships its data while the layout is
 * still deciding — and any Suspense boundary above a guarded page turns a
 * refusal into a 200. There is no `loading.tsx` anywhere under `/workrooms`.
 *
 * The session tells us who is asking. It never tells us what they may see:
 * membership is read from the database on every request, so revoking access
 * takes effect on the client's next click rather than when their cookie
 * happens to expire.
 */

/** The signed-in client, or null. Never throws, never redirects. */
export async function currentViewer(): Promise<ViewerIdentity | null> {
  const session = await clientAuth().api.getSession({ headers: await headers() });
  const id = session?.user?.id;
  if (!id) return null;

  // Re-read from our own tables rather than trusting the session's copy: a
  // disabled identity or an archived contact loses access on the next request.
  return findActiveIdentity(id);
}

/** Requires a signed-in client. Sends anyone else to the entrance. */
export async function requireViewer(): Promise<ViewerIdentity> {
  const viewer = await currentViewer();
  if (!viewer) redirect("/workrooms/login");
  return viewer;
}
