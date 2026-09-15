"use server";

import { revalidatePath } from "next/cache";

import { requireOwner } from "@/lib/auth/guard";
import {
  createInvitation,
  findStaffByEmail,
  revokeInvitation,
  setStaffStatus,
} from "@/lib/db/staff";
import { sendInvitationEmail } from "@/lib/emails";
import { studioUrl } from "@/lib/env";
import { describeError, log, redactEmail } from "@/lib/log";
import { STAFF_ROLES, type StaffRole } from "@/lib/db/schema";

/**
 * Owner-only access management. Every action re-checks the caller server-side:
 * a server action is a public endpoint, so the fact that the button is only
 * rendered for Owners protects nothing on its own.
 */

export type ActionResult = { ok: true; message: string } | { ok: false; message: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function inviteStaff(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const owner = await requireOwner();

  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const role = String(form.get("role") ?? "member") as StaffRole;

  if (!EMAIL.test(email) || email.length > 254) {
    return { ok: false, message: "That does not look like an email address." };
  }
  if (!STAFF_ROLES.includes(role)) {
    return { ok: false, message: "Unknown role." };
  }
  if (await findStaffByEmail(email)) {
    return { ok: false, message: "That address already has Studio access." };
  }

  try {
    const { token } = await createInvitation({ email, role, invitedBy: owner.id });
    await sendInvitationEmail({
      to: email,
      url: `${studioUrl()}/join?token=${encodeURIComponent(token)}`,
      invitedBy: owner.name,
    });
    log.info("studio.invite_created", { email: redactEmail(email), role });
    return { ok: true, message: "Invitation sent." };
  } catch (cause) {
    // A duplicate open invitation trips the partial unique index rather than a
    // read-then-write race, so report it as the ordinary case it is.
    const detail = describeError(cause);
    log.error("studio.invite_failed", { email: redactEmail(email), error: detail });
    if (detail.includes("staff_invitations_one_open_per_email_idx")) {
      return { ok: false, message: "That address already has an open invitation." };
    }
    return { ok: false, message: "The invitation could not be sent." };
  }
}

export async function revokeStaffInvitation(id: string): Promise<void> {
  await requireOwner();
  await revokeInvitation(id);
  log.info("studio.invite_revoked");
  revalidatePath("/studio/team");
}

export async function deactivateStaff(id: string): Promise<void> {
  const owner = await requireOwner();
  // An Owner locking themselves out would leave Studio unreachable.
  if (id === owner.id) return;
  await setStaffStatus(id, "inactive");
  log.info("studio.member_deactivated");
  revalidatePath("/studio/team");
}

export async function reactivateStaff(id: string): Promise<void> {
  await requireOwner();
  await setStaffStatus(id, "active");
  log.info("studio.member_reactivated");
  revalidatePath("/studio/team");
}
