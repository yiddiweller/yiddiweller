import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";

import { eq } from "drizzle-orm";

import { closeDb, db } from "../lib/db/index.ts";
import { createReviewNote } from "../lib/db/reviews.ts";
import { presentationReviewNotes } from "../lib/db/schema.ts";
import { roundSeconds } from "../lib/workrooms/anchor-geometry.ts";
import {
  anchorAfterSubjectChange,
  beginCapture,
  candidateLabel,
  captureSummary,
  captureTime,
  capturesTime,
  noticeText,
  rangesOffered,
  serializeAnchor,
  takeEnd,
  takeMoment,
  takeStart,
  takesTime,
  type CaptureState,
} from "../lib/workrooms/time-capture.ts";
import { itemSubjects } from "../lib/workrooms/presentation-view.ts";
import { parseReviewAnchor } from "../lib/workrooms/review-anchor.ts";
import { readAnchor } from "../lib/workrooms/review-input.ts";
import { clearOwner, round, seedOwner, stage } from "./support/review-stage.ts";

/**
 * The rules for choosing a time — Stage F3's for audio, shared by F4.1's video
 * — as data, and the path a chosen time takes to the database, run for real.
 * The browser halves are `review-capture-browser.test.ts` (audio) and
 * `video-capture-browser.test.ts` (video).
 */

before(seedOwner);

after(async () => {
  await clearOwner();
  await closeDb();
});

const empty: CaptureState = { candidate: null, start: null, notice: null };

/* ------------------------------------------------------------ eligibility */

test("audio and video blocks offer a precise time, read from the frozen Revision — nothing else does", () => {
  const file = (viewer: "image" | "video" | "audio" | "pdf" | "download") =>
    ({
      name: `${viewer}.bin`,
      kind: "other",
      viewer,
      size: "1 KB",
      downloadPath: "/d",
    }) as never;

  const subjects = itemSubjects([
    { position: 0, kind: "note", caption: "Intro", body: "Words." },
    { position: 1, kind: "file", caption: "Picture", file: file("image") },
    { position: 2, kind: "file", caption: "Film", file: file("video") },
    { position: 3, kind: "file", caption: "Sound", file: file("audio") },
    { position: 4, kind: "file", caption: "Deck", file: file("pdf") },
    { position: 5, kind: "file", caption: "Archive", file: file("download") },
  ]);

  assert.deepEqual(
    subjects.map((subject) => [subject.label, capturesTime(subject)]),
    [
      ["Intro", false],
      ["Picture", false],
      ["Film", true],
      ["Sound", true],
      ["Deck", false],
      ["Archive", false],
    ],
  );
  assert.equal(capturesTime(undefined), false, "the version as a whole offered a time");

  // The viewer is the only input: the frozen one, by name.
  assert.deepEqual(
    (["audio", "video", "image", "pdf", "download", null] as const).map((viewer) => [viewer, takesTime(viewer)]),
    [["audio", true], ["video", true], ["image", false], ["pdf", false], ["download", false], [null, false]],
  );
  // A viewer this build does not know takes nothing.
  assert.equal(takesTime("hologram" as never), false);
});

test("a video frozen as a download takes no time, whatever it is called or is now", () => {
  // A MOV published before F4.0 froze `{ kind: "video", viewer: "download" }`.
  // Its label says video and its name says .mov; neither is consulted.
  const frozen = itemSubjects([
    {
      position: 0,
      kind: "file",
      caption: null,
      file: { id: "f", name: "IMG_0044.mov", kind: "video", viewer: "download", size: "15 MB", downloadPath: "/d" },
    } as never,
  ]);
  assert.deepEqual(frozen, [{ value: "0", label: "IMG_0044.mov" }]);
  assert.equal(capturesTime(frozen[0]), false);
});

test("stretches are offered on every pointer until a real phone says otherwise", () => {
  assert.equal(rangesOffered(false), true);
  assert.equal(rangesOffered(true), true);
});

