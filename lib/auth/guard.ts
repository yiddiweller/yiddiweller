import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { type Staff } from "../db/staff.ts";
import { STUDIO_PREFIX } from "../hosts.ts";
import { staffForEmail } from "./access.ts";
import { auth } from "./config.ts";

/**
 * Server-side authorization. Every Studio page, action and route handler goes
 * through one of these before touching data.
 *
 * Hiding a link is not security, and neither is an unguessable path. These run
 * on the server on every request, so a deactivated member loses access on their
 * very next navigation rather than whenever their cookie happens to expire.
 */

/** The signed-in, still-active staff member, or null. Never throws. */
export async function currentStaff(): Promise<Staff | null> {
  const session = await auth().api.getSession({ headers: await headers() });
  return staffForEmail(session?.user?.email);
}

/**
 * The address on the session cookie, whatever Studio thinks of it.
 *
 * Only the entrance needs this. Somebody whose access was removed still holds
 * a valid Better Auth session — the two are different questions — and without
 * this the sign-in page would show them an empty form for ever, with no way to
 * learn why signing in keeps failing. Every guard above uses `staffForEmail`;
 * this one is never an access check.
 */
export async function sessionEmail(): Promise<string | null> {
  const session = await auth().api.getSession({ headers: await headers() });
  return session?.user?.email ?? null;
}

/** Requires a signed-in active member. Sends anyone else to sign in. */
export async function requireStaff(): Promise<Staff> {
  const staff = await currentStaff();
  if (!staff) redirect(`${STUDIO_PREFIX}/login`);
  return staff;
}

/**
 * Requires the Owner role. Answers not-found rather than forbidden for a
 * signed-in Member, so Studio does not confirm to a non-Owner that a given
 * management surface exists at all.
 *
 * **Where this must be called, and it is not a style preference.** Measured
 * against a running build, not assumed:
 *
 *   guard in the page, before the read       404, nothing fetched  — correct
 *   guard in the page, loading.tsx above it  200, nothing fetched  — wrong status
 *   guard in a parent layout                 404, but the page ran
 *                                            and shipped its data  — a leak
 *
 * A parent layout does not gate its children: Next renders layout and page
 * concurrently, so a page that fetches protected data will fetch and ship it
 * while the layout is still deciding. And any Suspense boundary above the page
 * — a `loading.tsx` in that segment or an ancestor — flushes the shell first,
 * after which the status can no longer be set and a refusal arrives as 200.
 *
 * So: call this **inside the component that reads the data, before it reads**,
 * and do not put a `loading.tsx` above a guarded page. The guard in
 * `(app)/layout.tsx` is defence in depth and the thing that produces the
 * redirect for an anonymous request; it is not what protects a page's data.
 */
export async function requireOwner(): Promise<Staff> {
  const staff = await requireStaff();
  if (staff.role !== "owner") notFound();
  return staff;
}
