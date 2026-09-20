import Moment from "@/components/studio/Moment";
import RecordAction from "@/components/studio/RecordAction";
import ReviewThread from "@/components/workrooms/ReviewThread";
import { reviewPanelForStaff } from "@/lib/db/reviews";
import { labelAt, type ClientRevisionItem } from "@/lib/workrooms/presentation-view";
import { type ReviewLifecycle } from "@/lib/workrooms/review-lifecycle";
import studio from "@/app/studio/studio.module.css";
import room from "@/app/workrooms/workroom.module.css";

import {
  closeReviewAction,
  editReviewNoteAction,
  removeReviewNoteAction,
  reopenReviewAction,
  reopenReviewNoteAction,
  replyToReviewNoteAction,
  requestReviewAction,
  resolveReviewNoteAction,
  withdrawReviewAction,
} from "./reviews";

/**
 * The studio's half of a round: its administration, and the same thread the
 * client is reading.
 *
 * **Two things, and the boundary between them is the point.** The thread is
 * `ReviewThread` rendering a `ClientReview` — the one projection, identical to
 * the client's, a removed note staying removed for staff as well. Everything
 * *around* it is Studio's, drawn from `lifecycle`, which carries five states, a
 * version number and four booleans and not one word anybody wrote. Internal
 * controls compose around the content; they never reach inside it.
 *
 * `lifecycle` exists because the projection is null for a withdrawn round —
 * correctly, for a client — and Studio still has to tell *nobody has asked*
 * from *I asked and took it back*, or the same person asks twice.
 *
 * The thread is wrapped in the Workroom's token root. It is a shared component
 * with its own stylesheet built from the global tokens, so this is belt and
 * braces rather than a requirement — and it is the same thing
 * `StudioPresentationRevision` does with `PresentationView`, for the same
 * reason: a client-facing component rendered in Studio should be spaced like
 * what it is.
 */

function Controls({
  lifecycle,
  fields,
}: {
  lifecycle: ReviewLifecycle;
  fields: { workroomId: string; presentationId: string; revision?: number };
}) {
  // `revision` is absent rather than undefined when there is none, so this is
  // the whole of what each form says: two ids and, on a version's own page,
  // which version. Never a Review id and never a version counter.
  const named = fields as Record<string, string | number>;

  return (
    <div className={studio.actions}>
      {lifecycle.canRequest ? (
        <RecordAction
          action={requestReviewAction}
          fields={named}
          label={lifecycle.state === "withdrawn" ? "Ask again" : "Ask for feedback"}
          busyLabel="Asking…"
          variant="secondary"
          confirm={{
            title: "Ask for feedback on this version?",
            message:
              "The client can write on it until you close it. No email is sent — telling them is a separate decision.",
            action: "Ask",
          }}
        />
      ) : null}

      {lifecycle.canClose ? (
        <RecordAction
          action={closeReviewAction}
          fields={named}
          label="Close feedback"
          busyLabel="Closing…"
          confirm={{
            title: "Close feedback on this version?",
            message:
              "The client keeps everything that was said and can no longer add to it. You can reopen it while this is the version they are reading.",
            action: "Close",
            destructive: true,
          }}
        />
      ) : null}

      {/* Gone for good the moment anybody writes, including a comment that was
          taken back: the ordinal is spent, and presenting an untouched round to
          somebody who had already used it would be a lie about their own
          Workroom. The button disappears rather than refusing. */}
      {lifecycle.canWithdraw ? (
        <RecordAction
          action={withdrawReviewAction}
          fields={named}
          label="Take the request back"
          busyLabel="Taking back…"
          confirm={{
            title: "Take the request back?",
            message:
              "This version looks to the client exactly as it did before you asked. Only possible while nothing has been written.",
            action: "Take back",
            destructive: true,
          }}
        />
      ) : null}

      {lifecycle.canReopen ? (
        <RecordAction
          action={reopenReviewAction}
          fields={named}
          label="Reopen feedback"
          busyLabel="Reopening…"
        />
      ) : null}
    </div>
  );
}

