import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";

import { record as recordActivity } from "./activity.ts";
import { record as recordAudit, type AuditActor } from "./audit.ts";
import { db, type Tx } from "./index.ts";
import { uuidv7 } from "./id.ts";
import { ok, refuse, expectUnchanged, type Outcome } from "./outcome.ts";
import {
  presentationRevisionItems,
  workroomFiles,
  workroomMembers,
  workrooms,
  type FileStatus,
  type FileVisibility,
} from "./schema.ts";
import { log } from "../log.ts";
import {
  copyObject,
  deleteObject,
  headObject,
  MULTIPART_PART_BYTES,
  MULTIPART_THRESHOLD_BYTES,
} from "../storage/presign.ts";
import { isPendingKey, pendingKey, permanentKey, previewKey } from "../storage/keys.ts";
import { checkUpload, MAX_FILE_BYTES } from "../storage/policy.ts";
import { opaquePublicId } from "../workrooms/id.ts";

/**
 * Files inside a Workroom.
 *
 * Two things here are worth reading before changing anything.
 *
 * **The database row exists before the bytes do.** An upload creates a
 * `pending` row, the browser sends bytes straight to storage, and only a
 * verified `HEAD` promotes the row to `ready`. Nothing is `ready` on the
 * strength of the browser saying so, because a presigned PUT cannot enforce a
 * size — that condition belongs to a different S3 mechanism — so the ceiling is
 * checked afterwards against what storage says it holds.
 *
 * **PostgreSQL and object storage are not one transaction, and this module does
 * not pretend they are.** Where they cannot commit together, the order is
 * chosen so a failure leaves a state we can retry from rather than a lie. Each
 * place it matters says which way it leans and why.
 */

export type WorkroomFileRow = {
  id: string;
  publicId: string;
  workroomId: string;
  displayName: string;
  originalFilename: string;
  contentType: string;
  byteSize: number | null;
  storageKey: string;
  previewKey: string | null;
  status: FileStatus;
  visibility: FileVisibility;
  supersedesFileId: string | null;
  version: number;
  archivedAt: Date | null;
  createdAt: Date;
};

const columns = {
  id: workroomFiles.id,
  publicId: workroomFiles.publicId,
  workroomId: workroomFiles.workroomId,
  displayName: workroomFiles.displayName,
  originalFilename: workroomFiles.originalFilename,
  contentType: workroomFiles.contentType,
  byteSize: workroomFiles.byteSize,
  storageKey: workroomFiles.storageKey,
  previewKey: workroomFiles.previewKey,
  status: workroomFiles.status,
  visibility: workroomFiles.visibility,
  supersedesFileId: workroomFiles.supersedesFileId,
  version: workroomFiles.version,
  archivedAt: workroomFiles.archivedAt,
  createdAt: workroomFiles.createdAt,
};

/* ------------------------------------------------------------------ reads */

export async function findFile(id: string): Promise<WorkroomFileRow | null> {
  const [row] = await db().select(columns).from(workroomFiles).where(eq(workroomFiles.id, id)).limit(1);
  return (row as WorkroomFileRow | undefined) ?? null;
}

/** Everything staff may see in one Workroom: internal and shared, both. */
export async function listFiles(
  workroomId: string,
  options: { includeArchived?: boolean } = {},
): Promise<WorkroomFileRow[]> {
  const where = [eq(workroomFiles.workroomId, workroomId), eq(workroomFiles.status, "ready")];
  if (!options.includeArchived) where.push(isNull(workroomFiles.archivedAt));

  const rows = await db()
    .select(columns)
    .from(workroomFiles)
    .where(and(...where))
    .orderBy(desc(workroomFiles.createdAt));

  return rows as WorkroomFileRow[];
}

