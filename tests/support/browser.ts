import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";

import { createClient } from "../../lib/db/clients.ts";
import { closeDb, db } from "../../lib/db/index.ts";
import { uuidv7 } from "../../lib/db/id.ts";
import {
  addFileItem,
  addNoteItem,
  createPresentation,
  findPresentation,
  listDraftRows,
  moveItem,
  publishPresentation,
} from "../../lib/db/presentations.ts";
import { createProject } from "../../lib/db/projects.ts";
import {
  createReviewNote,
  removeReviewNote,
  requestReview,
  resolveReviewNote,
  type ClientActor,
} from "../../lib/db/reviews.ts";
import { clientSession, session, workroomFiles, workrooms } from "../../lib/db/schema.ts";
import { createWorkroom, publishWorkroom } from "../../lib/db/workrooms.ts";
import { png, wav, webm } from "./media.ts";
import { clearOwner, owner, person, seedOwner, staff } from "./review-stage.ts";

/**
 * A real browser against a real server, for Stage F's tests — shared by the
 * locator suite (F2) and the capture suite (F3) rather than copied into each.
 *
 * `seed` builds its own Workroom through the domain in this `DATABASE_URL` and
 * puts **real, playable bytes** where each file's storage key says they are;
 * the pages are those of a server that shares this database and bucket.
 * Three published versions, a round on the second and on the third:
 *
 *   Version 2   0 Intro · 1 board · 2 motion · 3 sound · 4 poster · 5 voice · 6 deck
 *   Version 3   0 Intro · 1 motion · 2 board · 3 sound · 4 poster · 5 voice · 6 deck
 *
 * The board is at 1 in Version 2 and the video at 1 in Version 3 on purpose: a
 * locator that looked at the wrong version finds the wrong thing. Version 3's
 * round is open, which is where capture happens.
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

export const skip =
  base && playwrightModule && endpoint && bucket && clientSecret && staffSecret
    ? false
    : "set REVIEW_SERVER_URL (a server sharing this DATABASE_URL and bucket), PLAYWRIGHT_MODULE, BUCKET_ENDPOINT, BUCKET_NAME, CLIENT_AUTH_SECRET and BETTER_AUTH_SECRET";

/* eslint-disable @typescript-eslint/no-explicit-any -- Playwright is loaded by path, untyped. */
type Browser = any;
export type Page = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

let browser: Browser;

export const fixture = {
  room: "",
  presentation: "",
  workroomId: "",
  presentationId: "",
  motionFile: "",
  voiceFile: "",
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

export async function note(actor: ClientActor, reviewId: string, itemPosition: number, anchor?: unknown) {
  const made = await createReviewNote(actor, { reviewId, body: `Note at ${itemPosition}.`, itemPosition, anchor });
  assert.ok(made.ok, made.ok ? "" : made.message);
  return made.value;
}

export async function seed(): Promise<void> {
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
  const voice = await file(workroomId, "Voice.wav", "audio/wav", wav(10));
  const deck = await file(workroomId, "Deck.pdf", "application/pdf", Buffer.from("%PDF-1.4\n%%EOF\n"));

  const presentation = await createPresentation(owner, workroomId, { title: "Locators", intro: "" });
  assert.ok(presentation.ok);
  const pid = presentation.value;

  // Version 1: words only.
  assert.ok((await addNoteItem(owner, pid, await version(pid), { caption: "Intro", body: "Words." })).ok);
  assert.ok((await publishPresentation(owner, pid, await version(pid))).ok);

  // Version 2: 0 Intro, 1 board, 2 motion, 3 sound, 4 poster, 5 voice, 6 deck.
  for (const [id, caption] of [
    [board, "The board"],
    [motion, "The motion"],
    [sound, "The sound"],
    [poster, "The poster"],
    [voice, "The voice"],
    [deck, "The deck"],
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
    voiceFile: `f${voice.replace(/-/g, "").slice(0, 25)}`,
    clientCookie: signed(clientToken, clientSecret!),
    staffCookie: signed(staffToken, staffSecret!),
  });
}

/** Seeds the fixture and starts the browser. Call from a suite's `before`. */
export async function setUp(): Promise<void> {
  if (skip) return;
  await seed();
  const playwright = await import(playwrightModule!);
  browser = await playwright.chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  );
}

/** Closes the browser, removes the fixture and the pool. Call from `after`. */
export async function tearDown(): Promise<void> {
  if (browser) await browser.close();
  if (!skip) await clearOwner();
  await closeDb();
}

/* ------------------------------------------------------------ browsing */

export const clientPage = () => `/workrooms/${fixture.room}/presentations/${fixture.presentation}`;
export const studioPage = () => `/studio/workrooms/${fixture.workroomId}/presentations/${fixture.presentationId}`;

export async function open(
  path: string,
  options: {
    viewport?: { width: number; height: number };
    reducedMotion?: "reduce" | "no-preference";
    /** A request held until `release` is called — a file still loading. */
    hold?: string;
    /** A request that fails outright — a file that will not load. */
    fail?: string;
    /** A phone: touch, and a coarse pointer. */
    mobile?: boolean;
  } = {},
): Promise<{ page: Page; errors: string[]; release: () => void }> {
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1280, height: 900 },
    reducedMotion: options.reducedMotion ?? "no-preference",
    ...(options.mobile ? { isMobile: true, hasTouch: true } : {}),
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

  if (options.fail) {
    await page.route(`**${options.fail}`, (route: { abort: () => Promise<void> }) => route.abort());
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

export const locator = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
export const markers = (page: Page) => page.locator("[data-anchor-marker]").count();

/**
 * Where the marker is against where the point is — the point computed here
 * independently: the image's content box, the intrinsic aspect ratio fitted
 * and centred inside it, the fraction placed in that.
 */
export async function offset(page: Page, alt: string, x: number, y: number): Promise<{ dx: number; dy: number; onIt: boolean }> {
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

export async function pointIsOn(page: Page, alt: string, x: number, y: number): Promise<void> {
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
export async function inViewNow(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((selector: string) => {
    const r = document.querySelector(selector)!.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight;
  }, selector);
}

/** In the viewport once a smooth scroll has had time to arrive. */
export async function inView(page: Page, selector: string): Promise<boolean> {
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

export async function player(page: Page, tag: "video" | "audio") {
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

export async function seeksTo(page: Page, tag: "video" | "audio", t: number): Promise<void> {
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
