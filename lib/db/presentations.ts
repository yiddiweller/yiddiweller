import { createHash } from "node:crypto";

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { record as recordActivity } from "./activity.ts";
import { record as recordAudit, type AuditActor } from "./audit.ts";
import { type WorkroomFileRow } from "./files.ts";
import { db, type Tx } from "./index.ts";
import { uuidv7 } from "./id.ts";
import { ok, refuse, expectUnchanged, type Outcome } from "./outcome.ts";
import { supersedeReviewOnPublish } from "./reviews.ts";
import {
  presentationItems,
  presentationRevisionItems,
  presentationRevisions,
  presentations,
  workroomFiles,
  workroomMembers,
  workrooms,
  type PresentationItemKind,
  type PresentationStatus,
} from "./schema.ts";
import {
  canonical,
  toClientPresentationView,
  toPresentationContent,
  type ClientPresentation,
  type PresentableItem,
  type PresentationContent,
  type PresentedItem,
} from "../workrooms/presentation-view.ts";
import { clientFileBase, studioFileBase } from "../workrooms/delivery-view.ts";
import { type FileKind, type ViewerKind } from "../storage/policy.ts";
import { opaquePublicId } from "../workrooms/id.ts";

/**
 * Presentations inside a Workroom.
 *
 * Four things here are worth reading before changing anything.
 *
 * **The draft is one document, so it carries one version.** Every mutation of a
 * Presentation — its title, its intro, an item's words, the order of the items
 * — passes the Presentation's own integer `version`, and a losing writer is
 * told somebody else got there first. Per-item versions would let two people
 * reorder the same list concurrently and both succeed, which is not a race
 * anybody wins.
 *
 * **Publishing is the one mutation that must be all-or-nothing.** It shares
 * files, freezes a snapshot, allocates a revision number, writes two immutable
 * tables and moves the Presentation's own pointer. A refusal part-way through
 * is raised as a throw rather than returned, precisely so PostgreSQL rolls the
 * whole thing back — returning an `Outcome` from inside a transaction commits
 * it, which is fine for a single guarded UPDATE and wrong for this.
 *
 * **Revision numbers are allocated under a row lock, not by reading a MAX.**
 * `SELECT … FOR UPDATE` on the Presentation serialises concurrent publishes of
 * it; the optimistic `version` check refuses the loser cleanly; and the unique
 * index on `(presentation_id, revision_number)` is the last line if both of
 * those were ever wrong. Three layers, all of them in the database.
 *
 * **A client is never shown anything rebuilt from a draft.** What a Revision
 * holds in `snapshot` is what the client reads, for ever. Draft rows are read
 * only by staff, and only to build the next snapshot or to preview it.
 */

/* ------------------------------------------------------------------ rows */

