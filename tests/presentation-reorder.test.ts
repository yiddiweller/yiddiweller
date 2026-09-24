import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";

import { and, asc, eq, sql } from "drizzle-orm";

import { closeDb, db } from "../lib/db/index.ts";
import {
  addNoteItem,
  createPresentation,
  draftPreview,
  findPresentation,
  listDraftRows,
  moveItem,
  publishPresentation,
  removeItem,
} from "../lib/db/presentations.ts";
import { createReviewNote, reviewPanelForStaff } from "../lib/db/reviews.ts";
import { presentationItems, presentationRevisionItems, presentationRevisions } from "../lib/db/schema.ts";
import { readSnapshot } from "../lib/workrooms/presentation-view.ts";
import { clearOwner, live, owner, round, seedOwner, stage } from "./support/review-stage.ts";

/**
 * Move up and Move down — the Stage B defect F1's tests found.
 *
 * `moveItem` parked the moving row at position `-1` before exchanging the two
 * positions, and `presentation_items_position_check` (`position >= 0`)
 * refused the parking write, so the press threw and nothing ever moved. The
 * only test of it used a stale version and was refused before the write, so
 * the one path that mattered was never run. Every test here runs the write,
 * against PostgreSQL, because that is where the defect lived.
 *
 * A draft's positions are an **ordering key**, not a sequence: removal leaves
 * gaps and additions take `max + 1`. So a move exchanges the two rows'
 * existing positions with the neighbour **that exists** — never `±1` — and the
 * set of positions in the draft is the same after a move as before it.
 */

before(seedOwner);

after(async () => {
  await clearOwner();
  await closeDb();
});

/** A fresh draft of notes, captioned by letter, in the fixture's Workroom. */
async function draft(captions: string[]): Promise<string> {
  const s = await stage();
  const made = await createPresentation(owner, s.workroomId, { title: "Order", intro: "" });
  assert.ok(made.ok);
  for (const caption of captions) {
    const added = await addNoteItem(owner, made.value, await version(made.value), { caption, body: "Words." });
    assert.ok(added.ok);
  }
  return made.value;
}

async function version(presentationId: string): Promise<number> {
  return (await findPresentation(presentationId))!.version;
}

/** The draft as `caption@position`, in order — identity and key together. */
async function order(presentationId: string): Promise<string[]> {
  return (await listDraftRows(presentationId)).map((row) => `${row.caption}@${row.position}`);
}

async function idOf(presentationId: string, caption: string): Promise<string> {
  return (await listDraftRows(presentationId)).find((row) => row.caption === caption)!.id;
}

async function move(presentationId: string, caption: string, direction: "up" | "down") {
  return moveItem(owner, presentationId, await version(presentationId), await idOf(presentationId, caption), direction);
}

/** Every position non-negative and distinct: nothing parked, nothing doubled. */
async function sound(presentationId: string): Promise<void> {
  const positions = (await listDraftRows(presentationId)).map((row) => row.position);
  assert.ok(positions.every((position) => position >= 0), `a negative position survived: ${positions}`);
  assert.equal(new Set(positions).size, positions.length, `two blocks share a position: ${positions}`);
}

/* ------------------------------------------------------------ the swap */

test("moving a block up exchanges it with the one above", async () => {
  const id = await draft(["A", "B", "C"]);
  const before = await version(id);

  const moved = await move(id, "B", "up");
  assert.ok(moved.ok, moved.ok ? "" : moved.message);

  assert.deepEqual(await order(id), ["B@0", "A@1", "C@2"]);
  await sound(id);
  assert.equal(await version(id), before + 1, "a move is a draft edit and advances the version once");
});

test("moving a block down exchanges it with the one below", async () => {
  const id = await draft(["A", "B", "C"]);

  const moved = await move(id, "B", "down");
  assert.ok(moved.ok, moved.ok ? "" : moved.message);

  assert.deepEqual(await order(id), ["A@0", "C@1", "B@2"]);
  await sound(id);
});

test("a move and its reverse put the draft back exactly", async () => {
  const id = await draft(["A", "B", "C", "D"]);
  const start = await order(id);

  assert.ok((await move(id, "C", "up")).ok);
  assert.deepEqual(await order(id), ["A@0", "C@1", "B@2", "D@3"]);
  assert.ok((await move(id, "C", "down")).ok);
  assert.deepEqual(await order(id), start);
});

/* --------------------------------------------------------- sparse keys */

