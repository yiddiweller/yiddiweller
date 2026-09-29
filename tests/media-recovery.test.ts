import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  initialRecovery,
  MEDIA_ERR_NETWORK,
  qualifies,
  recover,
  refreshSource,
  restoreSeek,
  windowOpen,
  type MediaFailure,
  type RecoveryEvent,
  type RecoveryState,
  type Step,
} from "../lib/workrooms/media-recovery.ts";

/**
 * Stage F6.1: recovering a player from an expired signed URL, as data. Every
 * transition, with the clock handed in — nothing waits.
 */

const MINUTE = 60_000;
const WINDOW = 15 * MINUTE;
const T0 = 1_000_000;

const network: MediaFailure = { code: MEDIA_ERR_NETWORK, hadMetadata: true };
const error = (at: number, now: number, failure: MediaFailure = network): RecoveryEvent => ({ type: "error", failure, at, now });

/** Runs events in order from a state, returning every step. */
function run(from: RecoveryState, events: RecoveryEvent[]): Step[] {
  const steps: Step[] = [];
  let state = from;
  for (const event of events) {
    const step = recover(state, event, WINDOW);
    steps.push(step);
    state = step.state;
  }
  return steps;
}

test("A. a player starts ready, with no refresh behind it", () => {
  assert.deepEqual(initialRecovery, { phase: "ready", lastRefreshAt: null });
  assert.equal(MEDIA_ERR_NETWORK, 2, "MediaError.MEDIA_ERR_NETWORK");
});

test("B. a network failure after metadata permits one refresh, resuming where it was", () => {
  const step = recover(initialRecovery, error(42.5, T0), WINDOW);
  assert.deepEqual(step.action, { type: "refresh" });
  assert.deepEqual(step.state, { phase: "refreshing", resumeAt: 42.5, lastRefreshAt: T0 });
});

test("C. a failure before metadata is never retried", () => {
  for (const code of [MEDIA_ERR_NETWORK, 4, 3, 1, null]) {
    const step = recover(initialRecovery, error(0, T0, { code, hadMetadata: false }), WINDOW);
    assert.deepEqual(step.action, { type: "give_up", reason: "not_recoverable" }, `code ${code}`);
    assert.equal(step.state.phase, "failed");
  }
});

test("D. an error that is not a network failure is never retried, however loaded", () => {
  for (const code of [1, 3, 4, null, 0, 99]) {
    const step = recover(initialRecovery, error(10, T0, { code, hadMetadata: true }), WINDOW);
    assert.deepEqual(step.action, { type: "give_up", reason: "not_recoverable" }, `code ${code}`);
  }
  assert.equal(qualifies({ code: 2, hadMetadata: true }), true);
  assert.equal(qualifies({ code: 2, hadMetadata: false }), false);
  assert.equal(qualifies({ code: 4, hadMetadata: true }), false);
});

test("E. a refresh that loads is restored, then ready — the window it opened still open", () => {
  const steps = run(initialRecovery, [error(42.5, T0), { type: "metadata" }, { type: "restored" }]);
  assert.deepEqual(steps.map((s) => s.state.phase), ["refreshing", "restoring", "ready"]);
  assert.deepEqual(steps[1]!.action, { type: "restore", seek: 42.5, playback: "paused" });
  assert.deepEqual(steps[2]!.state, { phase: "ready", lastRefreshAt: T0 });
  assert.deepEqual(steps[2]!.action, { type: "none" });
});

test("F. recovery always ends paused: a restore cannot say anything else", () => {
  // Whatever was happening before — playing at double speed, or paused —
  // the only restore there is seeks and leaves it paused.
  for (const at of [0, 0.001, 42.5, 3600, 90_000]) {
    const steps = run(initialRecovery, [error(at, T0), { type: "metadata" }]);
    const action = steps[1]!.action;
    assert.equal(action.type, "restore");
    assert.deepEqual(Object.keys(action).sort(), ["playback", "seek", "type"]);
    assert.equal(action.type === "restore" && action.playback, "paused");
  }
  // And the source says no one may play: nothing here names play().
  const source = readFileSync("lib/workrooms/media-recovery.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(source, /play\(|"playing"|playback: "play/);
});

test("G. a refresh that fails, or a restore that fails, stops for good", () => {
  for (const tail of [
    [error(0, T0 + 1000, { code: 4, hadMetadata: false })],
    [error(0, T0 + 1000)],
    [{ type: "timeout" } as RecoveryEvent],
    [{ type: "metadata" } as RecoveryEvent, error(10, T0 + 2000)],
    [{ type: "metadata" } as RecoveryEvent, { type: "timeout" } as RecoveryEvent],
  ]) {
    const steps = run(initialRecovery, [error(10, T0), ...tail]);
    const last = steps[steps.length - 1]!;
    assert.deepEqual(last.action, { type: "give_up", reason: "refresh_failed" });
    assert.equal(last.state.phase, "failed");

    // And nothing automatic moves it again — not errors, not metadata, not
    // the window closing.
    for (const event of [error(10, T0 + WINDOW * 3), { type: "metadata" }, { type: "restored" }, { type: "timeout" }] as RecoveryEvent[]) {
      const after = recover(last.state, event, WINDOW);
      assert.equal(after.state.phase, "failed", event.type);
      assert.deepEqual(after.action, { type: "none" }, event.type);
    }
  }
});

