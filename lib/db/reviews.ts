import { and, count, eq, isNull, sql } from "drizzle-orm";

import { record as recordActivity } from "./activity.ts";
import { record as recordAudit, type AuditActor } from "./audit.ts";
import { db, type Tx } from "./index.ts";
import { uuidv7 } from "./id.ts";
import { ok, refuse, expectUnchanged, type Outcome } from "./outcome.ts";
import {
  presentationRevisionItems,
  presentationRevisions,
  presentationReviewNotes,
  presentationReviews,
  presentations,
  workroomMembers,
  workrooms,
  NOTE_GRACE_MINUTES,
  type NoteSide,
  type ReviewClosureReason,
  type ReviewStatus,
} from "./schema.ts";
import { type ViewerKind } from "../storage/policy.ts";
import { viewersByPosition } from "../workrooms/presentation-view.ts";
import {
  parseReviewAnchor,
  type AnchorKind,
  type AnchorRefusal,
  type ReviewAnchor,
} from "../workrooms/review-anchor.ts";
import {
  reviewCapabilities,
  NO_CAPABILITIES,
  type NoteFacts,
  type ReviewCapabilities,
} from "../workrooms/review-capabilities.ts";
import { reviewLifecycle, type ReviewLifecycle } from "../workrooms/review-lifecycle.ts";
import { toClientReview, type ClientReview } from "../workrooms/review-view.ts";

/**
 * Reviews: one round of client feedback on one published Revision.
 *
 * **Every write to `presentation_reviews` and `presentation_review_notes` goes
 * through this module.** No route, server action or component touches those
 * tables, because the rules that make a round coherent are relational — "no
 * edit once a reply exists", "the round must be open", "this Revision must
 * still be the current one" — and a per-row trigger cannot hold them without
 * paying a child count on every write. `0006` holds everything that can be
 * structural; the rest is here, under one lock.
 *
 * ## The lock order, and why there is only one lock
 *
 *     presentations  →  presentation_reviews  →  presentation_review_notes
 *
 * Never acquired upward. Every mutating function in this module opens by
 * locking **the Review row**, which is the round's single serialization point:
 * every mutation of a round passes through it, so a second lock on the root
 * note would protect nothing the first does not — and a second lock is a second
 * chance to order it wrongly, which is how deadlocks are actually born.
 *
 * Only `reopenReview` reaches up to `presentations`, and only because its
 * precondition is a column on that table: `current_revision_id`. Reading it
 * unlocked would let a concurrent publish move it between the read and the
 * write. It takes the same order `publishPresentation` already takes, so the
 * two serialize instead of racing.
 *
 * The backstops behind the convention are structural, so a mutation written
 * outside it fails loudly rather than corrupting a round quietly: the note's
 * optimistic `version`, `UNIQUE (presentation_review_id, number)`, and the
 * `0006` triggers.
 *
 * ## Ordinals, not ids
 *
 * The API names a note by its **ordinal within the round**, never by its
 * internal id. That is not a convenience: the client-safe projection will only
 * ever hand out ordinals, so taking ids here would create a surface that has to
 * be defended. The same goes for an anchor's subject, which arrives as the
 * item's `position` and is resolved against the exact Revision inside the
 * transaction.
 */

/* ------------------------------------------------------------------ actors */

/**
 * Who is acting, and which side they are on.
 *
 * `side` is passed rather than inferred, and stored rather than derived,
 * because every actor foreign key in this schema is `ON DELETE set null` — the
 * day somebody leaves, a key can no longer say who spoke and `author_side`
 * still can.
 */
export type ReviewActor =
  | { side: "studio"; userId: string; name: string }
  | { side: "client"; identityId: string; contactId: string; name: string };

export type StaffActor = Extract<ReviewActor, { side: "studio" }>;
export type ClientActor = Extract<ReviewActor, { side: "client" }>;

/** The same person, as `audit_events` records them. */
function auditActor(actor: ReviewActor): AuditActor {
  return actor.side === "studio"
    ? { id: actor.userId, name: actor.name, kind: "team_user" }
    : { id: actor.identityId, name: actor.name, kind: "client_user" };
}

/* ------------------------------------------------------------- transaction */

/**
 * A refusal raised from inside a transaction.
 *
 * Returning an `Outcome` from a transaction callback **commits** it, which is
 * wrong for anything that has already written — and most of what follows writes
 * an Audit row before it is finished. The same device `presentations.ts` uses,
 * for the same reason.
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

/* ------------------------------------------------------------------ anchors */

/**
 * The anchor vocabulary, re-exported for callers of this module. It is defined
 * — and judged — in exactly one place, `lib/workrooms/review-anchor.ts`.
 */
export type { ReviewAnchor };

/**
 * What a person reads when an anchor is refused.
 *
 * **Words only; no rule lives here.** Every judgement about whether a value is
 * a valid anchor is `parseReviewAnchor`'s, and the projection reading stored
 * anchors calls the same function — so the write path and the read path cannot
 * disagree, because there is nothing here to disagree with. This turns a
 * machine reason into the sentence that has always been shown for it.
 */
function refusalSentence(
  reason: AnchorRefusal,
  kind: AnchorKind | null,
  viewer: ViewerKind | null,
): string {
  if (reason === "unsupported_for_viewer") {
    if (viewer === null) return "There is nothing to point at in a written note.";
    if (viewer === "pdf" || viewer === "download" || !["image", "video", "audio"].includes(viewer)) {
      return "This kind of file takes feedback as a whole, not at a point in it.";
    }
    if (kind === "point") return "A point belongs on an image.";
    if (kind === "region") return "An area belongs on an image.";
    if (kind === "time_region") return "There is no picture to point at here.";
    return "A moment belongs in something that plays.";
  }

  switch (kind) {
    case "point":
      return "That point is not inside the image.";
    case "region":
      return "That area is not inside the image.";
    case "time_range":
      return reason === "invalid_range"
        ? "A stretch has to end after it starts."
        : "That is not a moment in this file.";
    case "time_region":
      return reason === "invalid_region" || reason === "unknown_key" || reason === "invalid_shape"
        ? "That area is not inside the picture."
        : "That is not a moment in this file.";
    case "time":
      return "That is not a moment in this file.";
    default:
      return "That is not a place in the work.";
  }
}

/**
 * An anchor judged for storage, as an `Outcome` the rest of this module speaks.
 *
 * A thin wrapper: `parseReviewAnchor` decides, this translates. Kept because
 * the domain answers in `Outcome` everywhere, and because a refusal needs the
 * sentence the person will read.
 */
export function parseAnchor(raw: unknown, viewer: ViewerKind | null): Outcome<ReviewAnchor | null> {
  const parsed = parseReviewAnchor(raw, viewer);
  if (parsed.ok) return ok(parsed.anchor);
  return refuse("invalid", refusalSentence(parsed.reason, parsed.kind, viewer));
}

type RoundRow = {
  id: string;
  workroomId: string;
  revisionId: string;
  status: ReviewStatus;
  closedReason: ReviewClosureReason | null;
  version: number;
  presentationId: string;
  presentationTitle: string;
  presentationStatus: string;
  presentationArchivedAt: Date | null;
  currentRevisionId: string | null;
  workroomStatus: string;
  workroomArchivedAt: Date | null;
};

/**
 * Take the round's write lock, then read its world.
 *
 * Two statements on purpose. The lock is a bare `SELECT … FOR UPDATE` on the
 * Review row alone — a locking join would take `presentations` with it and
 * acquire, out of order, a lock this function has no business holding. Under
 * READ COMMITTED the read that follows sees whatever the writer we just waited
 * for committed, which is the point of doing it in this order.
 */
