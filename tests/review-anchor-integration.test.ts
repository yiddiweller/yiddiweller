import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { and, eq, max } from "drizzle-orm";

import { closeDb, db } from "../lib/db/index.ts";
import { uuidv7 } from "../lib/db/id.ts";
import {
  addFileItem,
  findPresentation,
  listDraftRows,
  publishPresentation,
  removeItem,
} from "../lib/db/presentations.ts";
import {
  createReviewNote,
  requestReview,
  reviewPanelForStaff,
  type ClientActor,
} from "../lib/db/reviews.ts";
import {
  presentationReviewNotes,
  presentationRevisionItems,
  presentationRevisions,
  workroomFiles,
} from "../lib/db/schema.ts";
import { viewersByPosition } from "../lib/workrooms/presentation-view.ts";
import { clearOwner, live, owner, round, seedOwner, stage, staff, type Stage } from "./support/review-stage.ts";

/**
 * One rule for where a comment may point, asked in both directions against a
 * real database.
 *
 * Until F1 the domain and the projection each carried their own anchor check,
 * and they had already drifted: the projection accepted keys the domain
 * refused, and it had no way to ask whether a moment belonged on an image at
 * all. These tests pin that the two now agree — by writing through the domain,
 * and by **planting rows straight into PostgreSQL** that the coarse CHECK in
 * `0006` lets through and the parser does not, then reading them back.
 *
 * Revision 2 of the fixture: 0 note, 1 image, 2 video, 3 audio, 4 pdf.
 */

before(seedOwner);

after(async () => {
  await clearOwner();
  await closeDb();
});

const IMAGE = 1;
const VIDEO = 2;
const AUDIO = 3;
const PDF = 4;
const NOTE = 0;

/** The round as Studio reads it — the same projection the client reads. */
async function projected(s: Stage, revisionNumber?: number) {
  const panel = await reviewPanelForStaff({ userId: owner.id }, s.workroomId, s.presentationId, revisionNumber);
  assert.ok(panel.review, "the round did not project at all");
  return panel.review.notes;
}

/**
 * A note written past the domain, the way a row from an older build — or a
 * hand-written SQL fix — would reach the table. Only the CHECK constraints in
 * `0006` stand between it and the column.
 */
async function plant(s: Stage, reviewId: string, position: number, anchor: unknown): Promise<number> {
  const current = (await findPresentation(s.presentationId))!.currentRevisionId!;
  const [item] = await db()
    .select({ id: presentationRevisionItems.id })
    .from(presentationRevisionItems)
    .where(
      and(
        eq(presentationRevisionItems.presentationRevisionId, current),
        eq(presentationRevisionItems.position, position),
      ),
    );
  assert.ok(item, `position ${position} is not in the current Revision`);

  const [top] = await db()
    .select({ n: max(presentationReviewNotes.number) })
    .from(presentationReviewNotes)
    .where(eq(presentationReviewNotes.presentationReviewId, reviewId));
  const number = (top?.n ?? 0) + 1;

  await db().insert(presentationReviewNotes).values({
    id: uuidv7(),
    workroomId: s.workroomId,
    presentationReviewId: reviewId,
    presentationRevisionId: current,
    number,
    parentNoteId: null,
    isRoot: true,
    parentIsRoot: null,
    revisionItemId: item.id,
    anchor,
    body: `Planted ${number}.`,
    authorSide: "client",
    authorIdentityId: s.ana.identityId,
    authorName: s.ana.name,
  });
  return number;
}

async function write(actor: ClientActor, reviewId: string, itemPosition: number, anchor: unknown) {
  return createReviewNote(actor, { reviewId, body: "Here.", itemPosition, anchor });
}

/* ------------------------------------------------------ through the domain */

