import { type ViewerKind } from "../storage/policy.ts";

/**
 * What a precise Review anchor may be — **the only definition there is.**
 *
 * Before Stage F there were two: the domain's write check and the projection's
 * read check, written separately, and they had already drifted. The projection
 * ignored unexpected keys the domain refused, and it could not check whether a
 * kind of anchor belonged on the item at all, because nothing told it what the
 * item was. Both now call this, so they cannot disagree about anything: there
 * is one implementation to agree with.
 *
 * **Pure and server-safe.** No database, no React, no browser API. It takes an
 * unknown value and the item's viewer kind, and returns the anchor or a
 * machine-readable reason. Never a sentence — the domain turns a reason into
 * words a person reads, and the projection turns one into silence.
 *
 * **An anchor carries precision only.** Which block a note is about is its
 * `subject`, held beside the anchor and never inside it; this module does not
 * know or need the position.
 *
 * Fractions are of the media's content rectangle — the area its pixels occupy
 * — measured from the top left; seconds are from the start. See
 * `anchor-geometry.ts` for how a fraction is measured.
 */

export type ReviewRegion = { x: number; y: number; w: number; h: number };

export type ReviewAnchor =
  | { kind: "point"; x: number; y: number }
  | ({ kind: "region" } & ReviewRegion)
  | { kind: "time"; t: number }
  | { kind: "time"; t: number; t2: number }
  | { kind: "time"; t: number; region: ReviewRegion };

/** Which shape a value was trying to be, when that much could be told. */
export type AnchorKind = "point" | "region" | "time" | "time_range" | "time_region";

/** Why a value is not an anchor. Stable, compact, and never shown to anybody. */
export type AnchorRefusal =
  /** Not an object, or not a kind this vocabulary has. */
  | "invalid_shape"
  /** A key the shape does not have. Refused, never ignored. */
  | "unknown_key"
  /** A value that is not a finite number where one is required. */
  | "invalid_number"
  /** A point or a coordinate outside the media. */
  | "out_of_bounds"
  /** A region of no size, or one that leaves the media. */
  | "invalid_region"
  /** A stretch that does not end after it starts. */
  | "invalid_range"
  /** A kind of precision this item cannot have. */
  | "unsupported_for_viewer";

export type AnchorParse =
  | { ok: true; anchor: ReviewAnchor | null }
  | { ok: false; reason: AnchorRefusal; kind: AnchorKind | null };

/* ------------------------------------------------------------ primitives */

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const fraction = (value: number): boolean => value >= 0 && value <= 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exactly these keys, every one of them present, and nothing else. */
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

type Checked<T> = { ok: true; value: T } | { ok: false; reason: AnchorRefusal };

/**
 * A region on the media — the one place the region rule is written.
 *
 * Every edge inside the content rectangle and a size that is not zero:
 * `x + w ≤ 1` and `y + h ≤ 1` are what the architecture review found missing.
 * Used for an image region and, recursively, for a region on a video frame.
 */
function region(value: unknown): Checked<ReviewRegion> {
  if (!isRecord(value)) return { ok: false, reason: "invalid_shape" };
  if (!exactKeys(value, ["x", "y", "w", "h"])) return { ok: false, reason: "unknown_key" };

  const { x, y, w, h } = value;
  if (!finite(x) || !finite(y) || !finite(w) || !finite(h)) {
    return { ok: false, reason: "invalid_number" };
  }
  if (!fraction(x) || !fraction(y)) return { ok: false, reason: "out_of_bounds" };
  if (w <= 0 || h <= 0 || x + w > 1 || y + h > 1) return { ok: false, reason: "invalid_region" };

  return { ok: true, value: { x, y, w, h } };
}

/** A moment from the start: finite and not negative. There is no upper limit. */
function moment(value: unknown): Checked<number> {
  if (!finite(value)) return { ok: false, reason: "invalid_number" };
  if (value < 0) return { ok: false, reason: "out_of_bounds" };
  return { ok: true, value };
}

