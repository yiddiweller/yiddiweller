import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { type ViewerKind } from "../lib/storage/policy.ts";
import { parseReviewAnchor, type AnchorRefusal } from "../lib/workrooms/review-anchor.ts";

/**
 * The one definition of a precise anchor.
 *
 * Pure: no database, no browser. Every rule the write path and the read path
 * both depend on is exercised here once, against the function both of them
 * call. The integration suite proves the two paths call it; this proves what
 * it says.
 */

type Viewer = ViewerKind | null;

const refused = (raw: unknown, viewer: Viewer): AnchorRefusal => {
  const parsed = parseReviewAnchor(raw, viewer);
  assert.ok(!parsed.ok, `accepted ${JSON.stringify(raw)} on ${viewer}`);
  return parsed.reason;
};

const accepted = (raw: unknown, viewer: Viewer) => {
  const parsed = parseReviewAnchor(raw, viewer);
  assert.ok(parsed.ok, `refused ${JSON.stringify(raw)} on ${viewer}`);
  return parsed.anchor;
};

/* ---------------------------------------------------------------- nothing */

test("no anchor is not a refusal, on any kind of item", () => {
  for (const viewer of ["image", "video", "audio", "pdf", "download", null] as const) {
    assert.equal(accepted(null, viewer), null, `${viewer}: null`);
    assert.equal(accepted(undefined, viewer), null, `${viewer}: undefined`);
  }
});

/* ------------------------------------------------------------------ point */

test("a point is two fractions of the image and nothing else", () => {
  assert.deepEqual(accepted({ kind: "point", x: 0.42, y: 0.18 }, "image"), {
    kind: "point",
    x: 0.42,
    y: 0.18,
  });
  // The edges are inside.
  for (const [x, y] of [[0, 0], [1, 1], [0, 1], [1, 0]] as const) {
    accepted({ kind: "point", x, y }, "image");
  }

  assert.equal(refused({ kind: "point", x: 1.0001, y: 0.2 }, "image"), "out_of_bounds");
  assert.equal(refused({ kind: "point", x: -0.0001, y: 0.2 }, "image"), "out_of_bounds");
  // A viewport pixel is exactly what normalising forbids.
  assert.equal(refused({ kind: "point", x: 412, y: 220 }, "image"), "out_of_bounds");

  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "0.4", null, [0.4], {}]) {
    assert.equal(refused({ kind: "point", x: bad, y: 0.2 }, "image"), "invalid_number", String(bad));
  }

  assert.equal(refused({ kind: "point", x: 0.4 }, "image"), "unknown_key", "a missing key");
  assert.equal(refused({ kind: "point", x: 0.4, y: 0.2, note: "x" }, "image"), "unknown_key");
});

/* ----------------------------------------------------------------- region */

