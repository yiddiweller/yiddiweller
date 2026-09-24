import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import {
  clientPage,
  fixture,
  inView,
  inViewNow,
  locator,
  markers,
  open,
  player,
  pointIsOn,
  seeksTo,
  setUp,
  skip,
  studioPage,
  tearDown,
} from "./support/browser.ts";
import { UUID } from "./support/review-stage.ts";

/**
 * Stage F2 in a real browser: a locator shows exactly what its comment is
 * about, on the version it was written about, and nothing moves until
 * somebody asks. The fixture and the page helpers are `support/browser.ts`,
 * shared with the capture suite.
 */

const base = process.env.REVIEW_SERVER_URL;

before(setUp);
after(tearDown);
/* ------------------------------------------------------- image points */

test("the work is clean until somebody asks", { skip }, async () => {
  for (const path of [clientPage(), `${clientPage()}/revisions/2`, `${studioPage()}/revisions/2`, `${studioPage()}/revisions/3`]) {
    const { page, errors } = await open(path);
    await page.waitForTimeout(500);
    assert.equal(await markers(page), 0, `${path} drew a marker on load`);
    const video = await player(page, "video");
    assert.equal(video.time, 0, `${path} moved the player on load`);
    assert.ok(video.paused, `${path} started the player on load`);
    assert.equal(await page.locator('[aria-pressed="true"]').count(), 0);
    assert.deepEqual(errors, []);
    await page.context().close();
  }
});

test("a point is drawn exactly where it was stored, and follows the picture as it resizes", { skip }, async () => {
  const { page, errors } = await open(`${clientPage()}/revisions/2`);

  await locator(page, "On The board · Point").click();
  await pointIsOn(page, "Board.png", 0.25, 0.75);
  assert.ok(await inView(page, 'img[alt="Board.png"]'), "the board was not brought into view");
  assert.equal(await page.locator('[aria-pressed="true"]').count(), 1);
  assert.equal(
    await page.evaluate(() => document.activeElement?.querySelector('img[alt="Board.png"]') !== null),
    true,
    "focus did not follow to the work",
  );

  // Narrower: the picture shrinks, and the point shrinks with it.
  await page.setViewportSize({ width: 700, height: 900 });
  await pointIsOn(page, "Board.png", 0.25, 0.75);

  // A second point replaces the first.
  await locator(page, "On The poster · Point").click();
  await pointIsOn(page, "Poster.png", 0.8, 0.2);
  assert.equal(await markers(page), 1, "two points at once");

  // Pressing it again puts it away; so does Escape.
  await locator(page, "On The poster · Point").click();
  assert.equal(await markers(page), 0, "pressing the locator again did not hide it");
  await locator(page, "On The poster · Point").click();
  await page.waitForFunction(() => document.querySelectorAll("[data-anchor-marker]").length === 1);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelectorAll("[data-anchor-marker]").length === 0);
  assert.equal(await page.locator('[aria-pressed="true"]').count(), 0);

  assert.deepEqual(errors, []);
  await page.context().close();
});

test("on a phone the point is on the same place in the picture", { skip }, async () => {
  const { page, errors } = await open(`${clientPage()}/revisions/2`, { viewport: { width: 390, height: 844 } });
  await locator(page, "On The board · Point").click();
  await pointIsOn(page, "Board.png", 0.25, 0.75);
  await locator(page, "On The poster · Point").click();
  await pointIsOn(page, "Poster.png", 0.8, 0.2);
  assert.deepEqual(errors, []);
  await page.context().close();
});

test("an area is brought into view and not passed off as a point", { skip }, async () => {
  const { page, errors } = await open(`${clientPage()}/revisions/2`);
  await locator(page, "On The board · Area").click();
  await page.waitForTimeout(800);
  assert.equal(await markers(page), 0, "a region was drawn as a point");
  assert.ok(await inView(page, 'img[alt="Board.png"]'));
  assert.equal(await page.getByText("Showing The board.", { exact: true }).count(), 1);
  assert.deepEqual(errors, []);
  await page.context().close();
});

test("with reduced motion the jump is immediate", { skip }, async () => {
  const { page } = await open(`${clientPage()}/revisions/2`, { reducedMotion: "reduce" });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await locator(page, "On The board · Point").click();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.ok(await inViewNow(page, 'img[alt="Board.png"]'), "the scroll animated under reduced motion");
  await page.context().close();
});

