"use server";

import { revalidatePath } from "next/cache";

import { requireOwner, requireStaff } from "@/lib/auth/guard";
import {
  LIMITS,
  isId,
  multiline,
  optional,
  optionalDate,
  optionalId,
  readProjectStatus,
  readVersion,
  text,
} from "@/lib/business";
import {
  archiveProject,
  attachContactToProject,
  createProject,
  detachContactFromProject,
  restoreProject,
  updateProject,
  updateProjectContact,
} from "@/lib/db/projects";
import { failed, fromOutcome, type ActionResult } from "@/lib/studio-result";

/** Everything a person can do to a project, and to who is on it. */

function readProject(form: FormData) {
  return {
    name: text(form.get("name"), LIMITS.name),
    status: readProjectStatus(form.get("status")),
    description: multiline(form.get("description"), LIMITS.description),
    notes: multiline(form.get("notes"), LIMITS.notes),
    ownerId: optionalId(form.get("ownerId")),
    startsOn: optionalDate(form.get("startsOn")),
    targetOn: optionalDate(form.get("targetOn")),
  };
}

export async function createProjectAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const clientId = String(form.get("clientId") ?? "");
  if (!isId(clientId)) return failed("Choose which client this work is for.");

  const input = readProject(form);
  if (!input.name) return failed("A project needs a name.");

  const outcome = await createProject(staff, { ...input, clientId });
  revalidatePath("/studio/projects");
  revalidatePath(`/studio/clients/${clientId}`);
  return fromOutcome(outcome, `${input.name} added.`);
}

export async function updateProjectAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const id = String(form.get("id") ?? "");
  if (!isId(id)) return failed("That project no longer exists.");

  const input = readProject(form);
  if (!input.name) return failed("A project needs a name.");

  const outcome = await updateProject(staff, id, input, readVersion(form.get("version")));
  revalidatePath(`/studio/projects/${id}`);
  revalidatePath("/studio/projects");
  return fromOutcome(outcome, "Saved.");
}

export async function archiveProjectAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const owner = await requireOwner();

  const id = String(form.get("id") ?? "");
  if (!isId(id)) return failed("That project no longer exists.");

  const outcome = await archiveProject(owner, id, readVersion(form.get("version")));
  revalidatePath(`/studio/projects/${id}`);
  revalidatePath("/studio/projects");
  return fromOutcome(outcome, "Archived.");
}

export async function restoreProjectAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const owner = await requireOwner();

  const id = String(form.get("id") ?? "");
  if (!isId(id)) return failed("That project no longer exists.");

  const outcome = await restoreProject(owner, id, readVersion(form.get("version")));
  revalidatePath(`/studio/projects/${id}`);
  revalidatePath("/studio/projects");
  return fromOutcome(outcome, "Restored.");
}

/* ------------------------------------------------------ project ↔ contact */

export async function attachProjectContactAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const projectId = String(form.get("projectId") ?? "");
  const contactId = String(form.get("contactId") ?? "");
  if (!isId(projectId)) return failed("That project no longer exists.");
  if (!isId(contactId)) return failed("Choose somebody to add.");

  const outcome = await attachContactToProject(staff, {
    projectId,
    contactId,
    role: optional(text(form.get("role"), LIMITS.role)),
    isPrimary: form.get("isPrimary") === "on",
  });

  revalidatePath(`/studio/projects/${projectId}`);
  revalidatePath(`/studio/contacts/${contactId}`);
  return fromOutcome(outcome, "Added.");
}

export async function updateProjectContactAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const id = String(form.get("id") ?? "");
  if (!isId(id)) return failed("That relationship no longer exists.");

  const outcome = await updateProjectContact(
    staff,
    id,
    {
      role: optional(text(form.get("role"), LIMITS.role)),
      isPrimary: form.get("isPrimary") === "on" || form.get("isPrimary") === "true",
    },
    readVersion(form.get("version")),
  );

  revalidatePath("/studio/projects");
  return fromOutcome(outcome, "Saved.");
}

export async function detachProjectContactAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const id = String(form.get("id") ?? "");
  if (!isId(id)) return failed("That relationship no longer exists.");

  const outcome = await detachContactFromProject(staff, id);
  revalidatePath("/studio/projects");
  return fromOutcome(outcome, "Removed from this project.");
}