/** What a Workroom is holding, for the soft threshold staff are warned about. */
export async function workroomBytes(workroomId: string): Promise<number> {
  const [row] = await db()
    .select({ total: sql<string>`COALESCE(SUM(${workroomFiles.byteSize}), 0)` })
    .from(workroomFiles)
    .where(and(eq(workroomFiles.workroomId, workroomId), eq(workroomFiles.status, "ready")));
  return Number(row?.total ?? 0);
}

/**
 * The client's read, and the download route's.
 *
 * **One query, not five checks.** Membership, the Workroom's published and
 * unarchived state, the file's Workroom, its readiness, its visibility and its
 * own archive state are all in the same `WHERE` — so a request from somebody
 * who may not have it never fetches the row at all, and every one of those
 * failures produces the same nothing.
 */
/**
 * What makes a file client-visible, independent of who is asking.
 *
 * Kept as one expression because two places need it and they must never drift:
 * the client's own read, and the staff preview that promises to show exactly
 * what a client would see. A preview built from a *similar* filter is a
 * preview that lies the first time somebody edits one of them.
 */
function clientVisible() {
  return and(
    eq(workroomFiles.status, "ready"),
    eq(workroomFiles.visibility, "shared"),
    isNull(workroomFiles.archivedAt),
  );
}

function viewerScope(contactId: string, workroomPublicId: string) {
  return and(
    eq(workrooms.publicId, workroomPublicId),
    eq(workroomMembers.contactId, contactId),
    eq(workroomMembers.status, "active"),
    eq(workrooms.status, "published"),
    isNull(workrooms.archivedAt),
    clientVisible(),
  );
}

/**
 * The same files, for the staff preview.
 *
 * No membership clause, because staff authorization already happened and there
 * is no client session here — that is the whole point of the preview. What it
 * must not differ on is **visibility**, so it shares `clientVisible()` with the
 * read above rather than restating it.
 */
export async function sharedFilesInWorkroom(workroomId: string): Promise<WorkroomFileRow[]> {
  const rows = await db()
    .select(columns)
    .from(workroomFiles)
    .where(and(eq(workroomFiles.workroomId, workroomId), clientVisible()))
    .orderBy(desc(workroomFiles.createdAt));

  return rows as WorkroomFileRow[];
}

export async function filesForViewer(
  contactId: string,
  workroomPublicId: string,
): Promise<WorkroomFileRow[]> {
  const rows = await db()
    .select(columns)
    .from(workroomFiles)
    .innerJoin(workrooms, eq(workrooms.id, workroomFiles.workroomId))
    .innerJoin(workroomMembers, eq(workroomMembers.workroomId, workrooms.id))
    .where(viewerScope(contactId, workroomPublicId))
    .orderBy(desc(workroomFiles.createdAt));

  return rows as WorkroomFileRow[];
}

/**
 * One file, for a client, by the same scope with one more clause.
 *
 * Not a lookup followed by a permission check — the file id is inside the same
 * guarded query, so an unknown file, another Workroom's file, an internal file,
 * an archived file, a pending file and a revoked member all produce the same
 * nothing, and the caller cannot accidentally tell them apart.
 */
export async function fileForViewer(
  contactId: string,
  workroomPublicId: string,
  filePublicId: string,
): Promise<WorkroomFileRow | null> {
  const [row] = await db()
    .select(columns)
    .from(workroomFiles)
    .innerJoin(workrooms, eq(workrooms.id, workroomFiles.workroomId))
    .innerJoin(workroomMembers, eq(workroomMembers.workroomId, workrooms.id))
    .where(and(viewerScope(contactId, workroomPublicId), eq(workroomFiles.publicId, filePublicId)))
    .limit(1);

  return (row as WorkroomFileRow | undefined) ?? null;
}

/** One file for staff, by public id, with the Workroom it belongs to. */
export async function fileForStaff(filePublicId: string): Promise<WorkroomFileRow | null> {
  const [row] = await db()
    .select(columns)
    .from(workroomFiles)
    .where(and(eq(workroomFiles.publicId, filePublicId), eq(workroomFiles.status, "ready")))
    .limit(1);
  return (row as WorkroomFileRow | undefined) ?? null;
}

