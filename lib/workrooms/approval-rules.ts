/**
 * The rules of an Approval request, pure (Stage H1).
 *
 * One request asks **named** client members — chosen by Studio for this request
 * and for nothing else — to approve one exact published Revision. Each named
 * approver decides once. The request's own outcome follows from those
 * decisions and from nothing else:
 *
 *   every named approver approved         -> approved
 *   the first approver to ask for changes  -> changes_requested
 *   otherwise                              -> still requested (pending)
 *
 * There is no quorum, no weighting, no sequence, no stage and no conditional
 * approval. A partial approval is not an approval. One request for changes ends
 * the request, and the approvers who had not decided yet never need to. Zero
 * approvers is not a request.
 *
 * The database holds the same agreement — `presentation_approvals_agree` in
 * `drizzle/0008_approvals.sql` — at commit time, so a stored request can never
 * disagree with its approvers. This module is what the domain (H2) will ask
 * before it writes, and what the tests read the database against.
 *
 * No imports: the schema reads its vocabulary from here, and nothing here may
 * depend back.
 */

/**
 * Where a request stands.
 *
 *   requested          waiting on at least one named approver
 *   approved           every named approver approved — terminal
 *   changes_requested  one named approver asked for changes — terminal
 *   withdrawn          Studio took the request back — terminal; the Revision
 *                      may be asked again
 *   superseded         a newer Revision of the Presentation was published —
 *                      terminal
 */
export const APPROVAL_STATUSES = [
  "requested",
  "approved",
  "changes_requested",
  "withdrawn",
  "superseded",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** The four ways a request ends. Each is final. */
export const TERMINAL_APPROVAL_STATUSES = [
  "approved",
  "changes_requested",
  "withdrawn",
  "superseded",
] as const satisfies readonly ApprovalStatus[];
export type TerminalApprovalStatus = (typeof TERMINAL_APPROVAL_STATUSES)[number];

/** What one named approver may say. Once, and never changed or cleared. */
export const APPROVER_DECISIONS = ["approved", "changes_requested"] as const;
export type ApproverDecision = (typeof APPROVER_DECISIONS)[number];

/** A named approver's decision, or `null` while they have not decided. */
export type ApproverState = ApproverDecision | null;

/** The outcome the decisions alone produce. Never `withdrawn` or `superseded`. */
export type DecidedOutcome = "requested" | "approved" | "changes_requested";

export function isApprovalStatus(value: unknown): value is ApprovalStatus {
  return typeof value === "string" && (APPROVAL_STATUSES as readonly string[]).includes(value);
}

export function isApproverDecision(value: unknown): value is ApproverDecision {
  return typeof value === "string" && (APPROVER_DECISIONS as readonly string[]).includes(value);
}

export function isTerminal(status: ApprovalStatus): status is TerminalApprovalStatus {
  return status !== "requested";
}

/**
 * The only transitions there are: `requested` to exactly one terminal status.
 * Nothing leaves a terminal status, and `requested` to itself is not a move.
 */
export function canTransition(from: ApprovalStatus, to: ApprovalStatus): boolean {
  return from === "requested" && isTerminal(to);
}

/** A named approver may decide only while the request is still `requested`. */
export function canDecide(status: ApprovalStatus, current: ApproverState): boolean {
  return status === "requested" && current === null;
}

/**
 * What the request's outcome is, given every named approver's state.
 *
 * Throws on zero approvers: a request nobody was named on is not a request,
 * and answering "approved" for it — every one of nobody agreed — is exactly
 * the vacuous truth an `every()` would hand back.
 */
export function overallApprovalState(approvers: readonly ApproverState[]): DecidedOutcome {
  if (approvers.length === 0) {
    throw new Error("an approval request names at least one approver");
  }
  for (const state of approvers) {
    if (state !== null && !isApproverDecision(state)) {
      throw new Error("an approver's decision is approved, changes_requested or nothing");
    }
  }
  if (approvers.includes("changes_requested")) return "changes_requested";
  if (approvers.every((state) => state === "approved")) return "approved";
  return "requested";
}

/** The approvers who have not decided — and, once the request ends, never will. */
export function pendingCount(approvers: readonly ApproverState[]): number {
  return approvers.filter((state) => state === null).length;
}

/**
 * Whether a stored request agrees with its approvers — the same statement the
 * database makes at commit:
 *
 *   approved            every approver approved
 *   changes_requested   exactly one approver asked for changes, because the
 *                       first one ends the request and nobody decides after it
 *   requested, withdrawn, superseded
 *                       nobody asked for changes and not everybody approved:
 *                       the request was still pending when it ended, and
 *                       whatever partial decisions it held stay as they were
 *
 * Zero approvers never agrees with anything.
 */
export function agreesWithApprovers(status: ApprovalStatus, approvers: readonly ApproverState[]): boolean {
  const total = approvers.length;
  if (total === 0) return false;
  const approved = approvers.filter((state) => state === "approved").length;
  const changes = approvers.filter((state) => state === "changes_requested").length;
  switch (status) {
    case "approved":
      return approved === total;
    case "changes_requested":
      return changes === 1;
    case "requested":
    case "withdrawn":
    case "superseded":
      return changes === 0 && approved < total;
  }
}
