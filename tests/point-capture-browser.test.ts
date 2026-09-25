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
import { requestReview } from "../lib/db/reviews.ts";
import { presentationReviewNotes, presentationRevisionItems } from "../lib/db/schema.ts";
import { file, fixture, markers, open, pointIsOn, setUp, skip, tearDown, type Page } from "./support/browser.ts";
import { png, wav, webm } from "./support/media.ts";
import { owner, staff, UUID } from "./support/review-stage.ts";

/**
 * Stage F5.2 in a real browser: one point on a picture, chosen on the picture
 * itself, kept in the draft, stored through the ordinary client action, and
 * found again by F2's locators — the client's, Studio's, and on a version that
 * has since been replaced.
 *
 * *Image review test*, in the fixture's Workroom, with an open round:
 *
 *   Version 1   0 Intro · 1 The board (800×400) · 2 The poster (400×800)
 *               · 3 The wordmark (an SVG, frozen as a download) · 4 The clip
 *               · 5 The sound · 6 The deck
 *
 * The poster is tall, so at desktop width its stage has space beside it: the
 * letterbox a press must never turn into a point.
 */

before(async () => {
  await setUp();
  if (!skip) await seedImages();
});
after(tearDown);

const v = { pid: "", presentation: "" };

async function version(pid: string): Promise<number> {
  return (await findPresentation(pid))!.version;
}

async function seedImages(): Promise<void> {
  const workroomId = fixture.workroomId;
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  const made = await createPresentation(owner, workroomId, { title: "Image review test", intro: "" });
  assert.ok(made.ok);
  const pid = made.value;
  assert.ok((await addNoteItem(owner, pid, await version(pid), { caption: "Intro", body: "Words." })).ok);
  for (const [name, type, bytes, caption] of [
    ["Board.png", "image/png", png(800, 400), "The board"],
    ["Poster.png", "image/png", png(400, 800), "The poster"],
    ["Wordmark.svg", "image/svg+xml", svg, "The wordmark"],
    ["Clip.webm", "video/webm", webm(), "The clip"],
    ["Sound.wav", "audio/wav", wav(6), "The sound"],
    ["Deck.pdf", "application/pdf", Buffer.from("%PDF-1.4\n%%EOF\n"), "The deck"],
  ] as const) {
    const id = await file(workroomId, name, type, bytes);
    assert.ok((await addFileItem(owner, pid, await version(pid), id, caption)).ok);
  }
  assert.ok((await publishPresentation(owner, pid, await version(pid))).ok);
  assert.ok((await requestReview(staff, (await findPresentation(pid))!.currentRevisionId!)).ok);
  Object.assign(v, { pid, presentation: (await findPresentation(pid))!.publicId });
}

const clientPage = () => `/workrooms/${fixture.room}/presentations/${v.presentation}`;
const studioPage = () => `/studio/workrooms/${fixture.workroomId}/presentations/${v.pid}`;

/* -------------------------------------------------------------- helpers */

const about = (page: Page) => page.getByLabel("About");
const words = (page: Page) => page.getByLabel("What would you like to say?");
const pointTo = (page: Page, name: string) => page.getByRole("button", { name: `Point to a place on ${name}`, exact: true });
const panel = (page: Page) => page.getByRole("group", { name: /^Point on / });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const status = (page: Page) => panel(page).getByRole("status").textContent();
const draft = (page: Page) => page.locator("input[name=anchor]").inputValue();

/**
 * Where on the screen a fraction of a picture is, and what fraction a press at
 * that whole pixel will record — computed here independently of the app: the
 * image's content box, its natural aspect ratio fitted and centred inside it.
 */
