import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { and, eq, isNull } from "drizzle-orm";

import { db } from "../lib/db/index.ts";
import {
  addFileItem,
  addNoteItem,
  createPresentation,
  findPresentation,
  publishPresentation,
} from "../lib/db/presentations.ts";
import { createReviewNote, requestReview, type ClientActor } from "../lib/db/reviews.ts";
import {
  presentationReviewNotes,
  presentationRevisionItems,
  presentationRevisions,
  workroomFiles,
} from "../lib/db/schema.ts";
import { file, fixture, inView, locator, open, seeksTo, setUp, skip, tearDown, type Page } from "./support/browser.ts";
import { wav, webm } from "./support/media.ts";
import { owner, person, staff, UUID } from "./support/review-stage.ts";

/**
 * Stage F4.1 in a real browser: a moment or a stretch in a **video**, chosen
 * on the video's own native player with F3's panel, stored through the
 * ordinary client action, and found again by F2's locators — the client's,
 * Studio's, and on a version that has since been replaced.
 *
 * **What the video is.** *The clip* is declared `video/quicktime`, exactly as
 * Safari declares an iPhone's `.mov`, and its bytes are the committed 8-second
 * VP8 WebM: the bundled Chromium has no H.264 or HEVC decoder and plays by the
 * bytes, not the declared type. So this proves capture and return to context
 * on a file stored as a MOV — **not** that a real QuickTime file decodes. That
 * was F4.0's real-beta walk, and F4.1's will be too.
 *
 * *Video review test*, in the fixture's Workroom, with an open round:
 *
 *   Version 1   0 Intro · 1 The clip (IMG_0044.mov) · 2 The sound (a WAV)
 *
 * *Frozen clip*, with an open round, whose one MOV was frozen as `download`
 * the way every Revision published before F4.0 froze one.
 */

before(async () => {
  await setUp();
  if (!skip) await seedVideo();
});
after(tearDown);

const v = {
  pid: "",
  presentation: "",
  frozen: "",
  frozenReview: "",
  review: "",
  quinn: null as unknown as ClientActor,
};

async function version(pid: string): Promise<number> {
  return (await findPresentation(pid))!.version;
}

async function seedVideo(): Promise<void> {
  const workroomId = fixture.workroomId;
  const clip = await file(workroomId, "IMG_0044.mov", "video/quicktime", webm());
  const sound = await file(workroomId, "Sound.wav", "audio/wav", wav(6));

  const made = await createPresentation(owner, workroomId, { title: "Video review test", intro: "" });
  assert.ok(made.ok);
  const pid = made.value;
  assert.ok((await addNoteItem(owner, pid, await version(pid), { caption: "Intro", body: "Words." })).ok);
  assert.ok((await addFileItem(owner, pid, await version(pid), clip, "The clip")).ok);
  assert.ok((await addFileItem(owner, pid, await version(pid), sound, "The sound")).ok);
  assert.ok((await publishPresentation(owner, pid, await version(pid))).ok);
  const round = await requestReview(staff, (await findPresentation(pid))!.currentRevisionId!);
  assert.ok(round.ok);

  // A MOV frozen as a download, as it was published before F4.0: published
  // under a type both policies call a download and label video, then given its
  // real type — so the frozen `{ kind: "video", viewer: "download" }` is
  // exactly the old build's, and the live file today is a playable MOV.
  const old = await file(workroomId, "IMG_0048.mov", "video/x-quicktime", webm());
  const frozen = await createPresentation(owner, workroomId, { title: "Frozen clip", intro: "" });
  assert.ok(frozen.ok);
  assert.ok((await addFileItem(owner, frozen.value, await version(frozen.value), old, "The frozen clip")).ok);
  assert.ok((await publishPresentation(owner, frozen.value, await version(frozen.value))).ok);
  await db().update(workroomFiles).set({ contentType: "video/quicktime" }).where(eq(workroomFiles.id, old));
  const frozenRevision = (await findPresentation(frozen.value))!.currentRevisionId!;
  const [row] = await db()
    .select({ snapshot: presentationRevisions.snapshot })
    .from(presentationRevisions)
    .where(eq(presentationRevisions.id, frozenRevision));
  const frozenFile = (row!.snapshot as { items: { file: { kind: string; viewer: string } }[] }).items[0]!.file;
  assert.deepEqual({ kind: frozenFile.kind, viewer: frozenFile.viewer }, { kind: "video", viewer: "download" });
  const frozenRound = await requestReview(staff, frozenRevision);
  assert.ok(frozenRound.ok);

  Object.assign(v, {
    pid,
    presentation: (await findPresentation(pid))!.publicId,
    frozen: (await findPresentation(frozen.value))!.publicId,
    frozenReview: frozenRound.value,
    review: round.value,
    quinn: await person("Quinn", workroomId, "quinn-video@example.test"),
  });
}