/* ------------------------------------------------------------ players */

test("a moment on a video pauses it there, and nothing plays", { skip }, async () => {
  const { page, errors } = await open(`${clientPage()}/revisions/2`);

  await locator(page, "On The motion · At 0:03").click();
  await seeksTo(page, "video", 3);
  assert.ok((await player(page, "video")).focused, "focus did not go to the player");
  assert.ok(await inView(page, "video"));

  // A stretch goes to its start and stays there — no loop, no playback.
  await locator(page, "On The motion · 0:02–0:05").click();
  await seeksTo(page, "video", 2);

  // A moment with an area on its frame: the moment, and no drawing.
  await locator(page, "On The motion · At 0:04").click();
  await seeksTo(page, "video", 4);
  assert.equal(await markers(page), 0, "a frame region was drawn");

  assert.deepEqual(errors, []);
  await page.context().close();
});

test("a stored moment past the end of the file is declined, and the note stays whole", { skip }, async () => {
  const { page, errors } = await open(`${clientPage()}/revisions/2`);
  const beyond = locator(page, "On The motion · At 25:00:00");

  await beyond.click();
  await page.getByText("The motion ends before 25:00:00.", { exact: true }).waitFor({ state: "attached" });
  const video = await player(page, "video");
  assert.equal(video.time, 0, "the player was moved to somewhere the note does not say");
  assert.ok(video.paused);
  assert.equal(await beyond.count(), 1, "the locator went");
  assert.equal(await page.getByText("Note at 2.").count(), 4, "the notes on the motion did not all survive");
  assert.deepEqual(errors, []);
  await page.context().close();
});

test("a player that has not loaded yet is seeked once it has, with one wait and no pile of listeners", { skip }, async () => {
  const { page, errors, release } = await open(`${clientPage()}/revisions/2`, {
    hold: `/files/${fixture.motionFile}/view`,
  });

  const baseline = await page.evaluate(() => (window as unknown as { __metadataListeners: number }).__metadataListeners);
  assert.equal((await player(page, "video")).ready, 0, "the file was not held back");

  await locator(page, "On The motion · 0:02–0:05").click();
  await locator(page, "On The motion · At 0:04").click();
  await locator(page, "On The motion · At 0:03").click();
  await page.waitForTimeout(200);

  const waiting = await page.evaluate(() => (window as unknown as { __metadataListeners: number }).__metadataListeners);
  assert.equal(waiting - baseline, 1, `${waiting - baseline} waits for one player`);

  release();
  await seeksTo(page, "video", 3);
  const done = await page.evaluate(() => (window as unknown as { __metadataListeners: number }).__metadataListeners);
  assert.equal(done, baseline, "a wait was left behind");
  assert.deepEqual(errors, []);
  await page.context().close();
});

test("audio seeks the same way, by keyboard, with nothing drawn", { skip }, async () => {
  const { page, errors } = await open(`${clientPage()}/revisions/2`);

  const moment = locator(page, "On The sound · At 0:02");
  await moment.focus();
  await page.keyboard.press("Enter");
  await seeksTo(page, "audio", 2);
  assert.ok((await player(page, "audio")).focused);

  const stretch = locator(page, "On The sound · 0:01–0:03");
  await stretch.focus();
  await page.keyboard.press(" ");
  await seeksTo(page, "audio", 1);

  assert.equal(await page.locator("canvas").count(), 0, "a waveform appeared");
  assert.equal(await markers(page), 0);
  assert.deepEqual(errors, []);
  await page.context().close();
});

/* ------------------------------------------------ which notes have one */

test("only precise live notes have a locator: not item-level, not a tombstone, and a resolved one still does", { skip }, async () => {
  const { page } = await open(`${clientPage()}/revisions/2`);
  const thread = page.getByRole("region", { name: "Feedback" });

  // Nine precise notes, the first of them dealt with.
  assert.equal(await thread.locator("button[aria-pressed]").count(), 9);
  assert.equal(await thread.getByText("On The board", { exact: true }).count(), 1, "item-level feedback lost its line");
  assert.equal(await thread.getByText("Comment removed", { exact: true }).count(), 1);
  assert.equal(await thread.getByText(/Dealt with/).count(), 1);
  await locator(page, "On The board · Point").click();
  await pointIsOn(page, "Board.png", 0.25, 0.75);
  await page.context().close();
});