test("H. a second network failure inside the window is not expiry: no second refresh", () => {
  const recovered = run(initialRecovery, [error(10, T0), { type: "metadata" }, { type: "restored" }]).at(-1)!.state;
  for (const later of [1, MINUTE, 5 * MINUTE, WINDOW - 1]) {
    const step = recover(recovered, error(20, T0 + later), WINDOW);
    assert.deepEqual(step.action, { type: "give_up", reason: "window" }, `${later}ms later`);
  }
});

test("I. once the window has closed, a new failure is a new episode and may be recovered once", () => {
  const recovered = run(initialRecovery, [error(10, T0), { type: "metadata" }, { type: "restored" }]).at(-1)!.state;
  const again = recover(recovered, error(30, T0 + WINDOW), WINDOW);
  assert.deepEqual(again.action, { type: "refresh" });
  assert.deepEqual(again.state, { phase: "refreshing", resumeAt: 30, lastRefreshAt: T0 + WINDOW });
  assert.equal(windowOpen(null, 0, WINDOW), true);
  assert.equal(windowOpen(T0, T0 + WINDOW - 1, WINDOW), false);
  assert.equal(windowOpen(T0, T0 + WINDOW, WINDOW), true);
});

test("J. a person's Try again restarts from failed, whatever the window says, and still ends paused", () => {
  const failed = run(initialRecovery, [error(10, T0), { type: "timeout" }]).at(-1)!.state;
  const retry = recover(failed, { type: "retry", at: 12, now: T0 + 1000 }, WINDOW);
  assert.deepEqual(retry.action, { type: "refresh" });
  assert.deepEqual(retry.state, { phase: "refreshing", resumeAt: 12, lastRefreshAt: T0 + 1000 });
  const restored = recover(retry.state, { type: "metadata" }, WINDOW);
  assert.deepEqual(restored.action, { type: "restore", seek: 12, playback: "paused" });

  // A retry anywhere but failed does nothing: it is not a second way in.
  for (const state of [initialRecovery, retry.state, restored.state]) {
    assert.deepEqual(recover(state, { type: "retry", at: 0, now: T0 }, WINDOW).action, { type: "none" });
  }
  // A time that cannot be sought resumes from the start, never NaN.
  for (const at of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
    const step = recover(initialRecovery, error(at, T0), WINDOW);
    assert.equal(step.state.phase === "refreshing" && step.state.resumeAt, 0, String(at));
  }
});

test("K. nothing in any state is a URL, a credential, a person or a Review", () => {
  const states: RecoveryState[] = [initialRecovery];
  for (const events of [
    [error(10, T0), { type: "metadata" }, { type: "restored" }, error(20, T0 + WINDOW)],
    [error(10, T0, { code: 4, hadMetadata: false })],
    [error(10, T0), { type: "timeout" }, { type: "retry", at: 3, now: T0 + 5 }],
  ] as RecoveryEvent[][]) {
    for (const step of run(initialRecovery, events)) states.push(step.state);
  }
  for (const state of states) {
    assert.ok(Object.keys(state).every((key) => ["phase", "lastRefreshAt", "resumeAt", "reason"].includes(key)), JSON.stringify(state));
    for (const value of Object.values(state)) {
      assert.ok(typeof value === "number" || value === null || /^[a-z_]+$/.test(String(value)), JSON.stringify(state));
    }
    assert.doesNotMatch(JSON.stringify(state), /http|X-Amz|Signature|@|anchor|kind|note/i);
  }

  const source = readFileSync("lib/workrooms/media-recovery.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(source, /^import /m, "the rules import something");
  assert.doesNotMatch(source, /document|window\.|HTMLMediaElement|fetch\(|useState|process\.env/);
});

/* ------------------------------------------------ F6.2: the player's side */

test("a refresh is our own route with a refresh marker — never anything else", () => {
  const view = "/workrooms/w1/files/f1/view";
  assert.equal(refreshSource(view, 0), view, "generation 0 is the path exactly as given");
  assert.equal(refreshSource(view, 1), `${view}?refresh=1`);
  assert.equal(refreshSource(view, 2), `${view}?refresh=2`);
  // A query it already had is kept, and a stale marker is replaced, not repeated.
  assert.equal(refreshSource(`${view}?a=b`, 3), `${view}?a=b&refresh=3`);
  assert.equal(refreshSource(`${view}?refresh=1`, 2), `${view}?refresh=2`);
  assert.equal(refreshSource(`${view}#t`, 1), `${view}?refresh=1#t`);
  for (const generation of [-1, 0.5, Number.NaN]) assert.equal(refreshSource(view, generation), view);
  // It is always the path it was given: nothing it builds leaves our origin.
  assert.ok(refreshSource(view, 9).startsWith(view));
});

test("the time is put back where the file has it; a time past the end is declined, not clamped", () => {
  assert.equal(restoreSeek(42.5, 600), 42.5);
  assert.equal(restoreSeek(600, 600), 600);
  assert.equal(restoreSeek(42.5, Number.NaN), 42.5, "an unknown duration is no reason to refuse");
  assert.equal(restoreSeek(42.5, Number.POSITIVE_INFINITY), 42.5);
  assert.equal(restoreSeek(601, 600), null);
  assert.equal(restoreSeek(Number.NaN, 600), 0);
  assert.equal(restoreSeek(-3, 600), 0);
});
