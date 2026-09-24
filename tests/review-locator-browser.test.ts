import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { after, before, test } from "node:test";

import { eq } from "drizzle-orm";

import { createClient } from "../lib/db/clients.ts";
import { closeDb, db } from "../lib/db/index.ts";
import { uuidv7 } from "../lib/db/id.ts";
import {
  addFileItem,
  addNoteItem,
  createPresentation,
  findPresentation,
  listDraftRows,
  moveItem,
  publishPresentation,
} from "../lib/db/presentations.ts";
import { createProject } from "../lib/db/projects.ts";
import {
  createReviewNote,
  removeReviewNote,
  requestReview,
  resolveReviewNote,
  type ClientActor,
} from "../lib/db/reviews.ts";
import { clientSession, session, workroomFiles, workrooms } from "../lib/db/schema.ts";
import { createWorkroom, publishWorkroom } from "../lib/db/workrooms.ts";
import { png, wav, webm } from "./support/media.ts";
import { clearOwner, owner, person, seedOwner, staff, UUID } from "./support/review-stage.ts";

/**
 * Stage F2 in a real browser: a locator shows exactly what its comment is
 * about, on the version it was written about, and nothing moves until
 * somebody asks.
 *
 * Seeds its own Workroom through the domain — three published versions, a
 * round on the second and the third, precise anchors of every shape the
 * vocabulary holds — puts **real, playable bytes** where each file's storage
 * key says they are, and drives the pages of a server that shares this
 * database and bucket. The second and third versions hold different work at
 * the same position on purpose: the board is at 1 in Version 2 and the video
 * is at 1 in Version 3, so a locator that looked at the wrong version would
 * find the wrong thing and fail.
 *
 * Playwright is not a dependency of this repository, so it is named by path:
 *
 *   REVIEW_SERVER_URL=http://localhost:3101 \
 *   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs \
 *   CHROMIUM_PATH=/opt/pw-browsers/chromium \
 *   BUCKET_ENDPOINT=… BUCKET_NAME=… CLIENT_AUTH_SECRET=… BETTER_AUTH_SECRET=… \
 *   DATABASE_URL=… npm test
 */

const base = process.env.REVIEW_SERVER_URL;
const playwrightModule = process.env.PLAYWRIGHT_MODULE;
const endpoint = process.env.BUCKET_ENDPOINT;
const bucket = process.env.BUCKET_NAME;
const clientSecret = process.env.CLIENT_AUTH_SECRET;
const staffSecret = process.env.BETTER_AUTH_SECRET;

const skip =
  base && playwrightModule && endpoint && bucket && clientSecret && staffSecret
    ? false
    : "set REVIEW_SERVER_URL (a server sharing this DATABASE_URL and bucket), PLAYWRIGHT_MODULE, BUCKET_ENDPOINT, BUCKET_NAME, CLIENT_AUTH_SECRET and BETTER_AUTH_SECRET";

/* eslint-disable @typescript-eslint/no-explicit-any -- Playwright is loaded by path, untyped. */
type Browser = any;
type Page = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

let browser: Browser;

const fixture = {
  room: "",
  presentation: "",
  workroomId: "",
  presentationId: "",
  motionFile: "",
  clientCookie: "",
  staffCookie: "",
};

/* ------------------------------------------------------------- seeding */

/** Better Auth's signed cookie value: the token, a dot, its HMAC — URI-encoded. */
function signed(token: string, secret: string): string {
  return encodeURIComponent(`${token}.${createHmac("sha256", secret).update(token).digest("base64")}`);
}

/** A ready file row with real bytes at its storage key. */
async function file(workroomId: string, name: string, contentType: string, bytes: Buffer): Promise<string> {
  const id = uuidv7();
  const storageKey = `w/${workroomId}/f/${id}/original`;
  const put = await fetch(`${endpoint}/${bucket}/${storageKey}`, {
    method: "PUT",
    body: new Uint8Array(bytes),
    headers: { "content-type": contentType },
  });
  assert.ok(put.ok, `the bucket refused ${name}: ${put.status}`);

  await db().insert(workroomFiles).values({
    id,
    publicId: `f${id.replace(/-/g, "").slice(0, 25)}`,
    workroomId,
    displayName: name,
    originalFilename: name,
    contentType,
    byteSize: bytes.length,
    storageKey,
    storageEtag: `"${id}"`,
    status: "ready",
    visibility: "internal",
    createdBy: owner.id,
  });
  return id;
}

async function version(presentationId: string): Promise<number> {
  return (await findPresentation(presentationId))!.version;
}