/* --------------------------------------------------------------- the time */

test("a time is only a time once the file says how long it is", () => {
  for (const duration of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
    assert.equal(captureTime(2, duration), null, `${duration}`);
  }
  assert.equal(captureTime(Number.NaN, 8), null);
  assert.equal(captureTime(-0.5, 8), null);
  assert.equal(captureTime(8.5, 8), null, "a position past the end");
});

test("rounded by F1's rule, never past the end, and with no ceiling of its own", () => {
  assert.equal(captureTime(2.34567, 8), roundSeconds(2.34567));
  assert.equal(captureTime(2.34567, 8), 2.346);
  assert.equal(captureTime(0, 8), 0);
  assert.equal(captureTime(8, 8), 8);
  // The last instant of a file whose length is not a whole millisecond.
  assert.equal(captureTime(7.9996, 7.9996), 7.999);
  // Longer than a day is still a time.
  assert.equal(captureTime(90_188.1234, 360_000), 90_188.123);
});

/* ------------------------------------------------------------ the presses */

test("Use this moment makes a moment and sets any stretch aside", () => {
  const halfway = takeStart(empty, 1, 8);
  const moment = takeMoment(halfway, 2.5, 8);
  assert.deepEqual(moment, { candidate: { kind: "time", t: 2.5 }, start: null, notice: null });
  assert.deepEqual(takeMoment(empty, 2, Number.NaN), { ...empty, notice: "not_ready" });
});

test("a stretch needs a start and an end after it; a wrong end is refused, not swapped", () => {
  assert.deepEqual(takeEnd(empty, 3, 8), { ...empty, notice: "no_start" });

  const started = takeStart(empty, 3, 8);
  assert.deepEqual(started, { candidate: null, start: 3, notice: null });

  for (const end of [3, 2, 0]) {
    const refused = takeEnd(started, end, 8);
    assert.deepEqual(refused, { candidate: null, start: 3, notice: "end_before_start" }, `end ${end}`);
  }

  const done = takeEnd(started, 5, 8);
  assert.deepEqual(done, { candidate: { kind: "time", t: 3, t2: 5 }, start: 3, notice: null });

  // A wrong end after a good one keeps the good one.
  assert.deepEqual(takeEnd(done, 1, 8), { ...done, notice: "end_before_start" });
});

test("either end can be pressed again", () => {
  const done = takeEnd(takeStart(empty, 3, 8), 5, 8);
  assert.deepEqual(takeEnd(done, 6, 8).candidate, { kind: "time", t: 3, t2: 6 });
  // A new start before the end keeps the end…
  assert.deepEqual(takeStart(done, 1, 8).candidate, { kind: "time", t: 1, t2: 5 });
  // …and one at or after it waits for a new end.
  assert.deepEqual(takeStart(done, 5, 8), { candidate: null, start: 5, notice: null });
});

/* ---------------------------------------------------- Change, Cancel, Clear */

test("Change starts from the draft's time, so Cancel — or Escape — has something to give back", () => {
  assert.deepEqual(beginCapture(null), empty);
  assert.deepEqual(beginCapture({ kind: "time", t: 2.5 }), { candidate: { kind: "time", t: 2.5 }, start: null, notice: null });
  assert.deepEqual(beginCapture({ kind: "time", t: 1, t2: 3 }), {
    candidate: { kind: "time", t: 1, t2: 3 },
    start: 1,
    notice: null,
  });
  // A time with an area on its frame is never something this panel made.
  assert.deepEqual(beginCapture({ kind: "time", t: 1, region: { x: 0, y: 0, w: 1, h: 1 } }), empty);
  assert.deepEqual(beginCapture({ kind: "point", x: 0.5, y: 0.5 }), empty);

  // Cancel and Escape end a session without answering the composer: the
  // component tests are the browser suite, and this source check is the
  // guarantee that neither one reaches `done`.
  const source = readFileSync("components/workrooms/ReviewStage.tsx", "utf8");
  assert.match(source, /if \(session\.current\) return endCapture\(null\);/, "Escape is not Cancel");
  assert.match(source, /onClick=\{\(\) => end\(null\)\}\s*>\s*Cancel/, "Cancel answers with a time");
  assert.match(source, /open\.cancel\(\);/);
});

