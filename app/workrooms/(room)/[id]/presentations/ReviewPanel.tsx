import ReviewThread from "@/components/workrooms/ReviewThread";
import { reviewPanelForViewer } from "@/lib/db/reviews";
import { itemSubjects, labelAt, type ClientRevisionItem } from "@/lib/workrooms/presentation-view";

import {
  createReviewNoteAction,
  editReviewNoteAction,
  removeReviewNoteAction,
  reopenReviewNoteAction,
  replyToReviewNoteAction,
  resolveReviewNoteAction,
} from "./reviews";

/**
 * The client's half of a round, on whichever version they are reading.
 *
 * **One file for two routes** — the current version and any published one
 * before it — so the only difference between them is the `revision` handle, and
 * there is no second copy of this wiring to forget.
 *
 * **It renders nothing at all when there is no round.** `reviewPanelForViewer`
 * answers null for four different situations on purpose: nobody ever asked, the
 * request was taken back, this is not a version this person may open, and this
 * is not their Workroom. A client can tell none of those apart, which is the
 * point — a retracted request should look exactly like one that was never made,
 * and the studio's administration is not the client's news.
 *
 * Everything this passes down is a public handle: the Workroom and the
 * Presentation by their opaque public ids, the version by its number. No
 * database identifier is on this page, and no `version` counter either — the
 * round's row lock runs from read to commit inside the domain, so a number in a
 * hidden field would add nothing and would put a raw column on a client page to
 * do it.
 */
export default async function ReviewPanel({
  viewer,
  room,
  presentation,
  items,
  revision,
}: {
  viewer: { contactId: string; identityId: string };
  /** The Workroom's public id. */
  room: string;
  /** The Presentation's public id. */
  presentation: string;
  items: ClientRevisionItem[];
  /** Absent on the current version, which is what the domain defaults to. */
  revision?: number;
}) {
  const panel = await reviewPanelForViewer(viewer, room, presentation, revision);
  if (!panel) return null;

  const open = panel.review.status === "open";

  return (
    <ReviewThread
      review={panel.review}
      capabilities={panel.capabilities}
      actions={{
        comment: createReviewNoteAction,
        reply: replyToReviewNoteAction,
        edit: editReviewNoteAction,
        remove: removeReviewNoteAction,
        resolve: resolveReviewNoteAction,
        reopen: reopenReviewNoteAction,
      }}
      fields={revision === undefined ? { room, presentation } : { room, presentation, revision }}
      subjects={itemSubjects(items)}
      itemLabel={(position) => labelAt(items, position)}
      lead={
        open
          ? "The studio asked for your thoughts on this version. Say as much or as little as you like."
          : "What was said about this version."
      }
    />
  );
}
