import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  APPROVAL_STATUSES,
  APPROVER_DECISIONS,
  TERMINAL_APPROVAL_STATUSES,
  agreesWithApprovers,
  canDecide,
  canTransition,
  isApprovalStatus,
  isApproverDecision,
  isTerminal,
  overallApprovalState,
  pendingCount,
  type ApprovalStatus,
  type ApproverState,
} from "../lib/workrooms/approval-rules.ts";
import { toClientActivity } from "../lib/workrooms/view.ts";

/**
 * Stage H1's Approval rules, pure: what a request's outcome is from its named
 * approvers' decisions, which moves exist, and whether a stored request agrees
 * with its approvers — the same sentence the database holds at commit.
 */

const A = "approved" as const;
const C = "changes_requested" as const;
const P = null;

/* ------------------------------------------------------- single approver */

test("one approver: pending, approved, changes requested", () => {
  assert.equal(overallApprovalState([P]), "requested");
  assert.equal(overallApprovalState([A]), "approved");
  assert.equal(overallApprovalState([C]), "changes_requested");
});

/* ---------------------------------------------------- several approvers */

test("several approvers, all pending: still requested", () => {
  assert.equal(overallApprovalState([P, P]), "requested");
  assert.equal(overallApprovalState([P, P, P, P]), "requested");
});

test("several approvers, some approved: a partial approval is not an approval", () => {
  assert.equal(overallApprovalState([A, P]), "requested");
  assert.equal(overallApprovalState([P, A]), "requested");
  assert.equal(overallApprovalState([A, A, P]), "requested");
  assert.equal(overallApprovalState([A, P, A, A]), "requested");
});

test("several approvers, all approved: approved", () => {
  assert.equal(overallApprovalState([A, A]), "approved");
  assert.equal(overallApprovalState([A, A, A, A, A]), "approved");
});

test("several approvers, the first asks for changes: changes requested, and the rest never need to decide", () => {
  assert.equal(overallApprovalState([C, P]), "changes_requested");
  assert.equal(overallApprovalState([P, C, P]), "changes_requested");
  assert.equal(pendingCount([P, C, P]), 2);
});

test("changes after some approvals: still changes requested", () => {
  assert.equal(overallApprovalState([A, C]), "changes_requested");
  assert.equal(overallApprovalState([A, A, C]), "changes_requested");
  assert.equal(overallApprovalState([A, C, P]), "changes_requested");
  // Order says nothing: no sequence, no stage.
  for (const order of [[A, C, P], [C, A, P], [P, A, C], [P, C, A]] as ApproverState[][]) {
    assert.equal(overallApprovalState(order), "changes_requested");
  }
});

test("zero approvers is not a request, and is never vacuously approved", () => {
  assert.throws(() => overallApprovalState([]), /at least one approver/);
  for (const status of APPROVAL_STATUSES) assert.equal(agreesWithApprovers(status, []), false);
});

test("no quorum and no weighting: one pending approver among many approvals keeps it requested", () => {
  const many: ApproverState[] = Array.from({ length: 99 }, () => A);
  assert.equal(overallApprovalState([...many, P]), "requested");
  assert.equal(overallApprovalState([...many, C]), "changes_requested");
  assert.equal(overallApprovalState([...many, A]), "approved");
});

test("a value outside the vocabulary is refused, not counted", () => {
  for (const bad of ["granted", "declined", "rejected", "", "Approved", undefined, 0, false]) {
    assert.throws(() => overallApprovalState([A, bad as unknown as ApproverState]), /decision/);
  }
});

/* ------------------------------------------------------------ vocabulary */

test("the vocabulary is exactly H0/H1's", () => {
  assert.deepEqual([...APPROVAL_STATUSES], ["requested", "approved", "changes_requested", "withdrawn", "superseded"]);
  assert.deepEqual([...TERMINAL_APPROVAL_STATUSES], ["approved", "changes_requested", "withdrawn", "superseded"]);
  assert.deepEqual([...APPROVER_DECISIONS], ["approved", "changes_requested"]);
  for (const old of ["granted", "declined", "decided", "open", "closed"]) {
    assert.equal(isApprovalStatus(old), false, old);
    assert.equal(isApproverDecision(old), false, old);
  }
  assert.ok(APPROVAL_STATUSES.every(isApprovalStatus));
  assert.ok(APPROVER_DECISIONS.every(isApproverDecision));
  assert.equal(isApproverDecision("withdrawn"), false, "an approver does not withdraw");
  assert.equal(isApproverDecision("superseded"), false, "an approver does not supersede");
});