test("a time never follows the comment to another subject", () => {
  const time = { kind: "time" as const, t: 2 };
  assert.deepEqual(anchorAfterSubjectChange("3", "3", time), time);
  assert.equal(anchorAfterSubjectChange("3", "5", time), null, "carried to another recording");
  assert.equal(anchorAfterSubjectChange("3", "1", time), null, "carried to a picture");
  assert.equal(anchorAfterSubjectChange("3", "", time), null, "carried to the version as a whole");
});

/* ------------------------------------------------------------- the words */

test("the choice is said in words, including a stretch half chosen and why a press did nothing", () => {
  assert.equal(candidateLabel({ kind: "time", t: 42 }), "At 0:42");
  assert.equal(candidateLabel({ kind: "time", t: 42, t2: 51 }), "0:42–0:51");
  assert.equal(candidateLabel(null), null);
  assert.equal(captureSummary(empty), "Nothing chosen yet.");
  assert.equal(captureSummary({ candidate: null, start: 42, notice: null }), "Starts at 0:42 — now choose where it ends.");
  assert.equal(noticeText("end_before_start"), "Choose an end after the start.");
  assert.equal(noticeText("no_start"), "Choose where it starts first.");
  assert.equal(noticeText("not_ready"), "Available once the file has loaded — press play if it has not.");
});

/* ------------------------------------------- the path to the database */

test("the form field is compact and deterministic, and the server reads it with the one parser", () => {
  assert.equal(serializeAnchor(null), "");
  assert.equal(serializeAnchor({ kind: "time", t: 2.5 }), '{"kind":"time","t":2.5}');
  assert.equal(serializeAnchor({ kind: "time", t: 1.25, t2: 3.5 }), '{"kind":"time","t":1.25,"t2":3.5}');

  for (const candidate of [
    { kind: "time" as const, t: 2.5 },
    { kind: "time" as const, t: 1.25, t2: 3.5 },
  ]) {
    const read = readAnchor(serializeAnchor(candidate));
    // The same field, the same parser, the same answer for a video.
    for (const viewer of ["audio", "video"] as const) {
      assert.deepEqual(parseReviewAnchor(read, viewer), { ok: true, anchor: candidate });
    }
    assert.deepEqual(parseReviewAnchor(read, "download"), { ok: false, reason: "unsupported_for_viewer", kind: "t2" in candidate ? "time_range" : "time" });
  }
  assert.equal(readAnchor(serializeAnchor(null)), undefined, "an empty field became an anchor");
});

