import Moment from "@/components/studio/Moment";
import ReviewAction from "@/components/workrooms/ReviewAction";
import ReviewComposer, { type ReviewSubject } from "@/components/workrooms/ReviewComposer";
import { type ActionResult } from "@/lib/studio-result";
import { type ReviewCapabilities } from "@/lib/workrooms/review-capabilities";
import {
  type ClientAuthor,
  type ClientReview,
  type ClientReviewNote,
  type ClientReviewReply,
} from "@/lib/workrooms/review-view";
import styles from "@/components/workrooms/ReviewThread.module.css";

/**
 * One round of feedback, rendered for whoever is reading it.
 *
 * **One component, four routes**: the client's current version, the client's
 * view of an earlier version, Studio's presentation page and Studio's view of a
 * published version. `PresentationView` exists for the same reason and was
 * written after a preview had already fallen a feature behind the page it
 * claimed to preview — and a *conversation* falling behind itself is worse than
 * a document doing it, because the two people in it would be reading different
 * versions of what each other said.
 *
 * **There is no `if (isStaff)` below.** Not in the markup, not in the copy, not
 * in the ordering. The content is a `ClientReview` — the one projection, the
 * same for both worlds — and every control is drawn from a `ReviewCapabilities`
 * sidecar the server computed. Which world is rendering shows up in exactly two
 * places, both of them outside the content: the `lead` sentence a page passes
 * in, and which server actions it hands over. A capability that is true with no
 * action behind it draws nothing, so neither is load-bearing on its own.
 *
 * **Nothing here decides anything.** Every control is a form posting to a
 * server action that re-reads the caller, the Workroom, the Presentation, the
 * Revision, the round and the note under the round's row lock. The sidecar's
 * only job is that a control nobody may press is not drawn; a control that
 * somehow is drawn is refused on the server, and a test presses one to prove it.
 *
 * **No identifier of any kind is in this markup.** A note is named by its
 * ordinal within the round and an item by its position in the Revision, which
 * are meaningless outside a round the caller has already been authorized for.
 * That is what makes them safe to put in a hidden field.
 */

type Action = (previous: ActionResult | null, form: FormData) => Promise<ActionResult>;

/**
 * The six things that can be done, as each world is allowed to do them.
 *
 * Three are optional because Studio genuinely has no action behind them:
 * **staff cannot open a feedback item** — the round is the client's voice, and
 * a CHECK in `0006` refuses a studio-authored root — while correcting and
 * taking back apply to a reply either side may have written, so Studio has
 * those.
 */
export type ReviewActions = {
  /** Open a new point. The client's alone. */
  comment?: Action;
  reply: Action;
  edit?: Action;
  remove?: Action;
  resolve: Action;
  reopen: Action;
};

const NO_CONTROLS = { reply: false, edit: false, remove: false, resolve: false, reopen: false };

/** The studio is named as the studio. Everyone else is simply themselves. */
function Who({ author }: { author: ClientAuthor }) {
  return (
    <>
      <span className={styles.author}>{author.name}</span>
      {author.side === "studio" ? <span className={styles.meta}>Studio</span> : null}
    </>
  );
}

function Body({ note }: { note: ClientReviewReply }) {
  // A tombstone carries no words, for anybody. There is one projection and it
  // does not produce a removed body, so there is nothing here to conditionally
  // show — the field is simply absent.
  return note.removed ? (
    <p className={styles.gone}>This was taken back.</p>
  ) : (
    <p className={styles.body}>{note.body}</p>
  );
}