async function lockRound(tx: Tx, reviewId: string): Promise<RoundRow | null> {
  const locked = await tx.execute(
    sql`SELECT id FROM presentation_reviews WHERE id = ${reviewId} FOR UPDATE`,
  );
  if ((locked as unknown as unknown[]).length === 0) return null;

  const [row] = await tx
    .select({
      id: presentationReviews.id,
      workroomId: presentationReviews.workroomId,
      revisionId: presentationReviews.presentationRevisionId,
      status: presentationReviews.status,
      closedReason: presentationReviews.closedReason,
      version: presentationReviews.version,
      presentationId: presentationRevisions.presentationId,
      presentationTitle: presentations.title,
      presentationStatus: presentations.status,
      presentationArchivedAt: presentations.archivedAt,
      currentRevisionId: presentations.currentRevisionId,
      workroomStatus: workrooms.status,
      workroomArchivedAt: workrooms.archivedAt,
    })
    .from(presentationReviews)
    .innerJoin(
      presentationRevisions,
      eq(presentationRevisions.id, presentationReviews.presentationRevisionId),
    )
    .innerJoin(presentations, eq(presentations.id, presentationRevisions.presentationId))
    .innerJoin(workrooms, eq(workrooms.id, presentationReviews.workroomId))
    .where(eq(presentationReviews.id, reviewId))
    .limit(1);

  return (row as RoundRow | undefined) ?? null;
}

/**
 * How each block of one Revision was shown when it was published, by position.
 *
 * Read from the Revision's frozen snapshot, which is immutable, rather than
 * recomputed from the file row with today's rules — so an anchor is always
 * judged against the Revision it belongs to. Used on the way in by
 * `createReviewNote` and on the way out by `reviewNotes`, so both judge an
 * anchor against the same fact.
 */
async function revisionViewers(
  runner: Pick<Tx, "select">,
  revisionId: string,
): Promise<Map<number, ViewerKind | null>> {
  const [row] = await runner
    .select({ snapshot: presentationRevisions.snapshot })
    .from(presentationRevisions)
    .where(eq(presentationRevisions.id, revisionId))
    .limit(1);

  return row ? viewersByPosition(row.snapshot) : new Map();
}

/** The round, or a refusal that says nothing about whether it exists. */
async function openRound(tx: Tx, reviewId: string): Promise<RoundRow> {
  const round = await lockRound(tx, reviewId);
  if (!round) refused("not_found", "That feedback round no longer exists.");
  if (round.status !== "open") {
    refused("blocked", "That feedback round is closed.");
  }
  return round;
}

/**
 * Whether this client may act in this round at all.
 *
 * The same four conditions `workroomForViewer` carries — active membership, the
 * Workroom published and unarchived — plus the Presentation being published and
 * unarchived, because a round hangs off a Revision of one. Read on every call
 * rather than trusted from a session, so revocation lands on the next click.
 */
async function clientMayAct(tx: Tx, round: RoundRow, contactId: string): Promise<boolean> {
  if (round.workroomStatus !== "published" || round.workroomArchivedAt) return false;
  if (round.presentationStatus !== "published" || round.presentationArchivedAt) return false;

  const [member] = await tx
    .select({ id: workroomMembers.id })
    .from(workroomMembers)
    .where(
      and(
        eq(workroomMembers.workroomId, round.workroomId),
        eq(workroomMembers.contactId, contactId),
        eq(workroomMembers.status, "active"),
      ),
    )
    .limit(1);

  return Boolean(member);
}

/** Refuses a client who may not act, and says nothing that distinguishes why. */
async function requireActor(tx: Tx, round: RoundRow, actor: ReviewActor): Promise<void> {
  if (actor.side === "studio") return;
  if (!(await clientMayAct(tx, round, actor.contactId))) {
    refused("not_found", "That feedback round no longer exists.");
  }
}

/* ------------------------------------------------------- round lifecycle */

/**
 * Ask the client for their thoughts on a published Revision.
 *
 * **One round per Revision, ever.** If a row already exists, this does not
 * create a second one — `UNIQUE (presentation_revision_id)` would refuse it
 * anyway, and the row is that Revision's lifecycle record whatever state it is
 * in. A withdrawn row is re-requested in place; anything else is refused with
 * what it actually is.
 *
 * Only the Presentation's **current** Revision may be asked about. Asking for
 * feedback on a version the client has already been moved past is incoherent,
 * and it is the one case where the Studio surface and the domain would
 * otherwise disagree.
 */
export async function requestReview(
  actor: StaffActor,
  revisionId: string,
): Promise<Outcome<string>> {
  return settle(
    db().transaction(async (tx): Promise<Outcome<string>> => {
      const [revision] = await tx
        .select({
          id: presentationRevisions.id,
          workroomId: presentationRevisions.workroomId,
          presentationId: presentationRevisions.presentationId,
          title: presentations.title,
          status: presentations.status,
          archivedAt: presentations.archivedAt,
          currentRevisionId: presentations.currentRevisionId,
        })
        .from(presentationRevisions)
        .innerJoin(presentations, eq(presentations.id, presentationRevisions.presentationId))
        .where(eq(presentationRevisions.id, revisionId))
        .limit(1);

      if (!revision) refused("not_found", "That version no longer exists.");
      if (revision.archivedAt) refused("blocked", "Restore this presentation first.");
      if (revision.status !== "published") {
        refused("blocked", "Publish this presentation before asking for feedback on it.");
      }
      if (revision.currentRevisionId !== revisionId) {
        refused("blocked", "Ask for feedback on the version the client is reading.");
      }

      const [existing] = await tx
        .select({ id: presentationReviews.id })
        .from(presentationReviews)
        .where(eq(presentationReviews.presentationRevisionId, revisionId))
        .limit(1);

      if (existing) {
        // The row is the lifecycle record, so a re-request reuses it rather
        // than making a second round nobody could tell apart from the first.
        const round = await openReuse(tx, actor, existing.id, revision.title);
        return ok(round);
      }

      const id = uuidv7();
      await tx.insert(presentationReviews).values({
        id,
        workroomId: revision.workroomId,
        presentationRevisionId: revisionId,
        status: "open",
        requestedBy: actor.userId,
      });

      await recordAudit(tx, auditActor(actor), {
        action: "review.requested",
        entityType: "presentation_review",
        entityId: id,
        entityLabel: revision.title,
        metadata: { workroom_id: revision.workroomId, presentation_id: revision.presentationId },
      });

      // Written once, when the round is first opened. A later withdraw and
      // re-request is the studio's administration, not the client's news —
      // and *your thoughts were requested* stays true either way.
      await recordActivity(tx, revision.workroomId, {
        kind: "review.requested",
        subject: revision.title,
      });

      return ok(id);
    }),
  );
}

/** Re-request on a row that already exists. Only a withdrawal may be revived. */
async function openReuse(
  tx: Tx,
  actor: StaffActor,
  reviewId: string,
  title: string,
): Promise<string> {
  const round = await lockRound(tx, reviewId);
  if (!round) refused("not_found", "That feedback round no longer exists.");

  if (round.status === "open") {
    refused("already_done", "Feedback is already open on this version.");
  }
  if (round.status === "closed") {
    refused(
      "blocked",
      round.closedReason === "superseded"
        ? "That round closed when a newer version was published."
        : "Feedback on this version was closed. Reopen it rather than asking again.",
    );
  }

  const changed = await tx
    .update(presentationReviews)
    .set({
      status: "open",
      withdrawnAt: null,
      requestedAt: new Date(),
      requestedBy: actor.userId,
    })
    .where(
      and(eq(presentationReviews.id, reviewId), eq(presentationReviews.version, round.version)),
    )
    .returning({ id: presentationReviews.id });

  if (changed.length === 0) throw new Refused(expectUnchanged(0) as Outcome<never>);

  await recordAudit(tx, auditActor(actor), {
    action: "review.requested",
    entityType: "presentation_review",
    entityId: reviewId,
    entityLabel: title,
    metadata: { workroom_id: round.workroomId, after: "withdrawn" },
  });

  return reviewId;
}

/**
 * The studio has read enough. Reversible while this Revision is current.
 *
 * `expectedVersion` is **optional throughout this module**, and omitting it is
 * not a weakening. The round's row lock is held from the read to the commit, so
 * the version read under it is the version the update will find; passing it is
 * only useful to a caller that loaded the row earlier and wants to be told it
 * has moved. The server actions do not, which is why no `version` column
 * reaches a browser — see `docs/delivery.md`.
 */