test("a region is inside the image and has a size — the rule that was missing", () => {
  assert.deepEqual(accepted({ kind: "region", x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, "image"), {
    kind: "region",
    x: 0.1,
    y: 0.2,
    w: 0.3,
    h: 0.4,
  });
  // The whole image, and a region flush with the far edges.
  accepted({ kind: "region", x: 0, y: 0, w: 1, h: 1 }, "image");
  accepted({ kind: "region", x: 0.5, y: 0.75, w: 0.5, h: 0.25 }, "image");

  // What the old parser accepted, and the reason it no longer does.
  assert.equal(refused({ kind: "region", x: 0.9, y: 0.9, w: 0.9, h: 0.9 }, "image"), "invalid_region");
  assert.equal(refused({ kind: "region", x: 0.6, y: 0.1, w: 0.5, h: 0.1 }, "image"), "invalid_region", "past the right edge");
  assert.equal(refused({ kind: "region", x: 0.1, y: 0.6, w: 0.1, h: 0.5 }, "image"), "invalid_region", "past the bottom");
  assert.equal(refused({ kind: "region", x: 0.1, y: 0.1, w: 0, h: 0.2 }, "image"), "invalid_region", "no width");
  assert.equal(refused({ kind: "region", x: 0.1, y: 0.1, w: 0.2, h: 0 }, "image"), "invalid_region", "no height");
  assert.equal(refused({ kind: "region", x: 0.1, y: 0.1, w: -0.2, h: 0.2 }, "image"), "invalid_region");

  assert.equal(refused({ kind: "region", x: 1.2, y: 0.1, w: 0.1, h: 0.1 }, "image"), "out_of_bounds");
  assert.equal(refused({ kind: "region", x: 0.1, y: 0.1, w: "0.2", h: 0.2 }, "image"), "invalid_number");
  assert.equal(refused({ kind: "region", x: 0.1, y: 0.1, w: 0.2 }, "image"), "unknown_key");
  assert.equal(refused({ kind: "region", x: 0.1, y: 0.1, w: 0.2, h: 0.2, colour: "red" }, "image"), "unknown_key");
});

/* ------------------------------------------------------------------- time */

test("a moment is finite and not negative, and has no ceiling", () => {
  assert.deepEqual(accepted({ kind: "time", t: 42.5 }, "video"), { kind: "time", t: 42.5 });
  accepted({ kind: "time", t: 0 }, "audio");

  // More than a day, a week, a year. There is no product rule about length,
  // and the server cannot know one anyway: duration is judged at capture.
  for (const t of [86_400, 86_401, 604_800, 31_536_000, 1e12]) {
    assert.deepEqual(accepted({ kind: "time", t }, "video"), { kind: "time", t }, String(t));
  }

  assert.equal(refused({ kind: "time", t: -1 }, "video"), "out_of_bounds");
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "42", null]) {
    assert.equal(refused({ kind: "time", t: bad }, "video"), "invalid_number", String(bad));
  }
  assert.equal(refused({ kind: "time" }, "video"), "unknown_key");
  assert.equal(refused({ kind: "time", t: 1, speed: 2 }, "video"), "unknown_key");
});

test("a stretch ends after it starts", () => {
  assert.deepEqual(accepted({ kind: "time", t: 10, t2: 20 }, "video"), { kind: "time", t: 10, t2: 20 });
  accepted({ kind: "time", t: 0, t2: 0.001 }, "audio");
  accepted({ kind: "time", t: 90_000, t2: 90_060 }, "audio");

  assert.equal(refused({ kind: "time", t: 10, t2: 4 }, "video"), "invalid_range");
  assert.equal(refused({ kind: "time", t: 10, t2: 10 }, "video"), "invalid_range");
  assert.equal(refused({ kind: "time", t: 10, t2: Number.NaN }, "video"), "invalid_number");
  assert.equal(refused({ kind: "time", t: -1, t2: 4 }, "video"), "out_of_bounds");
  assert.equal(refused({ kind: "time", t2: 4 }, "video"), "unknown_key", "an end with no start");
  assert.equal(refused({ kind: "time", t: 1, t2: 4, region: { x: 0, y: 0, w: 1, h: 1 } }, "video"), "unknown_key");
});

test("a region on a frame obeys the same region rule, nested", () => {
  const frame = { kind: "time", t: 5, region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } };
  assert.deepEqual(accepted(frame, "video"), frame);

  assert.equal(refused({ kind: "time", t: 5, region: { x: 0.9, y: 0.1, w: 0.2, h: 0.2 } }, "video"), "invalid_region");
  assert.equal(refused({ kind: "time", t: 5, region: { x: 0.1, y: 0.1, w: 0, h: 0.2 } }, "video"), "invalid_region");
  assert.equal(refused({ kind: "time", t: 5, region: { x: 0.1, y: 0.1, w: 0.2 } }, "video"), "unknown_key");
  assert.equal(refused({ kind: "time", t: 5, region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2, z: 1 } }, "video"), "unknown_key");
  assert.equal(refused({ kind: "time", t: 5, region: [0.1, 0.1, 0.2, 0.2] }, "video"), "invalid_shape");
  assert.equal(refused({ kind: "time", t: 5, region: null }, "video"), "invalid_shape");
  assert.equal(refused({ kind: "time", t: -5, region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }, "video"), "out_of_bounds");
});