test("through the real write path: moments and stretches stored exactly; a crafted one judged again", async () => {
  // Revision 2 of the shared fixture: 0 note, 1 image, 2 video, 3 audio, 4 pdf.
  const s = await stage();
  const reviewId = await round(s);
  const write = (body: string, itemPosition: number | null, field: string | null) =>
    createReviewNote(s.ana, { reviewId, body, itemPosition, anchor: field === null ? undefined : readAnchor(field) });
  const anchorOf = async (body: string) =>
    (await db().select({ anchor: presentationReviewNotes.anchor }).from(presentationReviewNotes).where(eq(presentationReviewNotes.body, body)))[0]!
      .anchor;

  assert.ok((await write("Moment.", 3, serializeAnchor({ kind: "time", t: 2.5 }))).ok);
  assert.deepEqual(await anchorOf("Moment."), { kind: "time", t: 2.5 });

  assert.ok((await write("Stretch.", 3, serializeAnchor({ kind: "time", t: 1.25, t2: 3.5 }))).ok);
  assert.deepEqual(await anchorOf("Stretch."), { kind: "time", t: 1.25, t2: 3.5 });

  // The video, through the same field and the same write.
  assert.ok((await write("Video moment.", 2, serializeAnchor({ kind: "time", t: 4.125 }))).ok);
  assert.deepEqual(await anchorOf("Video moment."), { kind: "time", t: 4.125 });
  assert.ok((await write("Video stretch.", 2, serializeAnchor({ kind: "time", t: 0.5, t2: 6 }))).ok);
  assert.deepEqual(await anchorOf("Video stretch."), { kind: "time", t: 0.5, t2: 6 });

  // What the panel can never make, sent anyway, is refused by the server.
  for (const [position, field, why] of [
    [3, '{"kind":"time","t":5,"t2":3}', "a stretch that ends first"],
    [3, '{"kind":"time","t":-1}', "a negative time"],
    [3, '{"kind":"time","t":1,"region":{"x":0,"y":0,"w":1,"h":1}}', "a frame area on audio"],
    [3, '{"kind":"point","x":0.5,"y":0.5}', "a point on audio"],
    [2, '{"kind":"point","x":0.5,"y":0.5}', "a point on a video"],
    [2, '{"kind":"region","x":0.1,"y":0.1,"w":0.2,"h":0.2}', "an area on a video"],
    [2, '{"kind":"time","t":1,"region":{"x":0.9,"y":0.9,"w":0.5,"h":0.5}}', "a frame area leaving the video"],
    [2, '{"kind":"time","t":4,"t2":4}', "a video stretch that ends where it starts"],
    [2, '{"kind":"time","t":-0.5}', "a negative time on a video"],
    [2, '{"kind":"time","t":1e999}', "an infinite time on a video"],
    [2, '{"kind":"time","t":"2"}', "a time that is not a number"],
    [2, '{"kind":"time","t":2,"frame":48}', "a frame number"],
    [1, '{"kind":"time","t":2}', "a time on a picture"],
    [4, '{"kind":"time","t":2}', "a time on a PDF"],
    [0, '{"kind":"time","t":2}', "a time on a written note"],
    [null, '{"kind":"time","t":2}', "a time about nothing"],
  ] as const) {
    const refused = await write(`Refused: ${why}.`, position, field);
    assert.ok(!refused.ok, `the server stored ${why}`);
  }

  // Ordinary feedback is untouched.
  assert.ok((await write("General.", null, null)).ok);
  assert.equal(await anchorOf("General."), null);
  assert.ok((await write("About the sound.", 3, "")).ok);
  assert.equal(await anchorOf("About the sound."), null);
});

test("the draft is kept in the form and nowhere else", () => {
  for (const file of ["components/workrooms/ReviewStage.tsx", "components/workrooms/ReviewComposer.tsx", "lib/workrooms/time-capture.ts"]) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie|history\.(push|replace)State|router\.(push|replace)/, file);
  }
});

test("capture is one system for both players: one module, one panel, one element per block, nothing for pictures", () => {
  const composer = readFileSync("components/workrooms/ReviewComposer.tsx", "utf8");
  assert.match(composer, /capturesTime\(about\)/);
  const subjects = readFileSync("lib/workrooms/presentation-view.ts", "utf8");
  assert.match(subjects, /takesTime\(item\.file\.viewer\) \? \{ capture: "time" as const \}/);
  assert.doesNotMatch(subjects, /capture: "(audio|video|image|point)"/);

  // The panel reads the block's own player — a video's or a recording's —
  // and there is no second capture module or panel for video.
  const stage = readFileSync("components/workrooms/ReviewStage.tsx", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.match(stage, /const PLAYER = "video, audio";/);
  assert.doesNotMatch(stage, /querySelector<HTMLMediaElement>\("audio"\)/);
  assert.equal((stage.match(/function CapturePanel\(/g) ?? []).length, 1);
  assert.doesNotMatch(stage, /\.play\(\)/, "something in the stage plays media");
  assert.doesNotMatch(stage, /<video|<audio|requestFullscreen|webkitEnterFullscreen/, "the stage renders or drives a player of its own");
});