test("with gaps in the draft, a block swaps with the neighbour that exists", async () => {
  const id = await draft(["A", "B", "C", "D", "E", "F"]);
  for (const gone of ["B", "D", "E"]) {
    assert.ok((await removeItem(owner, id, await version(id), await idOf(id, gone))).ok);
  }
  assert.deepEqual(await order(id), ["A@0", "C@2", "F@5"], "the fixture is not sparse");

  // Up from 5: the block above is at 2, not 4.
  assert.ok((await move(id, "F", "up")).ok);
  assert.deepEqual(await order(id), ["A@0", "F@2", "C@5"]);

  // Down from 0: the block below is at 2, not 1.
  assert.ok((await move(id, "A", "down")).ok);
  assert.deepEqual(await order(id), ["F@0", "A@2", "C@5"]);

  // The keys are the same three keys: nothing renumbered, nothing invented.
  await sound(id);
  assert.deepEqual((await listDraftRows(id)).map((row) => row.position), [0, 2, 5]);
});

/* --------------------------------------------------------------- edges */

test("the first block up and the last block down change nothing, as before", async () => {
  // The existing convention: an edge move is a quiet success that writes
  // nothing — no version, no audit — because the page offers both controls on
  // every block and pressing one at the edge is not an error.
  const id = await draft(["A", "B", "C"]);
  const start = await order(id);
  const before = await version(id);

  const up = await move(id, "A", "up");
  assert.ok(up.ok);
  const down = await move(id, "C", "down");
  assert.ok(down.ok);

  assert.deepEqual(await order(id), start);
  assert.equal(await version(id), before, "an edge move wrote something");
});

test("a block that is not in this draft is refused", async () => {
  const id = await draft(["A", "B"]);
  const other = await draft(["X", "Y"]);

  const foreign = await moveItem(owner, id, await version(id), await idOf(other, "Y"), "up");
  assert.ok(!foreign.ok);
  assert.equal(foreign.reason, "not_found");
  assert.deepEqual(await order(other), ["X@0", "Y@1"]);
});

/* ------------------------------------------------------ never negative */

test("PostgreSQL refuses a negative position, and the domain never asks for one", async () => {
  const id = await draft(["A", "B", "C"]);

  // The constraint that caught the old code is still in force…
  await assert.rejects(
    db().update(presentationItems).set({ position: -1 }).where(eq(presentationItems.id, await idOf(id, "B"))),
    (error: unknown) => /presentation_items_position_check/.test(String((error as { cause?: unknown }).cause ?? error)),
  );

  // …every direction from every place succeeds against it…
  for (const caption of ["A", "B", "C"]) {
    for (const direction of ["up", "down"] as const) {
      const moved = await move(id, caption, direction);
      assert.ok(moved.ok, `${caption} ${direction}: ${moved.ok ? "" : moved.message}`);
      await sound(id);
    }
  }

  // …and nothing in the domain writes a position it did not read.
  const source = readFileSync("lib/db/presentations.ts", "utf8");
  assert.ok(!/position:\s*-/.test(source), "the domain writes a negative position literal");
});

/* ----------------------------------------------------------- atomicity */

test("a move that fails half-way leaves the order and the version as they were", async () => {
  const id = await draft(["A", "B", "C"]);
  const start = await order(id);
  const before = await version(id);
  const a = await idOf(id, "A");

  // Refuse the second of the two row writes — the neighbour's — so the first
  // has already happened inside the transaction when it fails.
  await db().execute(sql.raw(`
    CREATE OR REPLACE FUNCTION reorder_test_refuse() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'reorder test: refused'; END $$ LANGUAGE plpgsql;
    CREATE TRIGGER reorder_test_refuse BEFORE UPDATE OF position ON presentation_items
      FOR EACH ROW WHEN (OLD.id = '${a}') EXECUTE FUNCTION reorder_test_refuse();
  `));
  try {
    await assert.rejects(move(id, "B", "up"), /reorder test: refused|Failed query/);
  } finally {
    await db().execute(sql.raw(`
      DROP TRIGGER reorder_test_refuse ON presentation_items;
      DROP FUNCTION reorder_test_refuse();
    `));
  }

  assert.deepEqual(await order(id), start, "half a swap survived");
  assert.equal(await version(id), before, "the version moved for a swap that did not happen");

  // And the same move works once nothing is in the way.
  assert.ok((await move(id, "B", "up")).ok);
  assert.deepEqual(await order(id), ["B@0", "A@1", "C@2"]);
});

/* --------------------------------------------------------- concurrency */

test("a stale move is refused and changes nothing", async () => {
  const id = await draft(["A", "B", "C"]);
  const stale = await version(id);
  assert.ok((await move(id, "C", "up")).ok);
  const after = await order(id);

  const late = await moveItem(owner, id, stale, await idOf(id, "C"), "up");
  assert.ok(!late.ok);
  assert.equal(late.reason, "conflict");
  assert.deepEqual(await order(id), after);
});