export type PresentationRow = {
  id: string;
  publicId: string;
  workroomId: string;
  title: string;
  intro: string;
  status: PresentationStatus;
  publishedAt: Date | null;
  currentRevisionId: string | null;
  version: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PresentationItemRow = {
  id: string;
  presentationId: string;
  workroomId: string;
  kind: PresentationItemKind;
  fileId: string | null;
  caption: string | null;
  body: string | null;
  position: number;
};

export type RevisionRow = {
  id: string;
  presentationId: string;
  revisionNumber: number;
  contentHash: string;
  publishedAt: Date;
  publishedByName: string | null;
};

const presentationColumns = {
  id: presentations.id,
  publicId: presentations.publicId,
  workroomId: presentations.workroomId,
  title: presentations.title,
  intro: presentations.intro,
  status: presentations.status,
  publishedAt: presentations.publishedAt,
  currentRevisionId: presentations.currentRevisionId,
  version: presentations.version,
  archivedAt: presentations.archivedAt,
  createdAt: presentations.createdAt,
  updatedAt: presentations.updatedAt,
};

const revisionColumns = {
  id: presentationRevisions.id,
  presentationId: presentationRevisions.presentationId,
  revisionNumber: presentationRevisions.revisionNumber,
  contentHash: presentationRevisions.contentHash,
  publishedAt: presentationRevisions.publishedAt,
  publishedByName: presentationRevisions.publishedByName,
};

const fileColumns = {
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
  updatedAt: workroomFiles.updatedAt,
};

/** Text ceilings, matching the CHECK constraints rather than guessing at them. */
export const TITLE_MAX = 200;
export const INTRO_MAX = 4000;
export const CAPTION_MAX = 500;
export const BODY_MAX = 4000;

/* --------------------------------------------------------------- reading */

export async function findPresentation(id: string): Promise<PresentationRow | null> {
  const [row] = await db().select(presentationColumns).from(presentations).where(eq(presentations.id, id)).limit(1);
  return (row as PresentationRow | undefined) ?? null;
}

export async function findPresentationByPublicId(publicId: string): Promise<PresentationRow | null> {
  const [row] = await db()
    .select(presentationColumns)
    .from(presentations)
    .where(eq(presentations.publicId, publicId))
    .limit(1);
  return (row as PresentationRow | undefined) ?? null;
}

export async function listPresentations(
  workroomId: string,
  options: { includeArchived?: boolean } = {},
): Promise<PresentationRow[]> {
  const where = options.includeArchived
    ? eq(presentations.workroomId, workroomId)
    : and(eq(presentations.workroomId, workroomId), isNull(presentations.archivedAt));

  const rows = await db()
    .select(presentationColumns)
    .from(presentations)
    .where(where)
    .orderBy(desc(presentations.createdAt));

  return rows as PresentationRow[];
}

/** The mutable draft, in order, with each file item's File attached. */
export async function listDraftItems(presentationId: string): Promise<PresentableItem[]> {
  const rows = await db()
    .select({
      position: presentationItems.position,
      kind: presentationItems.kind,
      caption: presentationItems.caption,
      body: presentationItems.body,
      file: fileColumns,
    })
    .from(presentationItems)
    .leftJoin(workroomFiles, eq(workroomFiles.id, presentationItems.fileId))
    .where(eq(presentationItems.presentationId, presentationId))
    .orderBy(asc(presentationItems.position));

  return rows.map((row) => ({
    position: row.position,
    kind: row.kind,
    caption: row.caption,
    body: row.body,
    file: (row.file?.id ? (row.file as WorkroomFileRow) : null),
  }));
}

/** The same rows, unprojected, for the editor's own controls. */
export async function listDraftRows(presentationId: string): Promise<PresentationItemRow[]> {
  const rows = await db()
    .select({
      id: presentationItems.id,
      presentationId: presentationItems.presentationId,
      workroomId: presentationItems.workroomId,
      kind: presentationItems.kind,
      fileId: presentationItems.fileId,
      caption: presentationItems.caption,
      body: presentationItems.body,
      position: presentationItems.position,
    })
    .from(presentationItems)
    .where(eq(presentationItems.presentationId, presentationId))
    .orderBy(asc(presentationItems.position));

  return rows as PresentationItemRow[];
}

export async function listRevisions(presentationId: string): Promise<RevisionRow[]> {
  const rows = await db()
    .select(revisionColumns)
    .from(presentationRevisions)
    .where(eq(presentationRevisions.presentationId, presentationId))
    .orderBy(desc(presentationRevisions.revisionNumber));

  return rows as RevisionRow[];
}

/**
 * The frozen content of one Revision.
 *
 * Read straight out of `snapshot`. The relational items beside it are the
 * integrity record — they carry the foreign keys, the archive guard and the
 * proof of which physical file belonged to a decision — but the thing the
 * client reads is the thing that was written for the client, unaltered.
 */
function readSnapshot(value: unknown): PresentationContent {
  const snapshot = value as { title?: unknown; intro?: unknown; items?: unknown } | null;
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];

  return {
    title: typeof snapshot?.title === "string" ? snapshot.title : "",
    intro: typeof snapshot?.intro === "string" ? snapshot.intro : "",
    items: items.map(readSnapshotItem).filter((item): item is PresentedItem => item !== null),
  };
}

/**
 * One frozen item, normalised.
 *
 * Revisions published before routes were separated from content froze a file's
 * four paths into the snapshot. Those rows are immutable — correctly — so they
 * are read rather than rewritten: the file's opaque public id was always in
 * there, the routes are rebuilt per surface from it, and whether a thumbnail
 * exists is taken from the newer boolean or inferred from the old
 * `previewPath`. Nothing about what the client was shown changes either way.
 */
function readSnapshotItem(value: unknown): PresentedItem | null {
  const item = value as Record<string, unknown> | null;
  if (!item || typeof item.position !== "number") return null;

  if (item.kind === "note") {
    return {
      position: item.position,
      kind: "note",
      caption: typeof item.caption === "string" ? item.caption : null,
      body: typeof item.body === "string" ? item.body : "",
    };
  }

  if (item.kind !== "file") return null;
  const file = item.file as Record<string, unknown> | null;
  if (!file || typeof file.id !== "string") return null;

  return {
    position: item.position,
    kind: "file",
    caption: typeof item.caption === "string" ? item.caption : null,
    file: {
      id: file.id,
      name: typeof file.name === "string" ? file.name : "",
      kind: (typeof file.kind === "string" ? file.kind : "other") as FileKind,
      viewer: (typeof file.viewer === "string" ? file.viewer : "download") as ViewerKind,
      size: typeof file.size === "string" ? file.size : "",
      hasPreview:
        typeof file.hasPreview === "boolean" ? file.hasPreview : typeof file.previewPath === "string",
    },
  };
}

/* ------------------------------------------------------------ staff reads */

export type StaffPresentationView = {
  presentation: PresentationRow;
  view: ClientPresentation;
};

/**
 * The draft as it would publish — what `/preview` shows.
 *
 * Deliberately **not** what a client currently sees when the Presentation is
 * already published: that is the current Revision, and the two differ exactly
 * when somebody has edited without republishing. The Studio page says which is
 * which rather than leaving staff to infer it.
 */
export async function draftPreview(presentation: PresentationRow): Promise<ClientPresentation> {
  const [items, revisions] = await Promise.all([
    listDraftItems(presentation.id),
    listRevisions(presentation.id),
  ]);

  const content = toPresentationContent(presentation, items);

  // Staff-authorized routes, deliberately. The preview must render the draft
  // as it would publish, and a draft is full of files that are still internal
  // — which the client routes correctly refuse. Making them render by sharing
  // the file early would be the tail wagging the dog.
  return toClientPresentationView(
    presentation.publicId,
    content,
    {
      publishedAt: null,
      revision: null,
      revisions: revisions.map((r) => ({ number: r.revisionNumber, publishedAt: r.publishedAt })),
    },
    studioFileBase(presentation.workroomId),
  );
}

