"use server";

import { revalidatePath } from "next/cache";

import { requireOwner, requireStaff } from "@/lib/auth/guard";
import { LIMITS, isId, multiline, readVersion, text } from "@/lib/business";
import {
  archiveWorkroom,
  createWorkroom,
  inviteToWorkroom,
  publishWorkroom,
  resendWorkroomInvitation,
  restoreMembership,
  restoreWorkroom,
  revokeMembership,
  revokeWorkroomInvitation,
  setIdentityStatus,
  unpublishWorkroom,
  updateWorkroom,
} from "@/lib/db/workrooms";
import { sendWorkroomInvitationEmail } from "@/lib/emails";
import { workroomUrl } from "@/lib/env";
import { describeError, log } from "@/lib/log";
import { failed, fromOutcome, type ActionResult } from "@/lib/studio-result";

/**
 * Everything staff can do to a Workroom.
 *
 * Running a client's project is ordinary work, so a Member does all of it. The
 * two Owner-only actions are the ones that reach past a single Workroom:
 * archiving, and switching a person's identity off everywhere at once.
 *
 * Every action re-checks the caller server-side. A server action is a public
 * endpoint: a button only rendered for an Owner protects nothing on its own.
 */

const INVITE_DAYS = 7;

export async function createWorkroomAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const projectId = String(form.get("projectId") ?? "");
  if (!isId(projectId)) return failed("That project no longer exists.");

  const title = text(form.get("title"), LIMITS.name);
  if (!title) return failed("Give the workroom a title the client will recognise.");

  const outcome = await createWorkroom(staff, {
    projectId,
    title,
    summary: multiline(form.get("summary"), LIMITS.summary),
  });

  revalidatePath("/studio/workrooms");
  revalidatePath(`/studio/projects/${projectId}`);
  return fromOutcome(outcome, "Workroom created. Nobody can see it until it is published.");
}

export async function updateWorkroomAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const id = String(form.get("id") ?? "");
  if (!isId(id)) return failed("That workroom no longer exists.");

  const title = text(form.get("title"), LIMITS.name);
  if (!title) return failed("Give the workroom a title the client will recognise.");

  const outcome = await updateWorkroom(
    staff,
    id,
    { title, summary: multiline(form.get("summary"), LIMITS.summary) },
    readVersion(form.get("version")),
  );

  revalidatePath(`/studio/workrooms/${id}`);
  revalidatePath("/studio/workrooms");
  return fromOutcome(outcome, "Saved.");
}

export async function publishWorkroomAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const id = String(form.get("id") ?? "");
  if (!isId(id)) return failed("That workroom no longer exists.");

  const outcome = await publishWorkroom(staff, id, readVersion(form.get("version")));
  if (outcome.ok) log.info("workroom.published", {});

  revalidatePath(`/studio/workrooms/${id}`);
  revalidatePath("/studio/workrooms");
  return fromOutcome(outcome, "Published. Its members can open it now.");
}

export async function unpublishWorkroomAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const id = String(form.get("id") ?? "");
  if (!isId(id)) return failed("That workroom no longer exists.");

  const outcome = await unpublishWorkroom(staff, id, readVersion(form.get("version")));
  if (outcome.ok) log.info("workroom.unpublished", {});

  revalidatePath(`/studio/workrooms/${id}`);
  revalidatePath("/studio/workrooms");
  return fromOutcome(outcome, "Unpublished. Nobody outside the studio can reach it.");
}

export async function archiveWorkroomAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const owner = await requireOwner();

  const id = String(form.get("id") ?? "");
  if (!isId(id)) return failed("That workroom no longer exists.");

  const outcome = await archiveWorkroom(owner, id, readVersion(form.get("version")));
  revalidatePath(`/studio/workrooms/${id}`);
  revalidatePath("/studio/workrooms");
  return fromOutcome(outcome, "Archived.");
}

export async function restoreWorkroomAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const owner = await requireOwner();

  const id = String(form.get("id") ?? "");
  if (!isId(id)) return failed("That workroom no longer exists.");

  const outcome = await restoreWorkroom(owner, id, readVersion(form.get("version")));
  revalidatePath(`/studio/workrooms/${id}`);
  revalidatePath("/studio/workrooms");
  return fromOutcome(outcome, "Restored.");
}