const clientPage = () => `/workrooms/${fixture.room}/presentations/${v.presentation}`;
const studioPage = () => `/studio/workrooms/${fixture.workroomId}/presentations/${v.pid}`;

/* -------------------------------------------------------------- helpers */

const about = (page: Page) => page.getByLabel("About");
const setTime = (page: Page, name: string) => page.getByRole("button", { name: `Set precise time on ${name}`, exact: true });
const panel = (page: Page) => page.getByRole("group", { name: /^Precise time on / });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const choice = (page: Page) => panel(page).getByRole("status").last().textContent();

/** Counts every `play` either player ever fires. Nothing here may ever make one. */
async function countPlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __plays: number };
    w.__plays = 0;
    for (const media of document.querySelectorAll("video, audio")) {
      media.addEventListener("play", () => (w.__plays += 1));
    }
  });
}
const plays = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as { __plays: number }).__plays);

/** Moves the video's own player, the way a person scrubbing it would. */
async function scrub(page: Page, t: number): Promise<void> {
  await page.waitForFunction(
    () => {
      const video = document.querySelector("video");
      return video && video.readyState >= 1 && Number.isFinite(video.duration);
    },
    undefined,
    { timeout: 10_000 },
  );
  await page.evaluate(
    (t: number) =>
      new Promise<void>((resolve) => {
        const video = document.querySelector("video")!;
        video.addEventListener("seeked", () => resolve(), { once: true });
        video.currentTime = t;
      }),
    t,
  );
}

async function send(page: Page, body: string): Promise<void> {
  await page.getByLabel("What would you like to say?").fill(body);
  await button(page, "Send to the studio").click();
  await page.getByText(body, { exact: true }).waitFor({ timeout: 10_000 });
}

async function stored(body: string): Promise<{ position: number | null; anchor: unknown }> {
  const [row] = await db()
    .select({ anchor: presentationReviewNotes.anchor, position: presentationRevisionItems.position })
    .from(presentationReviewNotes)
    .leftJoin(presentationRevisionItems, eq(presentationRevisionItems.id, presentationReviewNotes.revisionItemId))
    .where(and(eq(presentationReviewNotes.body, body), isNull(presentationReviewNotes.parentNoteId)));
  assert.ok(row, `"${body}" was not stored`);
  return { position: row.position ?? null, anchor: row.anchor };
}

const audioTime = (page: Page) => page.evaluate(() => document.querySelector("audio")!.currentTime);

/* ---------------------------------------------------------- eligibility */