/** One published Revision, for staff, rendered from its own snapshot. */
export async function revisionForStaff(
  presentation: PresentationRow,
  revisionNumber: number,
): Promise<ClientPresentation | null> {
  const [row] = await db()
    .select({ ...revisionColumns, snapshot: presentationRevisions.snapshot })
    .from(presentationRevisions)
    .where(
      and(
        eq(presentationRevisions.presentationId, presentation.id),
        eq(presentationRevisions.revisionNumber, revisionNumber),
      ),
    )
    .limit(1);

  if (!row) return null;

  const revisions = await listRevisions(presentation.id);

  // Staff routes here too. Every file in a published Revision is shared, so
  // the client's would also resolve — but staff cannot use them: a Studio
  // session on a `/workrooms/...` route is sent to the client sign-in, exactly
  // as a stranger is. Authority decides the route, not the file's visibility.
  return toClientPresentationView(
    presentation.publicId,
    readSnapshot(row.snapshot),
    {
      publishedAt: row.publishedAt,
      revision: row.revisionNumber,
      revisions: revisions.map((r) => ({ number: r.revisionNumber, publishedAt: r.publishedAt })),
    },
    studioFileBase(presentation.workroomId),
  );
}

/* ----------------------------------------------------------- client reads */

/**
 * Every client-facing read carries the whole gate in one query: active
 * membership, a published unarchived Workroom, and a published unarchived
 * Presentation. Membership is read from the database on every request and
 * never from the session, so revocation takes effect on the next click.
 */
