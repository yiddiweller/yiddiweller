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

/** Requires a signed-in active member. Sends anyone else to sign in. */
export async function requireStaff(): Promise<Staff> {
  const staff = await currentStaff();
  if (!staff) redirect(`${STUDIO_PREFIX}/login`);
  return staff;
}

/**
 * Requires the Owner role. Answers 404 rather than 403 for a signed-in member,
 * so Studio does not confirm to a non-owner that a given management surface
 * exists at all.
 */
export async function requireOwner(): Promise<Staff> {
  const staff = await requireStaff();
  if (staff.role !== "owner") notFound();
  return staff;
}