export async function closeReview(
  actor: StaffActor,
  reviewId: string,
  expectedVersion?: number,
): Promise<Outcome<void>> {
  return settle(
    db().transaction(async (tx): Promise<Outcome<void>> => {
      const round = await openRound(tx, reviewId);

      const changed = await tx
        .update(presentationReviews)
        .set({
          status: "closed",
          closedAt: new Date(),
          closedReason: "staff",
          closedByUserId: actor.userId,
          closedByRevisionId: null,
          withdrawnAt: null,
        })
        .where(
          and(
            eq(presentationReviews.id, reviewId),
            eq(presentationReviews.version, expectedVersion ?? round.version),
          ),
        )
        .returning({ id: presentationReviews.id });

      const outcome = expectUnchanged(changed.length);
      if (!outcome.ok) return outcome;

      await recordAudit(tx, auditActor(actor), {
        action: "review.closed",
        entityType: "presentation_review",
        entityId: reviewId,
        entityLabel: round.presentationTitle,
        metadata: { workroom_id: round.workroomId, reason: "staff" },
      });

      return ok(undefined);
    }),
  );
}

/**
 * Take the request back. Only while nothing has been said.
 *
 * A removed note still counts: the row exists, the ordinal is spent, and the
 * client wrote something even if they took it back. Withdrawing then would
 * present an untouched round to somebody who had already used it.
 */
export async function withdrawReview(
  actor: StaffActor,
  reviewId: string,
  expectedVersion?: number,
): Promise<Outcome<void>> {
  return settle(
    db().transaction(async (tx): Promise<Outcome<void>> => {
      const round = await openRound(tx, reviewId);

      const [{ notes }] = await tx
        .select({ notes: count() })
        .from(presentationReviewNotes)
        .where(eq(presentationReviewNotes.presentationReviewId, reviewId));

      if (notes > 0) {
        refused("blocked", "This round already has feedback in it. Close it instead.");
      }

      const changed = await tx
        .update(presentationReviews)
        .set({
          status: "withdrawn",
          withdrawnAt: new Date(),
          closedAt: null,
          closedReason: null,
          closedByUserId: null,
          closedByRevisionId: null,
        })
        .where(
          and(
            eq(presentationReviews.id, reviewId),
            eq(presentationReviews.version, expectedVersion ?? round.version),
          ),
        )
        .returning({ id: presentationReviews.id });

      const outcome = expectUnchanged(changed.length);
      if (!outcome.ok) return outcome;

      await recordAudit(tx, auditActor(actor), {
        action: "review.withdrawn",
        entityType: "presentation_review",
        entityId: reviewId,
        entityLabel: round.presentationTitle,
        metadata: { workroom_id: round.workroomId },
      });

      return ok(undefined);
    }),
  );
}

/**
 * Open it again — the same row, never a second one.
 *
 * **The only function here that reaches up to `presentations`**, and it locks
 * that row first. Its precondition is `current_revision_id`, so reading it
 * unlocked would let a concurrent publish move it between the read and the
 * write and leave a superseded round open.
 *
 * A supersession never reopens. The trigger in `0006` refuses it too; this
 * refuses it first, with a sentence somebody can act on rather than a database
 * exception.
 */
export async function reopenReview(
  actor: StaffActor,
  reviewId: string,
  expectedVersion?: number,
): Promise<Outcome<void>> {
  return settle(
    db().transaction(async (tx): Promise<Outcome<void>> => {
      // presentations → presentation_reviews, in that order, always.
      const [presentation] = await tx
        .select({ presentationId: presentationRevisions.presentationId })
        .from(presentationReviews)
        .innerJoin(
          presentationRevisions,
          eq(presentationRevisions.id, presentationReviews.presentationRevisionId),
        )
        .where(eq(presentationReviews.id, reviewId))
        .limit(1);

      if (!presentation) refused("not_found", "That feedback round no longer exists.");

      await tx.execute(
        sql`SELECT id FROM presentations WHERE id = ${presentation.presentationId} FOR UPDATE`,
      );

      const round = await lockRound(tx, reviewId);
      if (!round) refused("not_found", "That feedback round no longer exists.");

      if (round.status === "open") refused("already_done", "Feedback is already open.");
      if (round.status === "closed" && round.closedReason === "superseded") {
        refused("blocked", "That round closed when a newer version was published.");
      }
      if (round.presentationStatus !== "published" || round.presentationArchivedAt) {
        refused("blocked", "Publish this presentation before reopening feedback on it.");
      }
      if (round.currentRevisionId !== round.revisionId) {
        refused("blocked", "A newer version has been published since this round closed.");
      }

      const wasWithdrawn = round.status === "withdrawn";

      const changed = await tx
        .update(presentationReviews)
        .set({
          status: "open",
          closedAt: null,
          closedReason: null,
          closedByUserId: null,
          closedByRevisionId: null,
          withdrawnAt: null,
          ...(wasWithdrawn ? { requestedAt: new Date(), requestedBy: actor.userId } : {}),
        })
        .where(
          and(
            eq(presentationReviews.id, reviewId),
            eq(presentationReviews.version, expectedVersion ?? round.version),
          ),
        )
        .returning({ id: presentationReviews.id });

      const outcome = expectUnchanged(changed.length);
      if (!outcome.ok) return outcome;

      await recordAudit(tx, auditActor(actor), {
        action: wasWithdrawn ? "review.requested" : "review.reopened",
        entityType: "presentation_review",
        entityId: reviewId,
        entityLabel: round.presentationTitle,
        metadata: { workroom_id: round.workroomId, ...(wasWithdrawn ? { after: "withdrawn" } : {}) },
      });

      return ok(undefined);
    }),
  );
}

/**
 * Publishing a newer Revision ends the round on the old one. **Terminally.**
 *
 * Called from inside `publishPresentation`'s transaction, which already holds
 * the `presentations` lock — so this takes the Review lock second, in order.
 *
 * It closes the container and touches nothing inside it. Unresolved notes stay
 * unresolved, visibly and permanently: auto-resolving them would be the studio
 * marking the client's points handled without saying so. A round already closed
 * by staff keeps that reason, and a withdrawn one stays withdrawn — publishing
 * is the studio's answer to feedback, not a rewrite of what was said.
 */
export async function supersedeReviewOnPublish(
  tx: Tx,
  actor: AuditActor,
  outgoingRevisionId: string | null,
  incomingRevisionId: string,
  label: string,
  revisionNumber: number,
): Promise<void> {
  if (!outgoingRevisionId) return;

  const [existing] = await tx
    .select({ id: presentationReviews.id })
    .from(presentationReviews)
    .where(eq(presentationReviews.presentationRevisionId, outgoingRevisionId))
    .limit(1);

  if (!existing) return;

  await tx.execute(sql`SELECT id FROM presentation_reviews WHERE id = ${existing.id} FOR UPDATE`);

  const [round] = await tx
    .select({
      id: presentationReviews.id,
      workroomId: presentationReviews.workroomId,
      status: presentationReviews.status,
    })
    .from(presentationReviews)
    .where(eq(presentationReviews.id, existing.id))
    .limit(1);

  if (!round || round.status !== "open") return;

  await tx
    .update(presentationReviews)
    .set({
      status: "closed",
      closedAt: new Date(),
      closedReason: "superseded",
      closedByUserId: null,
      closedByRevisionId: incomingRevisionId,
      withdrawnAt: null,
    })
    .where(eq(presentationReviews.id, round.id));

  await recordAudit(tx, actor, {
    action: "review.closed",
    entityType: "presentation_review",
    entityId: round.id,
    entityLabel: label,
    metadata: { workroom_id: round.workroomId, reason: "superseded", revision: revisionNumber },
  });
}

/* ------------------------------------------------------------------ notes */

