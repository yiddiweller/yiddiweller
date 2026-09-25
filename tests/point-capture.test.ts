import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";

import { and, eq, isNull } from "drizzle-orm";

import { closeDb, db } from "../lib/db/index.ts";
import { addFileItem, createPresentation, findPresentation, publishPresentation } from "../lib/db/presentations.ts";
import { createReviewNote, requestReview } from "../lib/db/reviews.ts";
import {
  auditEvents,
  presentationReviewNotes,
  presentationRevisionItems,
  presentationRevisions,
} from "../lib/db/schema.ts";
import { roundFraction } from "../lib/workrooms/anchor-geometry.ts";
import {
  beginPoint,
  capturesPoint,
  isArrowKey,
  nudgePoint,
  placePoint,
  POINT_STEP,
  POINT_STEP_LARGE,
  pointOnImage,
  pointSummary,
  takesPoint,
  type ArrowKey,
  type PointCandidate,
} from "../lib/workrooms/point-capture.ts";
import { itemSubjects } from "../lib/workrooms/presentation-view.ts";
import { parseReviewAnchor } from "../lib/workrooms/review-anchor.ts";
import { readAnchor } from "../lib/workrooms/review-input.ts";
import { capturesTime, serializeAnchor, takesTime } from "../lib/workrooms/time-capture.ts";
import { clearOwner, file, owner, round, seedOwner, stage, staff } from "./support/review-stage.ts";

/**
 * Stage F5.1: the rules for choosing one place on a picture, as data — and the
 * path a chosen point takes to the database, run for real. Nothing here is
 * visible yet; F5.2 wires these into the page.
 */

before(seedOwner);

after(async () => {
  await clearOwner();
  await closeDb();
});

const point = (x: number, y: number): PointCandidate => ({ kind: "point", x, y });

/* ------------------------------------------------------------ eligibility */

test("only a picture takes a point — by the viewer its Revision froze, and nothing else", () => {
  assert.deepEqual(
    (["image", "audio", "video", "pdf", "download", null] as const).map((viewer) => [viewer, takesPoint(viewer)]),
    [["image", true], ["audio", false], ["video", false], ["pdf", false], ["download", false], [null, false]],
  );
  assert.equal(takesPoint("hologram" as never), false, "a viewer this build does not know");

  // Time is untouched: audio and video, and never a picture.
  assert.deepEqual(
    (["image", "audio", "video", "pdf", "download"] as const).map((viewer) => takesTime(viewer)),
    [false, true, true, false, false],
  );
});

test("each block's subject says which precision it takes, read from the frozen snapshot", () => {
  const file = (name: string, kind: string, viewer: "image" | "video" | "audio" | "pdf" | "download") =>
    ({ id: "f", name, kind, viewer, size: "1 KB", downloadPath: "/d" }) as never;

  const subjects = itemSubjects([
    { position: 0, kind: "note", caption: "Intro", body: "Words." },
    { position: 1, kind: "file", caption: "Board", file: file("board.png", "image", "image") },
    { position: 2, kind: "file", caption: "Film", file: file("film.mp4", "video", "video") },
    { position: 3, kind: "file", caption: "Sound", file: file("sound.m4a", "audio", "audio") },
    { position: 4, kind: "file", caption: "Deck", file: file("deck.pdf", "pdf", "pdf") },
    // An SVG: a picture to a person, frozen as a download — never a point.
    { position: 5, kind: "file", caption: "Wordmark", file: file("wordmark.svg", "image", "download") },
    // A PNG whose Revision froze it as a download, whatever it is today.
    { position: 6, kind: "file", caption: "Old board", file: file("board.png", "image", "download") },
  ] as never);

  assert.deepEqual(
    subjects.map((subject) => [subject.label, subject.capture ?? null, capturesPoint(subject), capturesTime(subject)]),
    [
      ["Intro", null, false, false],
      ["Board", "point", true, false],
      ["Film", "time", false, true],
      ["Sound", "time", false, true],
      ["Deck", null, false, false],
      ["Wordmark", null, false, false],
      ["Old board", null, false, false],
    ],
  );
  assert.equal(capturesPoint(undefined), false, "the version as a whole took a point");
});

/* -------------------------------------------------------------- geometry */

// An 800×400 picture in a 400×400 content box at (10, 20): scaled by a half to
// 400×200, centred, so it sits from (10, 120) to (410, 320) with a 100px bar
// above and below.
const WIDE = { width: 800, height: 400 };
const SQUARE_BOX = { left: 10, top: 20, width: 400, height: 400 };

