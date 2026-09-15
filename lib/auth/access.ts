import { findStaffByEmail, type Staff } from "../db/staff.ts";

/**
 * The access decision, with no framework around it.
 *
 * It lives apart from `guard.ts` because that file imports `next/headers` and
 * `next/navigation`, which only resolve inside a Next.js request. Keeping the
 * rule here means the rule itself can be tested directly, rather than inferred
 * from the code that calls it.
 */
export async function staffForEmail(email: string | null | undefined): Promise<Staff | null> {
  if (!email) return null;

  // Read from the database rather than trusting a session payload, so a role
  // or status change takes effect on the very next request.
  const staff = await findStaffByEmail(email);
  if (!staff || staff.status !== "active") return null;

  return staff;
}