async function note(actor: ClientActor, reviewId: string, itemPosition: number, anchor?: unknown) {
  const made = await createReviewNote(actor, { reviewId, body: `Note at ${itemPosition}.`, itemPosition, anchor });
  assert.ok(made.ok, made.ok ? "" : made.message);
  return made.value;
}

async function seed(): Promise<void> {
  await seedOwner();

  const client = await createClient(owner, {
    accountType: "organization",
    name: "Locator Studio",
    website: null,
    domain: null,
    status: "active",
    notes: "",
  });
  assert.ok(client.ok);
  const project = await createProject(owner, {
    clientId: client.value,
    name: "Locator work",
    status: "active",
    description: "",
    notes: "",
    ownerId: null,
    startsOn: null,
    targetOn: null,
  });
  assert.ok(project.ok);
  const made = await createWorkroom(owner, { projectId: project.value, title: "Locator work", summary: "" });
  assert.ok(made.ok);
  const workroomId = made.value;
  assert.ok((await publishWorkroom(owner, workroomId, 1)).ok);
  const room = (await db().select({ publicId: workrooms.publicId }).from(workrooms).where(eq(workrooms.id, workroomId)))[0]!
    .publicId;

  const ana = await person("Ana", workroomId, "ana-locator@example.test");

  const board = await file(workroomId, "Board.png", "image/png", png(800, 400));
  const motion = await file(workroomId, "Motion.webm", "video/webm", webm());
  const sound = await file(workroomId, "Sound.wav", "audio/wav", wav(6));
  const poster = await file(workroomId, "Poster.png", "image/png", png(400, 800));

  const presentation = await createPresentation(owner, workroomId, { title: "Locators", intro: "" });
  assert.ok(presentation.ok);
  const pid = presentation.value;

  // Version 1: words only.
  assert.ok((await addNoteItem(owner, pid, await version(pid), { caption: "Intro", body: "Words." })).ok);
  assert.ok((await publishPresentation(owner, pid, await version(pid))).ok);

  // Version 2: 0 Intro, 1 board, 2 motion, 3 sound, 4 poster.
  for (const [id, caption] of [
    [board, "The board"],
    [motion, "The motion"],
    [sound, "The sound"],
    [poster, "The poster"],
  ] as const) {
    assert.ok((await addFileItem(owner, pid, await version(pid), id, caption)).ok);
  }
  assert.ok((await publishPresentation(owner, pid, await version(pid))).ok);

  const revision2 = (await findPresentation(pid))!.currentRevisionId!;
  const round2 = await requestReview(staff, revision2);
  assert.ok(round2.ok);
  const r2 = round2.value;

  await note(ana, r2, 1, { kind: "point", x: 0.25, y: 0.75 }); // 1
  await note(ana, r2, 4, { kind: "point", x: 0.8, y: 0.2 }); // 2
  await note(ana, r2, 1, { kind: "region", x: 0.1, y: 0.1, w: 0.3, h: 0.2 }); // 3
  await note(ana, r2, 2, { kind: "time", t: 3 }); // 4
  await note(ana, r2, 2, { kind: "time", t: 2, t2: 5 }); // 5
  await note(ana, r2, 2, { kind: "time", t: 4, region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }); // 6
  await note(ana, r2, 2, { kind: "time", t: 90_000 }); // 7
  await note(ana, r2, 3, { kind: "time", t: 2 }); // 8
  await note(ana, r2, 3, { kind: "time", t: 1, t2: 3 }); // 9
  await note(ana, r2, 1); // 10 — item-level, no anchor
  const taken = await note(ana, r2, 1, { kind: "point", x: 0.5, y: 0.5 }); // 11 — taken back
  assert.ok((await removeReviewNote(ana, { reviewId: r2, number: taken })).ok);
  assert.ok((await resolveReviewNote(staff, { reviewId: r2, number: 1 })).ok);

  // Version 3: the motion moves above the board, so position 1 is a video.
  const motionRow = (await listDraftRows(pid)).find((row) => row.caption === "The motion")!;
  assert.ok((await moveItem(owner, pid, await version(pid), motionRow.id, "up")).ok);
  assert.ok((await publishPresentation(owner, pid, await version(pid))).ok);

  const revision3 = (await findPresentation(pid))!.currentRevisionId!;
  const round3 = await requestReview(staff, revision3);
  assert.ok(round3.ok);
  await note(ana, round3.value, 1, { kind: "time", t: 2 }); // 1 — the motion, in Version 3
  await note(ana, round3.value, 2, { kind: "point", x: 0.5, y: 0.5 }); // 2 — the board, in Version 3

  // And the draft moves on again, unpublished: Studio's draft page now shows
  // work that no round was asked about.
  const posterRow = (await listDraftRows(pid)).find((row) => row.caption === "The poster")!;
  assert.ok((await moveItem(owner, pid, await version(pid), posterRow.id, "up")).ok);

  const clientToken = randomBytes(32).toString("base64url");
  await db().insert(clientSession).values({
    id: uuidv7(),
    token: clientToken,
    userId: ana.identityId,
    expiresAt: new Date(Date.now() + 3600_000),
    ipAddress: null,
    userAgent: null,
  });
  const staffToken = randomBytes(32).toString("base64url");
  await db().insert(session).values({
    id: uuidv7(),
    token: staffToken,
    userId: owner.id,
    expiresAt: new Date(Date.now() + 3600_000),
    ipAddress: null,
    userAgent: null,
  });

  Object.assign(fixture, {
    room,
    presentation: (await findPresentation(pid))!.publicId,
    workroomId,
    presentationId: pid,
    motionFile: `f${motion.replace(/-/g, "").slice(0, 25)}`,
    clientCookie: signed(clientToken, clientSecret!),
    staffCookie: signed(staffToken, staffSecret!),
  });
}