type NoteRow = {
  id: string;
  number: number;
  isRoot: boolean;
  parentNoteId: string | null;
  authorSide: NoteSide;
  authorUserId: string | null;
  authorIdentityId: string | null;
  createdAt: Date;
  removedAt: Date | null;
  resolvedAt: Date | null;
  version: number;
};

const BODY_MAX = 8000;

/** The next ordinal in this round. Allocated only while its row is locked. */
async function nextOrdinal(tx: Tx, reviewId: string): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number | null>`max(${presentationReviewNotes.number})` })
    .from(presentationReviewNotes)
    .where(eq(presentationReviewNotes.presentationReviewId, reviewId));

  return (row?.max ?? 0) + 1;
}

async function noteByNumber(tx: Tx, reviewId: string, number: number): Promise<NoteRow | null> {
  const [row] = await tx
    .select({
      id: presentationReviewNotes.id,
      number: presentationReviewNotes.number,
      isRoot: presentationReviewNotes.isRoot,
      parentNoteId: presentationReviewNotes.parentNoteId,
      authorSide: presentationReviewNotes.authorSide,
      authorUserId: presentationReviewNotes.authorUserId,
      authorIdentityId: presentationReviewNotes.authorIdentityId,
      createdAt: presentationReviewNotes.createdAt,
      removedAt: presentationReviewNotes.removedAt,
      resolvedAt: presentationReviewNotes.resolvedAt,
      version: presentationReviewNotes.version,
    })
    .from(presentationReviewNotes)
    .where(
      and(
        eq(presentationReviewNotes.presentationReviewId, reviewId),
        eq(presentationReviewNotes.number, number),
      ),
    )
    .limit(1);

  return (row as NoteRow | undefined) ?? null;
}

/** Whether this actor wrote it. Compared on the key, which is what identity is. */
function wroteIt(note: NoteRow, actor: ReviewActor): boolean {
  return actor.side === "studio"
    ? note.authorSide === "studio" && note.authorUserId === actor.userId
    : note.authorSide === "client" && note.authorIdentityId === actor.identityId;
}

function withinGrace(note: NoteRow, now: Date): boolean {
  return now.getTime() - note.createdAt.getTime() <= NOTE_GRACE_MINUTES * 60_000;
}

function checkBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) refused("invalid", "There is nothing written here.");
  if (trimmed.length > BODY_MAX) {
    refused("invalid", `Keep it under ${BODY_MAX} characters.`);
  }
  return trimmed;
}

/**
 * One feedback item, from the client.
 *
 * **Staff cannot open one**, which is a CHECK in `0006` and a refusal here: the
 * round is the client's voice, and a studio able to raise items on its own work
 * has built a shared to-do list rather than a review.
 *
 * The subject arrives as an item **position**, never an id, and is resolved
 * against the exact Revision under review — so a position from another Revision
 * simply does not exist here. The composite foreign key is the last line if
 * this were ever wrong.
 */
export async function createReviewNote(
  actor: ClientActor,
  input: {
    reviewId: string;
    body: string;
    /** The item this is about, by its position in the Revision. */
    itemPosition?: number | null;
    /** Where inside that item, or null for the item as a whole. */
    anchor?: unknown;
  },
): Promise<Outcome<number>> {
  return settle(
    db().transaction(async (tx): Promise<Outcome<number>> => {
      const round = await openRound(tx, input.reviewId);

      // The type says client and so does the CHECK, but neither stops a caller
      // handing this a studio actor in the client's shape — the row would then
      // store `author_side = 'client'` with nobody behind it. The round is the
      // client's voice, and that is worth a refusal rather than a cast.
      if (actor.side !== "client") {
        refused("blocked", "The studio replies to feedback rather than opening it.");
      }
      await requireActor(tx, round, actor);

      const body = checkBody(input.body);

      let itemId: string | null = null;
      let anchor: ReviewAnchor | null = null;

      if (input.itemPosition !== null && input.itemPosition !== undefined) {
        const [item] = await tx
          .select({ id: presentationRevisionItems.id })
          .from(presentationRevisionItems)
          .where(
            and(
              eq(presentationRevisionItems.presentationRevisionId, round.revisionId),
              eq(presentationRevisionItems.position, input.itemPosition),
            ),
          )
          .limit(1);

        if (!item) refused("not_found", "That part of the work is not in this version.");
        itemId = item.id;

        // Judged against how **this Revision** showed the block — the viewer
        // it froze at publication — which is exactly what the projection will
        // judge it against when it is read back, for as long as it exists.
        const viewer = (await revisionViewers(tx, round.revisionId)).get(input.itemPosition) ?? null;
        const parsed = parseAnchor(input.anchor ?? null, viewer);
        if (!parsed.ok) return parsed;
        anchor = parsed.value;
      } else if (input.anchor !== null && input.anchor !== undefined) {
        // Precision needs a subject. There is no point at 42% of a Revision.
        refused("invalid", "Say which part of the work this is about.");
      }

      const number = await nextOrdinal(tx, input.reviewId);

      await tx.insert(presentationReviewNotes).values({
        id: uuidv7(),
        workroomId: round.workroomId,
        presentationReviewId: round.id,
        presentationRevisionId: round.revisionId,
        number,
        parentNoteId: null,
        isRoot: true,
        parentIsRoot: null,
        revisionItemId: itemId,
        anchor,
        body,
        authorSide: "client",
        authorIdentityId: actor.identityId,
        authorName: actor.name,
      });

      await recordAudit(tx, auditActor(actor), {
        action: "review.responded",
        entityType: "presentation_review",
        entityId: round.id,
        entityLabel: round.presentationTitle,
        metadata: { workroom_id: round.workroomId, note: number },
      });

      // Once per round, on the first thing the client says. A row per note
      // would flood a timeline built to be calm.
      if (number === 1) {
        await recordActivity(tx, round.workroomId, {
          kind: "review.received",
          actorLabel: actor.name,
          subject: round.presentationTitle,
        });
      }

      return ok(number);
    }),
  );
}

/** An answer to one feedback item. Either side may write one; depth stays one. */
export async function replyToReviewNote(
  actor: ReviewActor,
  input: { reviewId: string; parentNumber: number; body: string },
): Promise<Outcome<number>> {
  return settle(
    db().transaction(async (tx): Promise<Outcome<number>> => {
      const round = await openRound(tx, input.reviewId);
      await requireActor(tx, round, actor);

      const body = checkBody(input.body);

      const parent = await noteByNumber(tx, round.id, input.parentNumber);
      if (!parent) refused("not_found", "That comment is no longer there.");
      // Structurally impossible to store, and refused here so the person is
      // told what happened rather than shown a foreign-key violation.
      if (!parent.isRoot) refused("blocked", "Replies go under the original comment.");
      if (parent.removedAt) refused("blocked", "That comment was removed.");

      const number = await nextOrdinal(tx, round.id);

      await tx.insert(presentationReviewNotes).values({
        id: uuidv7(),
        workroomId: round.workroomId,
        presentationReviewId: round.id,
        presentationRevisionId: round.revisionId,
        number,
        parentNoteId: parent.id,
        isRoot: false,
        parentIsRoot: true,
        revisionItemId: null,
        anchor: null,
        body,
        authorSide: actor.side,
        authorUserId: actor.side === "studio" ? actor.userId : null,
        authorIdentityId: actor.side === "client" ? actor.identityId : null,
        authorName: actor.name,
      });

      await recordAudit(tx, auditActor(actor), {
        action: "review.replied",
        entityType: "presentation_review",
        entityId: round.id,
        entityLabel: round.presentationTitle,
        metadata: { workroom_id: round.workroomId, note: number, to: parent.number },
      });

      return ok(number);
    }),
  );
}

/**
 * The five conditions that govern both correcting and removing what you wrote.
 *
 * One predicate used twice, so the two can never drift apart — and the
 * relational half of it, *nothing has replied yet*, is the reason this lives
 * here rather than in a trigger.
 */