async function spot(page: Page, alt: string, fx: number, fy: number) {
  return page.evaluate(
    ({ alt, fx, fy }: { alt: string; fx: number; fy: number }) => {
      const image = document.querySelector<HTMLImageElement>(`img[alt="${alt}"]`)!;
      const s = getComputedStyle(image);
      const n = (value: string) => parseFloat(value) || 0;
      const r = image.getBoundingClientRect();
      const box = {
        left: r.left + n(s.borderLeftWidth) + n(s.paddingLeft),
        top: r.top + n(s.borderTopWidth) + n(s.paddingTop),
        width: r.width - n(s.borderLeftWidth) - n(s.paddingLeft) - n(s.borderRightWidth) - n(s.paddingRight),
        height: r.height - n(s.borderTopWidth) - n(s.paddingTop) - n(s.borderBottomWidth) - n(s.paddingBottom),
      };
      const scale = Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight);
      const w = image.naturalWidth * scale;
      const h = image.naturalHeight * scale;
      const left = box.left + (box.width - w) / 2;
      const top = box.top + (box.height - h) / 2;
      const x = Math.round(left + fx * w);
      const y = Math.round(top + fy * h);
      const round = (value: number) => Math.round(value * 10_000) / 10_000;
      return { x, y, expected: { x: round((x - left) / w), y: round((y - top) / h) } };
    },
    { alt, fx, fy },
  );
}

/** Scrolls a picture fully into view, lets it settle, and presses at a fraction of it. */
async function pressOn(page: Page, alt: string, fx: number, fy: number, tap = false) {
  await page.locator(`img[alt="${alt}"]`).evaluate((image: HTMLElement) => image.scrollIntoView({ block: "center" }));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const at = await spot(page, alt, fx, fy);
  if (tap) await page.touchscreen.tap(at.x, at.y);
  else await page.mouse.click(at.x, at.y);
  return at.expected;
}

async function marker(page: Page): Promise<{ x: number; y: number } | null> {
  return page.evaluate(() => {
    const all = document.querySelectorAll<HTMLElement>("[data-anchor-marker]");
    if (all.length !== 1) return null;
    const r = all[0]!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
}

async function send(page: Page, body: string): Promise<void> {
  await words(page).fill(body);
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

const imgCount = (page: Page) => page.locator("img").count();

/**
 * Until a picture is in view and the page has stopped moving: Point to it
 * scrolls smoothly to its picture, and a smooth scroll may not have started
 * the moment the press returns.
 */
async function settled(page: Page, alt: string): Promise<void> {
  await page.waitForFunction(
    (alt: string) => {
      const r = document.querySelector(`img[alt="${alt}"]`)!.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight;
    },
    alt,
    { timeout: 10_000 },
  );
  // Still for 600ms of real time: headless frames are not a clock, and a
  // smooth scroll can pause between them.
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __lastY?: number; __still?: number };
      w.__still = w.__lastY === window.scrollY ? (w.__still ?? 0) + 1 : 0;
      w.__lastY = window.scrollY;
      return w.__still >= 4;
    },
    undefined,
    { timeout: 10_000, polling: 150 },
  );
}

/* ---------------------------------------------------------- eligibility */

test("A. only a picture its Revision froze as an image offers Point to it", { skip }, async () => {
  const { page, errors } = await open(clientPage());
  for (const [label, point, time] of [
    ["This version as a whole", false, false],
    ["Intro", false, false],
    ["The board", true, false],
    ["The poster", true, false],
    ["The wordmark", false, false],
    ["The clip", false, true],
    ["The sound", false, true],
    ["The deck", false, false],
  ] as const) {
    await about(page).selectOption({ label });
    assert.equal(await page.getByRole("button", { name: /^Point to a place on / }).count(), point ? 1 : 0, `${label}: point`);
    assert.equal(await page.getByRole("button", { name: /^Set precise time/ }).count(), time ? 1 : 0, `${label}: time`);
  }
  // The SVG is a download card: nothing to point at.
  assert.equal(await page.locator('img[alt="Wordmark.svg"]').count(), 0);
  assert.equal(await markers(page), 0, "a marker was drawn by choosing a subject");

  // Choosing the picture is not choosing a point: until Point to it is
  // pressed, nothing listens, and a press on the picture is nothing at all.
  await about(page).selectOption({ label: "The board" });
  await page.waitForTimeout(200);
  assert.equal(await panel(page).count(), 0, "capture opened without Point to it");
  await pressOn(page, "Board.png", 0.5, 0.5);
  assert.equal(await markers(page), 0, "a press placed a point without Point to it");
  assert.equal(await draft(page), "");
  assert.deepEqual(errors, []);
  await page.context().close();
});