/** One sentence naming the state, for the state each one is true of. */
function State({ lifecycle, requestedAt }: { lifecycle: ReviewLifecycle; requestedAt?: Date }) {
  if (lifecycle.state === "superseded") {
    return (
      <p className={studio.hint}>
        Closed when version {lifecycle.supersededBy} was published. That is terminal — the database
        refuses to reopen it, and a new decision about changed work needs its own round.
      </p>
    );
  }

  if (lifecycle.state === "withdrawn") {
    return (
      <p className={studio.hint}>
        You asked for feedback on this version and took the request back. The client sees no trace
        of it.
      </p>
    );
  }

  if (lifecycle.state === "closed") {
    return (
      <p className={studio.hint}>
        Closed by the studio. The client can still read it.
        {lifecycle.canReopen ? "" : " A newer version has been published since, so it stays closed."}
      </p>
    );
  }

  if (lifecycle.state === "open") {
    return (
      <p className={studio.hint}>
        Open{requestedAt ? " since " : ""}
        {requestedAt ? <Moment iso={requestedAt.toISOString()} style="day" /> : null}. The client
        can raise points on this version; you reply, resolve and close.
      </p>
    );
  }

  if (lifecycle.canRequest) {
    return (
      <p className={studio.hint}>
        Nobody has been asked about this version yet.
      </p>
    );
  }

  return (
    <p className={studio.hint}>
      Feedback is asked for on the version the client is reading, and only once this presentation is
      published.
    </p>
  );
}

export default async function ReviewPanel({
  staff,
  workroomId,
  presentationId,
  loadItems,
  revision,
}: {
  staff: { userId: string };
  workroomId: string;
  presentationId: string;
  /**
   * The blocks of the version under review, fetched only if something needs
   * naming. Studio's presentation page is about the *draft* and does not
   * otherwise read the published snapshot, and most rounds have no anchored
   * points at all — so this is a function rather than an array, and a page that
   * already holds the items simply returns them.
   */
  loadItems: () => Promise<ClientRevisionItem[]>;
  /** Absent on the presentation page, which is always about the current version. */
  revision?: number;
}) {
  const panel = await reviewPanelForStaff(staff, workroomId, presentationId, revision);
  const fields = { workroomId, presentationId, ...(revision === undefined ? {} : { revision }) };

  const anchored = panel.review?.notes.some((note) => note.anchor !== undefined) ?? false;
  const items = anchored ? await loadItems() : [];

  return (
    /* Unnamed on purpose when the thread is here: `ReviewThread` is a labelled
       region called Feedback, and wrapping it in a second region of the same
       name puts the words inside two things called the same thing. */
    <section className={studio.section}>
      {/* The thread carries the heading when there is one, so this is here for
          the states that have no thread — never asked, and taken back — rather
          than saying "Feedback" twice on the same screen. */}
      {panel.review ? null : (
        <div className={studio.sectionHead}>
          <h2 className={studio.sectionTitle}>Feedback</h2>
        </div>
      )}

      <State lifecycle={panel.lifecycle} requestedAt={panel.review?.requestedAt} />

      <Controls lifecycle={panel.lifecycle} fields={fields} />

      {panel.review ? (
        <div className={room.tokens}>
          <ReviewThread
            review={panel.review}
            capabilities={panel.capabilities}
            actions={{
              reply: replyToReviewNoteAction,
              edit: editReviewNoteAction,
              remove: removeReviewNoteAction,
              resolve: resolveReviewNoteAction,
              reopen: reopenReviewNoteAction,
            }}
            fields={fields}
            itemLabel={(position) => labelAt(items, position)}
            lead={
              panel.review.status === "open"
                ? "Exactly what the client is reading, and exactly what they can write in."
                : "What was said about this version."
            }
          />
        </div>
      ) : null}
    </section>
  );
}
