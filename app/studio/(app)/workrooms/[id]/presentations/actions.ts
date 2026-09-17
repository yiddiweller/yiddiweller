"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireOwner, requireStaff } from "@/lib/auth/guard";
import { isId, readVersion, text } from "@/lib/business";
import {
  addFileItem,
  addNoteItem,
  archivePresentation,
  createPresentation,
  moveItem,
  publishPresentation,
  removeItem,
  restorePresentation,
  unpublishPresentation,
  updateItem,
  updatePresentation,
  BODY_MAX,
  CAPTION_MAX,
  INTRO_MAX,
  TITLE_MAX,
} from "@/lib/db/presentations";
import { failed, fromOutcome, type ActionResult } from "@/lib/studio-result";

/**
 * Everything staff can do to a Presentation.
 *
 * Every one of these re-checks the caller. A server action is a public
 * endpoint, and a button only rendered for an Owner protects nothing on its
 * own.
 *
 * Every draft mutation carries the **Presentation's** version, not an item's.
 * The draft is one document: reordering it, retitling it and rewording a note
 * are all edits to the same thing, and two people doing them at once is a race
 * somebody should be told about rather than one both of them appear to win.
 */

function pages(workroomId: string, presentationId?: string) {
  revalidatePath(`/studio/workrooms/${workroomId}/presentations`);
  revalidatePath(`/studio/workrooms/${workroomId}`);
  revalidatePath(`/studio/workrooms/${workroomId}/preview`);
  if (presentationId) {
    revalidatePath(`/studio/workrooms/${workroomId}/presentations/${presentationId}`);
    revalidatePath(`/studio/workrooms/${workroomId}/presentations/${presentationId}/preview`);
  }
}

export async function createPresentationAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const workroomId = String(form.get("workroomId") ?? "");
  if (!isId(workroomId)) return failed("That workroom no longer exists.");

  const title = text(form.get("title"), TITLE_MAX);
  if (!title) return failed("Give the presentation a title the client will read.");

  const outcome = await createPresentation(staff, workroomId, {
    title,
    intro: text(form.get("intro"), INTRO_MAX) ?? "",
  });

  pages(workroomId);
  if (!outcome.ok) return fromOutcome(outcome, "");

  // Straight into the editor: a Presentation with nothing in it is a step on
  // the way somewhere, never a destination.
  redirect(`/studio/workrooms/${workroomId}/presentations/${outcome.value}`);
}

export async function updatePresentationAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const id = String(form.get("id") ?? "");
  const workroomId = String(form.get("workroomId") ?? "");
  if (!isId(id)) return failed("That presentation no longer exists.");

  const title = text(form.get("title"), TITLE_MAX);
  if (!title) return failed("Give the presentation a title the client will read.");

  const outcome = await updatePresentation(staff, id, readVersion(form.get("version")), {
    title,
    intro: text(form.get("intro"), INTRO_MAX) ?? "",
  });

  pages(workroomId, id);
  return fromOutcome(outcome, "Saved.");
}

export async function addFileItemAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const id = String(form.get("id") ?? "");
  const workroomId = String(form.get("workroomId") ?? "");
  const fileId = String(form.get("fileId") ?? "");
  if (!isId(id) || !isId(fileId)) return failed("That file is no longer available.");

  const outcome = await addFileItem(
    staff,
    id,
    readVersion(form.get("version")),
    fileId,
    text(form.get("caption"), CAPTION_MAX) ?? "",
  );

  pages(workroomId, id);
  return fromOutcome(outcome, "Added.");
}

export async function addNoteItemAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const id = String(form.get("id") ?? "");
  const workroomId = String(form.get("workroomId") ?? "");
  if (!isId(id)) return failed("That presentation no longer exists.");

  const outcome = await addNoteItem(staff, id, readVersion(form.get("version")), {
    caption: text(form.get("caption"), CAPTION_MAX) ?? "",
    body: text(form.get("body"), BODY_MAX) ?? "",
  });

  pages(workroomId, id);
  return fromOutcome(outcome, "Added.");
}

export async function updateItemAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const id = String(form.get("id") ?? "");
  const workroomId = String(form.get("workroomId") ?? "");
  const itemId = String(form.get("itemId") ?? "");
  if (!isId(id) || !isId(itemId)) return failed("That block is no longer in this presentation.");

  const outcome = await updateItem(staff, id, readVersion(form.get("version")), itemId, {
    caption: text(form.get("caption"), CAPTION_MAX) ?? "",
    body: text(form.get("body"), BODY_MAX) ?? "",
  });

  pages(workroomId, id);
  return fromOutcome(outcome, "Saved.");
}

export async function moveItemAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const id = String(form.get("id") ?? "");
  const workroomId = String(form.get("workroomId") ?? "");
  const itemId = String(form.get("itemId") ?? "");
  if (!isId(id) || !isId(itemId)) return failed("That block is no longer in this presentation.");

  const outcome = await moveItem(
    staff,
    id,
    readVersion(form.get("version")),
    itemId,
    form.get("direction") === "up" ? "up" : "down",
  );

  pages(workroomId, id);
  return fromOutcome(outcome, "Moved.");
}

export async function removeItemAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const id = String(form.get("id") ?? "");
  const workroomId = String(form.get("workroomId") ?? "");
  const itemId = String(form.get("itemId") ?? "");
  if (!isId(id) || !isId(itemId)) return failed("That block is no longer in this presentation.");

  const outcome = await removeItem(staff, id, readVersion(form.get("version")), itemId);

  pages(workroomId, id);
  return fromOutcome(outcome, "Removed.");
}

/**
 * Freeze the draft and open it to the client.
 *
 * The consequence staff are shown before pressing this is which internal files
 * it will share — the page computes that, and this records what happened.
 * Publishing sends no email: *Publish* and *Notify* are two decisions.
 */
export async function publishPresentationAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const id = String(form.get("id") ?? "");
  const workroomId = String(form.get("workroomId") ?? "");
  if (!isId(id)) return failed("That presentation no longer exists.");

  const outcome = await publishPresentation(staff, id, readVersion(form.get("version")));

  pages(workroomId, id);
  if (!outcome.ok) return fromOutcome(outcome, "");

  const shared =
    outcome.value.sharedFiles === 0
      ? ""
      : outcome.value.sharedFiles === 1
        ? " One file is now shared."
        : ` ${outcome.value.sharedFiles} files are now shared.`;

  return fromOutcome(outcome, `Version ${outcome.value.revision} is open to the client.${shared}`);
}

export async function unpublishPresentationAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const id = String(form.get("id") ?? "");
  const workroomId = String(form.get("workroomId") ?? "");
  if (!isId(id)) return failed("That presentation no longer exists.");

  const outcome = await unpublishPresentation(staff, id, readVersion(form.get("version")));

  pages(workroomId, id);
  return fromOutcome(outcome, "The client can no longer open this.");
}

export async function archivePresentationAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const owner = await requireOwner();

  const id = String(form.get("id") ?? "");
  const workroomId = String(form.get("workroomId") ?? "");
  if (!isId(id)) return failed("That presentation no longer exists.");

  const outcome = await archivePresentation(owner, id, readVersion(form.get("version")));

  pages(workroomId, id);
  return fromOutcome(outcome, "Archived.");
}

export async function restorePresentationAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const owner = await requireOwner();

  const id = String(form.get("id") ?? "");
  const workroomId = String(form.get("workroomId") ?? "");
  if (!isId(id)) return failed("That presentation no longer exists.");

  const outcome = await restorePresentation(owner, id, readVersion(form.get("version")));

  pages(workroomId, id);
  return fromOutcome(outcome, "Restored.");
}
