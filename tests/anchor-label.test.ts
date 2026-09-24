import assert from "node:assert/strict";
import { test } from "node:test";

import { anchorPhrase, formatDuration, momentLabel, rangeLabel } from "../lib/workrooms/anchor-label.ts";

/**
 * How an anchor is said.
 *
 * A duration, never a time of day: the one mistake this module exists to make
 * impossible is a clock formatter turning 25 hours back into 1:00:00.
 */

test("a duration is counted, not told like a clock", () => {
  const table: [number, string][] = [
    [0, "0:00"],
    [0.999, "0:00"],
    [9, "0:09"],
    [42, "0:42"],
    [59, "0:59"],
    [60, "1:00"],
    [61, "1:01"],
    [599, "9:59"],
    [600, "10:00"],
    [3599, "59:59"],
    [3600, "1:00:00"],
    [3737, "1:02:17"],
    [7384, "2:03:04"],
    [86_399, "23:59:59"],
    [86_400, "24:00:00"],
    [90_188, "25:03:08"],
    [360_000, "100:00:00"],
  ];

  for (const [seconds, expected] of table) {
    assert.equal(formatDuration(seconds), expected, `${seconds}s`);
  }
});

test("whole seconds only, the ones the player's clock showed", () => {
  assert.equal(formatDuration(42.999), "0:42");
  assert.equal(momentLabel(42.7), "At 0:42");
});

test("a moment and a stretch read naturally", () => {
  assert.equal(momentLabel(42), "At 0:42");
  assert.equal(momentLabel(72), "At 1:12");
  assert.equal(momentLabel(90_188), "At 25:03:08");

  assert.equal(rangeLabel(42, 51), "0:42–0:51");
  assert.equal(rangeLabel(42.2, 51.7), "0:42–0:51");
  assert.equal(rangeLabel(72, 84), "1:12–1:24");
  assert.equal(rangeLabel(3590, 3650), "59:50–1:00:50");
  assert.equal(rangeLabel(90_000, 90_188), "25:00:00–25:03:08");
});

test("a stretch under a second still has two different ends", () => {
  assert.equal(rangeLabel(42.2, 42.8), "0:42–0:43");
  assert.equal(rangeLabel(42, 42.001), "0:42–0:43");
  assert.equal(rangeLabel(41.9, 42.1), "0:41–0:42");
});

test("anything that is not a moment is not labelled", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assert.equal(formatDuration(bad), null);
    assert.equal(momentLabel(bad), null);
  }
  assert.equal(rangeLabel(10, 4), null);
  assert.equal(rangeLabel(10, 10), null);
  assert.equal(rangeLabel(10, Number.NaN), null);
});

test("each kind of anchor has a phrase, and none shows a coordinate", () => {
  assert.equal(anchorPhrase({ kind: "point", x: 0.42, y: 0.18 }), "a point");
  assert.equal(anchorPhrase({ kind: "region", x: 0.1, y: 0.1, w: 0.2, h: 0.2 }), "an area");
  assert.equal(anchorPhrase({ kind: "time", t: 42 }), "At 0:42");
  assert.equal(anchorPhrase({ kind: "time", t: 42, t2: 51 }), "0:42–0:51");
  assert.equal(
    anchorPhrase({ kind: "time", t: 42, region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }),
    "At 0:42, an area",
  );

  for (const anchor of [
    { kind: "point" as const, x: 0.42, y: 0.18 },
    { kind: "region" as const, x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
  ]) {
    assert.ok(!/\d/.test(anchorPhrase(anchor)!), "a coordinate reached the words");
  }
});