test("every shape a viewer can draw is accepted, stored and read back exactly", async () => {
  const s = await stage();
  const id = await round(s);

  const cases: [number, unknown][] = [
    [IMAGE, { kind: "point", x: 0.42, y: 0.18 }],
    [IMAGE, { kind: "point", x: 0, y: 1 }],
    [IMAGE, { kind: "region", x: 0.1, y: 0.2, w: 0.3, h: 0.4 }],
    [IMAGE, { kind: "region", x: 0, y: 0, w: 1, h: 1 }],
    [VIDEO, { kind: "time", t: 42.125 }],
    [VIDEO, { kind: "time", t: 42, t2: 51.5 }],
    [VIDEO, { kind: "time", t: 42, region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }],
    [AUDIO, { kind: "time", t: 0 }],
    [AUDIO, { kind: "time", t: 12, t2: 18 }],
  ];

  for (const [position, anchor] of cases) {
    const made = await write(s.ana, id, position, anchor);
    assert.ok(made.ok, `refused ${JSON.stringify(anchor)}: ${made.ok ? "" : made.message}`);
  }

  const notes = await projected(s);
  assert.equal(notes.length, cases.length);
  cases.forEach(([position, anchor], index) => {
    const note = live(notes[index]);
    assert.equal(note.subject, position);
    assert.deepEqual(note.anchor, anchor, `note ${note.n} did not come back as it went in`);
  });
});

test("there is no ceiling on a moment — a long recording is still addressable past a day", async () => {
  const s = await stage();
  const id = await round(s);

  for (const anchor of [
    { kind: "time", t: 86_401 },
    { kind: "time", t: 90_188, t2: 90_200 },
    { kind: "time", t: 360_000.5 },
  ]) {
    const made = await write(s.ana, id, VIDEO, anchor);
    assert.ok(made.ok, `refused ${JSON.stringify(anchor)}: ${made.ok ? "" : made.message}`);
  }

  const notes = await projected(s);
  assert.deepEqual(live(notes[0]).anchor, { kind: "time", t: 86_401 });
  assert.deepEqual(live(notes[2]).anchor, { kind: "time", t: 360_000.5 });
});

test("the domain refuses what the viewer cannot draw, and what is not inside the work", async () => {
  const s = await stage();
  const id = await round(s);

  const refusals: [number, unknown, RegExp][] = [
    // Nothing else in the object. The words are the kind's own — a stray key
    // arrives only from a crafted request, never from anything we draw.
    [IMAGE, { kind: "point", x: 0.4, y: 0.2, label: "extra" }, /point is not inside the image/],
    [IMAGE, { kind: "region", x: 0.1, y: 0.1, w: 0.2, h: 0.2, z: 1 }, /area is not inside the image/],
    [VIDEO, { kind: "time", t: 3, t3: 9 }, /not a moment in this file/],
    [VIDEO, { kind: "time", t: 3, region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2, z: 1 } }, /area is not inside the picture/],
    // The wrong kind for the viewer the Revision froze.
    [VIDEO, { kind: "point", x: 0.4, y: 0.2 }, /point belongs on an image/],
    [IMAGE, { kind: "time", t: 3 }, /moment belongs in something that plays/],
    [AUDIO, { kind: "time", t: 3, region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }, /no picture to point at/],
    [PDF, { kind: "point", x: 0.4, y: 0.2 }, /takes feedback as a whole/],
    [NOTE, { kind: "point", x: 0.4, y: 0.2 }, /nothing to point at in a written note/],
    // An area with no size, or one that runs off the picture.
    [IMAGE, { kind: "region", x: 0.1, y: 0.1, w: 0, h: 0.2 }, /area is not inside the image/],
    [IMAGE, { kind: "region", x: 0.1, y: 0.1, w: 0.2, h: 0 }, /area is not inside the image/],
    [IMAGE, { kind: "region", x: 0.8, y: 0.1, w: 0.3, h: 0.2 }, /area is not inside the image/],
    [IMAGE, { kind: "region", x: 0.1, y: 0.9, w: 0.2, h: 0.2 }, /area is not inside the image/],
    [VIDEO, { kind: "time", t: 1, region: { x: 0.9, y: 0.1, w: 0.2, h: 0.2 } }, /area is not inside the picture/],
    // A stretch that does not go forwards.
    [VIDEO, { kind: "time", t: 10, t2: 4 }, /has to end after it starts/],
    [AUDIO, { kind: "time", t: 10, t2: 10 }, /has to end after it starts/],
    [VIDEO, { kind: "time", t: -1 }, /not a moment in this file/],
    [VIDEO, { kind: "time", t: 10, t2: Number.NaN }, /not a moment in this file/],
  ];

  for (const [position, anchor, expected] of refusals) {
    const made = await write(s.ana, id, position, anchor);
    assert.ok(!made.ok, `accepted ${JSON.stringify(anchor)} at position ${position}`);
    assert.equal(made.reason, "invalid");
    assert.match(made.message, expected, `${JSON.stringify(anchor)} was refused as: ${made.message}`);
  }

  const notes = await projected(s);
  assert.equal(notes.length, 0, "a refused anchor still wrote a note");
});

