import type { ViewerKind } from "../storage/policy.ts";
import {
  containRect,
  fromFraction,
  roundFraction,
  toFraction,
  type Point,
  type Rect,
  type Size,
} from "./anchor-geometry.ts";
import type { ReviewAnchor } from "./review-anchor.ts";

/**
 * Choosing one place on a picture, decided without a browser — Stage F5.
 *
 * The browser measures and reports; these rules decide. A press becomes a
 * point only if it lands on the picture itself, as a fraction of the area its
 * pixels occupy; an arrow key moves a point already there, or starts one in
 * the middle. Nothing here draws, listens or focuses — `ReviewStage` will do
 * that in F5.2 and hand each press here — so everything a press can produce is
 * tested as data: a point on the picture, or nothing.
 *
 * **No geometry of its own.** Where the picture is inside its element, and
 * what a pointer position is as a fraction of it, are `anchor-geometry.ts`'s —
 * `containRect`, `toFraction`, `fromFraction` — and a stored fraction's
 * precision is `roundFraction`'s. This module only composes them, so capture
 * and display cannot disagree about where a point is.
 *
 * **F5.2's event-scoping rule, locked here so the wiring cannot forget it:**
 * only a press on the picture's own interaction surface is ever handed to
 * `placePoint`. A press on Done, Cancel, Change, Clear, *Download original*,
 * any link, any button or anything in the capture panel is never a placement
 * attempt — not a point, and not a "beside the picture" refusal either.
 */

/** The one shape a point takes — F1's `point`, exactly. */
export type PointCandidate = { kind: "point"; x: number; y: number };

/**
 * Whether an item of this **frozen** viewer takes a point. Called with the
 * viewer a Revision's snapshot recorded, and nothing else: not the filename,
 * not the live file row, not the Files policy as it reads today. Only a
 * picture has places; an image frozen as a download — an SVG, say — never
 * does, whatever it is labelled.
 */
export function takesPoint(viewer: ViewerKind | null): boolean {
  return viewer === "image";
}

/**
 * Whether a subject in the composer takes a point. Read from the subject the
 * page built out of the Revision's frozen snapshot, as `capturesTime` is.
 */
export function capturesPoint(subject: { capture?: "time" | "point" } | undefined): boolean {
  return subject?.capture === "point";
}

/* ---------------------------------------------------------------- pointer */

/**
 * A press, as a point on the picture — or null.
 *
 * `pointer` and `box` are in the same CSS pixel space: a pointer event's
 * client position and the image element's **content box** (its bounding
 * rectangle less its own border and padding). `intrinsic` is its natural size,
 * which browsers report after EXIF orientation.
 *
 * **Null for anything that is not on the picture** — a letterbox bar, the
 * background beside it, a picture with no size yet, a box with none — and
 * never a clamped point: a press beside the picture is not a press on its
 * edge. The edges and corners themselves are on it.
 */
export function placePoint(pointer: Point, intrinsic: Size, box: Rect): PointCandidate | null {
  const content = containRect(intrinsic, box);
  if (!content) return null;
  const fraction = toFraction(pointer, content);
  if (!fraction) return null;
  return { kind: "point", x: roundFraction(fraction.x), y: roundFraction(fraction.y) };
}

/**
 * Where a point is drawn, in the same pixel space it was measured in — the
 * inverse of `placePoint`, recomputed from the fraction every time so a resize,
 * a rotation or another device puts it on the same place in the picture.
 */
export function pointOnImage(point: { x: number; y: number }, intrinsic: Size, box: Rect): Point | null {
  const content = containRect(intrinsic, box);
  return content ? fromFraction(point, content) : null;
}

/* --------------------------------------------------------------- keyboard */

export type ArrowKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

/** How far one arrow press moves a point, as a fraction of the picture. */
export const POINT_STEP = 0.02;
/** How far one arrow press moves it with Shift held. */
export const POINT_STEP_LARGE = 0.1;

export function isArrowKey(key: string): key is ArrowKey {
  return key === "ArrowUp" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowRight";
}

const onPicture = (value: number): number => roundFraction(Math.min(1, Math.max(0, value)));

/**
 * An arrow press, as the point it leaves.
 *
 * With no point yet, the first press puts one in the middle of the picture and
 * moves it nowhere — so somebody who cannot point still starts from somewhere
 * they can see. After that each press moves it by `POINT_STEP`, or
 * `POINT_STEP_LARGE` with Shift, and **stops at the picture's edge**: a key
 * held down against an edge stays on it rather than leaving the image. This is
 * the one place a value is held to the picture rather than refused, because a
 * key names a direction, not a place.
 */
export function nudgePoint(current: PointCandidate | null, key: ArrowKey, large = false): PointCandidate {
  if (!current) return { kind: "point", x: 0.5, y: 0.5 };
  const step = large ? POINT_STEP_LARGE : POINT_STEP;
  const dx = key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0;
  const dy = key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0;
  return { kind: "point", x: onPicture(current.x + dx), y: onPicture(current.y + dy) };
}

/* ------------------------------------------------------------------ words */

/**
 * The draft's point when a capture opens: the one it already holds, so
 * *Change* then *Cancel* gives it back untouched. Anything else starts empty.
 */
export function beginPoint(initial: ReviewAnchor | PointCandidate | null): PointCandidate | null {
  return initial && initial.kind === "point" ? { kind: "point", x: initial.x, y: initial.y } : null;
}

/** What the composer says it holds — never a coordinate. */
export function pointSummary(name: string): string {
  return `A point on ${name}`;
}
