"use server";

import { revalidatePath } from "next/cache";

import { requireOwner, requireStaff } from "@/lib/auth/guard";
import { isId, readVersion, text } from "@/lib/business";
import {
  abandonUpload,
  archiveFile,
  beginUpload,
  finalizeUpload,
  renameFile,
  restoreFile,
  setFileVisibility,
} from "@/lib/db/files";
import { MULTIPART_PART_BYTES, createMultipart, completeMultipart, presignPart, presignPut } from "@/lib/storage/presign";
import { pendingKey, previewKey } from "@/lib/storage/keys";
import { previewable } from "@/lib/storage/policy";
import { failed, fromOutcome, type ActionResult } from "@/lib/studio-result";

/**
 * Everything staff can do to a file.
 *
 * Every one of these re-checks the caller. A server action is a public
 * endpoint: a button only rendered for an Owner protects nothing on its own,
 * and the upload actions hand out signed URLs, which makes that doubly true.
 *
 * Archiving and restoring are Owner-only, matching every other archive in the
 * business core. Everything else is ordinary work a Member does.
 */

export type UploadAuthorization = {
  fileId: string;
  strategy: "single" | "multipart";
  /** One presigned PUT, or one per part. Never a URL to a permanent key. */
  urls: string[];
  uploadId?: string;
  partSize: number;
  previewUrl?: string;
};

/**
 * Reserve a place and hand back the URLs to fill it.
 *
 * The URLs point at `pending/{id}` and nowhere else. The permanent key is not
 * reachable from anything issued here, which is what stops a stale link
 * changing a file somebody already approved.
 */
export async function authorizeUploadAction(input: {
  workroomId: string;
  filename: string;
  contentType: string;
  size: number;
  supersedesFileId?: string | null;
}): Promise<{ ok: true; value: UploadAuthorization } | { ok: false; message: string }> {
  const staff = await requireStaff();
  if (!isId(input.workroomId)) return { ok: false, message: "That workroom no longer exists." };

  const ticket = await beginUpload(staff, {
    workroomId: input.workroomId,
    filename: input.filename,
    contentType: input.contentType,
    declaredSize: input.size,
    supersedesFileId: input.supersedesFileId ?? null,
  });
  if (!ticket.ok) return { ok: false, message: ticket.message };

  const key = pendingKey(ticket.value.fileId);

  // A preview is a convenience and never the artefact, so its URL is issued
  // alongside rather than as a second round trip. If the browser cannot make
  // one, it simply does not use this.
  const previewUrl = previewable(input.contentType)
    ? await presignPut(previewKey(input.workroomId, ticket.value.fileId), input.contentType)
    : undefined;

  if (ticket.value.strategy === "single") {
    return {
      ok: true,
      value: {
        fileId: ticket.value.fileId,
        strategy: "single",
        urls: [await presignPut(key, input.contentType)],
        partSize: MULTIPART_PART_BYTES,
        ...(previewUrl ? { previewUrl } : {}),
      },
    };
  }

  const uploadId = await createMultipart(key, input.contentType);
  const urls: string[] = [];
  for (let part = 1; part <= ticket.value.parts; part++) {
    urls.push(await presignPart(key, uploadId, part));
  }

  return {
    ok: true,
    value: {
      fileId: ticket.value.fileId,
      strategy: "multipart",
      urls,
      uploadId,
      partSize: MULTIPART_PART_BYTES,
      ...(previewUrl ? { previewUrl } : {}),
    },
  };
}

/**
 * Verify what arrived, then promote it.
 *
 * `declaredSize` comes from the browser and is compared against what storage
 * actually holds. It is not believed — it is the claim being checked.
 */
export async function finalizeUploadAction(input: {
  workroomId: string;
  fileId: string;
  declaredSize: number;
  uploadId?: string;
  parts?: { partNumber: number; etag: string }[];
  previewUploaded?: boolean;
}): Promise<ActionResult> {
  const staff = await requireStaff();
  if (!isId(input.fileId) || !isId(input.workroomId)) return failed("That upload no longer exists.");

  if (input.uploadId && input.parts) {
    await completeMultipart(pendingKey(input.fileId), input.uploadId, input.parts);
  }

  const outcome = await finalizeUpload(staff, input.fileId, {
    declaredSize: input.declaredSize,
    previewUploaded: input.previewUploaded ?? false,
  });

  revalidatePath(`/studio/workrooms/${input.workroomId}/files`);
  revalidatePath(`/studio/workrooms/${input.workroomId}`);
  return fromOutcome(outcome, "File stored.");
}

/** Give up on an upload the browser could not finish. */
export async function abandonUploadAction(input: {
  workroomId: string;
  fileId: string;
}): Promise<ActionResult> {
  await requireStaff();
  if (!isId(input.fileId)) return failed("That upload no longer exists.");

  const outcome = await abandonUpload(input.fileId);
  revalidatePath(`/studio/workrooms/${input.workroomId}/files`);
  return fromOutcome(outcome, "Upload discarded.");
}

export async function renameFileAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const id = String(form.get("id") ?? "");
  const workroomId = String(form.get("workroomId") ?? "");
  if (!isId(id)) return failed("That file no longer exists.");

  const name = text(form.get("displayName"), 200);
  if (!name) return failed("Give the file a name the client will recognise.");

  const outcome = await renameFile(staff, id, readVersion(form.get("version")), name);
  revalidatePath(`/studio/workrooms/${workroomId}/files`);
  return fromOutcome(outcome, "Renamed.");
}

export async function setFileVisibilityAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const id = String(form.get("id") ?? "");
  const workroomId = String(form.get("workroomId") ?? "");
  if (!isId(id)) return failed("That file no longer exists.");

  const visibility = form.get("visibility") === "shared" ? "shared" : "internal";
  const outcome = await setFileVisibility(staff, id, readVersion(form.get("version")), visibility);

  revalidatePath(`/studio/workrooms/${workroomId}/files`);
  revalidatePath(`/studio/workrooms/${workroomId}`);
  return fromOutcome(
    outcome,
    visibility === "shared" ? "Shared with the client." : "No longer shared.",
  );
}

export async function archiveFileAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const owner = await requireOwner();

  const id = String(form.get("id") ?? "");
  const workroomId = String(form.get("workroomId") ?? "");
  if (!isId(id)) return failed("That file no longer exists.");

  const outcome = await archiveFile(owner, id, readVersion(form.get("version")));
  revalidatePath(`/studio/workrooms/${workroomId}/files`);
  return fromOutcome(outcome, "Archived.");
}

export async function restoreFileAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const owner = await requireOwner();

  const id = String(form.get("id") ?? "");
  const workroomId = String(form.get("workroomId") ?? "");
  if (!isId(id)) return failed("That file no longer exists.");

  const outcome = await restoreFile(owner, id, readVersion(form.get("version")));
  revalidatePath(`/studio/workrooms/${workroomId}/files`);
  return fromOutcome(outcome, "Restored.");
}

