import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { closeDb } from "../lib/db/index.ts";
import { findPresentation, listDraftRows, moveItem, publishPresentation } from "../lib/db/presentations.ts";
import { createReviewNote, requestReview, reviewPanelForStaff } from "../lib/db/reviews.ts";
import { locatorLabel } from "../lib/workrooms/anchor-label.ts";
import {
  activationTarget,
  locatable,
  readNoteParam,
  revisionLocatorHref,
  seekPlan,
} from "../lib/workrooms/review-locator.ts";
import { type ClientReview, type ClientReviewNote } from "../lib/workrooms/review-view.ts";
import { clearOwner, owner, round, seedOwner, stage, staff, UUID } from "./support/review-stage.ts";

/**
 * Stage F2's decisions, without a browser: which note has a locator, which
 * note a URL may open, where Studio's draft page sends somebody, and what a
 * player does with a stored time. The browser half — scrolling, drawing,
 * seeking — is `review-locator-browser.test.ts`.
 */

before(seedOwner);

after(async () => {
  await clearOwner();
  await closeDb();
});

const author = { side: "client" as const, name: "Ana Person" };
const at = new Date("2026-09-24T10:00:00Z");

function live(n: number, extra: Partial<Extract<ClientReviewNote, { removed: false }>> = {}): ClientReviewNote {
  return {
    n,
    author,
    at,
    body: "Words.",
    removed: false,
    edited: false,
    resolved: false,
    replies: [],
    ...extra,
  };
}

function review(notes: ClientReviewNote[]): ClientReview {
  return { status: "open", requestedAt: at, canWrite: true, notes };
}

/* ------------------------------------------------------- which notes */

test("only a live note with a block and an anchor has a locator", () => {
  const point = { kind: "point" as const, x: 0.4, y: 0.2 };

  assert.deepEqual(locatable(live(1, { subject: 2, anchor: point })), { n: 1, subject: 2, anchor: point });
  assert.equal(locatable(live(2, { subject: 2 })), null, "item-level feedback grew a locator");
  assert.equal(locatable(live(3)), null, "general feedback grew a locator");
  assert.equal(locatable({ n: 4, removed: true }), null, "a tombstone grew a locator");
});

test("a point that was dealt with is still somewhere to go", () => {
  const moment = { kind: "time" as const, t: 42 };
  const resolved = live(5, { subject: 1, anchor: moment, resolved: true, resolvedBy: author });
  assert.deepEqual(locatable(resolved), { n: 5, subject: 1, anchor: moment });
});

/* ------------------------------------------------- which note a URL opens */

test("a note parameter is a small positive whole number, or nothing", () => {
  for (const [raw, expected] of [
    ["1", 1],
    ["42", 42],
    ["999999", 999999],
    ["0", null],
    ["-1", null],
    ["01", null],
    ["1.5", null],
    ["1e3", null],
    ["3 ", null],
    ["3abc", null],
    ["1000000", null],
    ["", null],
    ["01a0d3bf-f3e1-771b-8c4c-da34529a0c48", null],
    ['{"kind":"point"}', null],
    [["1", "2"], null],
    [undefined, null],
    [7, null],
  ] as const) {
    assert.equal(readNoteParam(raw), expected, JSON.stringify(raw));
  }
});

