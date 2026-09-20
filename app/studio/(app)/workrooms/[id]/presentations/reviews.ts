"use server";

import { revalidatePath } from "next/cache";

import { requireStaff } from "@/lib/auth/guard";
import { isId } from "@/lib/business";
import {
  closeReview,
  currentRevisionForStaff,
  reopenReview,
  reopenReviewNote,
  replyToReviewNote,
  requestReview,
  resolveReviewNote,
  reviewIdForStaff,
  withdrawReview,
  type StaffActor,
} from "@/lib/db/reviews";
import { readBody, readOrdinal, readRevisionNumber } from "@/lib/workrooms/review-input";
import { failed, fromOutcome, type ActionResult } from "@/lib/studio-result";

/**
 * Everything staff can do to a round of feedback.
 *
 * **Three things happen here and nothing else**: the caller is re-checked, the
 * form is read into exactly the shapes `review-input.ts` permits, and the public
 * handles are resolved into a round the caller is allowed to reach. Then the
 * domain is called. No rule is restated, no SQL is written, and nothing writes
 * a Review table outside `lib/db/reviews.ts`.
 *
 * **Staff cannot open a feedback item, and there is no action here for it.**
 * The round is the client's voice; the studio replies, resolves and closes.
 * `createReviewNote` is refused by the domain and by a CHECK as well, so the
 * absence of a button is the least of the three defences rather than the only
 * one.
 *
 * **There is no version in any of these forms**, and that is a decision rather
 * than an omission. Every Review mutation holds the round's row lock from its
 * first read to its commit, so the version read under that lock is the version
 * the update finds — an `expectedVersion` from a browser would add nothing the
 * lock does not already give, and would put a raw database counter on a page to
 * get it. Two people pressing *Resolve* at once still get one clean answer each:
 * the second is told it is already dealt with. See `docs/delivery.md`.
 */

function refreshed(workroomId: string, presentationId: string): void {
  revalidatePath(`/studio/workrooms/${workroomId}/presentations/${presentationId}`);
  revalidatePath(`/studio/workrooms/${workroomId}/presentations`);
}

/** The Workroom and Presentation a form names, or null. Never a Review id. */
function handles(form: FormData): { workroomId: string; presentationId: string } | null {
  const workroomId = String(form.get("workroomId") ?? "");
  const presentationId = String(form.get("presentationId") ?? "");
  if (!isId(workroomId) || !isId(presentationId)) return null;
  return { workroomId, presentationId };
}

function actorFor(staff: { id: string; name: string }): StaffActor {
  return { side: "studio", userId: staff.id, name: staff.name };
}

/**
 * Resolve the round this form is about, through the staff-scoped read.
 *
 * A Presentation in another Workroom resolves to null here, so the action
 * answers exactly as it would for one that does not exist. Concealment, not
 * explanation — and the same query the reader uses, so an action can never
 * reach a round its reader could not have shown.
 */
async function roundFor(form: FormData): Promise<
  { workroomId: string; presentationId: string; reviewId: string } | null
> {
  const named = handles(form);
  if (!named) return null;

  const revisionNumber = readRevisionNumber(form.get("revision")) ?? undefined;
  const reviewId = await reviewIdForStaff(named.workroomId, named.presentationId, revisionNumber);
  if (!reviewId) return null;

  return { ...named, reviewId };
}

/* ------------------------------------------------------------- the round */

export async function requestReviewAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const named = handles(form);
  if (!named) return failed("That presentation no longer exists.");

  // The current Revision is read here rather than taken from the form: which
  // version the client is on is the database's answer, not the browser's.
  const revisionId = await currentRevisionForStaff(named.workroomId, named.presentationId);
  if (!revisionId) return failed("That presentation no longer exists.");

  const outcome = await requestReview(actorFor(staff), revisionId);
  refreshed(named.workroomId, named.presentationId);
  return fromOutcome(outcome, "Asked the client for their thoughts on this version.");
}

export async function closeReviewAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const round = await roundFor(form);
  if (!round) return failed("That feedback round no longer exists.");

  const outcome = await closeReview(actorFor(staff), round.reviewId);
  refreshed(round.workroomId, round.presentationId);
  return fromOutcome(outcome, "Feedback closed on this version.");
}

export async function withdrawReviewAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const round = await roundFor(form);
  if (!round) return failed("That feedback round no longer exists.");

  const outcome = await withdrawReview(actorFor(staff), round.reviewId);
  refreshed(round.workroomId, round.presentationId);
  return fromOutcome(outcome, "The request was taken back.");
}

export async function reopenReviewAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const round = await roundFor(form);
  if (!round) return failed("That feedback round no longer exists.");

  const outcome = await reopenReview(actorFor(staff), round.reviewId);
  refreshed(round.workroomId, round.presentationId);
  return fromOutcome(outcome, "Feedback is open again on this version.");
}

/* -------------------------------------------------------------- the notes */

export async function replyToReviewNoteAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const round = await roundFor(form);
  if (!round) return failed("That feedback round no longer exists.");

  const parentNumber = readOrdinal(form.get("n"));
  if (parentNumber === null) return failed("That comment is no longer there.");

  const body = readBody(form.get("body"));
  if (body === null) return failed("Write a reply first.");

  const outcome = await replyToReviewNote(actorFor(staff), {
    reviewId: round.reviewId,
    parentNumber,
    body,
  });
  refreshed(round.workroomId, round.presentationId);
  return fromOutcome(outcome, "Replied.");
}

export async function resolveReviewNoteAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const round = await roundFor(form);
  if (!round) return failed("That feedback round no longer exists.");

  const number = readOrdinal(form.get("n"));
  if (number === null) return failed("That comment is no longer there.");

  const outcome = await resolveReviewNote(actorFor(staff), { reviewId: round.reviewId, number });
  refreshed(round.workroomId, round.presentationId);
  return fromOutcome(outcome, "Marked as dealt with. The client can say otherwise.");
}

export async function reopenReviewNoteAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const staff = await requireStaff();

  const round = await roundFor(form);
  if (!round) return failed("That feedback round no longer exists.");

  const number = readOrdinal(form.get("n"));
  if (number === null) return failed("That comment is no longer there.");

  const outcome = await reopenReviewNote(actorFor(staff), { reviewId: round.reviewId, number });
  refreshed(round.workroomId, round.presentationId);
  return fromOutcome(outcome, "Open again.");
}
