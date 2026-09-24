import { type ReviewNoteRow } from "../db/reviews.ts";
import { type ReviewStatus } from "../db/schema.ts";

/**
 * What a Review looks like to somebody outside the database.
 *
 * **The only producer of client-visible Review data**, and the only place a
 * stored row becomes something a surface may hold. It follows `delivery-view.ts`
 * exactly: a whitelist, never a filter. No ORM row is spread, nothing is
 * "returned and hidden later", and adding a field to a Review surface means
 * adding it here first, deliberately, in review.
 *
 * **One projection for both worlds.** Studio renders the same `ClientReview` the
 * client does. There is no `StaffReview`, no `InternalReviewView` and no second
 * copy of the shape — the Stage A `WorkroomOverview` drift and the Stage B route
 * defect were both a second representation drifting from the first, and this is
 * the third place that lesson applies. Internal controls compose *around* this;
 * they never reach inside it.
 *
 * Two guarantees are worth stating before the types:
 *
 * **A removed note's words leave here for nobody.** Not the client, not the
 * studio, not an Owner. The row keeps the body so the record is not falsified;
 * this function does not carry it, and there is no second path that does. The
 * thing most likely to be removed in a panic is something private, and a
 * removal the studio can still read is not a removal.
 *
 * **No database identifier is in any of these types.** A note is named by its
 * ordinal within the round, `n`; an item by its `position` in the Revision. Both
 * are meaningless outside a round the caller has already been authorized for,
 * which is what makes them safe to hand out.
 */

/** A person, as history recorded them. Never an id, never an address. */
export type ClientAuthor = {
  name: string;
  side: "studio" | "client";
};

/**
 * Where **inside** a block a point was made — and nothing about which block.
 *
 * **Precision only.** Which block a note is about is `subject`, a position on
 * the note itself; this says where inside it, and exists only when somebody
 * captured that. The two were one shape until beta found what that costs: a
 * comment *about* a block is not an annotation *on* a point in it, and folding
 * them together made the block's identity something you had to reach through an
 * anchor to find. A note can have a subject and no anchor — that is ordinary
 * item-level feedback, and it is the common case.
 *
 * Fractions are of the media's own intrinsic box and seconds are from its
 * start, so a phone and a desktop resolve to the same place. This is the Stage
 * C vocabulary unchanged; only the redundant `item` field is gone, because the
 * note already carries it and two copies of one fact eventually disagree.
 */
export type ClientAnchor =
  | { kind: "point"; x: number; y: number }
  | { kind: "region"; x: number; y: number; w: number; h: number }
  | { kind: "time"; t: number }
  | { kind: "time"; t: number; t2: number }
  | { kind: "time"; t: number; region: { x: number; y: number; w: number; h: number } };

/**
 * A note that was taken back.
 *
 * **Its ordinal, and the fact that it happened. That is the whole type.** No
 * author, no time, no block, no anchor, no resolution, no edit history — not
 * because a surface is trusted to hide them, but because they are not here to
 * hide. Beta found the header still being drawn around a tombstone, and the
 * lesson of that is not "remember to check `removed` first": it is that a
 * shape which *can* carry an author on a removed note will eventually be read
 * that way by somebody, and will meanwhile carry it in the flight payload
 * whatever the markup does.
 *
 * So the two states are two types. Reading an author off a tombstone is not a
 * bug a reviewer has to catch; it does not compile, and there is nothing in the
 * serialized response to find.
 *
 * The ordinal stays because it is the note's handle and its place in the
 * order — it names nobody and says nothing.
 */
export type ClientRemovedNote = { n: number; removed: true };

/** A note somebody can still read. */
export type ClientLiveNote = {
  n: number;
  author: ClientAuthor;
  at: Date;
  body: string;
  removed: false;
  edited: boolean;
};

export type ClientReviewReply = ClientRemovedNote | ClientLiveNote;

export type ClientReviewNote =
  | ClientRemovedNote
  | (ClientLiveNote & {
      /**
       * Which block of the Revision this is about, by its **position** in the
       * sequence — never its id. Absent when the point is general to the
       * version.
       *
       * A Revision's positions are dense: 0, 1, 2 … with nothing missing,
       * matching both the frozen snapshot and `presentation_revision_items`.
       * Beta found them disagreeing, which is why that is written down here as
       * well as there.
       */
      subject?: number;
      /**
       * Where inside that block, when somebody said. Absent for ordinary
       * item-level feedback, which is most of it. Never present without a
       * `subject`.
       */
      anchor?: ClientAnchor;
      resolved: boolean;
      /** Present only while resolved. */
      resolvedBy?: ClientAuthor;
      replies: ClientReviewReply[];
    });

/** Why a round is no longer open, in terms somebody outside can act on. */
export type ClientReviewClosure =
  | { reason: "closed" }
  | { reason: "superseded"; version: number };

export type ClientReview = {
  status: "open" | "closed";
  requestedAt: Date;
  /** Decided on the server, from the round's state and the caller's standing. */
  canWrite: boolean;
  closedNote?: ClientReviewClosure;
  notes: ClientReviewNote[];
};

/* ------------------------------------------------------------------ anchors */

const FRACTION = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

const SECONDS = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

function box(value: unknown): { x: number; y: number; w: number; h: number } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!FRACTION(raw.x) || !FRACTION(raw.y) || !FRACTION(raw.w) || !FRACTION(raw.h)) return null;
  return { x: raw.x, y: raw.y, w: raw.w, h: raw.h };
}