function clientVisible() {
  return and(eq(presentations.status, "published"), isNull(presentations.archivedAt));
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

export type ClientPresentationSummary = {
  id: string;
  title: string;
  intro: string;
  publishedAt: string;
  revision: number;
  revisionCount: number;
};

export async function presentationsForViewer(
  contactId: string,
  workroomPublicId: string,
): Promise<ClientPresentationSummary[]> {
  const rows = await db()
    .select({
      publicId: presentations.publicId,
      title: presentations.title,
      intro: presentations.intro,
      publishedAt: presentations.publishedAt,
      revisionNumber: presentationRevisions.revisionNumber,
      revisionCount: sql<string>`(
        SELECT count(*) FROM ${presentationRevisions} r
        WHERE r.presentation_id = ${presentations.id}
      )`,
    })
    .from(presentations)
    .innerJoin(workrooms, eq(workrooms.id, presentations.workroomId))
    .innerJoin(workroomMembers, eq(workroomMembers.workroomId, workrooms.id))
    .innerJoin(presentationRevisions, eq(presentationRevisions.id, presentations.currentRevisionId))
    .where(viewerScope(contactId, workroomPublicId))
    .orderBy(desc(presentations.publishedAt));

  return rows.map((row) => ({
    id: row.publicId,
    title: row.title,
    intro: row.intro,
    publishedAt: (row.publishedAt ?? new Date()).toISOString(),
    revision: row.revisionNumber,
    revisionCount: Number(row.revisionCount ?? 1),
  }));
}

/**
 * The same summaries, for the staff preview.
 *
 * No membership clause, because staff authorization already happened and there
 * is no client session here — that is the whole point of the preview. What it
 * must not differ on is which Presentations count as open to the client, so it
 * shares `clientVisible()` with the read above rather than restating it.
 */
export async function presentationsInWorkroom(workroomId: string): Promise<ClientPresentationSummary[]> {
  const rows = await db()
    .select({
      publicId: presentations.publicId,
      title: presentations.title,
      intro: presentations.intro,
      publishedAt: presentations.publishedAt,
      revisionNumber: presentationRevisions.revisionNumber,
      revisionCount: sql<string>`(
        SELECT count(*) FROM ${presentationRevisions} r
        WHERE r.presentation_id = ${presentations.id}
      )`,
    })
    .from(presentations)
    .innerJoin(presentationRevisions, eq(presentationRevisions.id, presentations.currentRevisionId))
    .where(and(eq(presentations.workroomId, workroomId), clientVisible()))
    .orderBy(desc(presentations.publishedAt));

  return rows.map((row) => ({
    id: row.publicId,
    title: row.title,
    intro: row.intro,
    publishedAt: (row.publishedAt ?? new Date()).toISOString(),
    revision: row.revisionNumber,
    revisionCount: Number(row.revisionCount ?? 1),
  }));
}

/**
 * One Presentation for a client — the current Revision, or a named earlier one.
 *
 * A Revision row exists **if and only if** the publish transaction wrote it, so
 * "may they open Revision 2?" is answered by the row existing inside this
 * scope. No flag is consulted and none can be got wrong.
 */
export async function presentationForViewer(
  contactId: string,
  workroomPublicId: string,
  presentationPublicId: string,
  revisionNumber?: number,
): Promise<ClientPresentation | null> {
  const wanted =
    revisionNumber === undefined
      ? eq(presentationRevisions.id, presentations.currentRevisionId)
      : and(
          eq(presentationRevisions.presentationId, presentations.id),
          eq(presentationRevisions.revisionNumber, revisionNumber),
        );

  const [row] = await db()
    .select({
      presentationId: presentations.id,
      publicId: presentations.publicId,
      snapshot: presentationRevisions.snapshot,
      revisionNumber: presentationRevisions.revisionNumber,
      revisionPublishedAt: presentationRevisions.publishedAt,
    })
    .from(presentations)
    .innerJoin(workrooms, eq(workrooms.id, presentations.workroomId))
    .innerJoin(workroomMembers, eq(workroomMembers.workroomId, workrooms.id))
    .innerJoin(presentationRevisions, wanted)
    .where(and(viewerScope(contactId, workroomPublicId), eq(presentations.publicId, presentationPublicId)))
    .limit(1);

  if (!row) return null;

  const revisions = await db()
    .select({ number: presentationRevisions.revisionNumber, publishedAt: presentationRevisions.publishedAt })
    .from(presentationRevisions)
    .where(eq(presentationRevisions.presentationId, row.presentationId))
    .orderBy(desc(presentationRevisions.revisionNumber));

  return toClientPresentationView(
    row.publicId,
    readSnapshot(row.snapshot),
    { publishedAt: row.revisionPublishedAt, revision: row.revisionNumber, revisions },
    clientFileBase(workroomPublicId),
  );
}

/* --------------------------------------------------------------- writing */

/**
 * A refusal raised from inside a transaction.
 *
 * Returning an `Outcome` from a transaction callback **commits** it. Publishing
 * writes to five tables, so a refusal half-way has to unwind — and the only
 * thing that unwinds a PostgreSQL transaction is a throw.
 */
class Refused extends Error {
  // Declared rather than a parameter property: Node runs this repository's
  // tests with type stripping, which cannot rewrite one.
  readonly outcome: Outcome<never>;

  constructor(outcome: Outcome<never>) {
    super("refused");
    this.name = "Refused";
    this.outcome = outcome;
  }
}

function refused(reason: Parameters<typeof refuse>[0], message: string): never {
  throw new Refused(refuse(reason, message));
}

async function settle<T>(work: Promise<Outcome<T>>): Promise<Outcome<T>> {
  try {
    return await work;
  } catch (cause) {
    if (cause instanceof Refused) return cause.outcome as Outcome<T>;
    throw cause;
  }
}

/**
 * Proves this writer still holds the version it loaded, and takes the write
 * lock on the document in the same statement.
 *
 * Every draft mutation goes through here first, so an edit that lost a race
 * changes nothing at all rather than changing one row of several.
 */
async function claimDraft(
  tx: Tx,
  actor: AuditActor,
  presentationId: string,
  expectedVersion: number,
): Promise<void> {
  const changed = await tx
    .update(presentations)
    .set({ updatedBy: actor.id })
    .where(and(eq(presentations.id, presentationId), eq(presentations.version, expectedVersion)))
    .returning({ id: presentations.id });

  const outcome = expectUnchanged(changed.length);
  if (!outcome.ok) throw new Refused(outcome as Outcome<never>);
}

export async function createPresentation(
  actor: AuditActor,
  workroomId: string,
  input: { title: string; intro: string },
): Promise<Outcome<string>> {
  const title = input.title.trim();
  if (title.length === 0) return refuse("invalid", "A presentation needs a title.");
  if (title.length > TITLE_MAX) return refuse("invalid", `Keep the title under ${TITLE_MAX} characters.`);
  if (input.intro.length > INTRO_MAX) return refuse("invalid", `Keep the introduction under ${INTRO_MAX} characters.`);

  const [room] = await db()
    .select({ id: workrooms.id, archivedAt: workrooms.archivedAt })
    .from(workrooms)
    .where(eq(workrooms.id, workroomId))
    .limit(1);

  if (!room) return refuse("not_found", "That workroom no longer exists.");
  if (room.archivedAt) return refuse("blocked", "That workroom is archived.");

  const id = uuidv7();
  const publicId = opaquePublicId();

  return db().transaction(async (tx) => {
    await tx.insert(presentations).values({
      id,
      publicId,
      workroomId,
      title,
      intro: input.intro.trim(),
      createdBy: actor.id,
      updatedBy: actor.id,
    });

    await recordAudit(tx, actor, {
      action: "presentation.created",
      entityType: "presentation",
      entityId: id,
      entityLabel: title,
      metadata: { workroom_id: workroomId },
    });

    return ok(id);
  });
}

export async function updatePresentation(
  actor: AuditActor,
  id: string,
  expectedVersion: number,
  input: { title: string; intro: string },
): Promise<Outcome<void>> {
  const title = input.title.trim();
  if (title.length === 0) return refuse("invalid", "A presentation needs a title.");
  if (title.length > TITLE_MAX) return refuse("invalid", `Keep the title under ${TITLE_MAX} characters.`);
  if (input.intro.length > INTRO_MAX) return refuse("invalid", `Keep the introduction under ${INTRO_MAX} characters.`);

  const presentation = await findPresentation(id);
  if (!presentation) return refuse("not_found", "That presentation no longer exists.");
  if (presentation.archivedAt) return refuse("blocked", "Restore this presentation before editing it.");

  return settle(
    db().transaction(async (tx) => {
      const changed = await tx
        .update(presentations)
        .set({ title, intro: input.intro.trim(), updatedBy: actor.id })
        .where(and(eq(presentations.id, id), eq(presentations.version, expectedVersion)))
        .returning({ id: presentations.id });

      const outcome = expectUnchanged(changed.length);
      if (!outcome.ok) return outcome;

      await recordAudit(tx, actor, {
        action: "presentation.updated",
        entityType: "presentation",
        entityId: id,
        entityLabel: title,
        metadata: { workroom_id: presentation.workroomId, fields: ["title", "intro"] },
      });

      return ok(undefined);
    }),
  );
}

async function nextPosition(tx: Tx, presentationId: string): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number | null>`max(${presentationItems.position})` })
    .from(presentationItems)
    .where(eq(presentationItems.presentationId, presentationId));

  return (row?.max ?? -1) + 1;
}