/* -------------------------------------------------------------- opening */

test("B. Point to it brings that picture into view, one panel under it, no second picture", { skip }, async () => {
  const { page, errors } = await open(clientPage());
  const pictures = await imgCount(page);

  await about(page).selectOption({ label: "The board" });
  const opener = pointTo(page, "The board");
  assert.equal(await opener.textContent(), "Point to it");
  await opener.click();
  await panel(page).waitFor();

  assert.equal(await panel(page).count(), 1);
  assert.equal(await imgCount(page), pictures, "a second picture appeared");
  assert.equal(await panel(page).getByText("Point on The board", { exact: true }).count(), 1);
  assert.equal(await panel(page).getByText("Click the image where you mean.", { exact: true }).count(), 1);
  assert.equal(await status(page), "Nothing chosen yet.");
  assert.ok(await button(page, "Done").isDisabled(), "Done before a point");

  // Under that picture, its stage focused and labelled, and the picture in view.
  assert.ok(
    await panel(page).evaluate((element: HTMLElement) => {
      const board = document.querySelector('img[alt="Board.png"]')!;
      const stage = board.parentElement!;
      return (
        element.parentElement!.contains(board) &&
        document.activeElement === stage &&
        stage.getAttribute("aria-label") === "Place a point on The board"
      );
    }),
    "the panel is not under the board, or its stage is not the focused surface",
  );
  await page.waitForFunction(() => {
    const r = document.querySelector('img[alt="Board.png"]')!.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight;
  });
  assert.deepEqual(errors, []);
  await page.context().close();
});

/* ------------------------------------------------------------ placement */

test("C. a press on the picture places the one marker there; a second press moves it", { skip }, async () => {
  const { page, errors } = await open(clientPage());
  await about(page).selectOption({ label: "The board" });
  await pointTo(page, "The board").click();
  await panel(page).waitFor();

  const first = await pressOn(page, "Board.png", 0.25, 0.75);
  await pointIsOn(page, "Board.png", first.x, first.y);
  assert.equal(await status(page), "Point placed — click again to move it.");
  assert.ok(!(await button(page, "Done").isDisabled()), "Done stayed off");
  const before = await marker(page);

  const second = await pressOn(page, "Board.png", 0.6, 0.3);
  await pointIsOn(page, "Board.png", second.x, second.y);
  assert.equal(await markers(page), 1, "two markers");
  const after = await marker(page);
  assert.ok(before && after && (Math.abs(before.x - after.x) > 50 || Math.abs(before.y - after.y) > 50), "the marker did not move");

  await button(page, "Done").click();
  assert.equal(await draft(page), JSON.stringify({ kind: "point", x: second.x, y: second.y }));
  assert.deepEqual(errors, []);
  await page.context().close();
});

/* -------------------------------------------------------- event scoping */

