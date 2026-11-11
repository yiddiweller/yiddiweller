import assert from "node:assert/strict";
import { test } from "node:test";

import { approvalLifecycle, type LifecycleApprover, type LifecycleFacts } from "../lib/workrooms/approval-lifecycle.ts";
import {
  approvalCapabilities,
  toClientApproval,
  versionSubject,
  SUBJECT_MAX,
  type ApprovalFacts,
  type DecideFacts,
} from "../lib/workrooms/approval-view.ts";

/**
 * Stage H2's pure Approval projections: the client's view, the capability
 * sidecar, Studio's lifecycle and the Activity subject. No database — the
 * domain hands facts in, these decide what is shown and what may be pressed.
 */

const AT = new Date("2026-11-12T15:00:00Z");

function facts(over: Partial<ApprovalFacts> = {}): ApprovalFacts {
  return {
    status: "requested",
    version: 3,
    requestedAt: AT,
    closedAt: null,
    supersededByVersion: null,
    approvers: [
      { name: "Sarah", decision: null, decidedAt: null, isViewer: true },
      { name: "Ana", decision: "approved", decidedAt: AT, isViewer: false },
    ],
    ...over,
  };
}

/* ----------------------------------------------------------- client view */

test("the client view names a version and people, and nothing else", () => {
  const view = toClientApproval(facts())!;
  assert.equal(view.state, "awaiting");
  assert.equal(view.version, 3);
  assert.deepEqual(view.approvers.map((a) => a.name), ["Ana", "Sarah"], "names are in a stable order");
  assert.deepEqual(view.you, { named: true, decided: false });
  assert.deepEqual(Object.keys(view).sort(), ["approvers", "closedAt", "requestedAt", "state", "supersededBy", "version", "you"]);
  for (const a of view.approvers) assert.deepEqual(Object.keys(a).sort(), ["decidedAt", "decision", "name"]);
});

test("each status reads as its client state", () => {
  assert.equal(toClientApproval(facts({ status: "approved", closedAt: AT }))!.state, "approved");
  assert.equal(toClientApproval(facts({ status: "changes_requested", closedAt: AT }))!.state, "changes_requested");
  const superseded = toClientApproval(facts({ status: "superseded", closedAt: AT, supersededByVersion: 4 }))!;
  assert.equal(superseded.state, "superseded");
  assert.equal(superseded.supersededBy, 4);
  // supersededBy is only ever set for a supersession
  assert.equal(toClientApproval(facts({ status: "approved", supersededByVersion: 9 }))!.supersededBy, null);
});

test("a withdrawn request nobody answered is absent; one somebody answered is history", () => {
  const unanswered = facts({
    status: "withdrawn",
    approvers: [{ name: "Sarah", decision: null, decidedAt: null, isViewer: true }],
  });
  assert.equal(toClientApproval(unanswered), null);
  const answered = toClientApproval(facts({ status: "withdrawn", closedAt: AT }))!;
  assert.equal(answered.state, "withdrawn");
  assert.equal(answered.approvers.find((a) => a.name === "Ana")!.decision, "approved");
});

test("you: named or not, decided or not", () => {
  assert.deepEqual(
    toClientApproval(facts({ approvers: [{ name: "Ana", decision: null, decidedAt: null, isViewer: false }] }))!.you,
    { named: false, decided: false },
  );
  assert.deepEqual(
    toClientApproval(facts({ approvers: [{ name: "Ana", decision: "approved", decidedAt: AT, isViewer: true }] }))!.you,
    { named: true, decided: true },
  );
});

/* ------------------------------------------------------------ capability */

test("canDecide needs every condition at once", () => {
  const all: DecideFacts = { status: "requested", pendingForViewer: true, current: true, live: true, eligible: true };
  assert.equal(approvalCapabilities(all).canDecide, true);
  for (const key of ["pendingForViewer", "current", "live", "eligible"] as const) {
    assert.equal(approvalCapabilities({ ...all, [key]: false }).canDecide, false, key);
  }
  for (const status of ["approved", "changes_requested", "withdrawn", "superseded"] as const) {
    assert.equal(approvalCapabilities({ ...all, status }).canDecide, false, status);
  }
  assert.deepEqual(Object.keys(approvalCapabilities(all)), ["canDecide"]);
});