export default function ReviewThread({
  review,
  capabilities,
  actions,
  fields,
  subjects,
  itemLabel,
  lead,
}: {
  review: ClientReview;
  capabilities: ReviewCapabilities;
  actions: ReviewActions;
  /** The handles every form in this thread carries. Public ids, never row ids. */
  fields: Record<string, string | number>;
  /** The parts of the work a new point may be about. Absent where none may be opened. */
  subjects?: ReviewSubject[];
  /**
   * What the block at this position is called, so a note says what it is
   * about. Null when this Revision has nothing at that position, which the
   * thread turns into `Item N` rather than into silence.
   */
  itemLabel: (position: number) => string | null;
  /** The one sentence above the thread. The only copy either world supplies. */
  lead: string;
}) {
  const controlsFor = (n: number) => capabilities.notes[n] ?? NO_CONTROLS;

  const correction = (note: ClientReviewReply) => {
    const can = controlsFor(note.n);
    if (!can.edit || !actions.edit) return null;

    return (
      <ReviewComposer
        action={actions.edit}
        fields={{ ...fields, n: note.n }}
        trigger="Correct"
        label="What you meant"
        submitLabel="Save"
        busyLabel="Saving…"
        defaultBody={note.body}
        hint="Only while nobody has answered, and only for a few minutes."
      />
    );
  };

  const takeBack = (note: ClientReviewReply) => {
    const can = controlsFor(note.n);
    if (!can.remove || !actions.remove) return null;

    return (
      <ReviewAction
        action={actions.remove}
        fields={{ ...fields, n: note.n }}
        label="Take back"
        busyLabel="Taking back…"
        confirm={{
          title: "Take this comment back?",
          message:
            "The words go for good — nobody can read them again, the studio included. That you wrote something stays on the record, and this cannot be undone.",
          action: "Take back",
          destructive: true,
        }}
      />
    );
  };

  const Reply = ({ reply }: { reply: ClientReviewReply }) => {
    const can = controlsFor(reply.n);
    const own = (can.edit && actions.edit) || (can.remove && actions.remove);

    return (
      <li className={styles.note}>
        <div className={styles.noteHead}>
          <Who author={reply.author} />
          <Moment className={styles.meta} iso={reply.at.toISOString()} />
          {reply.edited ? <span className={styles.meta}>Corrected</span> : null}
        </div>

        <Body note={reply} />

        {own ? (
          <div className={styles.controls}>
            {correction(reply)}
            {takeBack(reply)}
          </div>
        ) : null}
      </li>
    );
  };

  const Note = ({ note }: { note: ClientReviewNote }) => {
    const can = controlsFor(note.n);

    // **The subject alone decides whether there is a locator**, never the
    // precise anchor beside it: item-level feedback is a comment about a block,
    // and most of it will never carry a pin. And a block that cannot be named
    // still gets named — falling back to its place in the sequence rather than
    // silently dropping the one line that says what the point is about, which
    // is exactly what beta caught.
    const named = note.subject === undefined ? null : itemLabel(note.subject);
    const subject =
      note.subject === undefined ? null : (named ?? `Item ${note.subject + 1}`);

    return (
      <li className={styles.note}>
        <div className={styles.noteHead}>
          <Who author={note.author} />
          <Moment className={styles.meta} iso={note.at.toISOString()} />
          {/* One text node, not `On {subject}`: React splits an interpolation
              with its own comment marker, which leaves the sentence in two
              pieces for anything reading the response — a test, a screen
              reader announcing it, somebody copying the line. */}
          {subject ? <span className={styles.subject}>{`On ${subject}`}</span> : null}
          {note.edited ? <span className={styles.meta}>Corrected</span> : null}
        </div>

        <Body note={note} />

        {note.resolved ? (
          <p className={styles.flags}>
            {/* Said as a claim by somebody, not as a verdict from the system —
                which is why either side can say otherwise afterwards. */}
            <span>
              Dealt with{note.resolvedBy ? ` — ${note.resolvedBy.name}` : ""}
            </span>
          </p>
        ) : null}

        {can.resolve || can.reopen || can.reply || can.edit || can.remove ? (
          <div className={styles.controls}>
            {can.resolve ? (
              <ReviewAction
                action={actions.resolve}
                fields={{ ...fields, n: note.n }}
                label="Mark as dealt with"
                busyLabel="Marking…"
                confirm={{
                  title: "Mark this as dealt with?",
                  message:
                    "It stays visible and nothing is deleted. Either side can say otherwise afterwards.",
                  action: "Mark as dealt with",
                }}
              />
            ) : null}

            {can.reopen ? (
              <ReviewAction
                action={actions.reopen}
                fields={{ ...fields, n: note.n }}
                label="Not dealt with"
                busyLabel="Reopening…"
              />
            ) : null}

            {can.reply ? (
              <ReviewComposer
                action={actions.reply}
                fields={{ ...fields, n: note.n }}
                trigger="Reply"
                label="Your reply"
                submitLabel="Send"
                busyLabel="Sending…"
              />
            ) : null}

            {correction(note)}
            {takeBack(note)}
          </div>
        ) : null}

        {note.replies.length > 0 ? (
          <ul className={styles.replies}>
            {note.replies.map((reply) => (
              <Reply key={reply.n} reply={reply} />
            ))}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    /* Named rather than labelled by the heading: an id on a shared component is
       an id that collides the first time two of these render on one page, and
       the accessible name is the same either way. */
    <section className={styles.review} aria-label="Feedback">
      <div className={styles.head}>
        <h2 className={styles.title}>Feedback</h2>
        {review.notes.length > 0 ? (
          <span className={styles.count}>
            {review.notes.length === 1 ? "1 point" : `${review.notes.length} points`}
          </span>
        ) : null}
      </div>

      <p className={styles.lead}>{lead}</p>

      {/* Why it is read-only, once, in terms that are true for both readers.
          A round nobody may write to is not explained twice. */}
      {review.closedNote ? (
        <p className={styles.closed}>
          {review.closedNote.reason === "superseded"
            ? `Feedback on this version closed when version ${review.closedNote.version} was published.`
            : "The studio has closed feedback on this version."}
        </p>
      ) : null}

      {review.notes.length === 0 ? (
        <p className={styles.empty}>Nothing has been said about this version yet.</p>
      ) : (
        <ul className={styles.thread}>
          {review.notes.map((note) => (
            <Note key={note.n} note={note} />
          ))}
        </ul>
      )}

      {capabilities.comment && actions.comment ? (
        <ReviewComposer
          action={actions.comment}
          fields={fields}
          label="What would you like to say?"
          submitLabel="Send to the studio"
          busyLabel="Sending…"
          placeholder="Anything at all — a change, a question, or that it is right."
          subjects={subjects}
        />
      ) : null}
    </section>
  );
}