async function claimOwnNote(
  tx: Tx,
  round: RoundRow,
  actor: ReviewActor,
  number: number,
  now: Date,
): Promise<NoteRow> {
  const note = await noteByNumber(tx, round.id, number);
  if (!note) refused("not_found", "That comment is no longer there.");
  if (!wroteIt(note, actor)) refused("blocked", "Only the person who wrote it can change it.");
  if (note.removedAt) refused("blocked", "That comment was already removed.");
  if (!withinGrace(note, now)) {
    refused("blocked", `A comment can only be changed within ${NOTE_GRACE_MINUTES} minutes.`);
  }

  if (note.isRoot) {
    const [{ replies }] = await tx
      .select({ replies: count() })
      .from(presentationReviewNotes)
      .where(eq(presentationReviewNotes.parentNoteId, note.id));

    if (replies > 0) refused("blocked", "Somebody has replied to this already.");
  }

  return note;
}

/** Fix what you just wrote. The words only — never the subject or the author. */
export async function editReviewNote(
  actor: ReviewActor,
  input: { reviewId: string; number: number; body: string; expectedVersion?: number },
  now: Date = new Date(),
): Promise<Outcome<void>> {
  return settle(
    db().transaction(async (tx): Promise<Outcome<void>> => {
      const round = await openRound(tx, input.reviewId);
      await requireActor(tx, round, actor);

      const note = await claimOwnNote(tx, round, actor, input.number, now);
      const body = checkBody(input.body);

      const changed = await tx
        .update(presentationReviewNotes)
        .set({ body, editedAt: now })
        .where(
          and(
            eq(presentationReviewNotes.id, note.id),
            eq(presentationReviewNotes.version, input.expectedVersion ?? note.version),
          ),
        )
        .returning({ id: presentationReviewNotes.id });

      const outcome = expectUnchanged(changed.length);
      if (!outcome.ok) return outcome;

      await recordAudit(tx, auditActor(actor), {
        action: "review.edited",
        entityType: "presentation_review",
        entityId: round.id,
        entityLabel: round.presentationTitle,
        metadata: { workroom_id: round.workroomId, note: note.number },
      });

      return ok(undefined);
    }),
  );
}

/**
 * Take back what you wrote, without erasing that you wrote it.
 *
 * **Additive.** One timestamp is written beside the body rather than over it,
 * so the record is not falsified and the immutability trigger needs no
 * exception. What hides the words is the projection, and it hides them from
 * both surfaces — a removal the studio can still read is not a removal.
 */
export async function removeReviewNote(
  actor: ReviewActor,
  input: { reviewId: string; number: number; expectedVersion?: number },
  now: Date = new Date(),
): Promise<Outcome<void>> {
  return settle(
    db().transaction(async (tx): Promise<Outcome<void>> => {
      const round = await openRound(tx, input.reviewId);
      await requireActor(tx, round, actor);

      const note = await claimOwnNote(tx, round, actor, input.number, now);

      const changed = await tx
        .update(presentationReviewNotes)
        .set({ removedAt: now })
        .where(
          and(
            eq(presentationReviewNotes.id, note.id),
            eq(presentationReviewNotes.version, input.expectedVersion ?? note.version),
          ),
        )
        .returning({ id: presentationReviewNotes.id });

      const outcome = expectUnchanged(changed.length);
      if (!outcome.ok) return outcome;

      await recordAudit(tx, auditActor(actor), {
        action: "review.removed",
        entityType: "presentation_review",
        entityId: round.id,
        entityLabel: round.presentationTitle,
        // The ordinal, and nothing else. A tombstone is exactly where somebody
        // would be tempted to keep a copy of what it replaced.
        metadata: { workroom_id: round.workroomId, note: note.number },
      });

      return ok(undefined);
    }),
  );
}

/* ------------------------------------------------------------- resolution */

/**
 * Who may say a point has been dealt with.
 *
 * Every root is client-authored, so these are not one rule narrowed — they
 * answer different questions. The studio saying *resolved* is a claim; the
 * client reopening it is the answer to that claim; and one client member
 * cannot speak for another's.
 */
function mayDecide(note: NoteRow, actor: ReviewActor): boolean {
  return actor.side === "studio" || wroteIt(note, actor);
}

async function claimRoot(
  tx: Tx,
  round: RoundRow,
  actor: ReviewActor,
  number: number,
): Promise<NoteRow> {
  const note = await noteByNumber(tx, round.id, number);
  if (!note) refused("not_found", "That comment is no longer there.");
  if (!note.isRoot) refused("blocked", "A reply is not resolved on its own.");
  if (note.removedAt) refused("blocked", "That comment was removed.");
  if (!mayDecide(note, actor)) refused("blocked", "That is somebody else's comment.");
  return note;
}

/** Mark one feedback item dealt with. It hides nothing and deletes nothing. */
export async function resolveReviewNote(
  actor: ReviewActor,
  input: { reviewId: string; number: number; expectedVersion?: number },
  now: Date = new Date(),
): Promise<Outcome<void>> {
  return settle(
    db().transaction(async (tx): Promise<Outcome<void>> => {
      const round = await openRound(tx, input.reviewId);
      await requireActor(tx, round, actor);

      const note = await claimRoot(tx, round, actor, input.number);
      if (note.resolvedAt) refused("already_done", "That is already marked as dealt with.");

      const changed = await tx
        .update(presentationReviewNotes)
        .set({
          resolvedAt: now,
          resolvedBySide: actor.side,
          resolvedByName: actor.name,
          resolvedByUserId: actor.side === "studio" ? actor.userId : null,
          resolvedByIdentityId: actor.side === "client" ? actor.identityId : null,
        })
        .where(
          and(
            eq(presentationReviewNotes.id, note.id),
            eq(presentationReviewNotes.version, input.expectedVersion ?? note.version),
          ),
        )
        .returning({ id: presentationReviewNotes.id });

      const outcome = expectUnchanged(changed.length);
      if (!outcome.ok) return outcome;

      await recordAudit(tx, auditActor(actor), {
        action: "review.resolved",
        entityType: "presentation_review",
        entityId: round.id,
        entityLabel: round.presentationTitle,
        metadata: { workroom_id: round.workroomId, note: note.number },
      });

      return ok(undefined);
    }),
  );
}

/**
 * Say it is not dealt with after all.
 *
 * A client may reopen their own point **including one the studio resolved**,
 * which is what keeps *resolved* honest: it is the studio's belief, not a
 * verdict on somebody else's behalf.
 */
export async function reopenReviewNote(
  actor: ReviewActor,
  input: { reviewId: string; number: number; expectedVersion?: number },
): Promise<Outcome<void>> {
  return settle(
    db().transaction(async (tx): Promise<Outcome<void>> => {
      const round = await openRound(tx, input.reviewId);
      await requireActor(tx, round, actor);

      const note = await claimRoot(tx, round, actor, input.number);
      if (!note.resolvedAt) refused("already_done", "That is already open.");

      const changed = await tx
        .update(presentationReviewNotes)
        .set({
          resolvedAt: null,
          resolvedBySide: null,
          resolvedByName: null,
          resolvedByUserId: null,
          resolvedByIdentityId: null,
        })
        .where(
          and(
            eq(presentationReviewNotes.id, note.id),
            eq(presentationReviewNotes.version, input.expectedVersion ?? note.version),
          ),
        )
        .returning({ id: presentationReviewNotes.id });

      const outcome = expectUnchanged(changed.length);
      if (!outcome.ok) return outcome;

      await recordAudit(tx, auditActor(actor), {
        action: "review.unresolved",
        entityType: "presentation_review",
        entityId: round.id,
        entityLabel: round.presentationTitle,
        metadata: { workroom_id: round.workroomId, note: note.number },
      });

      return ok(undefined);
    }),
  );
}

/* ------------------------------------------------------------------ reads */

export type ReviewRoundRow = {
  id: string;
  revisionId: string;
  status: ReviewStatus;
  closedReason: ReviewClosureReason | null;
  closedByRevisionId: string | null;
  requestedAt: Date;
  version: number;
};

