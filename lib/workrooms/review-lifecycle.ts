import { type ReviewStatus } from "../db/schema.ts";

/**
 * The round's administration — **Studio's alone**.
 *
 * `ClientReview` answers *what was said*; this answers *what state the studio's
 * request is in*, which is a different question with a different audience. A
 * withdrawn round projects as null to both worlds, deliberately: to anybody
 * reading the work, a request taken back should look exactly like one never
 * made. Studio still has to be able to see it, or the same person cannot tell
 * *nobody has asked* from *I asked and took it back* and will ask twice.
 *
 * So rather than forking the projection — which is the drift Stage A and Stage
 * B were both caught by — the fork is here, in a separate object that carries
 * **no Review content at all**: five states, one Revision number, four
 * booleans. Nothing a client wrote is in this shape, so there is nothing in it
 * to leak, and the client surfaces never construct one.
 *
 * The booleans mirror `lib/db/reviews.ts` and are drawn on rather than trusted:
 * every action re-reads and re-decides under the round's row lock.
 */

export type ReviewLifecycleState =
  /** No round has ever been asked for on this Revision. */
  | "none"
  | "open"
  /** Ended by somebody in the studio, while this Revision was current. */
  | "closed"
  /** Ended by publishing a newer Revision. Terminal, and never reopened. */
  | "superseded"
  /** Asked for and taken back before a word was written. */
  | "withdrawn";

export type ReviewLifecycle = {
  state: ReviewLifecycleState;
  /** The Revision number that ended it. Only ever set for `superseded`. */
  supersededBy: number | null;
  canRequest: boolean;
  canClose: boolean;
  canWithdraw: boolean;
  canReopen: boolean;
};

export type LifecycleFacts = {
  /** Null when no row exists — the row *is* the lifecycle record. */
  status: ReviewStatus | null;
  closedReason: "staff" | "superseded" | null;
  supersededByVersion: number | null;
  /** How many notes the round holds, tombstones included. */
  notes: number;
  /** This Revision is the one the client is reading. */
  current: boolean;
  /** The Presentation is published and unarchived. */
  live: boolean;
};

function stateOf(facts: LifecycleFacts): ReviewLifecycleState {
  if (facts.status === null) return "none";
  if (facts.status === "withdrawn") return "withdrawn";
  if (facts.status === "open") return "open";
  return facts.closedReason === "superseded" ? "superseded" : "closed";
}

export function reviewLifecycle(facts: LifecycleFacts): ReviewLifecycle {
  const state = stateOf(facts);

  // Only the version the client is actually reading may be asked about, and
  // only while there is something published to read. Both are the domain's
  // conditions, restated here so the button is absent rather than refusing.
  const askable = facts.current && facts.live;

  return {
    state,
    supersededBy: state === "superseded" ? facts.supersededByVersion : null,

    // A withdrawn row is re-requested in place — the same row, revived. There
    // is no second round on a Revision, ever.
    canRequest: askable && (state === "none" || state === "withdrawn"),

    canClose: state === "open",

    // **Gone for good once anybody has written.** A removed note still counts:
    // the row exists and the ordinal is spent, so withdrawing would present an
    // untouched round to somebody who had already used it.
    canWithdraw: state === "open" && facts.notes === 0,

    // Reopening is for a round the studio closed. A withdrawal is revived by
    // asking again, which is the word that fits what happened; a supersession
    // is terminal in the domain and in a trigger, and is offered nowhere.
    canReopen: askable && state === "closed",
  };
}