/**
 * The stored anchor, projected — **and it fails closed to nothing.**
 *
 * `parseAnchor` in the domain is what stops a malformed anchor being stored, so
 * anything that reaches here and does not match the Stage C vocabulary exactly
 * got in some other way. It is not passed through and it is not repaired: the
 * note keeps its `subject`, which is a position read from a join and therefore
 * known good, and loses only the precision nobody can vouch for. Losing an
 * anchor costs a note its pin; it never costs the note the block it is about.
 *
 * Nothing arbitrary crosses this boundary. Every field emitted is named here.
 */
export function toClientAnchor(stored: unknown): ClientAnchor | undefined {
  if (stored === null || stored === undefined) return undefined;
  if (typeof stored !== "object" || Array.isArray(stored)) return undefined;

  const raw = stored as Record<string, unknown>;

  if (raw.kind === "point") {
    return FRACTION(raw.x) && FRACTION(raw.y) ? { kind: "point", x: raw.x, y: raw.y } : undefined;
  }

  if (raw.kind === "region") {
    const region = box(raw);
    return region ? { kind: "region", ...region } : undefined;
  }

  if (raw.kind === "time") {
    if (!SECONDS(raw.t)) return undefined;

    if (raw.t2 !== undefined) {
      return SECONDS(raw.t2) && raw.t2 > raw.t ? { kind: "time", t: raw.t, t2: raw.t2 } : undefined;
    }

    if (raw.region !== undefined) {
      const region = box(raw.region);
      return region ? { kind: "time", t: raw.t, region } : undefined;
    }

    return { kind: "time", t: raw.t };
  }

  return undefined;
}

/* -------------------------------------------------------------- the notes */

function author(row: ReviewNoteRow): ClientAuthor {
  // The snapshots, never the foreign keys — those go null the day somebody
  // leaves, and history has to keep reading afterwards.
  return { name: row.authorName, side: row.authorSide };
}

function toReply(row: ReviewNoteRow): ClientReviewReply {
  // Built by naming every field, so a removal is an absence rather than a
  // value somebody has to remember to strip — and the tombstone names two.
  if (row.removedAt !== null) return { n: row.number, removed: true };

  return {
    n: row.number,
    author: author(row),
    at: row.createdAt,
    body: row.body,
    removed: false,
    edited: row.editedAt !== null,
  };
}

function toNote(row: ReviewNoteRow, replies: ReviewNoteRow[]): ClientReviewNote {
  // A tombstone carries no words, no author, no time, no place and no
  // decision. Whether it was resolved before it was removed is not the
  // client's business and not the studio's either: the point is gone, so the
  // state of it means nothing — and nor does who made it or when.
  //
  // It carries no replies either, and that is the domain's guarantee rather
  // than this function's opinion: `claimOwnNote` refuses a removal once
  // anything has answered, and `replyToReviewNote` refuses a removed parent,
  // so a removed root has none and can never gain one.
  if (row.removedAt !== null) return { n: row.number, removed: true };

  const base = toReply(row);
  if (base.removed) return base;

  // The subject stands on its own. Precision is read separately and only where
  // there is a subject to be precise about — "say which part of the work this
  // is about" is the domain's rule, and this is the projection agreeing with it
  // rather than inferring the subject back out of the anchor.
  const subject = row.itemPosition;
  const anchor = subject === null ? undefined : toClientAnchor(row.anchor);
  const resolved = row.resolvedAt !== null;

  return {
    ...base,
    ...(subject === null ? {} : { subject }),
    ...(anchor ? { anchor } : {}),
    resolved,
    ...(resolved && row.resolvedByName && row.resolvedBySide
      ? { resolvedBy: { name: row.resolvedByName, side: row.resolvedBySide } }
      : {}),
    replies: replies.map(toReply),
  };
}

/* ------------------------------------------------------------- the round */

export type ReviewFacts = {
  status: ReviewStatus;
  closedReason: "staff" | "superseded" | null;
  requestedAt: Date;
  /** The Revision number that ended this round, when one did. Never its id. */
  supersededByVersion: number | null;
  canWrite: boolean;
};

/**
 * One round, projected.
 *
 * **Returns null for a withdrawn round, deliberately.** A retracted request is
 * the studio's administration, and to anybody reading the work it should look
 * exactly like a round that was never asked for. Studio learns it was withdrawn
 * from its own controls, which sit outside this shape — not by this function
 * growing a fork.
 *
 * Notes come back in ordinal order with replies nested under their root, which
 * is the order they were written. There is no other ordering and no sorting
 * key a caller could pass.
 */
export function toClientReview(facts: ReviewFacts, rows: ReviewNoteRow[]): ClientReview | null {
  if (facts.status === "withdrawn") return null;

  const roots = rows.filter((row) => row.isRoot).sort((a, b) => a.number - b.number);
  const byParent = new Map<number, ReviewNoteRow[]>();

  for (const row of rows) {
    if (row.isRoot || row.parentNumber === null) continue;
    const list = byParent.get(row.parentNumber) ?? [];
    list.push(row);
    byParent.set(row.parentNumber, list);
  }

  const notes = roots.map((root) =>
    toNote(
      root,
      (byParent.get(root.number) ?? []).sort((a, b) => a.number - b.number),
    ),
  );

  const closure: ClientReviewClosure | null =
    facts.status !== "closed"
      ? null
      : facts.closedReason === "superseded" && facts.supersededByVersion !== null
        ? { reason: "superseded", version: facts.supersededByVersion }
        : { reason: "closed" };

  return {
    status: facts.status === "open" ? "open" : "closed",
    requestedAt: facts.requestedAt,
    // Never recomputed by a surface. A page that decided this for itself would
    // be a second authorization system, and the wrong one would eventually win.
    canWrite: facts.canWrite,
    ...(closure ? { closedNote: closure } : {}),
    notes,
  };
}