/* ---------------------------------------------------------------- uploads */

export type UploadTicket = {
  fileId: string;
  key: string;
  strategy: "single" | "multipart";
  partSize: number;
  parts: number;
};

/**
 * Reserve a place for a file that does not exist yet.
 *
 * The declared values are checked here and checked again — properly — after the
 * bytes land. Refusing early is a courtesy to the person uploading, not a
 * security control: nothing a browser says is believed at step 9.
 *
 * Every identifier is generated here. **No caller-supplied string reaches the
 * storage key**, which is why path traversal is impossible rather than
 * defended against.
 */
export async function beginUpload(
  actor: AuditActor,
  input: {
    workroomId: string;
    filename: string;
    contentType: string;
    declaredSize: number;
    displayName?: string;
    supersedesFileId?: string | null;
  },
): Promise<Outcome<UploadTicket>> {
  const allowed = checkUpload({
    filename: input.filename,
    contentType: input.contentType,
    declaredSize: input.declaredSize,
  });
  if (!allowed.ok) return refuse("invalid", allowed.reason);

  const [room] = await db()
    .select({ id: workrooms.id, archivedAt: workrooms.archivedAt })
    .from(workrooms)
    .where(eq(workrooms.id, input.workroomId))
    .limit(1);
  if (!room) return refuse("not_found", "That workroom no longer exists.");
  if (room.archivedAt) {
    return refuse("blocked", "That workroom is archived. Restore it before adding files.");
  }

  if (input.supersedesFileId) {
    const previous = await findFile(input.supersedesFileId);
    if (!previous || previous.workroomId !== input.workroomId) {
      return refuse("not_found", "The file being replaced is not in this workroom.");
    }
    if (previous.status !== "ready") {
      return refuse("blocked", "That upload never finished, so there is nothing to replace.");
    }
  }

  const fileId = uuidv7();
  const key = pendingKey(fileId);
  const displayName = (input.displayName ?? input.filename).trim().slice(0, 200) || input.filename;

  await db().insert(workroomFiles).values({
    id: fileId,
    publicId: opaquePublicId(),
    workroomId: input.workroomId,
    displayName,
    originalFilename: input.filename,
    contentType: input.contentType,
    storageKey: key,
    status: "pending",
    visibility: "internal",
    supersedesFileId: input.supersedesFileId ?? null,
    createdBy: actor.id,
    updatedBy: actor.id,
  });

  // No audit event yet, deliberately. A reserved place is not an upload, and a
  // log full of uploads that never happened is a log nobody reads.

  const multipart = input.declaredSize > MULTIPART_THRESHOLD_BYTES;
  return ok({
    fileId,
    key,
    strategy: multipart ? "multipart" : "single",
    partSize: MULTIPART_PART_BYTES,
    parts: multipart ? Math.ceil(input.declaredSize / MULTIPART_PART_BYTES) : 1,
  });
}

/**
 * Verify what actually arrived, then promote it.
 *
 * The order is the whole design:
 *
 *   HEAD    — what is really there, asked with our own credentials
 *   COPY    — into a permanent key the browser has no URL for
 *   DELETE  — the pending object, now redundant
 *   UPDATE  — only now is the row `ready`
 *
 * A failure at any step leaves the row `pending`, which is retryable and which
 * the sweep will eventually clear. **The database is written last on purpose**:
 * a row that says `ready` while storage holds nothing is the one state that
 * cannot be recovered from by looking, and this order makes it unreachable.
 *
 * The copy before the delete matters too. Deleting first and copying second
 * would leave a moment where the bytes exist nowhere.
 */
