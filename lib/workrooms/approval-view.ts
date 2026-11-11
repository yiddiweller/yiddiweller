import { type ApprovalStatus, type ApproverDecision, type ApproverState } from "./approval-rules.ts";

/**
 * The only shape of an Approval that reaches a client surface (Stage H2).
 *
 * **A whitelist, never a filter.** Everything a client may learn about an
 * approval request is named in `ClientApproval`, and nothing else is ever
 * built: no request id, no Revision id, no Workroom id, no identity or user id,
 * no content hash, no closing user, no closing Revision id. A version is named
 * by its public number, a person by the name they were asked under. The same
 * discipline as `review-view.ts`, for the same reason — a field that is never
 * constructed cannot be serialized into a flight payload by accident.
 *
 * Pure: the domain (`lib/db/approvals.ts`) reads the rows and hands facts in;
 * nothing here touches the database.
 */

/** How the request stands, in the client's vocabulary. */
export type ClientApprovalState =
  | "awaiting"
  | "approved"
  | "changes_requested"
  /** Closed when a newer version was published, before everybody decided. */
  | "superseded"
  /** Taken back by the studio after somebody had already decided. */
  | "withdrawn";

export type ClientApprover = {
  /** The name they were asked under, as it was then. */
  name: string;
  decision: ApproverDecision | null;
  decidedAt: Date | null;
};

export type ClientApproval = {
  state: ClientApprovalState;
  /** The Revision's public number — the version that was asked about. */
  version: number;
  requestedAt: Date;
  closedAt: Date | null;
  /** The newer version whose publication closed it. Only for `superseded`. */
  supersededBy: number | null;
  /** Everybody asked, in a stable order. */
  approvers: ClientApprover[];
  /** About the person reading — a fact about them, never an identifier. */
  you: { named: boolean; decided: boolean };
};

/**
 * What the reader may press. **A sidecar, not part of the content** — booleans
 * only, decided on the server from the same rows, and guidance rather than
 * security: `decideApproval` re-checks every condition under the request's row
 * lock and refuses whatever this would have hidden.
 */
export type ApprovalCapabilities = { canDecide: boolean };

export const NO_APPROVAL_CAPABILITIES: ApprovalCapabilities = { canDecide: false };

/** One named approver, as the domain read them. Ids stop at the domain. */
export type ApproverFacts = {
  name: string;
  decision: ApproverState;
  decidedAt: Date | null;
  /** This approver is the person reading. Settled in the domain. */
  isViewer: boolean;
};

export type ApprovalFacts = {
  status: ApprovalStatus;
  version: number;
  requestedAt: Date;
  closedAt: Date | null;
  supersededByVersion: number | null;
  approvers: ApproverFacts[];
};

/** Names first, so the order is the same on every read and in both worlds. */
function ordered(approvers: ApproverFacts[]): ApproverFacts[] {
  return [...approvers].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The client's view of one request, or null when there is nothing to show.
 *
 * **A withdrawn request nobody had answered is null** — to anybody reading the
 * work, a request taken back before a word was said looks exactly like one
 * never made (H1 decision 3). A withdrawn request somebody *had* answered stays
 * visible, because a submitted decision is immutable history and never erased.
 */
export function toClientApproval(facts: ApprovalFacts): ClientApproval | null {
  const decided = facts.approvers.filter((a) => a.decision !== null).length;
  if (facts.status === "withdrawn" && decided === 0) return null;

  const viewer = facts.approvers.find((a) => a.isViewer);

  return {
    state: facts.status === "requested" ? "awaiting" : facts.status,
    version: facts.version,
    requestedAt: facts.requestedAt,
    closedAt: facts.closedAt,
    supersededBy: facts.status === "superseded" ? facts.supersededByVersion : null,
    approvers: ordered(facts.approvers).map((a) => ({
      name: a.name,
      decision: a.decision,
      decidedAt: a.decidedAt,
    })),
    you: { named: Boolean(viewer), decided: Boolean(viewer && viewer.decision !== null) },
  };
}

/** What has to be true, right now, for the reader to decide. */
export type DecideFacts = {
  status: ApprovalStatus;
  /** The reader is named on this request and has not decided. */
  pendingForViewer: boolean;
  /** The request's Revision is still its Presentation's current one. */
  current: boolean;
  /** Workroom and Presentation published and unarchived. */
  live: boolean;
  /** The reader's sign-in, contact and membership all still stand. */
  eligible: boolean;
};

/** Every condition `decideApproval` checks, restated so the control is absent. */
export function approvalCapabilities(facts: DecideFacts): ApprovalCapabilities {
  return {
    canDecide:
      facts.status === "requested" && facts.pendingForViewer && facts.current && facts.live && facts.eligible,
  };
}

/* ------------------------------------------------------------- Activity */

/** `workroom_activity.subject` holds at most this many characters. */
export const SUBJECT_MAX = 160;

/**
 * "Brand Direction, Version 3" — the subject every approval Activity row
 * carries, so the timeline always says which version. A title too long for the
 * column is shortened, never the version: the number is the part that matters.
 */
export function versionSubject(title: string, version: number): string {
  const suffix = `, Version ${version}`;
  if (title.length + suffix.length <= SUBJECT_MAX) return `${title}${suffix}`;
  return `${title.slice(0, SUBJECT_MAX - suffix.length - 1).trimEnd()}…${suffix}`;
}