test("two moves from the same page: one wins, one is refused, and the order is the winner's", async () => {
  const id = await draft(["A", "B", "C", "D"]);
  const seen = await version(id);
  const b = await idOf(id, "B");
  const c = await idOf(id, "C");

  // Different blocks, overlapping neighbours: B up and C up.
  const [one, two] = await Promise.all([
    moveItem(owner, id, seen, b, "up"),
    moveItem(owner, id, seen, c, "up"),
  ]);
  const outcomes = [one, two];
  assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1, "both moves won, or neither did");
  const loser = outcomes.find((outcome) => !outcome.ok);
  assert.equal(loser && !loser.ok && loser.reason, "conflict");

  const result = await order(id);
  assert.ok(
    JSON.stringify(result) === JSON.stringify(["B@0", "A@1", "C@2", "D@3"]) ||
      JSON.stringify(result) === JSON.stringify(["A@0", "C@1", "B@2", "D@3"]),
    `the order is neither winner's alone: ${result}`,
  );
  await sound(id);
  assert.equal(await version(id), seen + 1);

  // The same press twice: moved once, not moved and moved back.
  const again = await version(id);
  const top = (await listDraftRows(id))[2]!.id;
  const [first, second] = await Promise.all([
    moveItem(owner, id, again, top, "up"),
    moveItem(owner, id, again, top, "up"),
  ]);
  assert.equal([first, second].filter((outcome) => outcome.ok).length, 1);
  assert.equal((await listDraftRows(id))[1]!.id, top, "a double press moved the block twice, or not at all");
  await sound(id);
});

/* ------------------------------------------------- Revisions stay put */

/** A Revision's order and its relational rows, as one comparable value. */
async function frozen(presentationId: string, revisionNumber: number) {
  const [revision] = await db()
    .select({ id: presentationRevisions.id, snapshot: presentationRevisions.snapshot })
    .from(presentationRevisions)
    .where(
      and(
        eq(presentationRevisions.presentationId, presentationId),
        eq(presentationRevisions.revisionNumber, revisionNumber),
      ),
    );
  assert.ok(revision, `Revision ${revisionNumber} does not exist`);
  const rows = await db()
    .select({
      position: presentationRevisionItems.position,
      caption: presentationRevisionItems.caption,
      kind: presentationRevisionItems.kind,
    })
    .from(presentationRevisionItems)
    .where(eq(presentationRevisionItems.presentationRevisionId, revision.id))
    .orderBy(asc(presentationRevisionItems.position));
  return {
    snapshot: JSON.stringify(revision.snapshot),
    captions: readSnapshot(revision.snapshot).items.map((item) => `${item.caption}@${item.position}`),
    rows: rows.map((row) => `${row.caption}@${row.position}`),
  };
}

test("a reorder changes the draft and the next Revision, never one already published", async () => {
  // Revision 2 of the fixture: One, The board, The motion, The sound, The deck.
  const s = await stage();
  const id = s.presentationId;

  // Feedback on Revision 2's image, precise and item-level, before anything moves.
  const reviewId = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId, body: "This.", itemPosition: 1, anchor: { kind: "point", x: 0.4, y: 0.2 } })).ok);
  assert.ok((await createReviewNote(s.ben, { reviewId, body: "And the sound.", itemPosition: 3 })).ok);

  const revision2 = await frozen(id, 2);
  assert.deepEqual(revision2.captions, ["One@0", "The board@1", "The motion@2", "The sound@3", "The deck@4"]);

  // Move the motion above the board.
  assert.ok((await move(id, "The motion", "up")).ok);
  assert.deepEqual(await order(id), ["One@0", "The motion@1", "The board@2", "The sound@3", "The deck@4"]);

  // Preview follows the draft, not the published version…
  const preview = await draftPreview((await findPresentation(id))!);
  assert.deepEqual(
    preview.items.map((item) => item.caption),
    ["One", "The motion", "The board", "The sound", "The deck"],
  );
  // …and Revision 2 has not moved at all, row or snapshot.
  assert.deepEqual(await frozen(id, 2), revision2);

  // Publishing freezes the new order as Revision 3.
  const published = await publishPresentation(owner, id, await version(id));
  assert.ok(published.ok, published.ok ? "" : published.message);
  assert.equal(published.value.revision, 3);
  const revision3 = await frozen(id, 3);
  assert.deepEqual(revision3.captions, ["One@0", "The motion@1", "The board@2", "The sound@3", "The deck@4"]);
  assert.deepEqual(revision3.rows, revision3.captions, "Revision 3's rows and snapshot disagree");
  assert.deepEqual(await frozen(id, 2), revision2, "publishing Revision 3 touched Revision 2");

  // Revision 2's feedback still names Revision 2's blocks, anchor included.
  const panel = await reviewPanelForStaff({ userId: owner.id }, s.workroomId, id, 2);
  const [onImage, onSound] = panel.review!.notes;
  assert.equal(live(onImage).subject, 1);
  assert.deepEqual(live(onImage).anchor, { kind: "point", x: 0.4, y: 0.2 });
  assert.equal(revision2.captions[live(onImage).subject!], "The board@1");
  assert.equal(live(onSound).subject, 3);
  assert.equal(revision2.captions[live(onSound).subject!], "The sound@3");
});