test("a press on the picture is a fraction of the picture — centre, known places, all four corners", () => {
  assert.deepEqual(placePoint({ x: 210, y: 220 }, WIDE, SQUARE_BOX), point(0.5, 0.5));
  assert.deepEqual(placePoint({ x: 110, y: 170 }, WIDE, SQUARE_BOX), point(0.25, 0.25));
  assert.deepEqual(placePoint({ x: 310, y: 270 }, WIDE, SQUARE_BOX), point(0.75, 0.75));

  // The edges and corners are on the picture.
  assert.deepEqual(placePoint({ x: 10, y: 120 }, WIDE, SQUARE_BOX), point(0, 0));
  assert.deepEqual(placePoint({ x: 410, y: 120 }, WIDE, SQUARE_BOX), point(1, 0));
  assert.deepEqual(placePoint({ x: 10, y: 320 }, WIDE, SQUARE_BOX), point(0, 1));
  assert.deepEqual(placePoint({ x: 410, y: 320 }, WIDE, SQUARE_BOX), point(1, 1));
  assert.deepEqual(placePoint({ x: 210, y: 120 }, WIDE, SQUARE_BOX), point(0.5, 0));
});

test("a tall picture: its bars are at the sides, and its fractions are of the picture alone", () => {
  // 400×800 in 400×400 at (0, 0): 200×400, from x = 100 to 300.
  const tall = { width: 400, height: 800 };
  const box = { left: 0, top: 0, width: 400, height: 400 };
  assert.deepEqual(placePoint({ x: 200, y: 200 }, tall, box), point(0.5, 0.5));
  assert.deepEqual(placePoint({ x: 100, y: 0 }, tall, box), point(0, 0));
  assert.deepEqual(placePoint({ x: 300, y: 400 }, tall, box), point(1, 1));
  assert.deepEqual(placePoint({ x: 150, y: 300 }, tall, box), point(0.25, 0.75));
  assert.equal(placePoint({ x: 99, y: 200 }, tall, box), null, "the left bar");
  assert.equal(placePoint({ x: 301, y: 200 }, tall, box), null, "the right bar");
});

test("the same place in the picture is the same point at any size the picture is drawn", () => {
  // A quarter across and three quarters down, measured at three sizes.
  for (const box of [
    { left: 10, top: 20, width: 400, height: 400 },
    { left: 0, top: 0, width: 1600, height: 800 },
    { left: 33, top: 7, width: 390, height: 195 },
  ]) {
    const at = pointOnImage({ x: 0.25, y: 0.75 }, WIDE, box)!;
    assert.deepEqual(placePoint(at, WIDE, box), point(0.25, 0.75), JSON.stringify(box));
  }
  // And a press measured in one layout lands on the same place in another.
  const pressed = placePoint({ x: 110, y: 270 }, WIDE, SQUARE_BOX)!;
  const elsewhere = pointOnImage(pressed, WIDE, { left: 0, top: 0, width: 800, height: 400 })!;
  assert.deepEqual(elsewhere, { x: 200, y: 300 });
});

test("a press beside the picture is no point at all — never pulled onto its edge", () => {
  for (const [pointer, where] of [
    [{ x: 210, y: 119 }, "the bar above"],
    [{ x: 210, y: 321 }, "the bar below"],
    [{ x: 9, y: 220 }, "left of the box"],
    [{ x: 411, y: 220 }, "right of the box"],
    [{ x: 210, y: 20 }, "the top of the box, which is letterbox"],
    [{ x: -5000, y: -5000 }, "far away"],
  ] as const) {
    assert.equal(placePoint(pointer, WIDE, SQUARE_BOX), null, where);
  }
});

test("nothing is measured against a picture or a box that has no size, or a press that is not a number", () => {
  const good = { x: 210, y: 220 };
  for (const [intrinsic, box, pointer, why] of [
    [{ width: 0, height: 0 }, SQUARE_BOX, good, "not loaded yet"],
    [{ width: Number.NaN, height: 400 }, SQUARE_BOX, good, "a width that is not a number"],
    [{ width: -800, height: 400 }, SQUARE_BOX, good, "a negative width"],
    [WIDE, { left: 10, top: 20, width: 0, height: 400 }, good, "a box of no width"],
    [WIDE, { left: 10, top: 20, width: 400, height: Number.POSITIVE_INFINITY }, good, "an endless box"],
    [WIDE, SQUARE_BOX, { x: Number.NaN, y: 220 }, "a press that is not a number"],
  ] as const) {
    assert.equal(placePoint(pointer, intrinsic, box), null, why);
  }
  assert.equal(pointOnImage({ x: 0.5, y: 0.5 }, { width: 0, height: 0 }, SQUARE_BOX), null);
  assert.equal(pointOnImage({ x: 1.5, y: 0.5 }, WIDE, SQUARE_BOX), null, "a fraction off the picture was drawn");
});