/* ----------------------------------------------------------- transitions */

test("requested moves to exactly one terminal status, and nothing leaves a terminal status", () => {
  for (const from of APPROVAL_STATUSES) {
    for (const to of APPROVAL_STATUSES) {
      const expected = from === "requested" && to !== "requested";
      assert.equal(canTransition(from, to), expected, `${from} -> ${to}`);
    }
  }
  assert.deepEqual(APPROVAL_STATUSES.filter((s) => !isTerminal(s)), ["requested"]);
});

test("an approver decides once, and only while the request is requested", () => {
  assert.equal(canDecide("requested", null), true);
  for (const decided of APPROVER_DECISIONS) assert.equal(canDecide("requested", decided), false);
  for (const status of TERMINAL_APPROVAL_STATUSES) assert.equal(canDecide(status, null), false, status);
});

/* ------------------------------------------------------------ agreement */

test("a stored request agrees with its approvers exactly when the database says it does", () => {
  const cases: Array<[ApprovalStatus, ApproverState[], boolean]> = [
    ["requested", [P], true],
    ["requested", [A, P], true],
    ["requested", [A], false], // everybody approved: it is approved
    ["requested", [C, P], false], // somebody asked for changes: it ended
    ["approved", [A], true],
    ["approved", [A, A, A], true],
    ["approved", [A, P], false],
    ["approved", [A, C], false],
    ["approved", [P], false],
    ["changes_requested", [C], true],
    ["changes_requested", [A, C, P], true],
    ["changes_requested", [C, C], false], // the first one ends it
    ["changes_requested", [A, A], false],
    ["changes_requested", [P], false],
    ["withdrawn", [P], true],
    ["withdrawn", [A, P], true], // partial decisions stay as history
    ["withdrawn", [A], false],
    ["withdrawn", [C], false],
    ["superseded", [P, P], true],
    ["superseded", [A, P], true],
    ["superseded", [A, A], false],
    ["superseded", [C, P], false],
  ];
  for (const [status, approvers, expected] of cases) {
    assert.equal(agreesWithApprovers(status, approvers), expected, `${status} ${JSON.stringify(approvers)}`);
  }
});

test("the outcome the decisions produce always agrees with itself", () => {
  // Every combination of up to four approvers.
  const states: ApproverState[] = [P, A, C];
  const all: ApproverState[][] = [];
  const grow = (prefix: ApproverState[]) => {
    if (prefix.length) all.push(prefix);
    if (prefix.length < 4) for (const s of states) grow([...prefix, s]);
  };
  grow([]);
  for (const approvers of all) {
    const outcome = overallApprovalState(approvers);
    const changes = approvers.filter((s) => s === C).length;
    // More than one request for changes cannot be reached: the first ends it.
    assert.equal(agreesWithApprovers(outcome, approvers), changes <= 1, JSON.stringify(approvers));
  }
});

/* ------------------------------------------------------------- Activity */

test("Activity says who approved and who asked for changes, in a sentence", () => {
  const rows = [
    { kind: "approval.requested", actorLabel: null, subject: "Brand Direction" },
    { kind: "approval.approved", actorLabel: "Ana Alder", subject: "Brand Direction" },
    { kind: "approval.changes_requested", actorLabel: "Ana Alder", subject: "Brand Direction" },
    { kind: "approval.approved", actorLabel: null, subject: null },
    { kind: "approval.approved", actorLabel: null, subject: "Brand Direction, Version 3" },
  ].map((row, i) => ({ id: `r${i}`, occurredAt: new Date("2026-11-03T12:00:00Z"), ...row })) as Parameters<
    typeof toClientActivity
  >[0];
  assert.deepEqual(
    toClientActivity(rows).map((item) => item.text),
    [
      "Approval was requested for Brand Direction",
      "Ana Alder approved Brand Direction",
      "Ana Alder asked for changes to Brand Direction",
      "A presentation was approved",
      "Brand Direction, Version 3 was approved",
    ],
  );
});

test("nothing in the product depends on approval.decided", () => {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx|mjs|js|css)$/.test(entry) && readFileSync(path, "utf8").includes("approval.decided")) hits.push(path);
    }
  };
  for (const dir of ["app", "components", "lib", "scripts"]) walk(dir);
  assert.deepEqual(hits, []);
});
