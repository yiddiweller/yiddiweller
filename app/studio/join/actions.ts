"use server";

import { acceptInvitation, type InvitationFailure } from "@/lib/db/staff";
import { describeError, log, redactEmail } from "@/lib/log";

/**
 * The one server action in Studio that an unauthenticated caller may reach.
 * Its authorization is the invitation token itself: 32 random bytes, checked
 * against a stored digest, single use, and expiring in seven days. Nothing here
 * trusts anything the page rendered — `acceptInvitation` re-runs every check.
 *
 * The token is never logged, and neither is the name someone types.
 */

export type JoinResult =
  | { ok: true; email: string }
  | { ok: false; reason: InvitationFailure | "name" };

export async function acceptStaffInvitation(
  _prev: JoinResult | null,
  form: FormData,
): Promise<JoinResult> {
  const token = String(form.get("token") ?? "");
  const name = String(form.get("name") ?? "").trim();

  if (!token) return { ok: false, reason: "invalid" };
  if (name.length < 2 || name.length > 120) return { ok: false, reason: "name" };

  try {
    const result = await acceptInvitation(token, name);
    if (!result.ok) {
      log.info("studio.invite_accept_rejected", { reason: result.reason });
      return result;
    }
    log.info("studio.invite_accepted", {
      email: redactEmail(result.staff.email),
      role: result.staff.role,
    });
    return { ok: true, email: result.staff.email };
  } catch (cause) {
    log.error("studio.invite_accept_failed", { error: describeError(cause) });
    return { ok: false, reason: "invalid" };
  }
}