test("D. nothing outside the picture's stage is ever a placement — not a control, a link, the words or another picture", { skip }, async () => {
  const { page, errors } = await open(clientPage());
  await about(page).selectOption({ label: "The board" });
  await pointTo(page, "The board").click();
  await panel(page).waitFor();
  const placed = await pressOn(page, "Board.png", 0.4, 0.6);
  const held = JSON.stringify({ kind: "point", x: placed.x, y: placed.y });
  const placedStatus = "Point placed — click again to move it.";

  // Every status the panel ever shows, from here on.
  await page.evaluate(() => {
    const w = window as unknown as { __said: string[] };
    w.__said = [];
    const status = document.querySelector('[role="group"] [role="status"]')!;
    new MutationObserver(() => w.__said.push(status.textContent ?? "")).observe(status, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
  const said = () => page.evaluate(() => (window as unknown as { __said: string[] }).__said);

  // The download link is followed only to the point of the click: its
  // navigation is stopped, never its propagation.
  await page.evaluate(() => {
    for (const a of document.querySelectorAll("a")) a.addEventListener("click", (event) => event.preventDefault());
  });

  const presses: [string, () => Promise<void>][] = [
    ["the panel's title", () => panel(page).getByText("Point on The board", { exact: true }).click()],
    ["the panel's hint", () => panel(page).getByText("Click the image where you mean.", { exact: true }).click()],
    ["the panel's status", () => panel(page).getByRole("status").click()],
    ["Download Board.png", () => page.getByRole("link", { name: "Download Board.png", exact: true }).click()],
    ["another block's download", () => page.getByRole("link", { name: "Download Poster.png", exact: true }).click()],
    ["another picture", async () => void (await pressOn(page, "Poster.png", 0.5, 0.5))],
    ["the file line under the work", () => page.getByText(/^image · /).first().click()],
    ["the words being written", () => words(page).click()],
    ["the About control", () => about(page).click()],
  ];
  for (const [what, press] of presses) {
    await press();
    await page.waitForTimeout(100);
    assert.equal(await markers(page), 1, `${what} took the marker away or added one`);
    await pointIsOn(page, "Board.png", placed.x, placed.y);
    assert.equal(await status(page), placedStatus, `${what} was treated as a press on the picture`);
  }
  assert.deepEqual(await said(), [], "a press outside the stage changed what the panel says");

  // Done keeps the point that was placed — Done's own position is no point.
  await button(page, "Done").click();
  assert.equal(await draft(page), held);
  assert.equal(await markers(page), 0, "the draft marker outlived its panel");

  // And Cancel, pressed over a held point, is not a point either.
  await button(page, "Change the point on The board").click();
  await panel(page).waitFor();
  await button(page, "Cancel").click();
  assert.equal(await draft(page), held);

  // With no capture open, a press on the picture is nothing at all.
  await pressOn(page, "Board.png", 0.9, 0.1);
  assert.equal(await markers(page), 0, "a press placed a point without Point to it");
  assert.equal(await draft(page), held);
  assert.deepEqual(errors, []);
  await page.context().close();
});

/* ------------------------------------------------------------- letterbox */

test("E. a press on the stage beside the picture places nothing, says so, and leaves a point where it was", { skip }, async () => {
  const { page, errors } = await open(clientPage());
  await about(page).selectOption({ label: "The poster" });
  await pointTo(page, "The poster").click();
  await panel(page).waitFor();
  await settled(page, "Poster.png");

  const stageBox = await page.locator('img[alt="Poster.png"]').evaluate((image: HTMLElement) => {
    const s = image.parentElement!.getBoundingClientRect();
    const i = image.getBoundingClientRect();
    return { left: s.left, right: s.right, imageLeft: i.left, imageRight: i.right, y: i.top + i.height / 2 };
  });
  assert.ok(stageBox.imageLeft - stageBox.left > 40, "the poster has no space beside it at this width");
  const besideX = Math.round((stageBox.left + stageBox.imageLeft) / 2);

  // Beside it, with nothing chosen yet: no point.
  await page.mouse.click(besideX, Math.round(stageBox.y));
  assert.equal(await status(page), "That is beside the image — click the picture itself.");
  assert.equal(await markers(page), 0);
  assert.ok(await button(page, "Done").isDisabled());

  // A real point, then beside it again: the point stays.
  const placed = await pressOn(page, "Poster.png", 0.5, 0.25);
  await pointIsOn(page, "Poster.png", placed.x, placed.y);
  const at = await page.locator('img[alt="Poster.png"]').evaluate((image: HTMLElement) => {
    const i = image.getBoundingClientRect();
    const s = image.parentElement!.getBoundingClientRect();
    return { x: Math.round((i.right + s.right) / 2), y: Math.round(i.top + i.height / 2) };
  });
  await page.mouse.click(at.x, at.y);
  assert.equal(await status(page), "That is beside the image — click the picture itself.");
  await pointIsOn(page, "Poster.png", placed.x, placed.y);
  await button(page, "Done").click();
  assert.equal(await draft(page), JSON.stringify({ kind: "point", x: placed.x, y: placed.y }));
  assert.deepEqual(errors, []);
  await page.context().close();
});

/* -------------------------------------------------------------- composer */

test("F. Done, Change, Cancel, Clear and a change of subject each leave the draft as they should", { skip }, async () => {
  const { page, errors } = await open(clientPage());
  await about(page).selectOption({ label: "The board" });

  // A new capture, cancelled: nothing.
  await pointTo(page, "The board").click();
  await panel(page).waitFor();
  await pressOn(page, "Board.png", 0.3, 0.3);
  await button(page, "Cancel").click();
  assert.equal(await draft(page), "");
  assert.equal(await markers(page), 0);
  assert.equal(await pointTo(page, "The board").count(), 1);

  // Done: the words, and Change and Clear.
  await pointTo(page, "The board").click();
  const first = await pressOn(page, "Board.png", 0.2, 0.8);
  await button(page, "Done").click();
  assert.equal(await page.getByText("A point on The board", { exact: true }).count(), 1);
  assert.equal(await button(page, "Change the point on The board").count(), 1);
  assert.equal(await button(page, "Clear the point on The board").count(), 1);
  assert.ok(await page.evaluate(() => document.activeElement?.tagName === "TEXTAREA"), "Done did not return to the words");
  const firstHeld = JSON.stringify({ kind: "point", x: first.x, y: first.y });
  assert.equal(await draft(page), firstHeld);

  // Change opens on the point already held; a new press moves it; Cancel
  // gives the old one back exactly.
  await button(page, "Change the point on The board").click();
  await panel(page).waitFor();
  await pointIsOn(page, "Board.png", first.x, first.y);
  assert.equal(await status(page), "Point placed — click again to move it.");
  await pressOn(page, "Board.png", 0.9, 0.1);
  await button(page, "Cancel").click();
  assert.equal(await draft(page), firstHeld, "Cancel after Change lost the old point");

  // Clear: the point goes, the subject stays.
  await button(page, "Clear the point on The board").click();
  assert.equal(await draft(page), "");
  assert.equal(await about(page).inputValue(), "1");
  assert.equal(await pointTo(page, "The board").count(), 1);

  // A point never follows the comment to another block.
  await pointTo(page, "The board").click();
  await pressOn(page, "Board.png", 0.5, 0.5);
  await button(page, "Done").click();
  await about(page).selectOption({ label: "The poster" });
  assert.equal(await draft(page), "", "the board's point followed the comment to the poster");
  await about(page).selectOption({ label: "The clip" });
  assert.equal(await draft(page), "");
  assert.deepEqual(errors, []);
  await page.context().close();
});

/* -------------------------------------------------------------- keyboard */

test("G. by keyboard: the first arrow centres it, arrows move it, Shift further, it stops at the edge, Enter keeps it, Escape does not", { skip }, async () => {
  const { page, errors } = await open(clientPage());
  await about(page).selectOption({ label: "The board" });
  await pointTo(page, "The board").click();
  await panel(page).waitFor();
  await page.waitForFunction(() => document.activeElement === document.querySelector('img[alt="Board.png"]')!.parentElement);
  await settled(page, "Board.png");
  const scroll = await page.evaluate(() => window.scrollY);

  await page.keyboard.press("ArrowRight");
  await pointIsOn(page, "Board.png", 0.5, 0.5);
  await page.keyboard.press("ArrowRight");
  await pointIsOn(page, "Board.png", 0.52, 0.5);
  await page.keyboard.press("ArrowUp");
  await pointIsOn(page, "Board.png", 0.52, 0.48);
  await page.keyboard.press("Shift+ArrowDown");
  await pointIsOn(page, "Board.png", 0.52, 0.58);
  await page.keyboard.press("Shift+ArrowLeft");
  await pointIsOn(page, "Board.png", 0.42, 0.58);
  for (let i = 0; i < 8; i += 1) await page.keyboard.press("Shift+ArrowLeft");
  await pointIsOn(page, "Board.png", 0, 0.58);
  assert.equal(await page.evaluate(() => window.scrollY), scroll, "the arrows scrolled the page");

  await page.keyboard.press("Enter");
  assert.equal(await panel(page).count(), 0, "Enter did not keep it");
  assert.equal(await draft(page), '{"kind":"point","x":0,"y":0.58}');

  // Change, move it, Escape: the kept point stays.
  await button(page, "Change the point on The board").click();
  await panel(page).waitFor();
  await page.waitForFunction(() => document.activeElement === document.querySelector('img[alt="Board.png"]')!.parentElement);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Escape");
  assert.equal(await panel(page).count(), 0);
  assert.equal(await draft(page), '{"kind":"point","x":0,"y":0.58}');

  // The instructions are there for a screen reader, and describe the surface.
  await button(page, "Change the point on The board").click();
  await panel(page).waitFor();
  const described = await page.evaluate(() => {
    const stage = document.querySelector('img[alt="Board.png"]')!.parentElement!;
    return document.getElementById(stage.getAttribute("aria-describedby")!)?.textContent ?? "";
  });
  assert.match(described, /arrow keys/);
  assert.doesNotMatch(described, /\d/, "the instructions say a number");
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
  await page.context().close();
});

/* ------------------------------------------------------------ submission */

test("H. sent through the ordinary action: the rounded point, on its own block, and no identifier on the page", { skip }, async () => {
  const { page, errors } = await open(clientPage());
  await about(page).selectOption({ label: "The board" });
  await pointTo(page, "The board").click();
  const board = await pressOn(page, "Board.png", 0.25, 0.75);
  await button(page, "Done").click();
  await send(page, "F5 the board, here.");
  assert.deepEqual(await stored("F5 the board, here."), { position: 1, anchor: { kind: "point", x: board.x, y: board.y } });

  await about(page).selectOption({ label: "The poster" });
  await pointTo(page, "The poster").click();
  const poster = await pressOn(page, "Poster.png", 0.8, 0.2);
  await button(page, "Done").click();
  await send(page, "F5 the poster, here.");
  assert.deepEqual(await stored("F5 the poster, here."), { position: 2, anchor: { kind: "point", x: poster.x, y: poster.y } });

  // The form carries the canonical shape and nothing else; the page and its
  // flight payload carry no identifier.
  const headers = { cookie: `__Secure-yw_client.session_token=${fixture.clientCookie}` };
  for (const extra of [{}, { RSC: "1" }] as Record<string, string>[]) {
    const body = await (await fetch(`${process.env.REVIEW_SERVER_URL}${clientPage()}`, { headers: { ...headers, ...extra } })).text();
    assert.ok(body.length > 500, "an empty page proves nothing");
    assert.doesNotMatch(body, UUID, "the page carries an identifier");
  }
  assert.deepEqual(errors, []);
  await page.context().close();
});

/* ------------------------------------------------------ fail closed, real */

test("M. a point the panel could never make, sent anyway through the real form, is refused by the server", { skip }, async () => {
  const { page } = await open(clientPage());
  // The field is React's, and a render puts the draft's own value back — so
  // the value is swapped where the form's data is actually built, in the one
  // FormData the action sends, exactly as a hand-crafted request would be.
  const tamper = async (label: string, value: string, body: string) => {
    await about(page).selectOption({ label });
    await words(page).fill(body);
    await page.evaluate((value: string) => {
      const form = document.querySelector("input[name=anchor]")!.closest("form")!;
      form.addEventListener("formdata", (event) => (event as FormDataEvent).formData.set("anchor", value), { once: true });
    }, value);
    await button(page, "Send to the studio").click();
  };

  await tamper("The board", '{"kind":"point","x":1.5,"y":0.5}', "F5 refused: off the picture.");
  await page.getByText("That point is not inside the image.").waitFor();
  await tamper("The clip", '{"kind":"point","x":0.5,"y":0.5}', "F5 refused: a point on a video.");
  await page.getByText("A point belongs on an image.").waitFor();
  await tamper("The board", '{"kind":"point","x":0.5,"y":0.5,"w":0.1,"h":0.1}', "F5 refused: an area as a point.");
  await page.getByText("That point is not inside the image.").waitFor();

  const rows = await db().select({ body: presentationReviewNotes.body }).from(presentationReviewNotes);
  assert.ok(!rows.some((row) => row.body.startsWith("F5 refused")), "a refused point was stored");
  await page.context().close();
});

/* -------------------------------------------------------------- locators */

test("I. the client's locator shows the point on its picture, follows a resize, and one at a time", { skip }, async () => {
  const boardPoint = (await stored("F5 the board, here.")).anchor as { x: number; y: number };
  const posterPoint = (await stored("F5 the poster, here.")).anchor as { x: number; y: number };

  const { page, errors } = await open(clientPage());
  assert.equal(await markers(page), 0, "a marker on load");
  await page.getByRole("button", { name: "On The board · Point", exact: true }).click();
  await pointIsOn(page, "Board.png", boardPoint.x, boardPoint.y);
  assert.equal(await panel(page).count(), 0, "a locator opened capture");

  await page.setViewportSize({ width: 700, height: 900 });
  await pointIsOn(page, "Board.png", boardPoint.x, boardPoint.y);

  await page.getByRole("button", { name: "On The poster · Point", exact: true }).click();
  await pointIsOn(page, "Poster.png", posterPoint.x, posterPoint.y);
  assert.equal(await markers(page), 1, "two points at once");

  // The locator pressed while choosing a point ends the choosing: one context.
  await about(page).selectOption({ label: "The board" });
  await pointTo(page, "The board").click();
  await panel(page).waitFor();
  assert.equal(await markers(page), 0, "the locator's point outlived Point to it");
  await page.getByRole("button", { name: "On The poster · Point", exact: true }).click();
  assert.equal(await panel(page).count(), 0);
  await pointIsOn(page, "Poster.png", posterPoint.x, posterPoint.y);
  assert.deepEqual(errors, []);
  await page.context().close();
});

test("J. Studio's draft page sends a point to its own Revision, where it is drawn in the same place", { skip }, async () => {
  const boardPoint = (await stored("F5 the board, here.")).anchor as { x: number; y: number };
  const { page, errors } = await open(studioPage());
  const link = page.getByRole("link", { name: "On The board · Point", exact: true });
  const href = (await link.getAttribute("href"))!;
  assert.match(href, /\/revisions\/1\?note=\d+$/);
  assert.doesNotMatch(href.slice(studioPage().length), UUID);
  assert.doesNotMatch(href, /[xy]=|0\.\d/, "geometry in a URL");
  assert.equal(await page.getByRole("button", { name: /^Point to a place on / }).count(), 0, "Studio offered a point");

  await link.click();
  await page.waitForURL("**/revisions/1?note=*");
  await pointIsOn(page, "Board.png", boardPoint.x, boardPoint.y);
  assert.equal(await page.getByRole("button", { name: /^Point to a place on / }).count(), 0);
  assert.deepEqual(errors, []);
  await page.context().close();
});

/* ------------------------------------------------------------------ phone */

test("L. at 390px with a finger: a tap places it, a scroll does not, nothing overflows, and it survives a rotation", { skip }, async () => {
  const { page, errors } = await open(clientPage(), { viewport: { width: 390, height: 844 }, mobile: true });
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

  await about(page).selectOption({ label: "The board" });
  await pointTo(page, "The board").tap();
  await panel(page).waitFor();
  assert.equal(await panel(page).getByText("Tap the image where you mean.", { exact: true }).count(), 1);
  assert.ok((await overflow()) <= 0, "the page scrolls sideways");

  const tapped = await pressOn(page, "Board.png", 0.7, 0.4, true);
  await pointIsOn(page, "Board.png", tapped.x, tapped.y);
  assert.equal(await status(page), "Point placed — tap again to move it.");

  // A finger dragging the page from the picture is a scroll, not a point —
  // a real touch sequence, start to end, through the browser's own input.
  const cdp = await page.context().newCDPSession(page);
  const from = await spot(page, "Board.png", 0.2, 0.5);
  const scrolled = await page.evaluate(() => window.scrollY);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y }] });
  for (let step = 1; step <= 10; step += 1) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x, y: from.y - step * 20 }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(500);
  assert.notEqual(await page.evaluate(() => window.scrollY), scrolled, "the page did not scroll under a finger");
  await pointIsOn(page, "Board.png", tapped.x, tapped.y);
  assert.equal(await status(page), "Point placed — tap again to move it.");

  for (const name of ["Done", "Cancel"]) {
    const size = await button(page, name).boundingBox();
    assert.ok(size && size.height >= 38 && size.x >= 0 && size.x + size.width <= 390, `${name} is cramped or off screen`);
  }
  await button(page, "Done").tap();
  assert.equal(await draft(page), JSON.stringify({ kind: "point", x: tapped.x, y: tapped.y }));
  await send(page, "F5 phone point.");
  assert.deepEqual(await stored("F5 phone point."), { position: 1, anchor: { kind: "point", x: tapped.x, y: tapped.y } });

  // Turned sideways, the locator's point is on the same place in the picture.
  await page.setViewportSize({ width: 844, height: 390 });
  await page.getByRole("button", { name: "On The board · Point", exact: true }).last().tap();
  await pointIsOn(page, "Board.png", tapped.x, tapped.y);
  assert.ok((await overflow()) <= 0);
  assert.deepEqual(errors, []);
  await page.context().close();
});