test("a URL opens only a note in the round on that page", () => {
  const point = { kind: "point" as const, x: 0.25, y: 0.75 };
  const moment = { kind: "time" as const, t: 2 };

  // The same ordinal in two rounds: each page finds its own, never the other's.
  const version2 = review([live(1, { subject: 1, anchor: point }), { n: 2, removed: true }, live(3, { subject: 1 })]);
  const version3 = review([live(1, { subject: 1, anchor: moment })]);

  assert.deepEqual(activationTarget(version2, 1)?.anchor, point);
  assert.deepEqual(activationTarget(version3, 1)?.anchor, moment);

  assert.equal(activationTarget(version2, 2), null, "a tombstone was opened");
  assert.equal(activationTarget(version2, 3), null, "item-level feedback was opened as precise");
  assert.equal(activationTarget(version2, 9), null, "a note from nowhere was opened");
  assert.equal(activationTarget(version3, 3), null, "another round's note was opened here");
  assert.equal(activationTarget(null, 1), null, "no round, and something was opened");
  assert.equal(activationTarget(version2, null), null);

  // A reply's ordinal is not a root's, and replies never carry an anchor.
  const withReply = review([
    live(1, { subject: 1, anchor: point, replies: [{ n: 2, author, at, body: "Yes.", removed: false, edited: false }] }),
  ]);
  assert.equal(activationTarget(withReply, 2), null, "a reply was opened as if it had an anchor");
});

/* --------------------------------------------------- Studio's draft page */

test("the draft page's locator names the reviewed Revision and the note, and nothing else", () => {
  const base = "/studio/workrooms/W/presentations/P";
  const href = revisionLocatorHref(base, 2, 3);
  assert.equal(href, `${base}/revisions/2?note=3`);

  const added = href.slice(base.length);
  assert.match(added, /^\/revisions\/\d+\?note=\d+$/);
  assert.doesNotMatch(added, UUID);
  assert.doesNotMatch(added, /[{}"[\]:,]|x=|y=|t=/, "geometry or JSON travelled in the URL");
});

test("the draft page links to the Revision whose round it shows, even after the draft moves on", async () => {
  const s = await stage();
  await round(s);
  const reviewId = (await reviewPanelForStaff({ userId: owner.id }, s.workroomId, s.presentationId))!;
  assert.equal(reviewId.revision, 2, "the panel did not say which Revision its round is on");

  // Reorder the draft: the draft page now shows work Revision 2 never had.
  const rows = await listDraftRows(s.presentationId);
  const version = (await findPresentation(s.presentationId))!.version;
  assert.ok((await moveItem(owner, s.presentationId, version, rows[2]!.id, "up")).ok);
  assert.equal((await reviewPanelForStaff({ userId: owner.id }, s.workroomId, s.presentationId)).revision, 2);

  // Published: the draft page's round is now Revision 3's, and Revision 2's
  // own page still reads Revision 2.
  assert.ok((await publishPresentation(owner, s.presentationId, (await findPresentation(s.presentationId))!.version)).ok);
  const current = (await findPresentation(s.presentationId))!.currentRevisionId!;
  assert.ok((await requestReview(staff, current)).ok);
  assert.equal((await reviewPanelForStaff({ userId: owner.id }, s.workroomId, s.presentationId)).revision, 3);
  assert.equal((await reviewPanelForStaff({ userId: owner.id }, s.workroomId, s.presentationId, 2)).revision, 2);
  assert.equal((await reviewPanelForStaff({ userId: owner.id }, s.workroomId, s.presentationId, 9)).revision, null);
});

test("a note with an anchor is found by its own page's projection", async () => {
  const s = await stage();
  const id = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId: id, body: "Here.", itemPosition: 1, anchor: { kind: "point", x: 0.25, y: 0.75 } })).ok);
  assert.ok((await createReviewNote(s.ana, { reviewId: id, body: "About it.", itemPosition: 1 })).ok);

  const panel = await reviewPanelForStaff({ userId: owner.id }, s.workroomId, s.presentationId, 2);
  assert.deepEqual(activationTarget(panel.review, 1), { n: 1, subject: 1, anchor: { kind: "point", x: 0.25, y: 0.75 } });
  assert.equal(activationTarget(panel.review, 2), null);
  assert.equal(activationTarget(panel.review, 3), null);
});

/* ------------------------------------------------------- the player */