/**
 * Add an existing Workroom File to the draft.
 *
 * `ready` is required and `pending` is refused for a reason beyond tidiness: a
 * pending row is a reservation whose bytes may never arrive, and the item's
 * foreign key is `ON DELETE restrict`, so a pending file inside a draft would
 * make Stage A's cleanup sweep fail on that row rather than skip it.
 */
export async function addFileItem(
  actor: AuditActor,
  presentationId: string,
  expectedVersion: number,
  fileId: string,
  caption: string,
): Promise<Outcome<void>> {
  if (caption.length > CAPTION_MAX) return refuse("invalid", `Keep the caption under ${CAPTION_MAX} characters.`);

  const presentation = await findPresentation(presentationId);
  if (!presentation) return refuse("not_found", "That presentation no longer exists.");
  if (presentation.archivedAt) return refuse("blocked", "Restore this presentation before editing it.");

  const [file] = await db()
    .select({
      id: workroomFiles.id,
      workroomId: workroomFiles.workroomId,
      status: workroomFiles.status,
      archivedAt: workroomFiles.archivedAt,
      displayName: workroomFiles.displayName,
    })
    .from(workroomFiles)
    .where(eq(workroomFiles.id, fileId))
    .limit(1);

  if (!file || file.workroomId !== presentation.workroomId) {
    return refuse("not_found", "That file is not in this workroom.");
  }
  if (file.status !== "ready") {
    return refuse("blocked", "That upload never finished, so there is nothing to present.");
  }
  if (file.archivedAt) return refuse("blocked", "That file is archived. Restore it before presenting it.");

  return settle(
    db().transaction(async (tx) => {
      await claimDraft(tx, actor, presentationId, expectedVersion);

      await tx.insert(presentationItems).values({
        id: uuidv7(),
        workroomId: presentation.workroomId,
        presentationId,
        kind: "file",
        fileId,
        caption: caption.trim() || null,
        body: null,
        position: await nextPosition(tx, presentationId),
      });

      await recordAudit(tx, actor, {
        action: "presentation.updated",
        entityType: "presentation",
        entityId: presentationId,
        entityLabel: presentation.title,
        metadata: { workroom_id: presentation.workroomId, added: "file", file_id: fileId },
      });

      return ok(undefined);
    }),
  );
}

export async function addNoteItem(
  actor: AuditActor,
  presentationId: string,
  expectedVersion: number,
  input: { caption: string; body: string },
): Promise<Outcome<void>> {
  const body = input.body.trim();
  if (body.length === 0) return refuse("invalid", "A note needs some words.");
  if (body.length > BODY_MAX) return refuse("invalid", `Keep the note under ${BODY_MAX} characters.`);
  if (input.caption.length > CAPTION_MAX) return refuse("invalid", `Keep the heading under ${CAPTION_MAX} characters.`);

  const presentation = await findPresentation(presentationId);
  if (!presentation) return refuse("not_found", "That presentation no longer exists.");
  if (presentation.archivedAt) return refuse("blocked", "Restore this presentation before editing it.");

  return settle(
    db().transaction(async (tx) => {
      await claimDraft(tx, actor, presentationId, expectedVersion);

      await tx.insert(presentationItems).values({
        id: uuidv7(),
        workroomId: presentation.workroomId,
        presentationId,
        kind: "note",
        fileId: null,
        caption: input.caption.trim() || null,
        body,
        position: await nextPosition(tx, presentationId),
      });

      await recordAudit(tx, actor, {
        action: "presentation.updated",
        entityType: "presentation",
        entityId: presentationId,
        entityLabel: presentation.title,
        metadata: { workroom_id: presentation.workroomId, added: "note" },
      });

      return ok(undefined);
    }),
  );
}

export async function updateItem(
  actor: AuditActor,
  presentationId: string,
  expectedVersion: number,
  itemId: string,
  input: { caption: string; body: string },
): Promise<Outcome<void>> {
  if (input.caption.length > CAPTION_MAX) return refuse("invalid", `Keep that under ${CAPTION_MAX} characters.`);
  if (input.body.length > BODY_MAX) return refuse("invalid", `Keep that under ${BODY_MAX} characters.`);

  const presentation = await findPresentation(presentationId);
  if (!presentation) return refuse("not_found", "That presentation no longer exists.");
  if (presentation.archivedAt) return refuse("blocked", "Restore this presentation before editing it.");

  const [item] = await db()
    .select({ id: presentationItems.id, kind: presentationItems.kind, presentationId: presentationItems.presentationId })
    .from(presentationItems)
    .where(eq(presentationItems.id, itemId))
    .limit(1);

  if (!item || item.presentationId !== presentationId) {
    return refuse("not_found", "That block is no longer in this presentation.");
  }

  const body = input.body.trim();
  if (item.kind === "note" && body.length === 0) return refuse("invalid", "A note needs some words.");

  return settle(
    db().transaction(async (tx) => {
      await claimDraft(tx, actor, presentationId, expectedVersion);

      await tx
        .update(presentationItems)
        .set({
          caption: input.caption.trim() || null,
          // The shape CHECK holds either way: a file item's body stays null.
          ...(item.kind === "note" ? { body } : {}),
        })
        .where(eq(presentationItems.id, itemId));

      await recordAudit(tx, actor, {
        action: "presentation.updated",
        entityType: "presentation",
        entityId: presentationId,
        entityLabel: presentation.title,
        metadata: { workroom_id: presentation.workroomId, fields: ["caption", "body"] },
      });

      return ok(undefined);
    }),
  );
}