before(async () => {
  if (skip) return;
  await seed();
  const playwright = await import(playwrightModule!);
  browser = await playwright.chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  );
});

after(async () => {
  if (browser) await browser.close();
  if (!skip) await clearOwner();
  await closeDb();
});

/* ------------------------------------------------------------ browsing */

const clientPage = () => `/workrooms/${fixture.room}/presentations/${fixture.presentation}`;
const studioPage = () => `/studio/workrooms/${fixture.workroomId}/presentations/${fixture.presentationId}`;

async function open(
  path: string,
  options: { viewport?: { width: number; height: number }; reducedMotion?: "reduce" | "no-preference"; hold?: string } = {},
): Promise<{ page: Page; errors: string[]; release: () => void }> {
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1280, height: 900 },
    reducedMotion: options.reducedMotion ?? "no-preference",
  });
  const host = new URL(base!).hostname;
  await context.addCookies([
    { name: "__Secure-yw_client.session_token", value: fixture.clientCookie, domain: host, path: "/", secure: true, httpOnly: true, sameSite: "Lax" },
    { name: "__Secure-yw_studio.session_token", value: fixture.staffCookie, domain: host, path: "/", secure: true, httpOnly: true, sameSite: "Lax" },
  ]);

  // Counts `loadedmetadata` listeners on media elements as they are added and
  // removed — React's own included, which is why tests compare to a baseline.
  await context.addInitScript(() => {
    const w = window as unknown as { __metadataListeners: number };
    w.__metadataListeners = 0;
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, ...rest: unknown[]) {
      if (type === "loadedmetadata" && this instanceof HTMLMediaElement) w.__metadataListeners += 1;
      return (add as (...args: unknown[]) => void).call(this, type, ...rest);
    };
    EventTarget.prototype.removeEventListener = function (this: EventTarget, type: string, ...rest: unknown[]) {
      if (type === "loadedmetadata" && this instanceof HTMLMediaElement) w.__metadataListeners -= 1;
      return (remove as (...args: unknown[]) => void).call(this, type, ...rest);
    };
  });

  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));

  let release = () => {};
  if (options.hold) {
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**${options.hold}`, async (route: { continue: () => Promise<void> }) => {
      await gate;
      await route.continue();
    });
  }

  const response = await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
  assert.equal(response.status(), 200, `${path} answered ${response.status()}`);
  await page.waitForLoadState("load").catch(() => {});
  // Hydrated: React has attached to the locators (and to the players), so a
  // press does something and a listener count read now is a real baseline.
  await page.waitForFunction(() => {
    const button = document.querySelector("button[aria-pressed]");
    return !button || Object.keys(button).some((key) => key.startsWith("__reactProps"));
  });
  return { page, errors, release };
}

const locator = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const markers = (page: Page) => page.locator("[data-anchor-marker]").count();

/**
 * Where the marker is against where the point is — the point computed here
 * independently: the image's content box, the intrinsic aspect ratio fitted
 * and centred inside it, the fraction placed in that.
 */
async function offset(page: Page, alt: string, x: number, y: number): Promise<{ dx: number; dy: number; onIt: boolean }> {
  return page.evaluate(
    ({ alt, x, y }: { alt: string; x: number; y: number }) => {
      const image = document.querySelector<HTMLImageElement>(`img[alt="${alt}"]`)!;
      const marker = document.querySelector<HTMLElement>("[data-anchor-marker]")!;
      const style = getComputedStyle(image);
      const n = (v: string) => parseFloat(v) || 0;
      const r = image.getBoundingClientRect();
      const box = {
        left: r.left + n(style.borderLeftWidth) + n(style.paddingLeft),
        top: r.top + n(style.borderTopWidth) + n(style.paddingTop),
        width: r.width - n(style.borderLeftWidth) - n(style.paddingLeft) - n(style.borderRightWidth) - n(style.paddingRight),
        height: r.height - n(style.borderTopWidth) - n(style.paddingTop) - n(style.borderBottomWidth) - n(style.paddingBottom),
      };
      const scale = Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight);
      const width = image.naturalWidth * scale;
      const height = image.naturalHeight * scale;
      const left = box.left + (box.width - width) / 2;
      const top = box.top + (box.height - height) / 2;
      const m = marker.getBoundingClientRect();
      return {
        dx: m.left + m.width / 2 - (left + x * width),
        dy: m.top + m.height / 2 - (top + y * height),
        onIt: marker.parentElement!.contains(image),
      };
    },
    { alt, x, y },
  );
}

async function pointIsOn(page: Page, alt: string, x: number, y: number): Promise<void> {
  await page.waitForFunction(() => document.querySelectorAll("[data-anchor-marker]").length === 1);
  // Allow the layout a frame to settle after a resize before measuring.
  await page.waitForFunction(
    ({ alt, x, y }: { alt: string; x: number; y: number }) => {
      const image = document.querySelector<HTMLImageElement>(`img[alt="${alt}"]`);
      const marker = document.querySelector<HTMLElement>("[data-anchor-marker]");
      if (!image || !marker || !marker.parentElement!.contains(image)) return false;
      const r = image.getBoundingClientRect();
      const scale = Math.min(r.width / image.naturalWidth, r.height / image.naturalHeight);
      const w = image.naturalWidth * scale;
      const h = image.naturalHeight * scale;
      const m = marker.getBoundingClientRect();
      return (
        Math.abs(m.left + m.width / 2 - (r.left + (r.width - w) / 2 + x * w)) < 1.5 &&
        Math.abs(m.top + m.height / 2 - (r.top + (r.height - h) / 2 + y * h)) < 1.5
      );
    },
    { alt, x, y },
    { timeout: 5000 },
  ).catch(() => {});
  const where = await offset(page, alt, x, y);
  assert.ok(where.onIt, `the marker is not on ${alt}`);
  assert.ok(Math.abs(where.dx) < 1 && Math.abs(where.dy) < 1, `the marker is off the point by ${where.dx}, ${where.dy}`);
}

/** In the viewport right now — for reduced motion, where there is no scroll to wait for. */
async function inViewNow(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((selector: string) => {
    const r = document.querySelector(selector)!.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight;
  }, selector);
}

/** In the viewport once a smooth scroll has had time to arrive. */
async function inView(page: Page, selector: string): Promise<boolean> {
  return page
    .waitForFunction(
      (selector: string) => {
        const r = document.querySelector(selector)!.getBoundingClientRect();
        return r.bottom > 0 && r.top < window.innerHeight;
      },
      selector,
      { timeout: 3000 },
    )
    .then(() => true, () => false);
}

async function player(page: Page, tag: "video" | "audio") {
  return page.evaluate((tag: string) => {
    const media = document.querySelector<HTMLMediaElement>(tag)!;
    return {
      time: media.currentTime,
      paused: media.paused,
      ready: media.readyState,
      focused: document.activeElement === media,
    };
  }, tag);
}

async function seeksTo(page: Page, tag: "video" | "audio", t: number): Promise<void> {
  await page.waitForFunction(
    ({ tag, t }: { tag: string; t: number }) => {
      const media = document.querySelector<HTMLMediaElement>(tag);
      return media && !media.seeking && Math.abs(media.currentTime - t) < 0.15;
    },
    { tag, t },
    { timeout: 10_000 },
  );
  const before = await player(page, tag);
  assert.ok(before.paused, `${tag} is playing after a seek`);
  // No autoplay: still where it was left a moment later.
  await page.waitForTimeout(600);
  const later = await player(page, tag);
  assert.ok(later.paused, `${tag} started playing by itself`);
  assert.equal(later.time, before.time, `${tag} moved by itself`);
}

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