/* -------------------------------------------------------------- lifecycle */

const person = (name: string, decision: LifecycleApprover["decision"], eligible = true): LifecycleApprover => ({
  name,
  decision,
  decidedAt: decision ? AT : null,
  eligible,
});

function lifecycle(over: Partial<LifecycleFacts> = {}) {
  return approvalLifecycle({
    status: "requested",
    supersededByVersion: null,
    approvers: [person("Ana", null), person("Ben", null)],
    withdrawnBefore: 0,
    current: true,
    live: true,
    anyEligible: true,
    ...over,
  });
}

test("Studio's lifecycle: every state, with progress", () => {
  assert.equal(lifecycle({ status: null, approvers: [] }).state, "none");
  const waiting = lifecycle();
  assert.equal(waiting.state, "awaiting");
  assert.equal(waiting.partial, false);
  assert.deepEqual(waiting.progress, { approved: 0, changesRequested: 0, pending: 2, total: 2 });
  const partial = lifecycle({ approvers: [person("Ana", "approved"), person("Ben", null)] });
  assert.equal(partial.partial, true);
  assert.deepEqual(partial.progress, { approved: 1, changesRequested: 0, pending: 1, total: 2 });
  assert.equal(lifecycle({ status: "approved", approvers: [person("Ana", "approved")] }).state, "approved");
  assert.equal(lifecycle({ status: "changes_requested", approvers: [person("Ana", "changes_requested")] }).state, "changes_requested");
  assert.equal(lifecycle({ status: "withdrawn" }).state, "withdrawn");
  const superseded = lifecycle({ status: "superseded", supersededByVersion: 5 });
  assert.equal(superseded.state, "superseded");
  assert.equal(superseded.supersededBy, 5);
  assert.equal(lifecycle({ status: "approved", supersededByVersion: 5 }).supersededBy, null);
});

test("canAsk: current, live, somebody eligible, and nothing standing", () => {
  assert.equal(lifecycle({ status: null }).canAsk, true);
  assert.equal(lifecycle({ status: "withdrawn" }).canAsk, true);
  for (const status of ["requested", "approved", "changes_requested", "superseded"] as const) {
    assert.equal(lifecycle({ status }).canAsk, false, status);
  }
  assert.equal(lifecycle({ status: null, current: false }).canAsk, false);
  assert.equal(lifecycle({ status: null, live: false }).canAsk, false);
  assert.equal(lifecycle({ status: null, anyEligible: false }).canAsk, false);
});

test("canWithdraw only while awaiting", () => {
  assert.equal(lifecycle().canWithdraw, true);
  for (const status of [null, "approved", "changes_requested", "withdrawn", "superseded"] as const) {
    assert.equal(lifecycle({ status }).canWithdraw, false, String(status));
  }
});

test("a pending approver who lost access is reported, and never removed", () => {
  const view = lifecycle({ approvers: [person("Ana", "approved", false), person("Ben", null, false), person("Cy", null)] });
  assert.deepEqual(view.lostAccess, ["Ben"], "only pending approvers matter; a made decision stands");
  assert.equal(view.approvers.length, 3);
  assert.equal(view.state, "awaiting");
  assert.deepEqual(lifecycle({ status: "approved", approvers: [person("Ben", "approved", false)] }).lostAccess, []);
});

/* ------------------------------------------------------- activity subject */

test("the Activity subject always names the version, and fits its column", () => {
  assert.equal(versionSubject("Brand Direction", 3), "Brand Direction, Version 3");
  const long = versionSubject("x".repeat(200), 12);
  assert.ok(long.length <= SUBJECT_MAX);
  assert.ok(long.endsWith(", Version 12"));
  assert.ok(long.includes("…"));
  const exact = "y".repeat(SUBJECT_MAX - ", Version 1".length);
  assert.equal(versionSubject(exact, 1), `${exact}, Version 1`);
});