/** The round on one Revision, or null. No projection: that is Implementation C. */
export async function reviewForRevision(revisionId: string): Promise<ReviewRoundRow | null> {
  const [row] = await db()
    .select({
      id: presentationReviews.id,
      revisionId: presentationReviews.presentationRevisionId,
      status: presentationReviews.status,
      closedReason: presentationReviews.closedReason,
      closedByRevisionId: presentationReviews.closedByRevisionId,
      requestedAt: presentationReviews.requestedAt,
      version: presentationReviews.version,
    })
    .from(presentationReviews)
    .where(eq(presentationReviews.presentationRevisionId, revisionId))
    .limit(1);

  return (row as ReviewRoundRow | undefined) ?? null;
}

export type ReviewNoteRow = {
  number: number;
  isRoot: boolean;
  parentNumber: number | null;
  body: string;
  authorSide: NoteSide;
  authorName: string;
  itemPosition: number | null;
  /**
   * How the block this note is about was shown in **its own** Revision — the
   * viewer that Revision froze at publication. `null` for a written note, for
   * general feedback, and for a position the snapshot does not have; every one
   * of those holds no precise anchor, which is what `null` tells the parser.
   * Internal: the projection judges the anchor with it and emits nothing of it.
   */
  itemViewer: ViewerKind | null;
  /** The stored jsonb, unjudged. Only `parseReviewAnchor` decides what it is. */
  anchor: unknown;
  resolvedAt: Date | null;
  resolvedBySide: NoteSide | null;
  resolvedByName: string | null;
  editedAt: Date | null;
  removedAt: Date | null;
  createdAt: Date;
  version: number;
};

/**
 * Every note in a round, in the order they were written.
 *
 * **Raw rows, including the body of a removed note.** This is the domain's own
 * reader, for tests and for whatever Implementation C builds on top; the
 * client-safe projection is what drops a removed body, and it does not exist
 * yet. Nothing may hand these rows to a surface.
 */
export async function reviewNotes(reviewId: string): Promise<ReviewNoteRow[]> {
  const parents = db()
    .select({
      id: presentationReviewNotes.id,
      number: presentationReviewNotes.number,
    })
    .from(presentationReviewNotes)
    .where(eq(presentationReviewNotes.presentationReviewId, reviewId))
    .as("parents");

  const rows = await db()
    .select({
      number: presentationReviewNotes.number,
      isRoot: presentationReviewNotes.isRoot,
      parentNumber: parents.number,
      body: presentationReviewNotes.body,
      authorSide: presentationReviewNotes.authorSide,
      authorName: presentationReviewNotes.authorName,
      itemPosition: presentationRevisionItems.position,
      anchor: presentationReviewNotes.anchor,
      resolvedAt: presentationReviewNotes.resolvedAt,
      resolvedBySide: presentationReviewNotes.resolvedBySide,
      resolvedByName: presentationReviewNotes.resolvedByName,
      editedAt: presentationReviewNotes.editedAt,
      removedAt: presentationReviewNotes.removedAt,
      createdAt: presentationReviewNotes.createdAt,
      version: presentationReviewNotes.version,
    })
    .from(presentationReviewNotes)
    .leftJoin(parents, eq(parents.id, presentationReviewNotes.parentNoteId))
    .leftJoin(
      presentationRevisionItems,
      eq(presentationRevisionItems.id, presentationReviewNotes.revisionItemId),
    )
    .where(eq(presentationReviewNotes.presentationReviewId, reviewId))
    .orderBy(presentationReviewNotes.number);

  // Every note in a round belongs to the round's one Revision, so its frozen
  // viewers are read once — from that Revision, never from the current one.
  const [round] = await db()
    .select({ revisionId: presentationReviews.presentationRevisionId })
    .from(presentationReviews)
    .where(eq(presentationReviews.id, reviewId))
    .limit(1);
  const viewers = round ? await revisionViewers(db(), round.revisionId) : new Map();

  return rows.map((row) => ({
    ...row,
    itemViewer: row.itemPosition === null ? null : (viewers.get(row.itemPosition) ?? null),
  })) as ReviewNoteRow[];
}

/* ----------------------------------------------------- the authorized read */

/**
 * The round on one Revision, ready for a surface — or null.
 *
 * Null covers three different things on purpose: no round was ever asked for,
 * the round was withdrawn, and the caller may not see this Revision at all. A
 * surface that could tell those apart would be telling somebody outside the
 * company about the studio's administration, or about a Workroom that is not
 * theirs. Concealment over explanation, as everywhere else here.
 */
async function projected(
  reviewId: string,
  facts: { canWrite: boolean; supersededByVersion: number | null },
): Promise<ClientReview | null> {
  const [round] = await db()
    .select({
      status: presentationReviews.status,
      closedReason: presentationReviews.closedReason,
      requestedAt: presentationReviews.requestedAt,
    })
    .from(presentationReviews)
    .where(eq(presentationReviews.id, reviewId))
    .limit(1);

  if (!round) return null;

  return toClientReview(
    {
      status: round.status,
      closedReason: round.closedReason,
      requestedAt: round.requestedAt,
      supersededByVersion: facts.supersededByVersion,
      // A closed round accepts nothing from anybody, whichever world is asking.
      canWrite: facts.canWrite && round.status === "open",
    },
    await reviewNotes(reviewId),
  );
}

/** Which Revision number ended this round, when one did. Never its id. */
async function supersededBy(closedByRevisionId: string | null): Promise<number | null> {
  if (!closedByRevisionId) return null;

  const [row] = await db()
    .select({ number: presentationRevisions.revisionNumber })
    .from(presentationRevisions)
    .where(eq(presentationRevisions.id, closedByRevisionId))
    .limit(1);

  return row?.number ?? null;
}

/**
 * One round, for one client, on one Revision of one Presentation.
 *
 * **Membership is part of the query, not a check after it**, the
 * `workroomForViewer` discipline: a non-member's request never reads the round
 * at all. Everything a client may open is joined in one go — the Workroom
 * published and unarchived, the membership active, the Presentation published
 * and unarchived, and the Revision belonging to that Presentation — so a wrong
 * Workroom, a wrong Presentation and a wrong Revision all produce the same
 * null.
 *
 * `revisionNumber` omitted means the current Revision. Historical Revisions are
 * readable and never writable, which falls out of the round being closed rather
 * than from a rule about history.
 */
export async function reviewForViewer(
  contactId: string,
  workroomPublicId: string,
  presentationPublicId: string,
  revisionNumber?: number,
): Promise<ClientReview | null> {
  const wanted =
    revisionNumber === undefined
      ? eq(presentationRevisions.id, presentations.currentRevisionId)
      : and(
          eq(presentationRevisions.presentationId, presentations.id),
          eq(presentationRevisions.revisionNumber, revisionNumber),
        );

  const [row] = await db()
    .select({
      reviewId: presentationReviews.id,
      closedByRevisionId: presentationReviews.closedByRevisionId,
    })
    .from(presentationReviews)
    .innerJoin(
      presentationRevisions,
      eq(presentationRevisions.id, presentationReviews.presentationRevisionId),
    )
    .innerJoin(presentations, eq(presentations.id, presentationRevisions.presentationId))
    .innerJoin(workrooms, eq(workrooms.id, presentations.workroomId))
    .innerJoin(workroomMembers, eq(workroomMembers.workroomId, workrooms.id))
    .where(
      and(
        wanted,
        eq(workrooms.publicId, workroomPublicId),
        eq(workrooms.status, "published"),
        isNull(workrooms.archivedAt),
        eq(workroomMembers.contactId, contactId),
        eq(workroomMembers.status, "active"),
        eq(presentations.publicId, presentationPublicId),
        eq(presentations.status, "published"),
        isNull(presentations.archivedAt),
      ),
    )
    .limit(1);

  if (!row) return null;

  return projected(row.reviewId, {
    canWrite: true,
    supersededByVersion: await supersededBy(row.closedByRevisionId),
  });
}