/* --------------------------------------------------------------- history */

test("K. after a newer version, the old version's points are drawn exactly where they were, read-only", { skip }, async () => {
  const boardPoint = (await stored("F5 the board, here.")).anchor as { x: number; y: number };
  const posterPoint = (await stored("F5 the poster, here.")).anchor as { x: number; y: number };
  assert.ok((await publishPresentation(owner, v.pid, await version(v.pid))).ok);

  for (const path of [`${clientPage()}/revisions/1`, `${studioPage()}/revisions/1`]) {
    const { page, errors } = await open(path);
    assert.equal(await words(page).count(), 0, `${path} took new feedback`);
    assert.equal(await page.getByRole("button", { name: /^Point to a place on / }).count(), 0);
    await page.getByRole("button", { name: "On The board · Point", exact: true }).first().click();
    await pointIsOn(page, "Board.png", boardPoint.x, boardPoint.y);
    await page.getByRole("button", { name: "On The poster · Point", exact: true }).click();
    await pointIsOn(page, "Poster.png", posterPoint.x, posterPoint.y);
    assert.deepEqual(errors, [], path);
    await page.context().close();
  }

  // The newer version has no history of its own yet.
  const { page } = await open(clientPage());
  assert.equal(await page.getByRole("button", { name: /· Point$/ }).count(), 0);
  await page.context().close();
});