/** What `kind` says the value is trying to be, before its fields are judged. */
function kindOf(value: Record<string, unknown>): AnchorKind | null {
  if (value.kind === "point") return "point";
  if (value.kind === "region") return "region";
  if (value.kind !== "time") return null;
  if ("t2" in value) return "time_range";
  if ("region" in value) return "time_region";
  return "time";
}

/** Which kinds each viewer can hold. Everything not listed holds none. */
const ACCEPTS: Record<ViewerKind, readonly AnchorKind[]> = {
  image: ["point", "region"],
  video: ["time", "time_range", "time_region"],
  audio: ["time", "time_range"],
  pdf: [],
  download: [],
};

/* ----------------------------------------------------------------- parse */

/**
 * An unknown value, judged as a precise anchor on an item of `viewer` kind.
 *
 * `raw` null or undefined is not a refusal: it is the ordinary case — a point
 * about the item as a whole, or about the version in general — and comes back
 * as `anchor: null`. `viewer` null means the item is words rather than media,
 * which can hold no precision at all.
 *
 * Compatibility is judged before the fields are, so a well-formed moment on an
 * image is refused for being on an image rather than for anything about its
 * numbers. A viewer this module does not recognise holds nothing: an anchor it
 * cannot interpret fails closed.
 *
 * Nothing is repaired. A shape that does not match exactly is refused, so a
 * caller never gets back a different anchor from the one it gave.
 */
export function parseReviewAnchor(raw: unknown, viewer: ViewerKind | null): AnchorParse {
  if (raw === null || raw === undefined) return { ok: true, anchor: null };
  if (!isRecord(raw)) return { ok: false, reason: "invalid_shape", kind: null };

  const kind = kindOf(raw);
  const accepted = viewer !== null && Object.hasOwn(ACCEPTS, viewer) ? ACCEPTS[viewer] : [];

  // An item that can hold no precision refuses every anchor alike, whatever
  // it looks like — the reason is the item, not the value.
  if (accepted.length === 0) return { ok: false, reason: "unsupported_for_viewer", kind };
  if (kind === null) return { ok: false, reason: "invalid_shape", kind: null };
  if (!accepted.includes(kind)) return { ok: false, reason: "unsupported_for_viewer", kind };

  const refuse = (reason: AnchorRefusal): AnchorParse => ({ ok: false, reason, kind });

  switch (kind) {
    case "point": {
      if (!exactKeys(raw, ["kind", "x", "y"])) return refuse("unknown_key");
      if (!finite(raw.x) || !finite(raw.y)) return refuse("invalid_number");
      if (!fraction(raw.x) || !fraction(raw.y)) return refuse("out_of_bounds");
      return { ok: true, anchor: { kind: "point", x: raw.x, y: raw.y } };
    }

    case "region": {
      if (!exactKeys(raw, ["kind", "x", "y", "w", "h"])) return refuse("unknown_key");
      const box = region({ x: raw.x, y: raw.y, w: raw.w, h: raw.h });
      if (!box.ok) return refuse(box.reason);
      return { ok: true, anchor: { kind: "region", ...box.value } };
    }

    case "time": {
      if (!exactKeys(raw, ["kind", "t"])) return refuse("unknown_key");
      const t = moment(raw.t);
      if (!t.ok) return refuse(t.reason);
      return { ok: true, anchor: { kind: "time", t: t.value } };
    }

    case "time_range": {
      if (!exactKeys(raw, ["kind", "t", "t2"])) return refuse("unknown_key");
      const t = moment(raw.t);
      if (!t.ok) return refuse(t.reason);
      const t2 = moment(raw.t2);
      if (!t2.ok) return refuse(t2.reason);
      if (t2.value <= t.value) return refuse("invalid_range");
      return { ok: true, anchor: { kind: "time", t: t.value, t2: t2.value } };
    }

    case "time_region": {
      if (!exactKeys(raw, ["kind", "t", "region"])) return refuse("unknown_key");
      const t = moment(raw.t);
      if (!t.ok) return refuse(t.reason);
      // The same region rule, nested — not a second copy of it.
      const box = region(raw.region);
      if (!box.ok) return refuse(box.reason);
      return { ok: true, anchor: { kind: "time", t: t.value, region: box.value } };
    }
  }
}
