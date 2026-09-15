"use server";

import { revalidatePath } from "next/cache";

import { requireOwner, requireStaff } from "@/lib/auth/guard";
import {
  LIMITS,
  isId,
  multiline,
  normalizeEmail,
  optional,
  readVersion,
  text,
} from "@/lib/business";
import {
  archiveContact,
  attachContactToClient,
  createContact,
  detachContactFromClient,
  restoreContact,
  updateClientContact,
  updateContact,
  type ContactInput,
} from "@/lib/db/contacts";
import { failed, fromOutcome, type ActionResult } from "@/lib/studio-result";

/** Everything a person can do to a contact, and to what a contact is to a client. */

function readContact(form: FormData): ContactInput {
  const email = optional(text(form.get("email"), LIMITS.email));
  return {
    name: text(form.get("name"), LIMITS.name),
    email,
    emailNormalized: normalizeEmail(email),
    phone: optional(text(form.get("phone"), LIMITS.phone)),
    title: optional(text(form.get("title"), LIMITS.title)),
    notes: multiline(form.get("notes"), LIMITS.notes),
  };
}

export async function createContactAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const input = readContact(form);
  if (!input.name) return failed("A contact needs a name.");

  const created = await createContact(staff, input);
  if (!created.ok) return fromOutcome(created, "");

  // Created from a client's page, so the relationship is the point of it.
  const clientId = String(form.get("clientId") ?? "");
  if (isId(clientId)) {
    await attachContactToClient(staff, {
      clientId,
      contactId: created.value,
      role: optional(text(form.get("role"), LIMITS.role)),
      isPrimary: form.get("isPrimary") === "on",
    });
    revalidatePath(`/studio/clients/${clientId}`);
  }

  revalidatePath("/studio/contacts");
  return fromOutcome(created, `${input.name} added.`);
}

export async function updateContactAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const id = String(form.get("id") ?? "");
  if (!isId(id)) return failed("That contact no longer exists.");

  const input = readContact(form);
  if (!input.name) return failed("A contact needs a name.");

  const outcome = await updateContact(staff, id, input, readVersion(form.get("version")));
  revalidatePath(`/studio/contacts/${id}`);
  revalidatePath("/studio/contacts");
  return fromOutcome(outcome, "Saved.");
}

export async function archiveContactAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const owner = await requireOwner();

  const id = String(form.get("id") ?? "");
  if (!isId(id)) return failed("That contact no longer exists.");

  const outcome = await archiveContact(owner, id, readVersion(form.get("version")));
  revalidatePath(`/studio/contacts/${id}`);
  revalidatePath("/studio/contacts");
  return fromOutcome(outcome, "Archived.");
}

export async function restoreContactAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const owner = await requireOwner();

  const id = String(form.get("id") ?? "");
  if (!isId(id)) return failed("That contact no longer exists.");

  const outcome = await restoreContact(owner, id, readVersion(form.get("version")));
  revalidatePath(`/studio/contacts/${id}`);
  revalidatePath("/studio/contacts");
  return fromOutcome(outcome, "Restored.");
}

/* ------------------------------------------------------- client ↔ contact */

export async function attachContactAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const clientId = String(form.get("clientId") ?? "");
  const contactId = String(form.get("contactId") ?? "");
  if (!isId(clientId)) return failed("That client no longer exists.");
  if (!isId(contactId)) return failed("Choose somebody to add.");

  const outcome = await attachContactToClient(staff, {
    clientId,
    contactId,
    role: optional(text(form.get("role"), LIMITS.role)),
    isPrimary: form.get("isPrimary") === "on",
  });

  revalidatePath(`/studio/clients/${clientId}`);
  revalidatePath(`/studio/contacts/${contactId}`);
  return fromOutcome(outcome, "Added.");
}

export async function updateClientContactAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const id = String(form.get("id") ?? "");
  if (!isId(id)) return failed("That relationship no longer exists.");

  const outcome = await updateClientContact(
    staff,
    id,
    {
      role: optional(text(form.get("role"), LIMITS.role)),
      isPrimary: form.get("isPrimary") === "on" || form.get("isPrimary") === "true",
    },
    readVersion(form.get("version")),
  );

  revalidatePath("/studio/clients");
  revalidatePath("/studio/contacts");
  return fromOutcome(outcome, "Saved.");
}

export async function detachContactAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const id = String(form.get("id") ?? "");
  if (!isId(id)) return failed("That relationship no longer exists.");

  const outcome = await detachContactFromClient(staff, id);
  revalidatePath("/studio/clients");
  revalidatePath("/studio/contacts");
  return fromOutcome(outcome, "Removed from this client.");
}