test("a video frozen as video offers a precise time; a video frozen as a download never does", { skip }, async () => {
  {
    const { page, errors } = await open(clientPage());
    for (const [label, offered] of [
      ["This version as a whole", false],
      ["Intro", false],
      ["The clip", true],
      ["The sound", true],
    ] as const) {
      await about(page).selectOption({ label });
      assert.equal(await page.getByRole("button", { name: /^Set precise time/ }).count(), offered ? 1 : 0, `${label}: offered ${!offered}`);
    }
    assert.deepEqual(errors, []);
    await page.context().close();
  }

  // The same MOV today plays in Files; this Revision froze it as a download,
  // so it has no player here and takes no time, for good.
  {
    const { page, errors } = await open(`/workrooms/${fixture.room}/presentations/${v.frozen}`);
    assert.equal(await page.locator("video").count(), 0, "the frozen download became a player");
    assert.equal(await page.getByText("No preview for this kind of file.").count(), 1);
    await about(page).selectOption({ label: "The frozen clip" });
    assert.equal(await page.getByRole("button", { name: /precise time/ }).count(), 0, "a download offered a time");
    assert.equal(await page.locator("input[name=anchor]").count(), 0);
    assert.deepEqual(errors, []);
    await page.context().close();
  }
});

/* ------------------------------------------------------------- a moment */

test("a moment: chosen on the video's own player, read live as it is scrubbed, stored exactly", { skip }, async () => {
  const { page, errors } = await open(clientPage());
  await countPlays(page);
  const videos = await page.locator("video").count();

  await about(page).selectOption({ label: "The clip" });
  await setTime(page, "The clip").click();
  await panel(page).waitFor();

  // Under *that* video, which is the page's only one — nothing added, nothing
  // laid over it — and focus is in the panel.
  assert.ok(
    await panel(page).evaluate(
      (element: HTMLElement) =>
        element.parentElement!.querySelector("video") === document.querySelector("video") &&
        document.activeElement === element &&
        element.compareDocumentPosition(element.parentElement!.querySelector("video")!) & Node.DOCUMENT_POSITION_PRECEDING,
    ),
    "the panel is not under the clip's own player, or did not take focus",
  );
  assert.equal(await page.locator("video").count(), videos, "a second player appeared");
  assert.ok(await page.locator("video").evaluate((video: HTMLVideoElement) => video.controls), "native controls were taken away");
  assert.equal(await panel(page).getByText("Precise time on The clip", { exact: true }).count(), 1);

  // Scrubbing the native player is what the panel reads.
  await scrub(page, 3.25);
  await panel(page).getByText("Player at 0:03", { exact: true }).waitFor();
  await scrub(page, 2.5);
  await panel(page).getByText("Player at 0:02", { exact: true }).waitFor();

  await button(page, "Use this moment").click();
  assert.equal(await choice(page), "At 0:02");
  await button(page, "Done").click();
  assert.equal(await panel(page).count(), 0, "Done did not close the panel");

  // The composer holds it in words, with Change and Clear.
  assert.equal(await page.getByText("At 0:02", { exact: true }).count(), 1);
  assert.equal(await button(page, "Change the precise time on The clip").count(), 1);
  assert.equal(await button(page, "Clear the precise time on The clip").count(), 1);

  await send(page, "F4 moment.");
  assert.deepEqual(await stored("F4 moment."), { position: 1, anchor: { kind: "time", t: 2.5 } });
  assert.equal(await plays(page), 0, "something played the video");
  assert.ok(await page.locator("video").evaluate((video: HTMLVideoElement) => video.paused));
  assert.deepEqual(errors, []);
  await page.context().close();
});

/* ------------------------------------------------------------ a stretch */

test("a stretch: a start, an end after it — an end at or before the start refused — stored exactly", { skip }, async () => {
  const { page, errors } = await open(clientPage());
  await countPlays(page);

  await about(page).selectOption({ label: "The clip" });
  await setTime(page, "The clip").click();
  await panel(page).waitFor();

  await scrub(page, 1.5);
  await button(page, "Start here").click();
  assert.equal(await choice(page), "Starts at 0:01 — now choose where it ends.");

  for (const t of [1, 1.5]) {
    await scrub(page, t);
    await button(page, "End here").click();
    assert.equal(await choice(page), "Choose an end after the start.", `an end at ${t} was taken`);
  }

  await scrub(page, 5.75);
  await button(page, "End here").click();
  assert.equal(await choice(page), "0:01–0:05");
  await button(page, "Done").click();
  assert.equal(await page.getByText("0:01–0:05", { exact: true }).count(), 1);

  await send(page, "F4 stretch.");
  assert.deepEqual(await stored("F4 stretch."), { position: 1, anchor: { kind: "time", t: 1.5, t2: 5.75 } });
  assert.equal(await plays(page), 0);
  assert.deepEqual(errors, []);
  await page.context().close();
});

