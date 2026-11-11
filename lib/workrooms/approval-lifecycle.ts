import { type ApprovalStatus, type ApproverState } from "./approval-rules.ts";

/**
 * An approval request's administration — **Studio's alone** (Stage H2).
 *
 * `ClientApproval` answers what the client may see; this answers what state the
 * studio's request is in, including the two things a client never sees: a
 * request withdrawn before anybody answered, and a named approver who has since
 * lost access and can no longer decide. The same split as `review-lifecycle.ts`.
 *
 * Pure. Its booleans are drawn on rather than trusted: every action re-reads
 * and re-decides under the request's row lock.
 */

export type ApprovalLifecycleState =
  /** No request has been made on this Revision. */
  | "none"
  /** Waiting on at least one named approver. `progress` says how far along. */
  | "awaiting"
  | "approved"
  | "changes_requested"
  /** Taken back by the studio. The Revision may be asked again. */
  | "withdrawn"
  /** Closed when a newer Revision was published. */
  | "superseded";

export type LifecycleApprover = {
  name: string;
  decision: ApproverState;
  decidedAt: Date | null;
  /**
   * Still able to decide: active sign-in, unarchived contact, active access to
   * the Workroom. Only meaningful while they have not decided — a decision once
   * made stands whatever happens to their access afterwards.
   */
  eligible: boolean;
};

export type ApprovalLifecycle = {
  state: ApprovalLifecycleState;
  supersededBy: number | null;
  progress: { approved: number; changesRequested: number; pending: number; total: number };
  /** True while awaiting with at least one approval already in. */
  partial: boolean;
  approvers: LifecycleApprover[];
  /**
   * Pending approvers who can no longer decide. The request stays as it is —
   * nobody is removed, nothing is approved around them — until the studio
   * withdraws it and asks again.
   */
  lostAccess: string[];
  /** Earlier requests on this Revision that were withdrawn. */
  withdrawnBefore: number;
  canAsk: boolean;
  canWithdraw: boolean;
};

export type LifecycleFacts = {
  /** The latest request on this Revision, or null when there has never been one. */
  status: ApprovalStatus | null;
  supersededByVersion: number | null;
  approvers: LifecycleApprover[];
  withdrawnBefore: number;
  /** This Revision is the Presentation's current one. */
  current: boolean;
  /** The Workroom and the Presentation are published and unarchived. */
  live: boolean;
  /** At least one client member could be asked right now. */
  anyEligible: boolean;
};

export function approvalLifecycle(facts: LifecycleFacts): ApprovalLifecycle {
  const state: ApprovalLifecycleState =
    facts.status === null ? "none" : facts.status === "requested" ? "awaiting" : facts.status;

  const approvers = [...facts.approvers].sort((a, b) => a.name.localeCompare(b.name));
  const approved = approvers.filter((a) => a.decision === "approved").length;
  const changesRequested = approvers.filter((a) => a.decision === "changes_requested").length;
  const pending = approvers.filter((a) => a.decision === null).length;

  return {
    state,
    supersededBy: state === "superseded" ? facts.supersededByVersion : null,
    progress: { approved, changesRequested, pending, total: approvers.length },
    partial: state === "awaiting" && approved > 0,
    approvers,
    lostAccess: state === "awaiting" ? approvers.filter((a) => a.decision === null && !a.eligible).map((a) => a.name) : [],
    withdrawnBefore: facts.withdrawnBefore,
    // Asked only about the version the client is reading, only while it is
    // published, only when nothing stands on it — and only when somebody could
    // be named. The domain enforces each; this keeps the button honest.
    canAsk: facts.current && facts.live && facts.anyEligible && (state === "none" || state === "withdrawn"),
    canWithdraw: state === "awaiting",
  };
}
