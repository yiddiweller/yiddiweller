/**
 * Where a normalized point is, on media that has been laid out.
 *
 * **Pure numbers in, pure numbers out.** No DOM, no `window`, no measuring:
 * the browser collects the intrinsic size and the element's content box, and
 * hands them here. That keeps the one piece of Stage F that has to be exactly
 * right deterministic, and testable without a browser.
 *
 * **The rendering contract it assumes** — and which Stage F's viewer
 * integration will declare explicitly rather than inherit — is
 * `object-fit: contain` with `object-position: 50% 50%`: the media keeps its
 * aspect ratio, fits entirely inside the element, and is centred, leaving
 * letterbox bars on whichever axis has room to spare.
 *
 * **Every coordinate is a fraction of the media's content rectangle** — the
 * area its pixels actually occupy, not the element's box — measured from its
 * top left. That is what makes a point recorded on a phone land in the same
 * place on a desktop, at any zoom, in either orientation.
 *
 * Callers pass the element's **content box**: its bounding rectangle less its
 * own border and padding. Pointer positions and that box must be in the same
 * space — CSS pixels relative to the viewport, which is what pointer events and
 * `getBoundingClientRect` both report — so browser zoom and pinch cancel out.
 */

export type Size = { width: number; height: number };
export type Rect = { left: number; top: number; width: number; height: number };
export type Point = { x: number; y: number };

const finite = (value: number): boolean => Number.isFinite(value);

/**
 * How far past an edge floating-point arithmetic may land a press that was on
 * the edge. Far below anything a pointer can express; it absorbs rounding, not
 * intent. A press genuinely outside is still refused, never clamped.
 */
const EDGE_TOLERANCE = 1e-9;

function validRect(rect: Rect): boolean {
  return (
    finite(rect.left) &&
    finite(rect.top) &&
    finite(rect.width) &&
    finite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

/**
 * The media's content rectangle inside its element: `contain`, centred.
 *
 * Null when the inputs describe nothing — an intrinsic size of zero (metadata
 * not loaded yet, or a broken image), an element with no size, or anything
 * non-finite. The caller treats null as "no precision possible right now",
 * never as a rectangle to guess.
 */
export function containRect(intrinsic: Size, box: Rect): Rect | null {
  if (!finite(intrinsic.width) || !finite(intrinsic.height)) return null;
  if (intrinsic.width <= 0 || intrinsic.height <= 0) return null;
  if (!validRect(box)) return null;

  // Whichever axis runs out first decides the scale; the other has bars.
  const scale = Math.min(box.width / intrinsic.width, box.height / intrinsic.height);
  const width = intrinsic.width * scale;
  const height = intrinsic.height * scale;

  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height,
  };
}

/** A fraction nudged back onto an edge only when arithmetic, not a person, left it. */
function onto(value: number): number | null {
  if (value < -EDGE_TOLERANCE || value > 1 + EDGE_TOLERANCE) return null;
  return Math.min(1, Math.max(0, value));
}

/**
 * A pointer position, as a fraction of the content rectangle — or null.
 *
 * **Null for anything outside the media**, including every letterbox bar:
 * a press beside the picture is not a press on its edge. The edges themselves
 * are inside.
 */
export function toFraction(pointer: Point, content: Rect): Point | null {
  if (!finite(pointer.x) || !finite(pointer.y) || !validRect(content)) return null;

  const x = onto((pointer.x - content.left) / content.width);
  const y = onto((pointer.y - content.top) / content.height);
  return x === null || y === null ? null : { x, y };
}

/**
 * A fraction, placed on the content rectangle as it is laid out now.
 *
 * The inverse of `toFraction`, and the reason a stored point survives a resize,
 * a rotation or a different device: it is recomputed from the fraction, never
 * remembered in pixels. Null for a fraction outside the media.
 */
export function fromFraction(fraction: Point, content: Rect): Point | null {
  if (!finite(fraction.x) || !finite(fraction.y) || !validRect(content)) return null;
  if (fraction.x < 0 || fraction.x > 1 || fraction.y < 0 || fraction.y > 1) return null;

  return {
    x: content.left + fraction.x * content.width,
    y: content.top + fraction.y * content.height,
  };
}

/**
 * A fraction as it is stored: four decimal places.
 *
 * One ten-thousandth of the image's width — finer than any finger or cursor,
 * coarse enough that a stored point does not carry arithmetic noise. The one
 * place this precision is decided; capture calls it, nothing else rounds.
 * Stays within [0, 1] for any input inside it.
 */
export function roundFraction(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Seconds as they are stored: to the millisecond.
 *
 * Finer than any frame; the player reports more digits than mean anything.
 */
export function roundSeconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