/* ------------------------------------------------------------ history */

test("every page shows a note on its own version's work — never the current version's", { skip }, async () => {
  // The client's current page is Version 3: position 1 is the video there.
  {
    const { page, errors } = await open(clientPage());
    await locator(page, "On The board · Point").click();
    await pointIsOn(page, "Board.png", 0.5, 0.5);
    await locator(page, "On The motion · At 0:02").click();
    await seeksTo(page, "video", 2);
    assert.equal(await markers(page), 0, "the earlier point was left on screen");
    assert.deepEqual(errors, []);
    await page.context().close();
  }

  // Version 2, both worlds: position 1 is the board there.
  for (const path of [`${clientPage()}/revisions/2`, `${studioPage()}/revisions/2`]) {
    const { page, errors } = await open(path);
    await locator(page, "On The board · Point").click();
    await pointIsOn(page, "Board.png", 0.25, 0.75);
    assert.deepEqual(errors, [], path);
    await page.context().close();
  }
});

test("Studio's draft page sends a locator to the version the round is on, carrying only the note", { skip }, async () => {
  const { page, errors } = await open(studioPage());

  // No work of any version is drawn on here, and the draft is not a stage.
  assert.equal(await page.locator("[aria-pressed]").count(), 0);
  const links = page.getByRole("link", { name: /^On The (board|motion) · / });
  assert.equal(await links.count(), 2);
  const hrefs = await links.evaluateAll((all: HTMLAnchorElement[]) => all.map((a) => a.getAttribute("href")));
  assert.deepEqual(hrefs.sort(), [`${studioPage()}/revisions/3?note=1`, `${studioPage()}/revisions/3?note=2`]);
  for (const href of hrefs) assert.doesNotMatch(href!.slice(studioPage().length), UUID);

  await page.getByRole("link", { name: "On The board · Point" }).click();
  await page.waitForURL(`**/revisions/3?note=2`);
  await pointIsOn(page, "Board.png", 0.5, 0.5);
  assert.ok(await inView(page, 'img[alt="Board.png"]'));
  assert.deepEqual(errors, []);
  await page.context().close();
});

test("a version's page opens a note from the URL only if that version's round has it", { skip }, async () => {
  // Version 2's note 1: its point, on load.
  {
    const { page } = await open(`${studioPage()}/revisions/2?note=1`);
    await pointIsOn(page, "Board.png", 0.25, 0.75);
    await page.context().close();
  }
  // Version 3's note 1 is a moment on the video — not Version 2's point.
  {
    const { page } = await open(`${studioPage()}/revisions/3?note=1`);
    await seeksTo(page, "video", 2);
    assert.equal(await markers(page), 0);
    await page.context().close();
  }
  // A tombstone, an item-level note, a note that does not exist and nonsense.
  for (const query of ["?note=11", "?note=10", "?note=999", "?note=abc", "?note=1&note=2"]) {
    const { page, errors } = await open(`${studioPage()}/revisions/2${query}`);
    await page.waitForTimeout(700);
    assert.equal(await markers(page), 0, `${query} drew something`);
    assert.equal((await player(page, "video")).time, 0, `${query} moved the player`);
    assert.deepEqual(errors, [], query);
    await page.context().close();
  }
});

/* ------------------------------------------------------------- leaks */

test("the client's page carries no identifier, key or signed address for any of this", { skip }, async () => {
  const headers = { cookie: `__Secure-yw_client.session_token=${fixture.clientCookie}` };
  for (const path of [clientPage(), `${clientPage()}/revisions/2`]) {
    const document = await (await fetch(`${base}${path}`, { headers })).text();
    const flight = await (await fetch(`${base}${path}`, { headers: { ...headers, RSC: "1" } })).text();
    for (const [what, body] of [["document", document], ["flight", flight]] as const) {
      assert.ok(body.length > 500, `${path} ${what} is empty, so this proves nothing`);
      assert.doesNotMatch(body, UUID, `${path} ${what} carries an identifier`);
      assert.doesNotMatch(body, /\/original\b|X-Amz-|Signature=/, `${path} ${what} carries a storage address`);
      assert.doesNotMatch(body, /\?note=/, `${path} ${what} carries a Studio locator`);
    }
  }
});