/* ------------------------------------------------------------ what it is on */

test("each kind of item holds exactly the precision it can show", () => {
  const point = { kind: "point", x: 0.5, y: 0.5 };
  const region = { kind: "region", x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
  const moment = { kind: "time", t: 3 };
  const stretch = { kind: "time", t: 3, t2: 6 };
  const frame = { kind: "time", t: 3, region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } };

  const table: [Viewer, unknown[], unknown[]][] = [
    ["image", [point, region], [moment, stretch, frame]],
    ["video", [moment, stretch, frame], [point, region]],
    ["audio", [moment, stretch], [point, region, frame]],
    ["pdf", [], [point, region, moment, stretch, frame]],
    ["download", [], [point, region, moment, stretch, frame]],
    [null, [], [point, region, moment, stretch, frame]],
  ];

  for (const [viewer, yes, no] of table) {
    for (const anchor of yes) accepted(anchor, viewer);
    for (const anchor of no) {
      assert.equal(refused(anchor, viewer), "unsupported_for_viewer", `${JSON.stringify(anchor)} on ${viewer}`);
    }
  }

  // An item that holds nothing refuses even nonsense for that reason, first:
  // the refusal is about the item, not the value.
  assert.equal(refused({ kind: "sticker" }, "pdf"), "unsupported_for_viewer");
  assert.equal(refused({ kind: "sticker" }, null), "unsupported_for_viewer");

  // A viewer this module does not recognise holds nothing — an anchor on it
  // fails closed rather than being interpreted by guesswork.
  assert.equal(refused(point, "hologram" as ViewerKind), "unsupported_for_viewer");
});

test("the shape of a refusal is stable and carries what the value was trying to be", () => {
  assert.deepEqual(parseReviewAnchor("point", "image"), { ok: false, reason: "invalid_shape", kind: null });
  assert.deepEqual(parseReviewAnchor([], "image"), { ok: false, reason: "invalid_shape", kind: null });
  assert.deepEqual(parseReviewAnchor({ kind: "sticker" }, "image"), { ok: false, reason: "invalid_shape", kind: null });
  assert.deepEqual(parseReviewAnchor({ kind: "time", t: 9, t2: 1 }, "video"), {
    ok: false,
    reason: "invalid_range",
    kind: "time_range",
  });
});

test("nothing extra ever comes back out", () => {
  // The result is built by naming fields, so a value that sneaks a key past a
  // careless check still could not be carried through.
  const out = accepted({ kind: "time", t: 3, t2: 6 }, "video");
  assert.deepEqual(Object.keys(out!).sort(), ["kind", "t", "t2"]);
});

/* --------------------------------------------------------- one definition */

/** Prose explains what code does; only code can do it. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("the vocabulary is defined once, and the module that defines it imports nothing it should not", () => {
  const anchor = code("lib/workrooms/review-anchor.ts");
  const imports = [...anchor.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(imports, ["../storage/policy.ts"], "the anchor module imports more than a type");
  assert.ok(/import\s+\{\s*type ViewerKind\s*\}/.test(anchor), "the one import is not type-only");

  // Neither caller keeps a rule of its own.
  for (const path of ["lib/db/reviews.ts", "lib/workrooms/review-view.ts"]) {
    const source = code(path);
    for (const leftover of ["FRACTION", "SECONDS", "function box", "function region", "onlyKeys", "x + w", "t2 > "]) {
      assert.ok(!source.includes(leftover), `${path} still carries ${leftover}`);
    }
    assert.ok(source.includes("parseReviewAnchor"), `${path} does not call the canonical parser`);
  }
});