/**
 * The same round, for staff — **and the same projection**.
 *
 * Studio reads what the client reads, including a removed note staying removed.
 * There is no staff path to a removed body and no second shape to drift from
 * this one; internal controls compose around it.
 *
 * The scope differs by one thing and one thing only: staff reach a Presentation
 * by its own Workroom rather than by a membership, and are not stopped by it
 * being unpublished — looking at your own unpublished work is what Studio is
 * for. That is the same shape as `revisionForStaff`, and for the same reason.
 */
export async function reviewForStaff(
  workroomId: string,
  presentationId: string,
  revisionNumber?: number,
): Promise<ClientReview | null> {
  const wanted =
    revisionNumber === undefined
      ? eq(presentationRevisions.id, presentations.currentRevisionId)
      : and(
          eq(presentationRevisions.presentationId, presentations.id),
          eq(presentationRevisions.revisionNumber, revisionNumber),
        );

  const [row] = await db()
    .select({
      reviewId: presentationReviews.id,
      closedByRevisionId: presentationReviews.closedByRevisionId,
    })
    .from(presentationReviews)
    .innerJoin(
      presentationRevisions,
      eq(presentationRevisions.id, presentationReviews.presentationRevisionId),
    )
    .innerJoin(presentations, eq(presentations.id, presentationRevisions.presentationId))
    .where(
      and(
        wanted,
        eq(presentations.id, presentationId),
        eq(presentations.workroomId, workroomId),
        isNull(presentations.archivedAt),
      ),
    )
    .limit(1);

  if (!row) return null;

  return projected(row.reviewId, {
    canWrite: true,
    supersededByVersion: await supersededBy(row.closedByRevisionId),
  });
}

/**
 * The round's internal id, for an authorized caller that is about to write.
 *
 * Separate from the projection on purpose: a surface receives `ClientReview`
 * and never an id, while an action needs one to call the domain. The
 * authorization is the same query, so an action cannot reach a round its
 * reader could not have shown.
 */
export async function reviewIdForViewer(
  contactId: string,
  workroomPublicId: string,
  presentationPublicId: string,
  revisionNumber?: number,
): Promise<string | null> {
  const wanted =
    revisionNumber === undefined
      ? eq(presentationRevisions.id, presentations.currentRevisionId)
      : and(
          eq(presentationRevisions.presentationId, presentations.id),
          eq(presentationRevisions.revisionNumber, revisionNumber),
        );

  const [row] = await db()
    .select({ id: presentationReviews.id })
    .from(presentationReviews)
    .innerJoin(
      presentationRevisions,
      eq(presentationRevisions.id, presentationReviews.presentationRevisionId),
    )
    .innerJoin(presentations, eq(presentations.id, presentationRevisions.presentationId))
    .innerJoin(workrooms, eq(workrooms.id, presentations.workroomId))
    .innerJoin(workroomMembers, eq(workroomMembers.workroomId, workrooms.id))
    .where(
      and(
        wanted,
        eq(workrooms.publicId, workroomPublicId),
        eq(workrooms.status, "published"),
        isNull(workrooms.archivedAt),
        eq(workroomMembers.contactId, contactId),
        eq(workroomMembers.status, "active"),
        eq(presentations.publicId, presentationPublicId),
        eq(presentations.status, "published"),
        isNull(presentations.archivedAt),
      ),
    )
    .limit(1);

  return row?.id ?? null;
}

/** The same, for staff: the round on a Revision of a Presentation they own. */
export async function reviewIdForStaff(
  workroomId: string,
  presentationId: string,
  revisionNumber?: number,
): Promise<string | null> {
  const wanted =
    revisionNumber === undefined
      ? eq(presentationRevisions.id, presentations.currentRevisionId)
      : and(
          eq(presentationRevisions.presentationId, presentations.id),
          eq(presentationRevisions.revisionNumber, revisionNumber),
        );

  const [row] = await db()
    .select({ id: presentationReviews.id })
    .from(presentationReviews)
    .innerJoin(
      presentationRevisions,
      eq(presentationRevisions.id, presentationReviews.presentationRevisionId),
    )
    .innerJoin(presentations, eq(presentations.id, presentationRevisions.presentationId))
    .where(
      and(
        wanted,
        eq(presentations.id, presentationId),
        eq(presentations.workroomId, workroomId),
        isNull(presentations.archivedAt),
      ),
    )
    .limit(1);

  return row?.id ?? null;
}

/** The current Revision of a Presentation staff may act on. */
export async function currentRevisionForStaff(
  workroomId: string,
  presentationId: string,
): Promise<string | null> {
  const [row] = await db()
    .select({ id: presentations.currentRevisionId })
    .from(presentations)
    .where(
      and(
        eq(presentations.id, presentationId),
        eq(presentations.workroomId, workroomId),
        isNull(presentations.archivedAt),
      ),
    )
    .limit(1);

  return row?.id ?? null;
}

/**
 * Whether publishing this Presentation now would end an open round.
 *
 * The one Review fact a publish confirmation has to disclose, read from exactly
 * the column `supersedeReviewOnPublish` reads — `current_revision_id`, whatever
 * the Presentation's status — and true for exactly the state it acts on. So the
 * dialog and the transaction cannot disagree about which round is affected, or
 * about whether a closed or withdrawn one is.
 *
 * Advisory, like every sidecar here: somebody may close the round between the
 * page rendering and the press. The publish transaction reads the round again
 * under its own lock and does the right thing either way; the worst this can
 * be is one render out of date, in the direction of a warning that turned out
 * unnecessary.
 */
export async function openRoundOnCurrentRevision(
  workroomId: string,
  presentationId: string,
): Promise<boolean> {
  const [row] = await db()
    .select({ status: presentationReviews.status })
    .from(presentations)
    .innerJoin(
      presentationReviews,
      eq(presentationReviews.presentationRevisionId, presentations.currentRevisionId),
    )
    .where(
      and(
        eq(presentations.id, presentationId),
        eq(presentations.workroomId, workroomId),
        isNull(presentations.archivedAt),
      ),
    )
    .limit(1);

  return row?.status === "open";
}

/* --------------------------------------------------- the surface's bundle */

/**
 * What one Review surface needs, in one place: the content, and what this
 * person may do to it.
 *
 * **Two objects, deliberately, and the split is where the leak risk is.**
 * `ClientReview` is the one content model and is unchanged by any of this;
 * `ReviewCapabilities` is booleans only. Merging them would mean a permission
 * flag living inside the shape a removed body is kept out of, and the next
 * person to add a field there has a fifty-fifty chance of adding it to the one
 * that travels with words in it.
 *
 * The author keys stop here. They are read below, compared, and thrown away as
 * `mine` — no surface, either world, ever receives one.
 */

/** Who wrote each note, settled inside this module and never returned. */
async function noteOwners(
  reviewId: string,
): Promise<Map<number, { userId: string | null; identityId: string | null }>> {
  const rows = await db()
    .select({
      number: presentationReviewNotes.number,
      userId: presentationReviewNotes.authorUserId,
      identityId: presentationReviewNotes.authorIdentityId,
    })
    .from(presentationReviewNotes)
    .where(eq(presentationReviewNotes.presentationReviewId, reviewId));

  return new Map(rows.map((row) => [row.number, { userId: row.userId, identityId: row.identityId }]));
}

/** The identity a capability is decided against. Never the whole actor. */
type CapabilityActor = { side: "studio"; userId: string } | { side: "client"; identityId: string };

function wroteRow(
  owner: { userId: string | null; identityId: string | null } | undefined,
  actor: CapabilityActor,
): boolean {
  if (!owner) return false;
  return actor.side === "studio"
    ? owner.userId === actor.userId
    : owner.identityId === actor.identityId;
}

type AuthorizedRound = {
  reviewId: string;
  status: ReviewStatus;
  closedReason: ReviewClosureReason | null;
  closedByRevisionId: string | null;
  requestedAt: Date;
};

