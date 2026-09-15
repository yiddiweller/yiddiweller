"use server";

import { revalidatePath } from "next/cache";

import { requireOwner, requireStaff } from "@/lib/auth/guard";
import {
  LIMITS,
  isId,
  multiline,
  normalizeDomain,
  optional,
  readAccountType,
  readClientStatus,
  readVersion,
  text,
} from "@/lib/business";
import {
  archiveClient,
  createClient,
  restoreClient,
  updateClient,
  type ClientInput,
} from "@/lib/db/clients";
import { failed, fromOutcome, type ActionResult } from "@/lib/studio-result";

/**
 * Everything a person can do to a client.
 *
 * Every action re-checks the caller server-side. A server action is a public
 * endpoint: the fact that a button is only rendered for an Owner protects
 * nothing on its own, and neither does an unguessable id.
 */

function readClient(form: FormData): ClientInput {
  const website = optional(text(form.get("website"), LIMITS.website));
  return {
    accountType: readAccountType(form.get("accountType")),
    name: text(form.get("name"), LIMITS.name),
    website,
    domain: normalizeDomain(website),
    status: readClientStatus(form.get("status")),
    notes: multiline(form.get("notes"), LIMITS.notes),
  };
}

export async function createClientAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const input = readClient(form);
  if (!input.name) return failed("A client needs a name.");

  const outcome = await createClient(staff, input);
  revalidatePath("/studio/clients");
  return fromOutcome(outcome, `${input.name} added.`);
}

export async function updateClientAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const id = String(form.get("id") ?? "");
  if (!isId(id)) return failed("That client no longer exists.");

  const input = readClient(form);
  if (!input.name) return failed("A client needs a name.");

  const outcome = await updateClient(staff, id, input, readVersion(form.get("version")));
  revalidatePath(`/studio/clients/${id}`);
  revalidatePath("/studio/clients");
  return fromOutcome(outcome, "Saved.");
}

/** Archiving and restoring are Owner-only: they change what the studio can see. */
export async function archiveClientAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const owner = await requireOwner();

  const id = String(form.get("id") ?? "");
  if (!isId(id)) return failed("That client no longer exists.");

  const outcome = await archiveClient(owner, id, readVersion(form.get("version")));
  revalidatePath(`/studio/clients/${id}`);
  revalidatePath("/studio/clients");
  return fromOutcome(outcome, "Archived.");
}

export async function restoreClientAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const owner = await requireOwner();

  const id = String(form.get("id") ?? "");
  if (!isId(id)) return failed("That client no longer exists.");

  const outcome = await restoreClient(owner, id, readVersion(form.get("version")));
  revalidatePath(`/studio/clients/${id}`);
  revalidatePath("/studio/clients");
  return fromOutcome(outcome, "Restored.");
}