export async function finalizeUpload(
  actor: AuditActor,
  fileId: string,
  input: { declaredSize: number; previewUploaded?: boolean } = { declaredSize: 0 },
): Promise<Outcome<WorkroomFileRow>> {
  const file = await findFile(fileId);
  if (!file) return refuse("not_found", "That upload no longer exists.");
  if (file.status === "ready") return refuse("already_done", "That file is already stored.");
  if (!isPendingKey(file.storageKey)) {
    // Unreachable through the interface; a refusal rather than a copy from
    // somewhere unexpected, because this is the one place a wrong key would
    // become a permanent object.
    log.error("file.finalize_bad_key", { file_id: fileId });
    return refuse("invalid", "That upload is in an unexpected state.");
  }

  const facts = await headObject(file.storageKey);
  if (!facts) {
    return refuse("blocked", "Those bytes never arrived. Try the upload again.");
  }

  const expected = input.declaredSize;
  if (expected > 0 && facts.size !== expected) {
    await deleteObject(file.storageKey);
    log.warn("file.finalize_size_mismatch", { file_id: fileId, expected, actual: facts.size });
    return refuse("invalid", "The upload did not arrive intact. Try again.");
  }
  if (facts.size <= 0 || facts.size > MAX_FILE_BYTES) {
    await deleteObject(file.storageKey);
    log.warn("file.finalize_oversize", { file_id: fileId, actual: facts.size });
    return refuse("invalid", "That file is larger than 2 GB.");
  }

  const permanent = permanentKey(file.workroomId, file.id);
  await copyObject(file.storageKey, permanent);
  await deleteObject(file.storageKey);

  const preview = input.previewUploaded ? previewKey(file.workroomId, file.id) : null;

  return db().transaction(async (tx) => {
    const changed = await tx
      .update(workroomFiles)
      .set({
        storageKey: permanent,
        storageEtag: facts.etag,
        byteSize: facts.size,
        previewKey: preview,
        status: "ready",
        updatedBy: actor.id,
      })
      .where(and(eq(workroomFiles.id, fileId), eq(workroomFiles.status, "pending")))
      .returning({ id: workroomFiles.id });

    if (changed.length === 0) {
      // Somebody else finalized first. Their copy is the same bytes at the same
      // key, so nothing is wrong — this one simply has nothing left to do.
      return refuse("already_done", "That file is already stored.");
    }

    await recordAudit(tx, actor, {
      action: "file.uploaded",
      entityType: "workroom_file",
      entityId: fileId,
      entityLabel: file.displayName,
      metadata: { workroom_id: file.workroomId, bytes: facts.size },
    });

    if (file.supersedesFileId) {
      await recordAudit(tx, actor, {
        action: "file.replaced",
        entityType: "workroom_file",
        entityId: fileId,
        entityLabel: file.displayName,
        metadata: { workroom_id: file.workroomId, supersedes: file.supersedesFileId },
      });
    }

    const stored = await findFileIn(tx, fileId);
    return ok(stored!);
  });
}

async function findFileIn(tx: Tx, id: string): Promise<WorkroomFileRow | null> {
  const [row] = await tx.select(columns).from(workroomFiles).where(eq(workroomFiles.id, id)).limit(1);
  return (row as WorkroomFileRow | undefined) ?? null;
}

/** Give up on an upload deliberately. The same order the sweep uses. */
export async function abandonUpload(fileId: string): Promise<Outcome<void>> {
  const file = await findFile(fileId);
  if (!file) return ok(undefined);
  if (file.status !== "pending") {
    return refuse("blocked", "That file is stored, so it is archived rather than discarded.");
  }
  if (!isPendingKey(file.storageKey)) {
    log.error("file.abandon_bad_key", { file_id: fileId });
    return refuse("invalid", "That upload is in an unexpected state.");
  }

  await deleteObject(file.storageKey);
  await db().delete(workroomFiles).where(and(eq(workroomFiles.id, fileId), eq(workroomFiles.status, "pending")));
  return ok(undefined);
}

/* ----------------------------------------------------------------- edits */