/* ------------------------------------------------- past the domain, read back */

test("a stored anchor the parser refuses is dropped on the way out, and the note and its block stay", async () => {
  const s = await stage();
  const id = await round(s);

  // Every one of these passes 0006's CHECK — it is coarse on purpose — and
  // every one is something the domain would refuse.
  const planted: [number, unknown, string][] = [
    [IMAGE, { kind: "point", x: 0.4, y: 0.2, label: "extra" }, "an extra key"],
    [IMAGE, { kind: "region", x: 0.1, y: 0.1, w: 0, h: 0.2 }, "a region with no width"],
    [IMAGE, { kind: "region", x: 0.8, y: 0.1, w: 0.3, h: 0.2 }, "a region off the right edge"],
    [IMAGE, { kind: "region", x: 0.1, y: 0.9, w: 0.2, h: 0.2 }, "a region off the bottom edge"],
    [VIDEO, { kind: "time", t: 1, region: { x: 0.9, y: 0, w: 0.2, h: 0.2 } }, "a frame region off the picture"],
    [VIDEO, { kind: "time", t: 1, region: "everywhere" }, "a frame region that is not an area"],
    [IMAGE, { kind: "time", t: 3 }, "a moment on an image"],
    [VIDEO, { kind: "point", x: 0.4, y: 0.2 }, "a point on a video"],
    [AUDIO, { kind: "time", t: 3, region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }, "a frame region on audio"],
    [PDF, { kind: "point", x: 0.4, y: 0.2 }, "a point on a PDF"],
    [NOTE, { kind: "point", x: 0.4, y: 0.2 }, "a point on a written note"],
  ];

  for (const [position, anchor] of planted) await plant(s, id, position, anchor);

  const notes = await projected(s);
  assert.equal(notes.length, planted.length, "a note with a bad anchor disappeared entirely");
  planted.forEach(([position, , what], index) => {
    const note = live(notes[index], what);
    assert.equal(note.subject, position, `${what}: the block was lost with the anchor`);
    assert.equal(note.anchor, undefined, `${what} was projected`);
    assert.equal("anchor" in note, false, `${what} left an empty anchor key behind`);
  });
});

test("the projection agrees with the domain where the old one did not", async () => {
  // Measured against the pre-F1 projection, which checked numbers and keys it
  // knew about and nothing else: it returned all three of these. The domain
  // never would have stored them.
  const s = await stage();
  const id = await round(s);

  const extraKey = await plant(s, id, IMAGE, { kind: "point", x: 0.4, y: 0.2, label: "extra" });
  const momentOnImage = await plant(s, id, IMAGE, { kind: "time", t: 3 });
  const overflowing = await plant(s, id, IMAGE, { kind: "region", x: 0.8, y: 0.1, w: 0.3, h: 0.2 });

  for (const [n, anchor] of [
    [extraKey, { kind: "point", x: 0.4, y: 0.2, label: "extra" }],
    [momentOnImage, { kind: "time", t: 3 }],
    [overflowing, { kind: "region", x: 0.8, y: 0.1, w: 0.3, h: 0.2 }],
  ] as const) {
    const domain = await write(s.ana, id, IMAGE, anchor);
    assert.ok(!domain.ok, `the domain accepted what note ${n} holds`);

    const shown = live((await projected(s)).find((note) => note.n === n));
    assert.equal(shown.anchor, undefined, `note ${n} was shown an anchor the domain refuses`);
  }
});