test("a moment seeks; a stretch seeks to its start; a time past the end is declined, not clamped", () => {
  assert.deepEqual(seekPlan({ kind: "time", t: 3 }, 8), { seek: 3 });
  assert.deepEqual(seekPlan({ kind: "time", t: 8 }, 8), { seek: 8 }, "the last instant is inside");
  assert.deepEqual(seekPlan({ kind: "time", t: 2, t2: 5 }, 8), { seek: 2 });
  assert.deepEqual(seekPlan({ kind: "time", t: 2, t2: 50 }, 8), { seek: 2 }, "an end past the file does not stop the start");
  assert.deepEqual(seekPlan({ kind: "time", t: 4, region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }, 8), { seek: 4 });
  assert.deepEqual(seekPlan({ kind: "time", t: 90_000 }, 8), { beyond: true });

  // A duration nobody knows is not a reason to refuse.
  assert.deepEqual(seekPlan({ kind: "time", t: 90_000 }, Number.NaN), { seek: 90_000 });
  assert.deepEqual(seekPlan({ kind: "time", t: 90_000 }, Number.POSITIVE_INFINITY), { seek: 90_000 });

  assert.equal(seekPlan({ kind: "point", x: 0.5, y: 0.5 }, 8), null);
});

/* ------------------------------------------------------- the words */

test("a locator names the block and the precision, never a coordinate", () => {
  assert.equal(locatorLabel("Primary identity direction", { kind: "point", x: 0.42, y: 0.18 }), "On Primary identity direction · Point");
  assert.equal(locatorLabel("The board", { kind: "region", x: 0.1, y: 0.1, w: 0.2, h: 0.2 }), "On The board · Area");
  assert.equal(locatorLabel("The motion", { kind: "time", t: 42 }), "On The motion · At 0:42");
  assert.equal(locatorLabel("The motion", { kind: "time", t: 42, t2: 51 }), "On The motion · 0:42–0:51");
  assert.equal(locatorLabel("The sound", { kind: "time", t: 72 }), "On The sound · At 1:12");
  assert.equal(locatorLabel("The sound", { kind: "time", t: 72, t2: 84 }), "On The sound · 1:12–1:24");
  assert.equal(locatorLabel("The motion", { kind: "time", t: 90_000 }), "On The motion · At 25:00:00");
  // The area on a frame is kept, and not promised: nothing draws it yet.
  assert.equal(
    locatorLabel("The motion", { kind: "time", t: 42, region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }),
    "On The motion · At 0:42",
  );
});

/* -------------------------------------------------- what F2 must not do */

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|css)$/.test(name) ? [path] : [];
  });
}

test("capture exists for audio alone: its words live in the coordinator, and nothing captures a picture", () => {
  // F3 added the audio controls. Everything else stays uncreatable.
  const never = ["Point to it", "Change anchor", "Clear anchor draft"];
  const audioOnly = ["Set precise time", "Use this moment", "Start here", "End here"];
  for (const file of [...sources("app"), ...sources("components")]) {
    const text = readFileSync(file, "utf8");
    for (const words of never) {
      assert.ok(!text.includes(words), `${file} offers "${words}"`);
    }
    if (file.endsWith("components/workrooms/ReviewStage.tsx")) continue;
    for (const words of audioOnly) {
      assert.ok(!text.includes(words), `${file} offers "${words}" outside the one capture panel`);
    }
  }
});

test("there is still one FileViewer, and it knows nothing about Reviews", () => {
  const viewer = readFileSync("components/workrooms/FileViewer.tsx", "utf8");
  assert.doesNotMatch(viewer, /ReviewStage|anchor|locator/i);
  for (const name of ["ClientFileViewer", "StudioFileViewer", "ReviewFileViewer"]) {
    for (const file of [...sources("app"), ...sources("components")]) {
      assert.ok(!readFileSync(file, "utf8").includes(name), `${file} has a ${name}`);
    }
  }

  // Code only: the component's own comment says there is no `if (isStaff)`.
  const thread = readFileSync("components/workrooms/ReviewThread.tsx", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(thread, /isStaff/);
});