/**
 * Move one block up or down.
 *
 * A swap with the neighbour rather than a renumbering pass: positions may hold
 * gaps after a removal, and the only thing anything reads is their order.
 */
export async function moveItem(
  actor: AuditActor,
  presentationId: string,
  expectedVersion: number,
  itemId: string,
  direction: "up" | "down",
): Promise<Outcome<void>> {
  const presentation = await findPresentation(presentationId);
  if (!presentation) return refuse("not_found", "That presentation no longer exists.");
  if (presentation.archivedAt) return refuse("blocked", "Restore this presentation before editing it.");

  const rows = await listDraftRows(presentationId);
  const index = rows.findIndex((row) => row.id === itemId);
  if (index === -1) return refuse("not_found", "That block is no longer in this presentation.");

  const neighbour = direction === "up" ? rows[index - 1] : rows[index + 1];
  if (!neighbour) return ok(undefined);

  const mine = rows[index];

  return settle(
    db().transaction(async (tx) => {
      await claimDraft(tx, actor, presentationId, expectedVersion);

      // Park one out of the way first. The index on (presentation_id, position)
      // is not unique, so this is belt and braces rather than a requirement —
      // and it costs one statement.
      await tx.update(presentationItems).set({ position: -1 }).where(eq(presentationItems.id, mine.id));
      await tx
        .update(presentationItems)
        .set({ position: mine.position })
        .where(eq(presentationItems.id, neighbour.id));
      await tx
        .update(presentationItems)
        .set({ position: neighbour.position })
        .where(eq(presentationItems.id, mine.id));

      await recordAudit(tx, actor, {
        action: "presentation.updated",
        entityType: "presentation",
        entityId: presentationId,
        entityLabel: presentation.title,
        metadata: { workroom_id: presentation.workroomId, reordered: true },
      });

      return ok(undefined);
    }),
  );
}

export async function removeItem(
  actor: AuditActor,
  presentationId: string,
  expectedVersion: number,
  itemId: string,
): Promise<Outcome<void>> {
  const presentation = await findPresentation(presentationId);
  if (!presentation) return refuse("not_found", "That presentation no longer exists.");
  if (presentation.archivedAt) return refuse("blocked", "Restore this presentation before editing it.");

  return settle(
    db().transaction(async (tx) => {
      await claimDraft(tx, actor, presentationId, expectedVersion);

      await tx
        .delete(presentationItems)
        .where(and(eq(presentationItems.id, itemId), eq(presentationItems.presentationId, presentationId)));

      await recordAudit(tx, actor, {
        action: "presentation.updated",
        entityType: "presentation",
        entityId: presentationId,
        entityLabel: presentation.title,
        metadata: { workroom_id: presentation.workroomId, removed: true },
      });

      return ok(undefined);
    }),
  );
}

/* --------------------------------------------------------------- publish */

/**
 * Which currently-internal Files this publish would share.
 *
 * Read by the Studio confirmation before anybody presses the button, because
 * publishing shares what it references and a consequence nobody was shown is
 * not a consequence anybody chose.
 */
export async function filesToShareOnPublish(presentationId: string): Promise<WorkroomFileRow[]> {
  const rows = await db()
    .selectDistinct(fileColumns)
    .from(presentationItems)
    .innerJoin(workroomFiles, eq(workroomFiles.id, presentationItems.fileId))
    .where(and(eq(presentationItems.presentationId, presentationId), eq(workroomFiles.visibility, "internal")))
    .orderBy(asc(workroomFiles.displayName));

  return rows as WorkroomFileRow[];
}

export function contentHash(content: PresentationContent): string {
  return createHash("sha256").update(canonical(content)).digest("hex");
}

export type Published = { revision: number; sharedFiles: number; hash: string };

/**
 * Freeze the draft into an immutable Revision, and make it the one a client
 * sees.
 *
 * Twenty steps, one transaction, and every refusal inside it throws so that
 * nothing survives a failure: no half-shared files, no orphan Revision, no
 * activity for a publication that did not happen, and no `current_revision_id`
 * pointing at a row that was rolled back.
 */