/* ------------------------------------------------------------- locators */

test("the client's locators bring the video into view, seek it, and leave it paused", { skip }, async () => {
  const { page, errors } = await open(clientPage());
  await countPlays(page);

  await locator(page, "On The clip · At 0:02").click();
  await seeksTo(page, "video", 2.5);
  assert.ok(await inView(page, "video"), "the clip was not brought into view");
  assert.ok(await page.evaluate(() => document.activeElement === document.querySelector("video")), "focus is not on the clip");

  // A stretch seeks to its start and does not play it, or loop it.
  await locator(page, "On The clip · 0:01–0:05").click();
  await seeksTo(page, "video", 1.5);

  assert.equal(await audioTime(page), 0, "the recording on the same page was moved");
  assert.equal(await plays(page), 0, "a locator played something");
  assert.deepEqual(errors, []);
  await page.context().close();
});

test("Studio's draft page sends each video note to its own Revision, which seeks and stays paused", { skip }, async () => {
  const { page, errors } = await open(studioPage());
  const links = page.getByRole("link", { name: /^On The clip · / });
  assert.equal(await links.count(), 2);
  const hrefs = (await links.evaluateAll((all: HTMLAnchorElement[]) => all.map((a) => a.getAttribute("href")))) as string[];
  assert.deepEqual(hrefs.sort(), [`${studioPage()}/revisions/1?note=1`, `${studioPage()}/revisions/1?note=2`]);
  for (const href of hrefs) assert.doesNotMatch(href.slice(studioPage().length), UUID);
  // Studio never captures.
  assert.equal(await page.getByRole("button", { name: /precise time|Use this moment|Start here|End here/ }).count(), 0);

  await page.getByRole("link", { name: "On The clip · At 0:02" }).click();
  await page.waitForURL("**/revisions/1?note=1");
  await seeksTo(page, "video", 2.5);
  assert.ok(await inView(page, "video"));
  assert.deepEqual(errors, []);
  await page.context().close();

  // The stretch, opened the same way: its start, paused.
  const second = await open(`${studioPage()}/revisions/1?note=2`);
  await countPlays(second.page);
  await seeksTo(second.page, "video", 1.5);
  assert.equal(await plays(second.page), 0);
  assert.equal(await second.page.getByRole("button", { name: /precise time|Use this moment/ }).count(), 0);
  assert.deepEqual(second.errors, []);
  await second.page.context().close();
});

/* ---------------------------------------------------------------- phone */

test("at 390px on a touch screen: the panel sits under the native player, nothing overflows, a moment is kept", { skip }, async () => {
  const { page, errors } = await open(clientPage(), { viewport: { width: 390, height: 844 }, mobile: true });
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

  await about(page).selectOption({ label: "The clip" });
  await setTime(page, "The clip").click();
  await panel(page).waitFor();
  assert.ok(await page.locator("video").evaluate((video: HTMLVideoElement) => video.hasAttribute("playsinline") && video.controls));
  assert.ok((await overflow()) <= 0, "the page scrolls sideways");

  // The panel does not cover the video: it begins below the player's bottom edge.
  const [video, box] = await Promise.all([
    page.locator("video").boundingBox(),
    panel(page).boundingBox(),
  ]);
  assert.ok(box.y >= video.y + video.height - 1, "the panel is drawn over the video");

  // Ranges stay offered on a coarse pointer, as F3 was accepted.
  for (const [name, least] of [
    ["Use this moment", 44],
    ["Start here", 44],
    ["End here", 44],
    ["Done", 38],
    ["Cancel", 38],
  ] as const) {
    const size = await button(page, name).boundingBox();
    assert.ok(size && size.height >= least && size.x >= 0 && size.x + size.width <= 390, `${name} is cramped or off screen`);
  }

  await scrub(page, 4.25);
  await button(page, "Use this moment").tap();
  await button(page, "Done").tap();
  await send(page, "F4 phone moment.");
  assert.deepEqual(await stored("F4 phone moment."), { position: 1, anchor: { kind: "time", t: 4.25 } });
  assert.deepEqual(errors, []);
  await page.context().close();
});

