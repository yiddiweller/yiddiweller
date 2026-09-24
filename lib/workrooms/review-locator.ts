import type { ClientAnchor, ClientReview, ClientReviewNote } from "./review-view.ts";

/**
 * Where a Review locator leads, decided without a browser.
 *
 * A locator answers *show me exactly what this comment is about*. Everything
 * it needs is already in the one projection a page renders: the note's
 * ordinal `n`, the **position** of its block in the Revision under review, and
 * the precise anchor F1's parser let through. No identifier of any kind is
 * involved — not a note's, not an item's, not a file's — which is why a
 * locator can travel in a URL as nothing more than `?note=3`.
 *
 * These are the decisions; `ReviewStage` carries them out.
 */

/** A note a locator may point into its work. */
export type Locatable = { n: number; subject: number; anchor: ClientAnchor };

/**
 * The note, if it has somewhere precise to take somebody.
 *
 * A removed note has nothing — it is `{ n, removed }` and nothing else. A note
 * about the version as a whole has no block. A note about a block without an
 * anchor is ordinary item-level feedback and keeps the plain *On …* line it
 * has always had. Resolution is not consulted: a point that was dealt with is
 * still history somebody may want to look at.
 */
export function locatable(note: ClientReviewNote): Locatable | null {
  if (note.removed) return null;
  if (note.subject === undefined || note.anchor === undefined) return null;
  return { n: note.n, subject: note.subject, anchor: note.anchor };
}

/**
 * The note a `?note=` parameter asks for — **in this round and nowhere else.**
 *
 * Looked up among this Review's own root notes, so a number that belongs to
 * another Revision's round, a reply, a tombstone, a note without precision or
 * no note at all is simply nothing: the page renders as it always does.
 */
export function activationTarget(review: ClientReview | null, n: number | null): Locatable | null {
  if (!review || n === null) return null;
  const note = review.notes.find((candidate) => candidate.n === n);
  return note ? locatable(note) : null;
}

/**
 * A note ordinal read from a URL. Anything but a small positive integer — a
 * second value, a sign, a fraction, trailing words, an id — is null.
 */
export function readNoteParam(value: unknown): number | null {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,5}$/.test(value)) return null;
  return Number(value);
}

/**
 * Where a locator on Studio's **draft** page goes: that note, on the page of
 * the Revision it was written about.
 *
 * The draft page shows work that has changed since, so drawing a point on it
 * would draw on the wrong thing. The link names the Revision by its public
 * number and the note by its ordinal, and nothing else — the target page reads
 * the anchor from its own projection.
 */
export function revisionLocatorHref(presentationPath: string, revision: number, n: number): string {
  return `${presentationPath}/revisions/${revision}?note=${n}`;
}

/** What to do with a player for a moment or a stretch. */
export type SeekPlan = { seek: number } | { beyond: true };

/**
 * The seek a time anchor asks for, against what the loaded file reports.
 *
 * A stretch seeks to its start; the label carries the rest. A stored time past
 * the end the player reports is **declined**, not clamped: it is a fact about
 * the file as it plays here, not an error in the note, and parking at the end
 * would claim the comment was about the ending. Nothing stored changes. An
 * unknown duration — a live stream, or metadata that says nothing — is not a
 * reason to refuse.
 */
export function seekPlan(anchor: ClientAnchor, duration: number): SeekPlan | null {
  if (anchor.kind !== "time") return null;
  if (Number.isFinite(duration) && duration >= 0 && anchor.t > duration) return { beyond: true };
  return { seek: anchor.t };
}