test("a point is stored at the canonical precision, and only through roundFraction", () => {
  // A third of the way across a 300px-wide picture.
  const box = { left: 0, top: 0, width: 300, height: 150 };
  const third = placePoint({ x: 100, y: 50 }, { width: 600, height: 300 }, box)!;
  assert.equal(third.x, roundFraction(1 / 3));
  assert.equal(third.x, 0.3333);
  assert.equal(third.y, 0.3333);

  const odd = placePoint({ x: 123.456789, y: 45.678901 }, { width: 600, height: 300 }, box)!;
  for (const value of [odd.x, odd.y]) {
    assert.equal(value, roundFraction(value), "a stored fraction carries more than four places");
    assert.ok(String(value).split(".")[1]!.length <= 4);
  }

  const source = readFileSync("lib/workrooms/point-capture.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(source, /Math\.round\(|toFixed\(|\* 10_?000/, "a second rounding rule");
  assert.doesNotMatch(source, /naturalWidth|getBoundingClientRect|window\.|document\./, "the rules reached for the browser");
});

/* --------------------------------------------------------------- keyboard */

const ARROWS: ArrowKey[] = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

test("the first arrow puts the point in the middle of the picture, whichever arrow it is", () => {
  for (const key of ARROWS) {
    assert.deepEqual(nudgePoint(null, key), point(0.5, 0.5), key);
    assert.deepEqual(nudgePoint(null, key, true), point(0.5, 0.5), `Shift+${key}`);
  }
});

test("each arrow moves the point two hundredths its way, and ten with Shift", () => {
  assert.equal(POINT_STEP, 0.02);
  assert.equal(POINT_STEP_LARGE, 0.1);
  const middle = point(0.5, 0.5);
  assert.deepEqual(nudgePoint(middle, "ArrowRight"), point(0.52, 0.5));
  assert.deepEqual(nudgePoint(middle, "ArrowLeft"), point(0.48, 0.5));
  assert.deepEqual(nudgePoint(middle, "ArrowUp"), point(0.5, 0.48));
  assert.deepEqual(nudgePoint(middle, "ArrowDown"), point(0.5, 0.52));
  assert.deepEqual(nudgePoint(middle, "ArrowRight", true), point(0.6, 0.5));
  assert.deepEqual(nudgePoint(middle, "ArrowLeft", true), point(0.4, 0.5));
  assert.deepEqual(nudgePoint(middle, "ArrowUp", true), point(0.5, 0.4));
  assert.deepEqual(nudgePoint(middle, "ArrowDown", true), point(0.5, 0.6));

  // Fifty small steps are one whole width, with no drift from adding floats.
  let walked = point(0, 0.5);
  for (let i = 0; i < 50; i += 1) walked = nudgePoint(walked, "ArrowRight");
  assert.deepEqual(walked, point(1, 0.5));
});

test("a point stops at the picture's edge, and no key ever takes it off the picture", () => {
  assert.deepEqual(nudgePoint(point(0.99, 0.5), "ArrowRight"), point(1, 0.5));
  assert.deepEqual(nudgePoint(point(1, 0.5), "ArrowRight"), point(1, 0.5));
  assert.deepEqual(nudgePoint(point(0.05, 0.5), "ArrowLeft", true), point(0, 0.5));
  assert.deepEqual(nudgePoint(point(0.5, 0.01), "ArrowUp"), point(0.5, 0));
  assert.deepEqual(nudgePoint(point(0.5, 0.95), "ArrowDown", true), point(0.5, 1));
  assert.deepEqual(nudgePoint(point(0, 0), "ArrowUp", true), point(0, 0));

  // Anything a keyboard can do, done a thousand times, stays on the picture
  // and stays a point the parser accepts on an image.
  let current: PointCandidate | null = null;
  let seed = 7;
  for (let i = 0; i < 1000; i += 1) {
    seed = (seed * 48271) % 2147483647;
    current = nudgePoint(current, ARROWS[seed % 4]!, seed % 3 === 0);
    assert.ok(current.x >= 0 && current.x <= 1 && current.y >= 0 && current.y <= 1, JSON.stringify(current));
    assert.deepEqual(parseReviewAnchor(current, "image"), { ok: true, anchor: current });
  }

  assert.deepEqual(ARROWS.map(isArrowKey), [true, true, true, true]);
  for (const key of ["Enter", "Escape", " ", "Up", "arrowup", "Tab"]) assert.equal(isArrowKey(key), false, key);
});

/* ------------------------------------------------------------------ words */

test("the composer says a point in words, never numbers, and a draft's point is what Change starts from", () => {
  assert.equal(pointSummary("The board"), "A point on The board");
  assert.doesNotMatch(pointSummary("The board"), /\d|x|y/);

  assert.deepEqual(beginPoint(point(0.25, 0.75)), point(0.25, 0.75));
  assert.equal(beginPoint(null), null);
  assert.equal(beginPoint({ kind: "time", t: 2 }), null, "a time became a point");
  assert.equal(beginPoint({ kind: "region", x: 0.1, y: 0.1, w: 0.2, h: 0.2 }), null, "an area became a point");
});

/* ------------------------------------------ the path to the database */

test("the form field carries the canonical shape, and the one parser accepts it on a picture only", () => {
  assert.equal(serializeAnchor(point(0.25, 0.75)), '{"kind":"point","x":0.25,"y":0.75}');
  // A candidate with anything extra on it is written as the canonical shape only.
  assert.equal(serializeAnchor({ kind: "point", x: 0, y: 1, w: 3 } as never), '{"kind":"point","x":0,"y":1}');

  // Time is written exactly as F3 and F4.1 wrote it.
  assert.equal(serializeAnchor(null), "");
  assert.equal(serializeAnchor({ kind: "time", t: 2.5 }), '{"kind":"time","t":2.5}');
  assert.equal(serializeAnchor({ kind: "time", t: 1.25, t2: 3.5 }), '{"kind":"time","t":1.25,"t2":3.5}');

  const read = readAnchor(serializeAnchor(point(0.25, 0.75)));
  assert.deepEqual(parseReviewAnchor(read, "image"), { ok: true, anchor: point(0.25, 0.75) });
  for (const viewer of ["audio", "video", "pdf", "download", null] as const) {
    assert.deepEqual(parseReviewAnchor(read, viewer), { ok: false, reason: "unsupported_for_viewer", kind: "point" }, String(viewer));
  }
});

test("through the real write path: a placed point is stored exactly, on its block; everything else is refused", async () => {
  // Revision 2 of the shared fixture: 0 note, 1 image, 2 video, 3 audio, 4 pdf.
  const s = await stage();
  const reviewId = await round(s);
  const write = (body: string, itemPosition: number | null, anchor: unknown) =>
    createReviewNote(s.ana, { reviewId, body, itemPosition, anchor });

  const placed = placePoint({ x: 110, y: 270 }, WIDE, SQUARE_BOX)!;
  assert.deepEqual(placed, point(0.25, 0.75));
  const made = await write("A point, placed.", 1, readAnchor(serializeAnchor(placed)));
  assert.ok(made.ok, made.ok ? "" : made.message);

  const [row] = await db()
    .select({ anchor: presentationReviewNotes.anchor, position: presentationRevisionItems.position })
    .from(presentationReviewNotes)
    .innerJoin(presentationRevisionItems, eq(presentationRevisionItems.id, presentationReviewNotes.revisionItemId))
    .where(and(eq(presentationReviewNotes.body, "A point, placed."), isNull(presentationReviewNotes.parentNoteId)));
  assert.deepEqual(row, { anchor: { kind: "point", x: 0.25, y: 0.75 }, position: 1 });

  // A point keyed in, stored exactly too.
  const keyed = nudgePoint(nudgePoint(null, "ArrowRight"), "ArrowDown", true);
  assert.ok((await write("A point, keyed.", 1, readAnchor(serializeAnchor(keyed)))).ok);

  for (const [position, anchor, why, sentence] of [
    [2, point(0.5, 0.5), "a point on a video", "A point belongs on an image."],
    [3, point(0.5, 0.5), "a point on a recording", "A point belongs on an image."],
    [4, point(0.5, 0.5), "a point on a PDF", "This kind of file takes feedback as a whole, not at a point in it."],
    [0, point(0.5, 0.5), "a point on a written note", "There is nothing to point at in a written note."],
    [null, point(0.5, 0.5), "a point about nothing", null],
    [1, point(-0.01, 0.5), "x below 0", "That point is not inside the image."],
    [1, point(1.01, 0.5), "x above 1", "That point is not inside the image."],
    [1, point(0.5, -0.01), "y below 0", "That point is not inside the image."],
    [1, point(0.5, 1.01), "y above 1", "That point is not inside the image."],
    [1, point(Number.NaN, 0.5), "NaN", null],
    [1, point(0.5, Number.POSITIVE_INFINITY), "infinity", null],
    [1, { kind: "point", x: 0.5 }, "a missing coordinate", null],
    [1, { kind: "point", x: 0.5, y: 0.5, z: 0 }, "an extra key", null],
    [1, { kind: "point", x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, "an area passed off as a point", null],
    [1, { kind: "point", x: "0.5", y: "0.5" }, "coordinates as words", null],
    [1, [0.5, 0.5], "a pair, not an object", null],
    [1, "point", "not an object at all", null],
    [1, { kind: "Point", x: 0.5, y: 0.5 }, "a kind this vocabulary does not have", null],
  ] as const) {
    const refused = await write(`Refused: ${why}.`, position, anchor);
    assert.ok(!refused.ok, `the server stored ${why}`);
    if (sentence) assert.equal(refused.message, sentence, why);
  }

  // Nothing refused was stored, and the audit trail carries no body and no
  // anchor — only that the round was answered.
  const bodies = (await db().select({ body: presentationReviewNotes.body }).from(presentationReviewNotes).where(eq(presentationReviewNotes.presentationReviewId, reviewId))).map(
    (entry) => entry.body,
  );
  assert.deepEqual(bodies.sort(), ["A point, keyed.", "A point, placed."]);
  const audit = await db().select({ metadata: auditEvents.metadata }).from(auditEvents).where(eq(auditEvents.entityId, reviewId));
  assert.ok(audit.length >= 2, "the round's answers were not audited");
  for (const { metadata } of audit) {
    assert.doesNotMatch(JSON.stringify(metadata), /point|"x"|"y"|0\.25|placed|keyed|@/, "the audit carries a body, an anchor or an address");
  }
});

test("a picture frozen as a download takes no point, however it reads today", async () => {
  const s = await stage();
  // An SVG: labelled an image, frozen as a download, as every one is.
  const svg = await file(s.workroomId, "Wordmark.svg", "image/svg+xml");
  const made = await createPresentation(owner, s.workroomId, { title: "Frozen picture", intro: "" });
  assert.ok(made.ok);
  const version = async () => (await findPresentation(made.value))!.version;
  assert.ok((await addFileItem(owner, made.value, await version(), svg, "The wordmark")).ok);
  assert.ok((await publishPresentation(owner, made.value, await version())).ok);

  const revisionId = (await findPresentation(made.value))!.currentRevisionId!;
  const [row] = await db()
    .select({ snapshot: presentationRevisions.snapshot })
    .from(presentationRevisions)
    .where(eq(presentationRevisions.id, revisionId));
  const frozen = (row!.snapshot as { items: { file: { kind: string; viewer: string } }[] }).items[0]!.file;
  assert.deepEqual({ kind: frozen.kind, viewer: frozen.viewer }, { kind: "image", viewer: "download" });
  assert.equal(takesPoint(frozen.viewer as never), false);

  const round = await requestReview(staff, revisionId);
  assert.ok(round.ok);
  const refused = await createReviewNote(s.ana, {
    reviewId: round.value,
    body: "Refused: a point on a download.",
    itemPosition: 0,
    anchor: point(0.5, 0.5),
  });
  assert.ok(!refused.ok);
  assert.equal(refused.message, "This kind of file takes feedback as a whole, not at a point in it.");
});

/* ------------------------------------------------------------ the wiring */

test("the page measures and these rules decide: no geometry in the component, and only the stage listens", () => {
  const composer = readFileSync("components/workrooms/ReviewComposer.tsx", "utf8");
  assert.match(composer, /capturesTime\(about\) \|\| capturesPoint\(about\)/);

  const stage = readFileSync("components/workrooms/ReviewStage.tsx", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  // Placement, the marker and the keys all go through F5.1's rules…
  for (const rule of ["placePoint(", "pointOnImage(", "nudgePoint(", "beginPoint(", "pointSummary("]) {
    assert.ok(stage.includes(rule), `${rule} is not how the page does it`);
  }
  // …and the component does no geometry of its own.
  assert.doesNotMatch(stage, /containRect|fromFraction|toFraction|roundFraction|naturalWidth \*|\/ content\.width/);

  // The one surface: the image's own stage, and its listeners only while a
  // point is being chosen.
  assert.match(stage, /const surface = image\?\.parentElement;/);
  assert.match(stage, /surface\.addEventListener\("click", onClick\)/);
  assert.doesNotMatch(stage, /box\.current\??\.addEventListener|document\.addEventListener\("click"|window\.addEventListener\("click"/);
  assert.doesNotMatch(stage, /preventDefault\(\)[^;]*touch|addEventListener\("touch/, "a touch was intercepted");
});
