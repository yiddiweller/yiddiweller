import type { ViewerKind } from "../storage/policy.ts";
import { roundSeconds } from "./anchor-geometry.ts";
import { momentLabel, rangeLabel } from "./anchor-label.ts";
import type { PointCandidate } from "./point-capture.ts";
import type { ReviewAnchor } from "./review-anchor.ts";

/**
 * Choosing a moment or a stretch in something that plays — a recording or a
 * video — decided without a browser.
 *
 * The native player is how somebody gets to the place they mean; these rules
 * only read where it is. Nothing here draws, plays or seeks. `ReviewStage`
 * renders the panel and hands each press to the functions below, so the whole
 * of what a press can produce is tested as data: a moment inside the file, a
 * stretch that ends after it starts, or nothing.
 *
 * **One set of rules for audio and video (F3, then F4.1).** A time is media
 * time in seconds, rounded to the millisecond — never a frame number, and
 * nothing here claims to know which frame a video shows at it.
 */

/** The two shapes capture can make — the time anchors F1 accepts for both. */
export type TimeCandidate = { kind: "time"; t: number } | { kind: "time"; t: number; t2: number };

/**
 * The viewers a precise time is chosen in: the two that play. Never `download`
 * — a file frozen as one has no player to read, whatever it is now — and never
 * an image or a PDF, which have no time.
 */
const TIMED: readonly ViewerKind[] = ["audio", "video"];

/**
 * Whether an item of this **frozen** viewer takes a precise time. Called with
 * the viewer a Revision's snapshot recorded, and nothing else: not the
 * filename, not the live file row, not the Files policy as it reads today.
 */
export function takesTime(viewer: ViewerKind | null): boolean {
  return viewer !== null && TIMED.includes(viewer);
}

/**
 * Whether a subject in the composer takes a precise time.
 *
 * Read from the subject the page built out of the Revision's **frozen**
 * snapshot — its viewer, as it was published — so a file changed since, or a
 * draft reordered since, cannot make a block take precision it did not have.
 */
export function capturesTime(subject: { capture?: "time" | "point" } | undefined): boolean {
  return subject?.capture === "time";
}

/**
 * Whether stretches are offered at all.
 *
 * A stretch against a phone's native player is two careful presses on coarse
 * controls; if real-phone acceptance finds it unusable, phones get moments
 * only — by setting this to false — rather than a custom timeline to rescue
 * it. It is offered everywhere until a person has tried it.
 */
export const RANGES_ON_COARSE_POINTERS = true;

export function rangesOffered(coarsePointer: boolean): boolean {
  return !coarsePointer || RANGES_ON_COARSE_POINTERS;
}

/**
 * The player's position as something that may be stored — or null.
 *
 * Null until the file reports a finite, positive duration: before that there
 * is no way to know a moment is inside it. Rounded by F1's rule, to the
 * millisecond, and never rounded past the end. There is no other ceiling.
 */
export function captureTime(current: number, duration: number): number | null {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  if (!Number.isFinite(current) || current < 0 || current > duration) return null;
  const rounded = roundSeconds(current);
  return rounded <= duration ? rounded : Math.floor(duration * 1000) / 1000;
}

/** Why a press did not make a candidate, said calmly beside the controls. */
export type CaptureNotice = "not_ready" | "no_start" | "end_before_start";

export function noticeText(notice: CaptureNotice): string {
  switch (notice) {
    case "not_ready":
      return "Available once the file has loaded — press play if it has not.";
    case "no_start":
      return "Choose where it starts first.";
    case "end_before_start":
      return "Choose an end after the start.";
  }
}

/**
 * One capture session. `candidate` is what Done would keep; `start` is a
 * stretch's first end while the second has not been chosen.
 */
export type CaptureState = {
  candidate: TimeCandidate | null;
  start: number | null;
  notice: CaptureNotice | null;
};

/**
 * A session opened on whatever the draft already holds, so *Change* starts
 * from the choice being changed and Done without a press keeps it.
 */
export function beginCapture(initial: ReviewAnchor | null): CaptureState {
  if (!initial || initial.kind !== "time" || "region" in initial) {
    return { candidate: null, start: null, notice: null };
  }
  return {
    candidate: "t2" in initial ? { kind: "time", t: initial.t, t2: initial.t2 } : { kind: "time", t: initial.t },
    start: "t2" in initial ? initial.t : null,
    notice: null,
  };
}

/** *Use this moment*. */
export function takeMoment(state: CaptureState, current: number, duration: number): CaptureState {
  const t = captureTime(current, duration);
  if (t === null) return { ...state, notice: "not_ready" };
  return { candidate: { kind: "time", t }, start: null, notice: null };
}

/**
 * *Start here*. Sets or resets the start. A stretch already chosen keeps its
 * end if that end is still after the new start; otherwise the stretch waits
 * for a new end. A moment chosen earlier is set aside — this is a stretch now.
 */
export function takeStart(state: CaptureState, current: number, duration: number): CaptureState {
  const t = captureTime(current, duration);
  if (t === null) return { ...state, notice: "not_ready" };

  const end = state.candidate && "t2" in state.candidate ? state.candidate.t2 : null;
  return {
    candidate: end !== null && end > t ? { kind: "time", t, t2: end } : null,
    start: t,
    notice: null,
  };
}

/**
 * *End here*. Needs a start, and an end after it. An end at or before the
 * start is **refused, never swapped** — the start stays, anything already
 * complete stays, and the person moves the player and presses again.
 */
export function takeEnd(state: CaptureState, current: number, duration: number): CaptureState {
  const t = captureTime(current, duration);
  if (t === null) return { ...state, notice: "not_ready" };
  if (state.start === null) return { ...state, notice: "no_start" };
  if (t <= state.start) return { ...state, notice: "end_before_start" };
  return { candidate: { kind: "time", t: state.start, t2: t }, start: state.start, notice: null };
}

/** The candidate in words — *At 0:42*, *0:42–0:51* — never a raw number. */
export function candidateLabel(candidate: TimeCandidate | ReviewAnchor | null): string | null {
  if (!candidate || candidate.kind !== "time") return null;
  return "t2" in candidate ? rangeLabel(candidate.t, candidate.t2) : momentLabel(candidate.t);
}

/** What the panel says it holds, including a stretch that is half chosen. */
export function captureSummary(state: CaptureState): string {
  const chosen = candidateLabel(state.candidate);
  if (chosen) return chosen;
  if (state.start !== null) return `Starts ${momentLabel(state.start)?.toLowerCase() ?? ""} — now choose where it ends.`;
  return "Nothing chosen yet.";
}

/**
 * The draft's anchor after the subject changes. A time belongs to one
 * file: moving the comment anywhere else — another block, or the version
 * as a whole — drops it, without asking, since nothing has been sent.
 */
export function anchorAfterSubjectChange<T>(previous: string, next: string, anchor: T | null): T | null {
  return previous === next ? anchor : null;
}

/**
 * The form's `anchor` field: compact, deterministic, and empty for none. One
 * field for every precise anchor the composer can hold — a time (F3, F4.1) or
 * a point (F5) — written in the canonical key order and nothing else.
 */
export function serializeAnchor(anchor: TimeCandidate | PointCandidate | null): string {
  if (!anchor) return "";
  if (anchor.kind === "point") return JSON.stringify({ kind: "point", x: anchor.x, y: anchor.y });
  return JSON.stringify("t2" in anchor ? { kind: "time", t: anchor.t, t2: anchor.t2 } : { kind: "time", t: anchor.t });
}
