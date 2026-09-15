"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireOwner, requireStaff } from "@/lib/auth/guard";
import {
  LIMITS,
  isId,
  multiline,
  optional,
  optionalDate,
  optionalId,
  optionalMoment,
  readAccountType,
  readLeadSource,
  readLeadStage,
  readProjectStatus,
  readVersion,
  text,
} from "@/lib/business";
import {
  archiveLead,
  convertLead,
  createLead,
  createLeadFromInquiry,
  moveLead,
  restoreLead,
  updateLead,
  type LeadInput,
} from "@/lib/db/leads";
import { failed, fromOutcome, type ActionResult } from "@/lib/studio-result";

/** Everything a person can do to a lead, including the two flows that matter. */

function readLead(form: FormData): LeadInput {
  return {
    title: text(form.get("title"), LIMITS.name),
    source: readLeadSource(form.get("source")),
    contactId: optionalId(form.get("contactId")),
    clientId: optionalId(form.get("clientId")),
    prospectName: optional(text(form.get("prospectName"), LIMITS.name)),
    summary: multiline(form.get("summary"), LIMITS.summary),
    nextStep: multiline(form.get("nextStep"), LIMITS.nextStep),
    followUpAt: optionalMoment(form.get("followUpAt")),
    ownerId: optionalId(form.get("ownerId")),
  };
}

export async function createLeadAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const input = readLead(form);
  if (!input.title) return failed("A lead needs a title.");

  const outcome = await createLead(staff, input);
  revalidatePath("/studio/leads");
  return fromOutcome(outcome, `${input.title} added.`);
}

export async function updateLeadAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const id = String(form.get("id") ?? "");
  if (!isId(id)) return failed("That lead no longer exists.");

  const input = readLead(form);
  if (!input.title) return failed("A lead needs a title.");

  const outcome = await updateLead(staff, id, input, readVersion(form.get("version")));
  revalidatePath(`/studio/leads/${id}`);
  revalidatePath("/studio/leads");
  return fromOutcome(outcome, "Saved.");
}

export async function moveLeadAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const id = String(form.get("id") ?? "");
  if (!isId(id)) return failed("That lead no longer exists.");

  const stage = readLeadStage(form.get("stage"));
  const outcome = await moveLead(
    staff,
    id,
    stage,
    readVersion(form.get("version")),
    optional(text(form.get("lostReason"), LIMITS.lostReason)),
  );

  revalidatePath(`/studio/leads/${id}`);
  revalidatePath("/studio/leads");
  return fromOutcome(outcome, "Moved.");
}

export async function archiveLeadAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const owner = await requireOwner();

  const id = String(form.get("id") ?? "");
  if (!isId(id)) return failed("That lead no longer exists.");

  const outcome = await archiveLead(owner, id, readVersion(form.get("version")));
  revalidatePath(`/studio/leads/${id}`);
  revalidatePath("/studio/leads");
  return fromOutcome(outcome, "Archived.");
}

export async function restoreLeadAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const owner = await requireOwner();

  const id = String(form.get("id") ?? "");
  if (!isId(id)) return failed("That lead no longer exists.");

  const outcome = await restoreLead(owner, id, readVersion(form.get("version")));
  revalidatePath(`/studio/leads/${id}`);
  revalidatePath("/studio/leads");
  return fromOutcome(outcome, "Restored.");
}

/**
 * Turning an inquiry into a lead, from Home.
 *
 * It ends on the lead rather than back on the list, because the next thing
 * anybody wants after making one is to look at it. The redirect is outside the
 * outcome check so a lead that already existed still takes you to it.
 */
export async function createLeadFromInquiryAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const inquiryId = String(form.get("inquiryId") ?? "");
  if (!isId(inquiryId)) return failed("That inquiry no longer exists.");

  const outcome = await createLeadFromInquiry(staff, inquiryId);
  if (!outcome.ok) return fromOutcome(outcome, "");

  revalidatePath("/studio");
  revalidatePath("/studio/leads");
  redirect(`/studio/leads/${outcome.value.leadId}`);
}

/**
 * Converting a lead into work. One transaction behind this, so a refusal here
 * means nothing at all was written — no half-made client, no orphan project.
 */
export async function convertLeadAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const id = String(form.get("id") ?? "");
  if (!isId(id)) return failed("That lead no longer exists.");

  const clientId = optionalId(form.get("clientId"));
  const newClientName = text(form.get("newClientName"), LIMITS.name);
  if (!clientId && !newClientName) {
    return failed("Choose an existing client, or give the new one a name.");
  }

  const withProject = form.get("withProject") === "on";
  const projectName = text(form.get("projectName"), LIMITS.name);
  if (withProject && !projectName) return failed("Give the project a name.");

  const outcome = await convertLead(staff, id, readVersion(form.get("version")), {
    clientId,
    newClientName,
    newClientAccountType: readAccountType(form.get("newClientAccountType")),
    withProject,
    projectName,
    projectStatus: readProjectStatus(form.get("projectStatus")),
    projectDescription: multiline(form.get("projectDescription"), LIMITS.description),
    startsOn: optionalDate(form.get("startsOn")),
    targetOn: optionalDate(form.get("targetOn")),
    ownerId: optionalId(form.get("ownerId")),
  });

  if (!outcome.ok) return fromOutcome(outcome, "");

  revalidatePath("/studio/leads");
  revalidatePath("/studio/projects");
  revalidatePath("/studio/clients");
  // To the work if there is any, otherwise to the client it now belongs to.
  redirect(
    outcome.value.projectId
      ? `/studio/projects/${outcome.value.projectId}`
      : `/studio/clients/${outcome.value.clientId}`,
  );
}