export async function publishPresentation(
  actor: AuditActor,
  id: string,
  expectedVersion: number,
): Promise<Outcome<Published>> {
  const presentation = await findPresentation(id);
  if (!presentation) return refuse("not_found", "That presentation no longer exists.");
  if (presentation.archivedAt) return refuse("blocked", "Restore this presentation before publishing it.");

  const [room] = await db()
    .select({ status: workrooms.status, archivedAt: workrooms.archivedAt, publicId: workrooms.publicId })
    .from(workrooms)
    .where(eq(workrooms.id, presentation.workroomId))
    .limit(1);

  if (!room) return refuse("not_found", "That workroom no longer exists.");
  if (room.archivedAt) return refuse("blocked", "That workroom is archived.");
  if (room.status !== "published") {
    return refuse("blocked", "Open this workroom to the client before publishing a presentation in it.");
  }

  const firstPublication = presentation.publishedAt === null;

  return settle(
    db().transaction(async (tx): Promise<Outcome<Published>> => {
      // Serialises concurrent publishes of *this* Presentation. The second
      // waits here, then fails its version check below and writes nothing.
      await tx.execute(sql`SELECT id FROM ${presentations} WHERE id = ${id} FOR UPDATE`);

      // Re-read under the lock: the draft is what it is now, not what it was
      // when the page was rendered.
      const items = await tx
        .select({
          id: presentationItems.id,
          position: presentationItems.position,
          kind: presentationItems.kind,
          caption: presentationItems.caption,
          body: presentationItems.body,
          fileId: presentationItems.fileId,
          file: fileColumns,
        })
        .from(presentationItems)
        .leftJoin(workroomFiles, eq(workroomFiles.id, presentationItems.fileId))
        .where(eq(presentationItems.presentationId, id))
        .orderBy(asc(presentationItems.position));

      if (items.length === 0) {
        refused("blocked", "There is nothing in this presentation yet.");
      }

      for (const item of items) {
        if (item.kind !== "file") continue;
        const file = item.file;
        if (!file?.id) refused("blocked", "A file in this presentation no longer exists.");
        if (file.workroomId !== presentation.workroomId) {
          refused("blocked", "A file in this presentation belongs to another workroom.");
        }
        if (file.status !== "ready") {
          refused("blocked", `${file.displayName} never finished uploading.`);
        }
        if (file.archivedAt) {
          refused("blocked", `${file.displayName} is archived. Restore it or remove it from this presentation.`);
        }
      }

      // Publishing shares. One predicate governs what a client may see, and
      // this is what keeps it true inside a Revision opened years from now.
      const toShare = [
        ...new Map(
          items
            .filter((item) => item.file?.id && item.file.visibility === "internal")
            .map((item) => [item.file!.id, item.file!]),
        ).values(),
      ];

      for (const file of toShare) {
        await tx
          .update(workroomFiles)
          .set({ visibility: "shared", sharedAt: new Date(), updatedBy: actor.id })
          .where(eq(workroomFiles.id, file.id));

        await recordAudit(tx, actor, {
          action: "file.shared",
          entityType: "workroom_file",
          entityId: file.id,
          entityLabel: file.displayName,
          metadata: { workroom_id: presentation.workroomId, by: "presentation.published" },
        });

        await recordActivity(tx, presentation.workroomId, {
          kind: "file.shared",
          subject: file.displayName,
        });
      }

      // The snapshot is built by projecting, never by assembling a row. Files
      // are read back as just shared, so the frozen view says `shared` too.
      const presentable: PresentableItem[] = items.map((item) => ({
        position: item.position,
        kind: item.kind,
        caption: item.caption,
        body: item.body,
        file: item.file?.id ? ({ ...item.file, visibility: "shared" } as WorkroomFileRow) : null,
        displayNameSnapshot: item.file?.id ? item.file.displayName : null,
      }));

      const content = toPresentationContent(presentation, presentable);
      const hash = contentHash(content);

      const [highest] = await tx
        .select({ max: sql<number | null>`max(${presentationRevisions.revisionNumber})` })
        .from(presentationRevisions)
        .where(eq(presentationRevisions.presentationId, id));

      const revisionNumber = (highest?.max ?? 0) + 1;
      const revisionId = uuidv7();
      const publishedAt = new Date();

      // Which Revision this one replaces, read under the lock rather than from
      // the row loaded before it — a concurrent publish may have moved it.
      const [pointing] = await tx
        .select({ currentRevisionId: presentations.currentRevisionId })
        .from(presentations)
        .where(eq(presentations.id, id));
      const outgoingRevisionId = pointing?.currentRevisionId ?? null;

      await tx.insert(presentationRevisions).values({
        id: revisionId,
        workroomId: presentation.workroomId,
        presentationId: id,
        revisionNumber,
        snapshot: content,
        contentHash: hash,
        publishedAt,
        publishedBy: actor.kind === "team_user" || !actor.kind ? actor.id : null,
        publishedByName: actor.name,
      });

      await tx.insert(presentationRevisionItems).values(
        content.items.map((item, index) => ({
          id: uuidv7(),
          workroomId: presentation.workroomId,
          presentationRevisionId: revisionId,
          position: index,
          kind: item.kind,
          fileId: item.kind === "file" ? (presentable.find((p) => p.position === item.position)?.file?.id ?? null) : null,
          displayNameSnapshot: item.kind === "file" ? item.file.name : null,
          caption: item.caption,
          body: item.kind === "note" ? item.body : null,
        })),
      );

      // The optimistic gate, last, so a loser unwinds everything above it.
      const changed = await tx
        .update(presentations)
        .set({
          status: "published",
          publishedAt: presentation.publishedAt ?? publishedAt,
          currentRevisionId: revisionId,
          updatedBy: actor.id,
        })
        .where(and(eq(presentations.id, id), eq(presentations.version, expectedVersion)))
        .returning({ id: presentations.id });

      if (changed.length === 0) {
        const conflict = expectUnchanged(0);
        if (!conflict.ok) throw new Refused(conflict as Outcome<never>);
      }

      // Publishing ends the round on the version it replaces, terminally, and
      // touches nothing inside it. Unresolved notes stay unresolved — visibly,
      // permanently — because auto-resolving them would be the studio marking
      // the client's points handled without saying so. A round staff already
      // closed keeps that reason; a withdrawn one stays withdrawn.
      await supersedeReviewOnPublish(
        tx,
        actor,
        outgoingRevisionId,
        revisionId,
        presentation.title,
        revisionNumber,
      );

      await recordActivity(tx, presentation.workroomId, {
        kind: firstPublication ? "presentation.published" : "presentation.revised",
        subject: presentation.title,
      });

      await recordAudit(tx, actor, {
        action: "presentation.published",
        entityType: "presentation",
        entityId: id,
        entityLabel: presentation.title,
        metadata: {
          workroom_id: presentation.workroomId,
          revision: revisionNumber,
          shared_files: toShare.length,
        },
      });

      return ok({ revision: revisionNumber, sharedFiles: toShare.length, hash });
    }),
  );
}