/* ------------------------------------------------------------ invitations */

export async function inviteToWorkroomAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const workroomId = String(form.get("workroomId") ?? "");
  const contactId = String(form.get("contactId") ?? "");
  if (!isId(workroomId)) return failed("That workroom no longer exists.");
  if (!isId(contactId)) return failed("Choose somebody to invite.");

  const issued = await inviteToWorkroom(staff, { workroomId, contactId });
  if (!issued.ok) return fromOutcome(issued, "");

  const sent = await deliver(issued.value, staff.name);
  revalidatePath(`/studio/workrooms/${workroomId}`);
  return sent;
}

export async function resendWorkroomInvitationAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const id = String(form.get("id") ?? "");
  const workroomId = String(form.get("workroomId") ?? "");
  if (!isId(id)) return failed("That invitation no longer exists.");

  const issued = await resendWorkroomInvitation(staff, id);
  if (!issued.ok) return fromOutcome(issued, "");

  const sent = await deliver(issued.value, staff.name);
  if (isId(workroomId)) revalidatePath(`/studio/workrooms/${workroomId}`);
  return sent;
}

/**
 * The one place an invitation link is built and sent.
 *
 * The token exists only here and in the email; it is never logged, never
 * returned to the page, and only its digest is in the database. The link is
 * built from `CLIENT_AUTH_URL`, so a beta invitation points at beta.
 */
async function deliver(
  invitation: { token: string; email: string },
  invitedBy: string,
): Promise<ActionResult> {
  try {
    await sendWorkroomInvitationEmail({
      to: invitation.email,
      url: workroomUrl(`/invite/${invitation.token}`),
      invitedBy,
      days: INVITE_DAYS,
    });
    log.info("workroom.invite_created", {});
    return { ok: true, message: "Invitation sent." };
  } catch (cause) {
    log.error("workroom.invite_send_failed", { error: describeError(cause) });
    return {
      ok: false,
      message:
        "The invitation was created but could not be sent. Use Resend once mail is working again.",
    };
  }
}

export async function revokeWorkroomInvitationAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const id = String(form.get("id") ?? "");
  const workroomId = String(form.get("workroomId") ?? "");
  if (!isId(id)) return failed("That invitation no longer exists.");

  const outcome = await revokeWorkroomInvitation(staff, id);
  if (outcome.ok) log.info("workroom.invite_revoked", {});
  if (isId(workroomId)) revalidatePath(`/studio/workrooms/${workroomId}`);
  return fromOutcome(outcome, "Invitation revoked. Its link stops working straight away.");
}

/* ------------------------------------------------------------- membership */

export async function revokeMembershipAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const id = String(form.get("id") ?? "");
  const workroomId = String(form.get("workroomId") ?? "");
  if (!isId(id)) return failed("That person is no longer listed here.");

  const outcome = await revokeMembership(staff, id, readVersion(form.get("version")));
  if (outcome.ok) log.info("workroom.access_revoked", {});
  if (isId(workroomId)) revalidatePath(`/studio/workrooms/${workroomId}`);
  return fromOutcome(outcome, "Access taken away. It stops on their next click.");
}

export async function restoreMembershipAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const id = String(form.get("id") ?? "");
  const workroomId = String(form.get("workroomId") ?? "");
  if (!isId(id)) return failed("That person is no longer listed here.");

  const outcome = await restoreMembership(staff, id, readVersion(form.get("version")));
  if (isId(workroomId)) revalidatePath(`/studio/workrooms/${workroomId}`);
  return fromOutcome(outcome, "Access given back.");
}

/** Owner-only: this reaches every Workroom at once, not just this one. */
export async function setIdentityStatusAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const owner = await requireOwner();

  const identityId = String(form.get("identityId") ?? "");
  const workroomId = String(form.get("workroomId") ?? "");
  const status = form.get("status") === "inactive" ? "inactive" : "active";
  if (!identityId) return failed("That person has no sign-in to change.");

  const outcome = await setIdentityStatus(owner, identityId, status);
  if (isId(workroomId)) revalidatePath(`/studio/workrooms/${workroomId}`);
  return fromOutcome(
    outcome,
    status === "inactive"
      ? "Their sign-in is switched off everywhere."
      : "Their sign-in works again.",
  );
}