export async function renameFile(
  actor: AuditActor,
  id: string,
  expectedVersion: number,
  displayName: string,
): Promise<Outcome<void>> {
  const name = displayName.trim();
  if (name.length === 0 || name.length > 200) {
    return refuse("invalid", "A file needs a name of up to 200 characters.");
  }

  const file = await findFile(id);
  if (!file) return refuse("not_found", "That file no longer exists.");

  return db().transaction(async (tx) => {
    const changed = await tx
      .update(workroomFiles)
      .set({ displayName: name, updatedBy: actor.id })
      .where(and(eq(workroomFiles.id, id), eq(workroomFiles.version, expectedVersion)))
      .returning({ id: workroomFiles.id });

    const outcome = expectUnchanged(changed.length);
    if (!outcome.ok) return outcome;

    await recordAudit(tx, actor, {
      action: "file.renamed",
      entityType: "workroom_file",
      entityId: id,
      entityLabel: name,
      metadata: { workroom_id: file.workroomId, fields: ["display_name"] },
    });
    return ok(undefined);
  });
}

/**
 * Give a file to the client, or take it back.
 *
 * Sharing writes the client's timeline entry; unsharing does not. A client who
 * was shown something and then was not is told by its absence, and a line
 * saying "this was taken away from you" is worse than the silence.
 */
export async function setFileVisibility(
  actor: AuditActor,
  id: string,
  expectedVersion: number,
  visibility: FileVisibility,
): Promise<Outcome<void>> {
  const file = await findFile(id);
  if (!file) return refuse("not_found", "That file no longer exists.");
  if (file.status !== "ready") {
    return refuse("blocked", "That upload never finished, so there is nothing to share.");
  }
  if (file.archivedAt) {
    return refuse("blocked", "That file is archived. Restore it before sharing it.");
  }
  if (file.visibility === visibility) return ok(undefined);

  return db().transaction(async (tx) => {
    const changed = await tx
      .update(workroomFiles)
      .set({
        visibility,
        sharedAt: visibility === "shared" ? new Date() : null,
        updatedBy: actor.id,
      })
      .where(and(eq(workroomFiles.id, id), eq(workroomFiles.version, expectedVersion)))
      .returning({ id: workroomFiles.id });

    const outcome = expectUnchanged(changed.length);
    if (!outcome.ok) return outcome;

    await recordAudit(tx, actor, {
      action: visibility === "shared" ? "file.shared" : "file.unshared",
      entityType: "workroom_file",
      entityId: id,
      entityLabel: file.displayName,
      metadata: { workroom_id: file.workroomId },
    });

    if (visibility === "shared") {
      await recordActivity(tx, file.workroomId, {
        kind: "file.shared",
        subject: file.displayName,
      });
    }
    return ok(undefined);
  });
}

/* --------------------------------------------------------------- archive */

/**
 * Archive, never delete.
 *
 * Refused while any immutable Revision references the file, and the refusal
 * names the count rather than shrugging: a Revision is what somebody approved,
 * and a file disappearing out of one would make the approval describe work
 * nobody can see. `ON DELETE restrict` on the revision item is the second line,
 * and it holds even against a bug here.
 */
export async function archiveFile(
  actor: AuditActor,
  id: string,
  expectedVersion: number,
): Promise<Outcome<void>> {
  const file = await findFile(id);
  if (!file) return refuse("not_found", "That file no longer exists.");
  if (file.archivedAt) return ok(undefined);

  const [used] = await db()
    .select({ count: sql<string>`count(*)` })
    .from(presentationRevisionItems)
    .where(eq(presentationRevisionItems.fileId, id));

  if (Number(used?.count ?? 0) > 0) {
    return refuse(
      "blocked",
      `${file.displayName} is part of a published presentation and cannot be archived. ` +
        "What a client was shown has to stay where they were shown it.",
    );
  }

  return db().transaction(async (tx) => {
    const changed = await tx
      .update(workroomFiles)
      .set({ archivedAt: new Date(), updatedBy: actor.id })
      .where(and(eq(workroomFiles.id, id), eq(workroomFiles.version, expectedVersion)))
      .returning({ id: workroomFiles.id });

    const outcome = expectUnchanged(changed.length);
    if (!outcome.ok) return outcome;

    await recordAudit(tx, actor, {
      action: "file.archived",
      entityType: "workroom_file",
      entityId: id,
      entityLabel: file.displayName,
      metadata: { workroom_id: file.workroomId },
    });
    return ok(undefined);
  });
}

