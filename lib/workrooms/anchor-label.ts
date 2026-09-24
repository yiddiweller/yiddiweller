import { type ReviewAnchor } from "./review-anchor.ts";

/**
 * How a precise anchor is said, in the words a person uses.
 *
 * No coordinates, no JSON, no "annotation type": a point is *a point*, a moment
 * is *At 0:42*, a stretch is *0:42–0:51*. Pure, so the client and Studio say
 * the same thing about the same anchor by calling the same function.
 *
 * **A duration, never a time of day.** Nothing here goes near `Date` or a
 * clock formatter, which would wrap 25 hours back round to 1:00:00. Hours are
 * simply counted: a long recording reads *25:03:08*.
 *
 * Whole seconds only. The player's own clock shows whole seconds, so that is
 * what somebody saw when they pressed; milliseconds are stored and used to
 * seek, never shown.
 */

const pad = (value: number): string => String(value).padStart(2, "0");

/** `0:42`, `1:02:17`, `25:03:08`. Null for anything that is not a moment. */
export function formatDuration(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds < 0) return null;

  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

/** *At 0:42* — the second the moment falls in. */
export function momentLabel(t: number): string | null {
  const at = formatDuration(t);
  return at === null ? null : `At ${at}`;
}

/**
 * *0:42–0:51* — each end as the player's clock showed it.
 *
 * A stretch shorter than a second would read *0:42–0:42*, which says nothing,
 * so its end is shown as the next whole second instead: the label still
 * contains the stretch and the two ends always differ.
 */
export function rangeLabel(t: number, t2: number): string | null {
  if (!Number.isFinite(t) || !Number.isFinite(t2) || t < 0 || t2 <= t) return null;

  const end = Math.floor(t2) > Math.floor(t) ? t2 : Math.floor(t) + 1;
  const from = formatDuration(t);
  const to = formatDuration(end);
  return from === null || to === null ? null : `${from}–${to}`;
}

/**
 * The anchor alone, as a phrase.
 *
 * Spatial phrases are lower case because they are always said *about*
 * something — *On Primary identity direction · a point*. A moment or a stretch
 * stands on its own, so it reads as one.
 */
export function anchorPhrase(anchor: ReviewAnchor): string | null {
  switch (anchor.kind) {
    case "point":
      return "a point";
    case "region":
      return "an area";
    case "time":
      if ("t2" in anchor) return rangeLabel(anchor.t, anchor.t2);
      if ("region" in anchor) {
        const at = momentLabel(anchor.t);
        return at === null ? null : `${at}, an area`;
      }
      return momentLabel(anchor.t);
  }
}

/**
 * What a locator says — *On Primary identity direction · Point*, *On The
 * motion · At 0:42*, *On The sound · 1:12–1:24*.
 *
 * The block is always named first, because the locator replaces the plain
 * *On …* line an item-level note carries and a precise note is still about that
 * block. What follows is the precision in a word or a time, never a
 * coordinate. A moment with an area on its frame says only the moment: the
 * area is kept in the note and in history, but nothing draws it yet, and a
 * label must not promise what activating it will not show.
 */
export function locatorLabel(subject: string, anchor: ReviewAnchor): string | null {
  const precision =
    anchor.kind === "point"
      ? "Point"
      : anchor.kind === "region"
        ? "Area"
        : "t2" in anchor
          ? rangeLabel(anchor.t, anchor.t2)
          : momentLabel(anchor.t);
  return precision === null ? null : `On ${subject} · ${precision}`;
}
