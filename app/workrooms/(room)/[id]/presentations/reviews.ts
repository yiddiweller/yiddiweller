"use server";

import { revalidatePath } from "next/cache";

import { currentViewer } from "@/lib/client-auth/guard";
import {
  createReviewNote,
  editReviewNote,
  removeReviewNote,
  reopenReviewNote,
  replyToReviewNote,
  resolveReviewNote,
  reviewIdForViewer,
  type ClientActor,
} from "@/lib/db/reviews";
import {
  readAnchor,
  readBody,
  readItemPosition,
  readOrdinal,
  readRevisionNumber,
} from "@/lib/workrooms/review-input";
import { isPublicId } from "@/lib/workrooms/id";
import { failed, fromOutcome, type ActionResult } from "@/lib/studio-result";

/**
 * Everything a client can do in a round of feedback.
 *
 * **A separate world, and separately guarded.** These call `currentViewer`,
 * which reads the client Better Auth instance — a different cookie, a different
 * secret, a different table. A Studio session is not a client session and gets
 * nothing here; nothing in this file imports the staff guard, and a test asserts
 * that in both directions.
 *
 * Everything is named by a **public handle**: the Workroom and Presentation by
 * their opaque public ids, a note by its ordinal, an item by its position.
 * There is no path from this form to a database id, which is why a wrong
 * Workroom, a wrong Presentation, a wrong Revision and a wrong note are all the
 * same answer — the authorized read returns nothing and the action says the
 * round is not there.
 *
 * **No version travels either.** The round's row lock is held from read to
 * commit inside the domain, so an `expectedVersion` from a browser would add
 * nothing and would put a raw database counter on a client page to do it.
 *
 * There are no actions here for requesting, closing, withdrawing or reopening a
 * round: those are the studio's, and their absence is the least of three
 * defences — the domain takes a `StaffActor` for each, and only staff have one.
 */

/** What the form names, before anything is looked up. */
type Named = { room: string; presentation: string; revision?: number };

function handles(form: FormData): Named | null {
  const room = String(form.get("room") ?? "");
  const presentation = String(form.get("presentation") ?? "");
  if (!isPublicId(room) || !isPublicId(presentation)) return null;

  const revision = readRevisionNumber(form.get("revision"));
  return revision === null ? { room, presentation } : { room, presentation, revision };
}

function refreshed(named: Named): void {
  revalidatePath(`/workrooms/${named.room}/presentations/${named.presentation}`);
  if (named.revision !== undefined) {
    revalidatePath(
      `/workrooms/${named.room}/presentations/${named.presentation}/revisions/${named.revision}`,
    );
  }
}

/**
 * The signed-in client and the round they are asking about — or null, which is
 * the only thing a refusal here ever says.
 *
 * Membership is part of the query rather than a check after it, so somebody
 * else's Workroom never gets as far as being read. It is exactly the query the
 * reader uses, so an action cannot reach a round the page could not have shown.
 */
async function roundFor(
  form: FormData,
): Promise<{ actor: ClientActor; named: Named; reviewId: string } | null> {
  const viewer = await currentViewer();
  if (!viewer) return null;

  const named = handles(form);
  if (!named) return null;

  const reviewId = await reviewIdForViewer(
    viewer.contactId,
    named.room,
    named.presentation,
    named.revision,
  );
  if (!reviewId) return null;

  return {
    actor: {
      side: "client",
      identityId: viewer.id,
      contactId: viewer.contactId,
      name: viewer.name,
    },
    named,
    reviewId,
  };
}

/** The one sentence every refusal at this boundary gives, whatever went wrong. */
const NOWHERE = "That feedback is no longer there.";

/* ------------------------------------------------------------------ writing */

export async function createReviewNoteAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const round = await roundFor(form);
  if (!round) return failed(NOWHERE);

  const body = readBody(form.get("body"));
  if (body === null) return failed("Write something first.");

  const itemPosition = readItemPosition(form.get("item"));

  const anchor = readAnchor(form.get("anchor"));
  if (anchor === null) return failed("That is not a place in the work.");

  const outcome = await createReviewNote(round.actor, {
    reviewId: round.reviewId,
    body,
    itemPosition,
    anchor,
  });
  refreshed(round.named);
  return fromOutcome(outcome, "Sent to the studio.");
}

export async function replyToReviewNoteAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const round = await roundFor(form);
  if (!round) return failed(NOWHERE);

  const parentNumber = readOrdinal(form.get("n"));
  if (parentNumber === null) return failed(NOWHERE);

  const body = readBody(form.get("body"));
  if (body === null) return failed("Write something first.");

  const outcome = await replyToReviewNote(round.actor, {
    reviewId: round.reviewId,
    parentNumber,
    body,
  });
  refreshed(round.named);
  return fromOutcome(outcome, "Sent.");
}

export async function editReviewNoteAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const round = await roundFor(form);
  if (!round) return failed(NOWHERE);

  const number = readOrdinal(form.get("n"));
  if (number === null) return failed(NOWHERE);

  const body = readBody(form.get("body"));
  if (body === null) return failed("Write something first.");

  const outcome = await editReviewNote(round.actor, {
    reviewId: round.reviewId,
    number,
    body,
  });
  refreshed(round.named);
  return fromOutcome(outcome, "Corrected.");
}

export async function removeReviewNoteAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const round = await roundFor(form);
  if (!round) return failed(NOWHERE);

  const number = readOrdinal(form.get("n"));
  if (number === null) return failed(NOWHERE);

  const outcome = await removeReviewNote(round.actor, { reviewId: round.reviewId, number });
  refreshed(round.named);
  return fromOutcome(outcome, "Removed.");
}

export async function resolveReviewNoteAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const round = await roundFor(form);
  if (!round) return failed(NOWHERE);

  const number = readOrdinal(form.get("n"));
  if (number === null) return failed(NOWHERE);

  const outcome = await resolveReviewNote(round.actor, { reviewId: round.reviewId, number });
  refreshed(round.named);
  return fromOutcome(outcome, "Marked as settled.");
}

export async function reopenReviewNoteAction(
  _previous: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const round = await roundFor(form);
  if (!round) return failed(NOWHERE);

  const number = readOrdinal(form.get("n"));
  if (number === null) return failed(NOWHERE);

  const outcome = await reopenReviewNote(round.actor, { reviewId: round.reviewId, number });
  refreshed(round.named);
  return fromOutcome(outcome, "Open again.");
}