/**
 * One round, projected and costed, from rows read once.
 *
 * The notes are fetched a single time and used for both halves, so the
 * projection and the sidecar cannot disagree about which notes exist — a
 * capability keyed to an ordinal the content does not contain would be a
 * control floating over nothing.
 */
async function panelFor(
  round: AuthorizedRound,
  actor: CapabilityActor,
  standing: boolean,
  now: Date,
): Promise<{ review: ClientReview | null; capabilities: ReviewCapabilities; notes: number }> {
  const [rows, owners] = await Promise.all([reviewNotes(round.reviewId), noteOwners(round.reviewId)]);

  const review = toClientReview(
    {
      status: round.status,
      closedReason: round.closedReason,
      requestedAt: round.requestedAt,
      supersededByVersion: await supersededBy(round.closedByRevisionId),
      canWrite: standing && round.status === "open",
    },
    rows,
  );

  // A withdrawn round has no content for anybody, so it has no controls for
  // anybody either — Studio's own lifecycle object is what tells it apart.
  if (!review) {
    return { review: null, capabilities: NO_CAPABILITIES, notes: rows.length };
  }

  const replies = new Map<number, number>();
  for (const row of rows) {
    if (row.isRoot || row.parentNumber === null) continue;
    replies.set(row.parentNumber, (replies.get(row.parentNumber) ?? 0) + 1);
  }

  const facts: NoteFacts[] = rows.map((row) => ({
    n: row.number,
    isRoot: row.isRoot,
    mine: wroteRow(owners.get(row.number), actor),
    removed: row.removedAt !== null,
    resolved: row.resolvedAt !== null,
    createdAt: row.createdAt,
    replies: replies.get(row.number) ?? 0,
  }));

  return {
    review,
    capabilities: reviewCapabilities(
      facts,
      { open: round.status === "open", standing, side: actor.side },
      now,
    ),
    notes: rows.length,
  };
}

export type ClientReviewPanel = { review: ClientReview; capabilities: ReviewCapabilities };

/**
 * Everything the client's Review surface renders — or null, which is the
 * client's whole vocabulary for *there is nothing here*.
 *
 * Null still covers the same four things it did in the authorized read: never
 * asked for, withdrawn, not a Revision this person may open, and not their
 * Workroom at all. A surface that could tell those apart would be telling
 * somebody outside the company about the studio's administration.
 */
export async function reviewPanelForViewer(
  viewer: { contactId: string; identityId: string },
  workroomPublicId: string,
  presentationPublicId: string,
  revisionNumber?: number,
  now: Date = new Date(),
): Promise<ClientReviewPanel | null> {
  const wanted =
    revisionNumber === undefined
      ? eq(presentationRevisions.id, presentations.currentRevisionId)
      : and(
          eq(presentationRevisions.presentationId, presentations.id),
          eq(presentationRevisions.revisionNumber, revisionNumber),
        );

  const [row] = await db()
    .select({
      reviewId: presentationReviews.id,
      status: presentationReviews.status,
      closedReason: presentationReviews.closedReason,
      closedByRevisionId: presentationReviews.closedByRevisionId,
      requestedAt: presentationReviews.requestedAt,
    })
    .from(presentationReviews)
    .innerJoin(
      presentationRevisions,
      eq(presentationRevisions.id, presentationReviews.presentationRevisionId),
    )
    .innerJoin(presentations, eq(presentations.id, presentationRevisions.presentationId))
    .innerJoin(workrooms, eq(workrooms.id, presentations.workroomId))
    .innerJoin(workroomMembers, eq(workroomMembers.workroomId, workrooms.id))
    .where(
      and(
        wanted,
        eq(workrooms.publicId, workroomPublicId),
        eq(workrooms.status, "published"),
        isNull(workrooms.archivedAt),
        eq(workroomMembers.contactId, viewer.contactId),
        eq(workroomMembers.status, "active"),
        eq(presentations.publicId, presentationPublicId),
        eq(presentations.status, "published"),
        isNull(presentations.archivedAt),
      ),
    )
    .limit(1);

  if (!row) return null;

  const panel = await panelFor(row, { side: "client", identityId: viewer.identityId }, true, now);
  return panel.review ? { review: panel.review, capabilities: panel.capabilities } : null;
}

export type StaffReviewPanel = {
  /**
   * The public number of the Revision this panel was read for, or null when
   * there is none. Studio's draft page shows the *current* Revision's round
   * beside a draft that may since have changed, so its locators go to this
   * Revision's own page rather than pointing into the draft.
   */
  revision: number | null;
  /** Null when no round was ever asked for, and when one was withdrawn. */
  review: ClientReview | null;
  capabilities: ReviewCapabilities;
  /** The only thing Studio gets that the client does not. No content in it. */
  lifecycle: ReviewLifecycle;
};

/**
 * The same round, for staff — **the same projection, plus its administration**.
 *
 * Studio reads what the client reads, a removed note included: there is no
 * staff path to a removed body and no second content shape to drift from the
 * first. What Studio gets in addition is `lifecycle`, which carries five
 * states, a Revision number and four booleans, and not one word anybody wrote.
 *
 * It starts from the **Revision** rather than from the round, because the state
 * Studio most needs to see is the one where no round exists.
 */
export async function reviewPanelForStaff(
  staff: { userId: string },
  workroomId: string,
  presentationId: string,
  revisionNumber?: number,
  now: Date = new Date(),
): Promise<StaffReviewPanel> {
  const nothing: StaffReviewPanel = {
    revision: null,
    review: null,
    capabilities: NO_CAPABILITIES,
    lifecycle: reviewLifecycle({
      status: null,
      closedReason: null,
      supersededByVersion: null,
      notes: 0,
      current: false,
      live: false,
    }),
  };

  const wanted =
    revisionNumber === undefined
      ? eq(presentationRevisions.id, presentations.currentRevisionId)
      : and(
          eq(presentationRevisions.presentationId, presentations.id),
          eq(presentationRevisions.revisionNumber, revisionNumber),
        );

  const [row] = await db()
    .select({
      revisionId: presentationRevisions.id,
      revisionNumber: presentationRevisions.revisionNumber,
      currentRevisionId: presentations.currentRevisionId,
      presentationStatus: presentations.status,
      presentationArchivedAt: presentations.archivedAt,
      reviewId: presentationReviews.id,
      status: presentationReviews.status,
      closedReason: presentationReviews.closedReason,
      closedByRevisionId: presentationReviews.closedByRevisionId,
      requestedAt: presentationReviews.requestedAt,
    })
    .from(presentationRevisions)
    .innerJoin(presentations, eq(presentations.id, presentationRevisions.presentationId))
    .leftJoin(
      presentationReviews,
      eq(presentationReviews.presentationRevisionId, presentationRevisions.id),
    )
    .where(
      and(
        wanted,
        eq(presentations.id, presentationId),
        eq(presentations.workroomId, workroomId),
        isNull(presentations.archivedAt),
      ),
    )
    .limit(1);

  if (!row) return nothing;

  const live = row.presentationStatus === "published" && row.presentationArchivedAt === null;
  const current = row.currentRevisionId === row.revisionId;

  if (!row.reviewId || !row.status) {
    return {
      revision: row.revisionNumber,
      review: null,
      capabilities: NO_CAPABILITIES,
      lifecycle: reviewLifecycle({
        status: null,
        closedReason: null,
        supersededByVersion: null,
        notes: 0,
        current,
        live,
      }),
    };
  }

  const round: AuthorizedRound = {
    reviewId: row.reviewId,
    status: row.status,
    closedReason: row.closedReason,
    closedByRevisionId: row.closedByRevisionId,
    requestedAt: row.requestedAt ?? new Date(),
  };

  const panel = await panelFor(round, { side: "studio", userId: staff.userId }, true, now);

  return {
    revision: row.revisionNumber,
    review: panel.review,
    capabilities: panel.capabilities,
    lifecycle: reviewLifecycle({
      status: row.status,
      closedReason: row.closedReason,
      supersededByVersion: await supersededBy(row.closedByRevisionId),
      notes: panel.notes,
      current,
      live,
    }),
  };
}