test("a valid stored anchor planted past the domain reads back exactly as one written through it", async () => {
  const s = await stage();
  const id = await round(s);

  const valid: [number, unknown][] = [
    [IMAGE, { kind: "point", x: 0.5, y: 0.5 }],
    [IMAGE, { kind: "region", x: 0.25, y: 0.25, w: 0.5, h: 0.5 }],
    [VIDEO, { kind: "time", t: 90_188 }],
    [VIDEO, { kind: "time", t: 1, t2: 2 }],
    [VIDEO, { kind: "time", t: 1, region: { x: 0, y: 0, w: 1, h: 1 } }],
    [AUDIO, { kind: "time", t: 7, t2: 7.5 }],
  ];
  for (const [position, anchor] of valid) await plant(s, id, position, anchor);

  const notes = await projected(s);
  valid.forEach(([position, anchor], index) => {
    const note = live(notes[index]);
    assert.equal(note.subject, position);
    assert.deepEqual(note.anchor, anchor);
  });
});

/* ---------------------------------------------------- the viewer is frozen */

test("an anchor is judged by the viewer its own Revision froze, not by today's file or today's order", async () => {
  const s = await stage();
  const id = await round(s);

  const point = await write(s.ana, id, IMAGE, { kind: "point", x: 0.42, y: 0.18 });
  assert.ok(point.ok);

  // Move the image to the end of the draft — out, and back in last — so the
  // video takes its place, and publish. The draft is sparse afterwards
  // (0, 2, 3, 4, 5), which Revision 3 numbers densely.
  const v = async () => (await findPresentation(s.presentationId))!.version;
  const board = (await listDraftRows(s.presentationId)).find((row) => row.caption === "The board")!;
  assert.ok((await removeItem(owner, s.presentationId, await v(), board.id)).ok);
  assert.ok((await addFileItem(owner, s.presentationId, await v(), board.fileId!, "The board")).ok);
  const published = await publishPresentation(owner, s.presentationId, await v());
  assert.ok(published.ok, published.ok ? "" : published.message);

  // Position 1 is now a video in the current Revision…
  const current = (await findPresentation(s.presentationId))!.currentRevisionId!;
  const [revision3] = await db()
    .select({ number: presentationRevisions.revisionNumber, snapshot: presentationRevisions.snapshot })
    .from(presentationRevisions)
    .where(eq(presentationRevisions.id, current));
  assert.equal(revision3!.number, 3);
  assert.equal(viewersByPosition(revision3!.snapshot).get(IMAGE), "video");

  // …and a point there is refused, because Revision 3 shows a video there.
  const next = await requestReview(staff, current);
  assert.ok(next.ok);
  const onVideo = await write(s.ana, next.value, IMAGE, { kind: "point", x: 0.42, y: 0.18 });
  assert.ok(!onVideo.ok);
  assert.match(onVideo.message, /point belongs on an image/);

  // Revision 2's round, now history, still shows its point on its image.
  const history = await projected(s, 2);
  const kept = live(history[0]);
  assert.equal(kept.subject, IMAGE);
  assert.deepEqual(kept.anchor, { kind: "point", x: 0.42, y: 0.18 });

  // And the live file row is not consulted at all: turn the image into a PDF
  // underneath it, and Revision 2 still knows it showed an image.
  await db()
    .update(workroomFiles)
    .set({ contentType: "application/pdf" })
    .where(and(eq(workroomFiles.workroomId, s.workroomId), eq(workroomFiles.displayName, "Board.png")));
  assert.deepEqual(live((await projected(s, 2))[0]).anchor, { kind: "point", x: 0.42, y: 0.18 });
});
