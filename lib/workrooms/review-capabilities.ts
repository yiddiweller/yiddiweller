import { NOTE_GRACE_MINUTES } from "../db/schema.ts";

/**
 * What this person may do in this round, decided on the server.
 *
 * **A sidecar, not a second projection.** `ClientReview` is the one content
 * model and it is unchanged: this carries booleans and nothing else — no words,
 * no author, no timestamp, no anchor, and no database identifier of any kind.
 * Adding a field here can never leak content, because there is no content here
 * to leak.
 *
 * It exists because the two things a surface would otherwise have to work out
 * for itself are exactly the two it cannot: **whether this person wrote that
 * note**, which is a comparison against an author id the projection
 * deliberately does not carry, and **whether the fifteen-minute window is still
 * open**, which a browser's clock has no business answering. A page that
 * guessed would be a second authorization system, and the wrong one would
 * eventually win.
 *
 * **It is guidance, not security.** Every server action re-authorizes from
 * scratch — the caller, the Workroom, the Presentation, the Revision, the
 * round, the note, the window, the authorship — inside the transaction that
 * holds the round's row lock. Nothing below is trusted by anything. Its whole
 * job is that a control nobody may press is not drawn.
 *
 * It is computed from the same rows, in the same request, that the projection
 * is built from, so the two can never disagree about which notes exist.
 */

/** Which side of the wall this person is on. */
export type ReviewSide = "studio" | "client";

/** One note's controls, by its ordinal. Every rule mirrors `lib/db/reviews.ts`. */
export type NoteCapabilities = {
  /** Answer it. Roots only — replies are depth one, by foreign key. */
  reply: boolean;
  /** Correct your own words, inside the window, before anybody has answered. */
  edit: boolean;
  /** Take back your own words, on the same five conditions. */
  remove: boolean;
  /** Say the point is dealt with. The studio may; its author may. */
  resolve: boolean;
  /** Say it is not, after all. */
  reopen: boolean;
};

export type ReviewCapabilities = {
  /**
   * Open a new feedback item. **The client's alone** — a CHECK in `0006`
   * refuses a studio-authored root, and the domain refuses the actor before
   * the database gets the chance.
   */
  comment: boolean;
  /** Keyed by the note's ordinal `n`. Absent means every control is off. */
  notes: Record<number, NoteCapabilities>;
};

/** Nothing is permitted. The shape a surface gets when there is no round. */
export const NO_CAPABILITIES: ReviewCapabilities = { comment: false, notes: {} };

/**
 * One note, as the capability rules need to see it.
 *
 * `mine` is the whole reason this type exists. It is settled where the author
 * keys are — inside `lib/db/reviews.ts` — and arrives here as a boolean, so no
 * identifier travels even this far.
 */
export type NoteFacts = {
  n: number;
  isRoot: boolean;
  mine: boolean;
  removed: boolean;
  resolved: boolean;
  createdAt: Date;
  /** How many answers this root already has. Zero for a reply. */
  replies: number;
};

export type RoundFacts = {
  /** The round accepts writes. A closed or withdrawn round accepts none. */
  open: boolean;
  /**
   * This person still stands where they stood: an active member of a published
   * Workroom, or staff. Read from the database on the request that rendered,
   * exactly as the action will read it again.
   */
  standing: boolean;
  side: ReviewSide;
};

const GRACE_MS = NOTE_GRACE_MINUTES * 60_000;

/** Whether the fifteen minutes are still running. The server's clock, always. */
function withinGrace(note: NoteFacts, now: Date): boolean {
  return now.getTime() - note.createdAt.getTime() <= GRACE_MS;
}

/**
 * The five conditions that govern correcting and removing, in the order
 * `claimOwnNote` applies them. One rule, written twice in two modules and
 * asserted equal by a test rather than by hope — the alternative was handing a
 * surface the author ids so it could work them out itself.
 */
function mayTakeBack(note: NoteFacts, now: Date): boolean {
  if (!note.mine) return false;
  if (note.removed) return false;
  if (!withinGrace(note, now)) return false;
  // A root that has been answered is part of a conversation now. A reply is
  // never answered — depth is one — so the count does not apply to it.
  return !note.isRoot || note.replies === 0;
}

/** Who may say a point is dealt with, and who may say it is not. */
function mayDecide(note: NoteFacts, side: ReviewSide): boolean {
  return side === "studio" || note.mine;
}

export function noteCapabilities(
  note: NoteFacts,
  round: RoundFacts,
  now: Date = new Date(),
): NoteCapabilities {
  if (!round.open || !round.standing) {
    return { reply: false, edit: false, remove: false, resolve: false, reopen: false };
  }

  const takeBack = mayTakeBack(note, now);
  const decide = note.isRoot && !note.removed && mayDecide(note, round.side);

  return {
    reply: note.isRoot && !note.removed,
    edit: takeBack,
    remove: takeBack,
    resolve: decide && !note.resolved,
    reopen: decide && note.resolved,
  };
}

/**
 * Every control in one round.
 *
 * A removed note keeps an entry, all false. Leaving it out would work just as
 * well and would mean a missing key had two meanings — no such note, or a note
 * with nothing to offer — which is the kind of ambiguity a test eventually
 * tells you about.
 */
export function reviewCapabilities(
  notes: NoteFacts[],
  round: RoundFacts,
  now: Date = new Date(),
): ReviewCapabilities {
  const byOrdinal: Record<number, NoteCapabilities> = {};
  for (const note of notes) byOrdinal[note.n] = noteCapabilities(note, round, now);

  return {
    comment: round.open && round.standing && round.side === "client",
    notes: byOrdinal,
  };
}
