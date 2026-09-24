import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  containRect,
  fromFraction,
  roundFraction,
  roundSeconds,
  toFraction,
  type Rect,
} from "../lib/workrooms/anchor-geometry.ts";

/**
 * Where a normalized point is, on media that has been laid out.
 *
 * Pure numbers in and out, so every layout a phone or a desktop can produce is
 * a line in a table rather than a browser session. The capture and display
 * code later measures the element and hands the numbers here.
 */

const near = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} is not ${expected}`);

const box = (left: number, top: number, width: number, height: number): Rect => ({ left, top, width, height });

/* ------------------------------------------------------------- the fit */

test("wide media in a tall box is centred vertically, with bars above and below", () => {
  // 1600 × 900 into 400 × 600: width decides, height is 225.
  const content = containRect({ width: 1600, height: 900 }, box(0, 0, 400, 600))!;
  assert.deepEqual(content, { left: 0, top: 187.5, width: 400, height: 225 });

  assert.equal(toFraction({ x: 200, y: 100 }, content), null, "a press in the top bar");
  assert.equal(toFraction({ x: 200, y: 500 }, content), null, "a press in the bottom bar");
  assert.deepEqual(toFraction({ x: 200, y: 300 }, content), { x: 0.5, y: 0.5 });
});

test("tall media in a wide box is centred horizontally, with bars either side", () => {
  // 900 × 1600 into 800 × 400: height decides, width is 225.
  const content = containRect({ width: 900, height: 1600 }, box(0, 0, 800, 400))!;
  assert.deepEqual(content, { left: 287.5, top: 0, width: 225, height: 400 });

  assert.equal(toFraction({ x: 100, y: 200 }, content), null, "a press in the left bar");
  assert.equal(toFraction({ x: 700, y: 200 }, content), null, "a press in the right bar");
  assert.deepEqual(toFraction({ x: 400, y: 200 }, content), { x: 0.5, y: 0.5 });
});

test("media the same shape as its box fills it, with no bars", () => {
  const content = containRect({ width: 1200, height: 800 }, box(30, 40, 600, 400))!;
  assert.deepEqual(content, { left: 30, top: 40, width: 600, height: 400 });
});

test("the element's position on the page is carried through, not assumed to be the origin", () => {
  const content = containRect({ width: 1600, height: 900 }, box(120, 2400, 400, 600))!;
  assert.deepEqual(content, { left: 120, top: 2587.5, width: 400, height: 225 });
  assert.deepEqual(toFraction({ x: 320, y: 2700 }, content), { x: 0.5, y: 0.5 });
});

/* ------------------------------------------------------------- the edges */

test("the edges are inside; the smallest step past them is not", () => {
  const content = box(100, 50, 400, 300);

  assert.deepEqual(toFraction({ x: 100, y: 50 }, content), { x: 0, y: 0 }, "top left");
  assert.deepEqual(toFraction({ x: 500, y: 350 }, content), { x: 1, y: 1 }, "bottom right");
  assert.deepEqual(toFraction({ x: 500, y: 50 }, content), { x: 1, y: 0 }, "top right");

  assert.equal(toFraction({ x: 99.9, y: 200 }, content), null, "just left");
  assert.equal(toFraction({ x: 500.1, y: 200 }, content), null, "just right");
  assert.equal(toFraction({ x: 300, y: 49.9 }, content), null, "just above");
  assert.equal(toFraction({ x: 300, y: 350.1 }, content), null, "just below");
});

test("an outside press is refused, never pulled onto the edge", () => {
  const content = box(0, 0, 100, 100);
  for (const outside of [{ x: -40, y: 50 }, { x: 140, y: 50 }, { x: 50, y: -40 }, { x: 50, y: 140 }]) {
    assert.equal(toFraction(outside, content), null, JSON.stringify(outside));
  }
});

test("arithmetic noise at an edge is absorbed, and only arithmetic noise", () => {
  // A layout whose edge lands on an inexact binary fraction.
  const content = containRect({ width: 3, height: 1 }, box(0.1, 0.2, 0.7, 10))!;
  const right = content.left + content.width;
  const onEdge = toFraction({ x: right, y: content.top }, content);
  assert.ok(onEdge, "a press exactly on the computed edge was refused");
  assert.equal(onEdge.x, 1);
  assert.equal(onEdge.y, 0);
});

/* ------------------------------------------------------- there and back */

test("a fraction survives the round trip from display back to capture", () => {
  const content = containRect({ width: 1920, height: 1080 }, box(16, 820, 358, 600))!;
  for (const fraction of [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: 0.4231, y: 0.1877 },
    { x: 0.9999, y: 0.0001 },
  ]) {
    const shown = fromFraction(fraction, content)!;
    const read = toFraction(shown, content)!;
    near(read.x, fraction.x, "x");
    near(read.y, fraction.y, "y");
  }
});

test("one stored point lands in the same place on any size of screen", () => {
  const intrinsic = { width: 2400, height: 1600 };
  const point = { x: 0.3, y: 0.7 };

  const phone = containRect(intrinsic, box(16, 300, 358, 600))!;
  const desktop = containRect(intrinsic, box(260, 180, 900, 700))!;

  for (const [what, content] of [["phone", phone], ["desktop", desktop]] as const) {
    const shown = fromFraction(point, content)!;
    near((shown.x - content.left) / content.width, 0.3, `${what} x`);
    near((shown.y - content.top) / content.height, 0.7, `${what} y`);
  }

  // And the same layout at a new width, as a rotation or a resize produces.
  const rotated = containRect(intrinsic, box(16, 120, 812, 358))!;
  const shown = fromFraction(point, rotated)!;
  near((shown.x - rotated.left) / rotated.width, 0.3, "rotated x");
});

test("a fraction outside the media is not placed at all", () => {
  const content = box(0, 0, 100, 100);
  assert.equal(fromFraction({ x: 1.1, y: 0.5 }, content), null);
  assert.equal(fromFraction({ x: -0.1, y: 0.5 }, content), null);
});

/* --------------------------------------------------------- nothing to fit */

test("nothing to measure is null, never a guess", () => {
  const good = box(0, 0, 400, 300);

  // Metadata not loaded, a broken image, or a collapsed element.
  assert.equal(containRect({ width: 0, height: 900 }, good), null);
  assert.equal(containRect({ width: 1600, height: 0 }, good), null);
  assert.equal(containRect({ width: 1600, height: 900 }, box(0, 0, 0, 300)), null);
  assert.equal(containRect({ width: 1600, height: 900 }, box(0, 0, 400, 0)), null);
  assert.equal(containRect({ width: -1, height: 900 }, good), null);

  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(containRect({ width: bad, height: 900 }, good), null);
    assert.equal(containRect({ width: 1600, height: 900 }, box(bad, 0, 400, 300)), null);
    assert.equal(toFraction({ x: bad, y: 10 }, good), null);
    assert.equal(fromFraction({ x: bad, y: 0.5 }, good), null);
  }
  assert.equal(toFraction({ x: 10, y: 10 }, box(0, 0, 0, 0)), null);
});

/* -------------------------------------------------------------- rounding */

test("stored precision is decided in one place: four places of a fraction, a millisecond", () => {
  assert.equal(roundFraction(0.123456), 0.1235);
  assert.equal(roundFraction(0.99996), 1);
  assert.equal(roundFraction(0), 0);
  assert.equal(roundFraction(1), 1);
  assert.equal(roundFraction(0.00004), 0);

  // Every rounded fraction of an inside point is still inside.
  for (let i = 0; i <= 1000; i++) {
    const value = roundFraction(i / 1000 + 0.00003 * ((i % 3) - 1));
    if (i === 0 || i === 1000) continue;
    assert.ok(value >= 0 && value <= 1, String(value));
  }

  assert.equal(roundSeconds(42.123456), 42.123);
  assert.equal(roundSeconds(90_000.0004), 90_000);
});

/* ----------------------------------------------------------------- purity */

test("the geometry never reaches for the page", () => {
  const source = readFileSync("lib/workrooms/anchor-geometry.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  for (const reach of [
    "getBoundingClientRect",
    "naturalWidth",
    "naturalHeight",
    "videoWidth",
    "videoHeight",
    "window",
    "document",
    "import ",
  ]) {
    assert.ok(!source.includes(reach), `the geometry module uses ${reach}`);
  }
});