/* ------------------------------------------------------------ fail closed */

test("the server refuses a time on a frozen download, and anything but a time on a video", { skip }, async () => {
  const frozen = await createReviewNote(v.quinn, {
    reviewId: v.frozenReview,
    body: "Refused: a time on a frozen download.",
    itemPosition: 0,
    anchor: { kind: "time", t: 2 },
  });
  assert.ok(!frozen.ok);
  assert.equal(frozen.message, "This kind of file takes feedback as a whole, not at a point in it.");

  for (const [position, anchor, why] of [
    [1, { kind: "point", x: 0.5, y: 0.5 }, "a point on a video"],
    [1, { kind: "region", x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, "an area on a video"],
    [1, { kind: "time", t: 1, region: { x: 0.9, y: 0.9, w: 0.5, h: 0.5 } }, "a frame area leaving the video"],
    [1, { kind: "time", t: -1 }, "a negative time"],
    [1, { kind: "time", t: Number.NaN }, "NaN"],
    [1, { kind: "time", t: Number.POSITIVE_INFINITY }, "infinity"],
    [1, { kind: "time", t: 3, t2: 3 }, "an end at the start"],
    [1, { kind: "time", t: 3, t2: 2 }, "an end before the start"],
    [1, { kind: "time", t: 2, frame: 48 }, "a frame number"],
    [0, { kind: "time", t: 2 }, "a time on a written note"],
    [null, { kind: "time", t: 2 }, "a time about nothing"],
  ] as const) {
    const refused = await createReviewNote(v.quinn, {
      reviewId: v.review,
      body: `Refused: ${why}.`,
      itemPosition: position,
      anchor,
    });
    assert.ok(!refused.ok, `the server stored ${why}`);
  }
  const leaked = await db()
    .select({ body: presentationReviewNotes.body })
    .from(presentationReviewNotes)
    .where(eq(presentationReviewNotes.presentationReviewId, v.review));
  assert.ok(!leaked.some((row) => row.body.startsWith("Refused")), "a refused note was stored");
});

/* ------------------------------------------------------------- history */

test("after a newer version, the old one's video notes still seek and stay paused, read-only", { skip }, async () => {
  assert.ok((await publishPresentation(owner, v.pid, await version(v.pid))).ok);

  {
    const { page, errors } = await open(`${clientPage()}/revisions/1`);
    await countPlays(page);
    assert.equal(await page.getByLabel("What would you like to say?").count(), 0, "a replaced version took new feedback");
    assert.equal(await page.getByRole("button", { name: /precise time/ }).count(), 0);
    await locator(page, "On The clip · At 0:02").click();
    await seeksTo(page, "video", 2.5);
    await locator(page, "On The clip · 0:01–0:05").click();
    await seeksTo(page, "video", 1.5);
    await locator(page, "On The clip · At 0:04").click();
    await seeksTo(page, "video", 4.25);
    assert.equal(await plays(page), 0);
    assert.deepEqual(errors, []);
    await page.context().close();
  }

  // Studio's view of the replaced version, opened for a note.
  {
    const { page, errors } = await open(`${studioPage()}/revisions/1?note=2`);
    await seeksTo(page, "video", 1.5);
    assert.deepEqual(errors, []);
    await page.context().close();
  }

  // The new version has its own, empty, history: nothing from Version 1 on it.
  {
    const { page } = await open(clientPage());
    assert.equal(await page.getByRole("button", { name: /^On The clip · / }).count(), 0);
    await page.context().close();
  }
});
