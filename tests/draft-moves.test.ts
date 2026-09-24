import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";

import { closeDb } from "../lib/db/index.ts";
import {
  addNoteItem,
  createPresentation,
  findPresentation,
  listDraftRows,
  moveItem,
  removeItem,
} from "../lib/db/presentations.ts";
import { draftMoves } from "../lib/workrooms/draft-moves.ts";
import { clearOwner, owner, seedOwner, stage } from "./support/review-stage.ts";

/**
 * Which reorder controls a draft block is drawn with.
 *
 * Decided by the block's place in the list the page renders — never its
 * `position`, which has gaps — and a control that could do nothing is not
 * drawn at all. The rendered page is checked over HTTP in
 * `draft-moves-http.test.ts`; `presentation-reorder.test.ts` keeps the
 * server's own quiet no-op for an edge move, which stays as a defence against
 * a crafted or stale request.
 */

before(seedOwner);

after(async () => {
  await clearOwner();
  await closeDb();
});

/** The controls for a whole list, as the page would draw them. */
function controls(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const moves = draftMoves(index, count);
    return [moves.up ? "up" : "", moves.down ? "down" : ""].filter(Boolean).join("+") || "none";
  });
}

test("one block is offered neither move", () => {
  assert.deepEqual(controls(1), ["none"]);
});

test("two blocks: the first moves down only, the second up only", () => {
  assert.deepEqual(controls(2), ["down", "up"]);
});

test("three blocks: first down only, middle both, last up only", () => {
  assert.deepEqual(controls(3), ["down", "up+down", "up"]);
  assert.deepEqual(controls(5), ["down", "up+down", "up+down", "up+down", "up"]);
});

test("nothing to draw for a place that is not in the list", () => {
  for (const [index, count] of [
    [0, 0],
    [-1, 3],
    [3, 3],
    [1.5, 3],
    [Number.NaN, 3],
  ]) {
    assert.deepEqual(draftMoves(index!, count!), { up: false, down: false }, `${index} of ${count}`);
  }
});

test("a sparse draft is judged by its order, not by its numbers", async () => {
  const s = await stage();
  const made = await createPresentation(owner, s.workroomId, { title: "Gaps", intro: "" });
  assert.ok(made.ok);
  const id = made.value;
  const version = async () => (await findPresentation(id))!.version;
  for (const caption of ["A", "B", "C", "D", "E", "F"]) {
    assert.ok((await addNoteItem(owner, id, await version(), { caption, body: "Words." })).ok);
  }
  for (const gone of ["B", "D", "E"]) {
    const row = (await listDraftRows(id)).find((item) => item.caption === gone)!;
    assert.ok((await removeItem(owner, id, await version(), row.id)).ok);
  }

  // The reader the page renders from, in the order it renders.
  const rows = await listDraftRows(id);
  assert.deepEqual(rows.map((row) => row.position), [0, 2, 5], "the fixture is not sparse");

  const drawn = rows.map((row, index) => ({ caption: row.caption, ...draftMoves(index, rows.length) }));
  assert.deepEqual(drawn, [
    { caption: "A", up: false, down: true },
    { caption: "C", up: true, down: true },
    { caption: "F", up: true, down: false },
  ]);

  // Judged by numbers it would go wrong both ways: 5 is not `count - 1`, and
  // after a move the first block sits at 0 while the one at 2 is no longer
  // anybody's neighbour by arithmetic.
  assert.ok((await moveItem(owner, id, await version(), rows[2]!.id, "up")).ok);
  const after = await listDraftRows(id);
  assert.deepEqual(after.map((row) => `${row.caption}@${row.position}`), ["A@0", "F@2", "C@5"]);
  assert.deepEqual(
    after.map((row, index) => ({ caption: row.caption, ...draftMoves(index, after.length) })),
    [
      { caption: "A", up: false, down: true },
      { caption: "F", up: true, down: true },
      { caption: "C", up: true, down: false },
    ],
    "the controls did not follow the block to its new place",
  );
});

test("the page draws each move only when the rule allows it, and never asks a position", () => {
  const page = readFileSync("app/studio/(app)/workrooms/[id]/presentations/[pid]/page.tsx", "utf8");

  assert.match(page, /items\.map\(\(item, index\) =>/);
  assert.match(page, /draftMoves\(index, items\.length\)/);
  // Each control sits inside its own condition, so an impossible one is not
  // in the markup at all — not hidden, not disabled.
  assert.match(page, /\{moves\.up \? \(\s*<RecordAction[\s\S]*?direction: "up"[\s\S]*?\) : null\}/);
  assert.match(page, /\{moves\.down \? \(\s*<RecordAction[\s\S]*?direction: "down"[\s\S]*?\) : null\}/);
  assert.equal(page.match(/label="Move up"/g)?.length, 1);
  assert.equal(page.match(/label="Move down"/g)?.length, 1);
  assert.doesNotMatch(page, /position\s*===\s*0|aria-disabled|disabled=\{/);
});