export async function restoreFile(
  actor: AuditActor,
  id: string,
  expectedVersion: number,
): Promise<Outcome<void>> {
  const file = await findFile(id);
  if (!file) return refuse("not_found", "That file no longer exists.");
  if (!file.archivedAt) return ok(undefined);

  return db().transaction(async (tx) => {
    const changed = await tx
      .update(workroomFiles)
      .set({ archivedAt: null, updatedBy: actor.id })
      .where(and(eq(workroomFiles.id, id), eq(workroomFiles.version, expectedVersion)))
      .returning({ id: workroomFiles.id });

    const outcome = expectUnchanged(changed.length);
    if (!outcome.ok) return outcome;

    await recordAudit(tx, actor, {
      action: "file.restored",
      entityType: "workroom_file",
      entityId: id,
      entityLabel: file.displayName,
      metadata: { workroom_id: file.workroomId },
    });
    return ok(undefined);
  });
}

/* ----------------------------------------------------------------- sweep */

export type SweepResult = { examined: number; objectsDeleted: number; rowsDeleted: number };

/**
 * Remove uploads that were started and never finished.
 *
 * The bucket has no lifecycle configuration and expires nothing on our behalf,
 * so this is the whole of the cleanup. Five properties, each load-bearing:
 *
 *   The object is deleted BEFORE the row. The reverse order loses the key on a
 *   partial failure and leaves an object nobody can name. In this order a crash
 *   between the two leaves the row, the next run finds it, and the delete
 *   no-ops.
 *
 *   Idempotent. A missing object is success. Two runs, or two concurrent runs,
 *   change nothing the first did not.
 *
 *   It can only ever touch `pending/`. The prefix is asserted from the row
 *   rather than assumed from its status, so a bug that wrote a permanent key
 *   into a pending row still cannot delete a real file.
 *
 *   Bounded, by `limit`.
 *
 *   Only `pending`, only older than `olderThanHours`. A `ready` row is never a
 *   candidate and an upload in progress is never mistaken for an abandoned one.
 */
export async function sweepPendingUploads(
  options: { limit?: number; olderThanHours?: number; now?: Date } = {},
): Promise<SweepResult> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
  const hours = options.olderThanHours ?? 24;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - hours * 60 * 60 * 1000);

  const candidates = await db()
    .select({ id: workroomFiles.id, storageKey: workroomFiles.storageKey })
    .from(workroomFiles)
    .where(and(eq(workroomFiles.status, "pending"), lt(workroomFiles.createdAt, cutoff)))
    .orderBy(workroomFiles.createdAt)
    .limit(limit);

  const result: SweepResult = { examined: candidates.length, objectsDeleted: 0, rowsDeleted: 0 };

  for (const candidate of candidates) {
    if (!isPendingKey(candidate.storageKey)) {
      // Never guessed at, never "cleaned up anyway".
      log.error("file.sweep_refused_key", { file_id: candidate.id });
      continue;
    }

    await deleteObject(candidate.storageKey);
    result.objectsDeleted += 1;

    const removed = await db()
      .delete(workroomFiles)
      .where(and(eq(workroomFiles.id, candidate.id), eq(workroomFiles.status, "pending")))
      .returning({ id: workroomFiles.id });
    result.rowsDeleted += removed.length;
  }

  return result;
}