/**
 * Take the whole Presentation back — its history with it.
 *
 * Every Revision survives untouched, and so does every Activity and Audit row.
 * Files are **not** unshared: unpublishing retracts a delivery, not a library.
 */
export async function unpublishPresentation(
  actor: AuditActor,
  id: string,
  expectedVersion: number,
): Promise<Outcome<void>> {
  const presentation = await findPresentation(id);
  if (!presentation) return refuse("not_found", "That presentation no longer exists.");
  if (presentation.status !== "published") return ok(undefined);

  return db().transaction(async (tx) => {
    const changed = await tx
      .update(presentations)
      .set({ status: "unpublished", updatedBy: actor.id })
      .where(and(eq(presentations.id, id), eq(presentations.version, expectedVersion)))
      .returning({ id: presentations.id });

    const outcome = expectUnchanged(changed.length);
    if (!outcome.ok) return outcome;

    await recordAudit(tx, actor, {
      action: "presentation.unpublished",
      entityType: "presentation",
      entityId: id,
      entityLabel: presentation.title,
      metadata: { workroom_id: presentation.workroomId },
    });

    return ok(undefined);
  });
}

export async function archivePresentation(
  actor: AuditActor,
  id: string,
  expectedVersion: number,
): Promise<Outcome<void>> {
  const presentation = await findPresentation(id);
  if (!presentation) return refuse("not_found", "That presentation no longer exists.");
  if (presentation.archivedAt) return ok(undefined);
  if (presentation.status === "published") {
    return refuse(
      "blocked",
      "This presentation is open to the client. Unpublish it first, so losing access is never a side effect of tidying up.",
    );
  }

  return db().transaction(async (tx) => {
    const changed = await tx
      .update(presentations)
      .set({ archivedAt: new Date(), updatedBy: actor.id })
      .where(and(eq(presentations.id, id), eq(presentations.version, expectedVersion)))
      .returning({ id: presentations.id });

    const outcome = expectUnchanged(changed.length);
    if (!outcome.ok) return outcome;

    await recordAudit(tx, actor, {
      action: "presentation.archived",
      entityType: "presentation",
      entityId: id,
      entityLabel: presentation.title,
      metadata: { workroom_id: presentation.workroomId },
    });

    return ok(undefined);
  });
}

export async function restorePresentation(
  actor: AuditActor,
  id: string,
  expectedVersion: number,
): Promise<Outcome<void>> {
  const presentation = await findPresentation(id);
  if (!presentation) return refuse("not_found", "That presentation no longer exists.");
  if (!presentation.archivedAt) return ok(undefined);

  return db().transaction(async (tx) => {
    const changed = await tx
      .update(presentations)
      .set({ archivedAt: null, updatedBy: actor.id })
      .where(and(eq(presentations.id, id), eq(presentations.version, expectedVersion)))
      .returning({ id: presentations.id });

    const outcome = expectUnchanged(changed.length);
    if (!outcome.ok) return outcome;

    await recordAudit(tx, actor, {
      action: "presentation.restored",
      entityType: "presentation",
      entityId: id,
      entityLabel: presentation.title,
      metadata: { workroom_id: presentation.workroomId },
    });

    return ok(undefined);
  });
}

/** Which Files a Workroom has that are eligible to be presented. */
export async function presentableFiles(workroomId: string): Promise<WorkroomFileRow[]> {
  const rows = await db()
    .select(fileColumns)
    .from(workroomFiles)
    .where(
      and(
        eq(workroomFiles.workroomId, workroomId),
        eq(workroomFiles.status, "ready"),
        isNull(workroomFiles.archivedAt),
      ),
    )
    .orderBy(desc(workroomFiles.createdAt));

  return rows as WorkroomFileRow[];
}

/** Used by the Studio list to say how many people can currently open one. */
export async function revisionCounts(presentationIds: string[]): Promise<Map<string, number>> {
  if (presentationIds.length === 0) return new Map();

  const rows = await db()
    .select({
      presentationId: presentationRevisions.presentationId,
      count: sql<string>`count(*)`,
    })
    .from(presentationRevisions)
    .where(inArray(presentationRevisions.presentationId, presentationIds))
    .groupBy(presentationRevisions.presentationId);

  return new Map(rows.map((row) => [row.presentationId, Number(row.count)]));
}
