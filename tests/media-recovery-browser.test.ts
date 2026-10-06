import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";

import { eq } from "drizzle-orm";

import { db } from "../lib/db/index.ts";
import { uuidv7 } from "../lib/db/id.ts";
import {
  addFileItem,
  createPresentation,
  findPresentation,
  publishPresentation,
} from "../lib/db/presentations.ts";
import { requestReview } from "../lib/db/reviews.ts";
import { clientSession, workroomMembers } from "../lib/db/schema.ts";
import { revokeMembership } from "../lib/db/workrooms.ts";
import { file, fixture, note, open, pointIsOn, setUp, signed, skip as baseSkip, tearDown, type Page } from "./support/browser.ts";
import { noiseWebm, png, wav, webm } from "./support/media.ts";
import { owner, person, staff } from "./support/review-stage.ts";

/**
 * Stage F6.2 in a real browser: a recording or a video whose signed address
 * has run out, put back — once, through our own route, paused — and every
 * surface that drives a player (a locator, a capture panel) still ending where
 * it meant to.
 *
 * **The expiry is real.** The bucket stub refuses a presigned URL past its
 * date and lifetime with S3's own 403, and the browser meets that refusal on
 * a real byte-range request; nothing tells React "pretend". The first test
 * waits out a genuine thirty-second lifetime (`VIEW_TTL_OVERRIDE_SECONDS=30`
 * on a server run with `SITE_ENV=preview`); the rest ask the stub to expire
 * every URL issued so far, which a fresh one signed afterwards survives —
 * the same refusal, without waiting.
 *
 * The media are large on purpose: ten minutes of WAV and twenty seconds of
 * noise video, so a seek far ahead needs bytes the browser has not fetched.
 *
 *   RECOVERY_SERVER_URL=http://localhost:3102 (SITE_ENV=preview,
 *   VIEW_TTL_OVERRIDE_SECONDS=30, same DATABASE_URL and bucket) and
 *   RECOVERY_SERVER_LOG=<its stdout>, beside the usual browser variables.
 */

const server = process.env.RECOVERY_SERVER_URL;
const serverLog = process.env.RECOVERY_SERVER_LOG;
const endpoint = process.env.BUCKET_ENDPOINT;
const skip = baseSkip || (server && serverLog ? false : "set RECOVERY_SERVER_URL (a preview-mode server) and RECOVERY_SERVER_LOG");

const SOUND = "Long sound.wav";
const FILM = "Long film.webm";
const BROKEN = "Broken film.webm";

const v = { pid: "", presentation: "", ids: {} as Record<string, string>, rae: "", raeMember: "" };
const publicOf = (id: string) => `f${id.replace(/-/g, "").slice(0, 25)}`;

before(async () => {
  await setUp();
  if (skip) return;
  const workroomId = fixture.workroomId;
  const film = await noiseWebm();
  assert.ok(film.length > 8_000_000, "the noise film is too small to need a second range");

  const made = await createPresentation(owner, workroomId, { title: "Recovery test", intro: "" });
  assert.ok(made.ok);
  const pid = made.value;
  const version = async () => (await findPresentation(pid))!.version;
  for (const [name, type, bytes, caption] of [
    [SOUND, "audio/wav", wav(600), "The long sound"],
    [FILM, "video/webm", film, "The long film"],
    ["Board.png", "image/png", png(800, 400), "The board"],
    ["Deck.pdf", "application/pdf", Buffer.from("%PDF-1.4\n%%EOF\n"), "The deck"],
    [BROKEN, "video/webm", webm(), "The broken film"],
  ] as const) {
    const id = await file(workroomId, name, type, bytes);
    v.ids[name] = id;
    assert.ok((await addFileItem(owner, pid, await version(), id, caption)).ok);
  }
  assert.ok((await publishPresentation(owner, pid, await version())).ok);
  const round = await requestReview(staff, (await findPresentation(pid))!.currentRevisionId!);
  assert.ok(round.ok);

  const lia = await person("Lia", workroomId, "lia-recovery@example.test");
  await note(lia, round.value.reviewId, 0, { kind: "time", t: 450 }); // 1
  await note(lia, round.value.reviewId, 0, { kind: "time", t: 500, t2: 520 }); // 2
  await note(lia, round.value.reviewId, 1, { kind: "time", t: 15 }); // 3
  await note(lia, round.value.reviewId, 1, { kind: "time", t: 12, t2: 16 }); // 4
  await note(lia, round.value.reviewId, 2, { kind: "point", x: 0.25, y: 0.75 }); // 5

  // A second client, whose access the revocation test withdraws.
  const rae = await person("Rae", workroomId, "rae-recovery@example.test");
  const token = randomBytes(32).toString("base64url");
  await db().insert(clientSession).values({
    id: uuidv7(),
    token,
    userId: rae.identityId,
    expiresAt: new Date(Date.now() + 3600_000),
    ipAddress: null,
    userAgent: null,
  });
  const [member] = await db()
    .select({ id: workroomMembers.id })
    .from(workroomMembers)
    .where(eq(workroomMembers.contactId, rae.contactId));

  Object.assign(v, {
    pid,
    presentation: (await findPresentation(pid))!.publicId,
    rae: signed(token, process.env.CLIENT_AUTH_SECRET!),
    raeMember: member!.id,
  });
  await control("reset");
});

after(async () => {
  if (!skip) await control("reset");
  await tearDown();
});

const clientPage = () => `/workrooms/${fixture.room}/presentations/${v.presentation}`;
const studioPage = () => `/studio/workrooms/${fixture.workroomId}/presentations/${v.pid}`;

/* -------------------------------------------------------------- controls */

async function control(action: string, query = ""): Promise<void> {
  const response = await fetch(`${endpoint}/__control/${action}${query}`, { method: "POST" });
  assert.equal(response.status, 204, `stub control ${action}`);
}

/** Every URL issued so far has expired — after a second, so none is "now". */
async function expireAll(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await control("expire");
}

/* -------------------------------------------------------------- watching */

type Seen =
  | { kind: "view"; file: string; refresh: string | null; status: number }
  /** `status` 0 is a refusal the browser blocked before the page saw it (ORB). */
  | { kind: "bucket"; file: string; status: number; signature: string };

/**
 * Every `/view` answer and every bucket answer the page receives, per file.
 *
 * A bucket's refusal is XML, as S3's is, so Chromium's opaque-response
 * blocking withholds it from a cross-origin media request: the page never
 * sees a 403, only a failed request (`ERR_BLOCKED_BY_ORB`). Both count as the
 * bucket refusing.
 */
function watch(page: Page, seen: Seen[]): Seen[] {
  const bucket = new URL(endpoint!).origin;
  const fileOf = (url: URL) =>
    Object.keys(v.ids).find((name) => url.pathname.includes(publicOf(v.ids[name]!)) || url.pathname.includes(v.ids[name]!));
  const signatureOf = (url: URL) => url.searchParams.get("X-Amz-Signature")?.slice(0, 12) ?? "";
  page.on("response", (response: { url(): string; status(): number }) => {
    const url = new URL(response.url());
    const file = fileOf(url);
    if (!file) return;
    if (url.origin === bucket) {
      seen.push({ kind: "bucket", file, status: response.status(), signature: signatureOf(url) });
    } else if (url.pathname.endsWith("/view")) {
      seen.push({ kind: "view", file, refresh: url.searchParams.get("refresh"), status: response.status() });
    }
  });
  page.on("requestfailed", (request: { url(): string; failure(): { errorText: string } | null }) => {
    const url = new URL(request.url());
    const file = fileOf(url);
    if (file && url.origin === bucket && /BLOCKED_BY_ORB/.test(request.failure()?.errorText ?? "")) {
      seen.push({ kind: "bucket", file, status: 0, signature: signatureOf(url) });
    }
  });
  return seen;
}

/** The bucket refused this file's address: a 403 the page saw, or one ORB withheld. */
const refused = (s: Seen, file: string) => s.kind === "bucket" && s.file === file && (s.status === 403 || s.status === 0);

const refreshes = (seen: Seen[], file: string) =>
  seen.filter((s): s is Extract<Seen, { kind: "view" }> => s.kind === "view" && s.file === file && s.refresh !== null);
const signatures = (seen: Seen[], file: string) =>
  [...new Set(seen.filter((s): s is Extract<Seen, { kind: "bucket" }> => s.kind === "bucket" && s.file === file && s.status >= 200 && s.status < 300).map((s) => s.signature))];

/** Counts every play() call and play event on the page from now on. */
async function countPlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __play: number; __playEvents: number };
    w.__play = 0;
    w.__playEvents = 0;
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      w.__play += 1;
      return original.call(this);
    };
    document.addEventListener("play", () => (w.__playEvents += 1), true);
  });
}
const plays = (page: Page) => page.evaluate(() => { const w = window as unknown as { __play: number; __playEvents: number }; return w.__play + w.__playEvents; });

/* ---------------------------------------------------------------- players */

/** Chromium's own retrying of a refused range, then our refresh and restore. */
const RECOVERY_WAIT = 75_000;

const FIND = `(name) => {
  const link = [...document.querySelectorAll("a")].find((a) => a.textContent === "Download " + name);
  return link?.closest("section")?.querySelector("audio, video") ?? null;
}`;

async function loaded(page: Page, name: string): Promise<void> {
  await page.waitForFunction(
    ({ name, find }: { name: string; find: string }) => {
      const media = (0, eval)(find)(name) as HTMLMediaElement | null;
      return media !== null && media.readyState >= 1 && Number.isFinite(media.duration);
    },
    { name, find: FIND },
    { timeout: 20_000 },
  );
}

async function seek(page: Page, name: string, t: number): Promise<void> {
  await page.evaluate(({ name, t, find }: { name: string; t: number; find: string }) => {
    ((0, eval)(find)(name) as HTMLMediaElement).currentTime = t;
  }, { name, t, find: FIND });
}

async function playerState(page: Page, name: string) {
  return page.evaluate(({ name, find }: { name: string; find: string }) => {
    const media = (0, eval)(find)(name) as HTMLMediaElement;
    return {
      time: media.currentTime,
      paused: media.paused,
      ready: media.readyState,
      error: media.error?.code ?? null,
      recovery: media.getAttribute("data-recovery"),
      src: media.getAttribute("src") ?? "",
    };
  }, { name, find: FIND });
}

/** A wait that, when it times out, says where the player was instead. */
async function explained(page: Page, name: string, what: string, wait: Promise<unknown>): Promise<void> {
  try {
    await wait;
  } catch (error) {
    const state = await playerState(page, name).catch(() => null);
    throw new Error(`${name} never ${what}: ${JSON.stringify(state)} (${(error as Error).message.split("\n")[0]})`);
  }
}

/** Waits for the player's recovery flag to read `value`. */
const recoveryIs = (page: Page, name: string, value: string) =>
  explained(page, name, `read data-recovery="${value}"`, page.waitForFunction(
    ({ find, name, value }: { find: string; name: string; value: string }) =>
      ((0, eval)(find)(name) as HTMLMediaElement).getAttribute("data-recovery") === value,
    { find: FIND, name, value },
    { timeout: RECOVERY_WAIT },
  ));

/** Recovered, at `t`, paused — and still there, still paused, a moment later. */
async function settledAt(page: Page, name: string, t: number): Promise<void> {
  await explained(page, name, `settled at ${t}`, page.waitForFunction(
    ({ name, t, find }: { name: string; t: number; find: string }) => {
      const media = (0, eval)(find)(name) as HTMLMediaElement | null;
      return (
        media !== null &&
        !media.hasAttribute("data-recovery") &&
        media.error === null &&
        media.readyState >= 1 &&
        !media.seeking &&
        Math.abs(media.currentTime - t) < 0.25
      );
    },
    { name, t, find: FIND },
    { timeout: RECOVERY_WAIT },
  ));
  await page.waitForTimeout(700);
  const state = await playerState(page, name);
  assert.ok(state.paused, `${name} is playing after recovery`);
  assert.ok(Math.abs(state.time - t) < 0.25, `${name} moved by itself to ${state.time}`);
}

const failedLine = (page: Page, name: string) =>
  page.evaluate(({ name }: { name: string }) => {
    const link = [...document.querySelectorAll("a")].find((a) => a.textContent === "Download " + name);
    return link?.closest("section")?.textContent?.includes("This preview couldn't be refreshed.") ?? false;
  }, { name });

const logLines = (): Record<string, unknown>[] =>
  readFileSync(serverLog!, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.event === "file.view_refreshed");

/* ------------------------------------------------------------------ tests */

test("A. a real thirty-second lifetime runs out; the seek that meets it is recovered through /view, paused", { skip }, async () => {
  const seen: Seen[] = [];
  const { page, errors } = await open(clientPage(), { base: server, onPage: (p) => watch(p, seen) });
  await loaded(page, SOUND);
  await countPlays(page);
  const first = signatures(seen, SOUND);
  assert.equal(first.length, 1);

  await page.waitForTimeout(31_000);
  await seek(page, SOUND, 450);
  await settledAt(page, SOUND, 450);

  // The old address was refused by the bucket, our route was asked again, and
  // a new address served the bytes.
  assert.ok(seen.some((s) => refused(s, SOUND) && s.kind === "bucket" && s.signature === first[0]), "the lapsed URL was never refused");
  assert.deepEqual(refreshes(seen, SOUND).map((s) => [s.refresh, s.status]), [["1", 302]]);
  assert.equal(signatures(seen, SOUND).length, 2, "no fresh signed address");
  assert.match((await playerState(page, SOUND)).src, /\/view\?refresh=1$/);
  assert.equal(await plays(page), 0, "recovery played something");
  assert.equal(await failedLine(page, SOUND), false);
  assert.deepEqual(errors, []);
  await page.context().close();
});

test("E + G. audio: expired, a seek far ahead, one refresh, the time kept, paused, nothing played", { skip }, async () => {
  const seen: Seen[] = [];
  const { page, errors } = await open(clientPage(), { base: server, onPage: (p) => watch(p, seen) });
  await loaded(page, SOUND);
  await countPlays(page);
  await expireAll();

  await seek(page, SOUND, 470);
  await settledAt(page, SOUND, 470);
  assert.equal(refreshes(seen, SOUND).length, 1);
  assert.equal(signatures(seen, SOUND).length, 2);
  assert.equal(await plays(page), 0);
  assert.equal(await failedLine(page, SOUND), false);
  assert.deepEqual(errors, []);
  await page.context().close();
});

test("F + G. video: the same — one refresh, the time kept, paused, nothing played", { skip }, async () => {
  const seen: Seen[] = [];
  const { page, errors } = await open(clientPage(), { base: server, onPage: (p) => watch(p, seen) });
  await loaded(page, FILM);
  await countPlays(page);
  await expireAll();

  await seek(page, FILM, 15);
  await settledAt(page, FILM, 15);
  assert.equal(refreshes(seen, FILM).length, 1);
  assert.ok(seen.some((s) => refused(s, FILM)), "the expired range was never refused");
  assert.equal(signatures(seen, FILM).length, 2);
  assert.equal(await plays(page), 0);
  assert.deepEqual(errors, []);
  await page.context().close();
});

test("H. a locator on an expired player ends at its own moment, or its stretch's start, paused", { skip }, async () => {
  const seen: Seen[] = [];
  const { page, errors } = await open(clientPage(), { base: server, onPage: (p) => watch(p, seen) });
  await loaded(page, SOUND);
  await loaded(page, FILM);
  await countPlays(page);
  await expireAll();

  await page.getByRole("button", { name: "On The long sound · At 7:30", exact: true }).click();
  await settledAt(page, SOUND, 450);
  assert.equal(refreshes(seen, SOUND).length, 1);

  await page.getByRole("button", { name: "On The long film · 0:12–0:16", exact: true }).click();
  await settledAt(page, FILM, 12);
  assert.equal(refreshes(seen, FILM).length, 1);

  // Pressed while the player is already refreshing from somewhere else: the
  // locator waits for it, and its own start wins over where the player was.
  // (Ten minutes of sound, far past anything buffered — a seek into bytes the
  // player already holds needs no address and is rightly never refused.)
  await expireAll();
  await seek(page, SOUND, 580);
  await recoveryIs(page, SOUND, "refreshing");
  await page.getByRole("button", { name: "On The long sound · 8:20–8:40", exact: true }).click();
  await settledAt(page, SOUND, 500);
  assert.equal(refreshes(seen, SOUND).length, 2);
  assert.equal(await plays(page), 0);
  assert.deepEqual(errors, []);
  await page.context().close();
});

test("H (race). a locator pressed in the instant its player fails: its own start wins over the time the player saved", { skip }, async () => {
  const seen: Seen[] = [];
  const { page, errors } = await open(clientPage(), { base: server, onPage: (p) => watch(p, seen) });
  await loaded(page, SOUND);
  await countPlays(page);
  await expireAll();

  // The press lands between the player's error and its fresh source — the
  // player has saved 9:40 and is about to fetch a new address; the locator
  // seeks a source that is on its way out. The player then puts back 9:40,
  // and the locator must put its own start back over it.
  const button = await page.getByRole("button", { name: "On The long sound · 8:20–8:40", exact: true }).elementHandle();
  await page.evaluate(({ find, name, button }: { find: string; name: string; button: unknown }) => {
    const media = (0, eval)(find)(name) as HTMLMediaElement;
    media.addEventListener("error", () => (button as HTMLElement).click(), { once: true });
  }, { find: FIND, name: SOUND, button });
  await seek(page, SOUND, 580);
  await settledAt(page, SOUND, 500);
  assert.deepEqual(refreshes(seen, SOUND).map((s) => s.refresh), ["1"]);
  assert.equal(await plays(page), 0);
  assert.deepEqual(errors, []);
  await page.context().close();
});

test("I. a precise time being chosen survives its player's recovery: the start, the subject and the panel stay", { skip }, async () => {
  const seen: Seen[] = [];
  const { page, errors } = await open(clientPage(), { base: server, onPage: (p) => watch(p, seen) });
  await loaded(page, SOUND);
  await page.getByLabel("About").selectOption({ label: "The long sound" });
  await page.getByRole("button", { name: "Set precise time on The long sound", exact: true }).click();
  const panel = page.getByRole("group", { name: "Precise time on The long sound" });
  await panel.waitFor();

  await seek(page, SOUND, 60);
  await panel.getByText("Player at 1:00", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Start here", exact: true }).click();
  assert.equal(await panel.getByRole("status").last().textContent(), "Starts at 1:00 — now choose where it ends.");

  await expireAll();
  await seek(page, SOUND, 450);
  await settledAt(page, SOUND, 450);
  assert.equal(refreshes(seen, SOUND).length, 1);

  // The panel never closed, its choice is intact, and it reads the player again.
  assert.equal(await panel.count(), 1);
  assert.equal(await panel.getByRole("status").last().textContent(), "Starts at 1:00 — now choose where it ends.");
  await panel.getByText("Player at 7:30", { exact: true }).waitFor();
  assert.equal(await panel.getByText(/could not be loaded/).count(), 0);
  await page.getByRole("button", { name: "End here", exact: true }).click();
  assert.equal(await panel.getByRole("status").last().textContent(), "1:00–7:30");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  assert.equal(await page.getByLabel("About").inputValue(), "0");
  assert.equal(await page.locator("input[name=anchor]").inputValue(), '{"kind":"time","t":60,"t2":450}');
  assert.deepEqual(errors, []);
  await page.context().close();
});

test("J. access withdrawn after the page opened: the refresh is refused at /view, no new address, a calm stop", { skip }, async () => {
  const seen: Seen[] = [];
  const { page } = await open(clientPage(), { base: server, clientCookie: v.rae, onPage: (p) => watch(p, seen) });
  await loaded(page, SOUND);
  const logged = logLines().length;

  const [member] = await db().select({ version: workroomMembers.version }).from(workroomMembers).where(eq(workroomMembers.id, v.raeMember));
  assert.ok((await revokeMembership(owner, v.raeMember, member!.version)).ok);
  await expireAll();
  await seek(page, SOUND, 450);

  await recoveryIs(page, SOUND, "failed");
  await page.waitForTimeout(3000);
  assert.deepEqual(refreshes(seen, SOUND).map((s) => s.status), [404], "the refresh was not refused, or was retried");
  assert.equal(signatures(seen, SOUND).length, 1, "a fresh signed address was issued to someone without access");
  assert.equal(await failedLine(page, SOUND), true);
  assert.equal(logLines().length, logged, "a refused refresh was logged as served");
  await page.context().close();
});

test("K. a player that never loaded is not refreshed and says nothing about refreshing — refused outright, or broken off before its metadata", { skip }, async () => {
  // Refused outright, or broken off after its first bytes. Chromium calls
  // both a source it cannot use (4): any failure before metadata is that, to
  // it. Neither is refreshed, and neither is said to have been.
  for (const fault of ["fail", "truncate"] as const) {
    await control(fault, `?key=${v.ids[BROKEN]}`);
    try {
      const seen: Seen[] = [];
      const { page } = await open(clientPage(), { base: server, onPage: (p) => watch(p, seen) });
      await explained(page, BROKEN, "errored", page.waitForFunction(({ find, name }: { find: string; name: string }) =>
        ((0, eval)(find)(name) as HTMLMediaElement).error !== null, { find: FIND, name: BROKEN }, { timeout: RECOVERY_WAIT }));
      await page.waitForTimeout(2500);
      const state = await playerState(page, BROKEN);
      assert.ok(state.error === 2 || state.error === 4, `${fault}: the player failed another way — ${JSON.stringify(state)}`);
      assert.equal(state.ready, 0, `${fault}: it had its metadata after all`);
      assert.equal(refreshes(seen, BROKEN).length, 0, `${fault}: a player that never had metadata was refreshed`);
      assert.equal(await failedLine(page, BROKEN), false, `${fault}: it claims a refresh failed`);
      await page.context().close();
    } finally {
      await control("reset");
    }
  }
});

test("K (network). a network error before metadata — what a break after the first bytes is by the spec — is still never refreshed", { skip }, async () => {
  // Chromium never reports this case (above), so it is made here: the
  // player's own route is held, so it is hydrated and has not reached its
  // metadata, and then the element reports a network error. The expiry tests
  // all use real failures; this one exists for the rule a Chromium failure
  // cannot reach — a network error on a player that never loaded.
  const seen: Seen[] = [];
  const view = `/files/${publicOf(v.ids[BROKEN]!)}/view`;
  const { page, release } = await open(clientPage(), { base: server, hold: view, onPage: (p) => watch(p, seen) });
  await page.evaluate(({ find, name }: { find: string; name: string }) => {
    const media = (0, eval)(find)(name) as HTMLMediaElement;
    if (media.readyState !== 0) throw new Error("it reached its metadata");
    Object.defineProperty(media, "error", { configurable: true, get: () => ({ code: 2, message: "" }) });
    media.dispatchEvent(new Event("error"));
  }, { find: FIND, name: BROKEN });
  await page.waitForTimeout(2000);
  assert.equal(refreshes(seen, BROKEN).length, 0, "a network error before metadata was refreshed");
  assert.equal(await failedLine(page, BROKEN), false, "it claims a refresh failed");
  release();
  await page.context().close();
});

test("D + L. a fault that persists: one automatic refresh, then a stop; Try again is one request, and recovers when it can", { skip }, async () => {
  const seen: Seen[] = [];
  const { page, errors } = await open(clientPage(), { base: server, onPage: (p) => watch(p, seen) });
  await loaded(page, FILM);
  await countPlays(page);
  // Expired first, then the fault: the old address is refused only when the
  // seek needs it, so the failure happens at the time the person chose.
  await expireAll();
  await control("fail", `?key=${v.ids[FILM]}`);
  await seek(page, FILM, 15);

  await recoveryIs(page, FILM, "failed");
  await page.waitForTimeout(3000);
  assert.deepEqual(refreshes(seen, FILM).map((s) => s.refresh), ["1"], "not exactly one automatic refresh");
  assert.equal(await failedLine(page, FILM), true);
  assert.equal(
    await page.getByText("This preview couldn't be refreshed. Try again, or download the original.").count(),
    1,
  );

  // Try again while it still fails: one more request, and it stops again.
  const tryAgain = page.getByRole("button", { name: "Try again", exact: true });
  await tryAgain.click();
  await page.waitForTimeout(4000);
  assert.deepEqual(refreshes(seen, FILM).map((s) => s.refresh), ["1", "2"]);
  assert.equal(await failedLine(page, FILM), true);

  // The fault clears; Try again recovers, at the time that was meant, paused.
  await control("reset");
  await tryAgain.click();
  await settledAt(page, FILM, 15);
  assert.deepEqual(refreshes(seen, FILM).map((s) => s.refresh), ["1", "2", "3"]);
  assert.equal(await failedLine(page, FILM), false);
  assert.equal(await plays(page), 0);
  assert.deepEqual(errors, []);
  await page.context().close();
});

test("D (window). recovered, then failing again inside the window it opened: no second automatic refresh — the line, and Try again", { skip }, async () => {
  const seen: Seen[] = [];
  const { page, errors } = await open(clientPage(), { base: server, onPage: (p) => watch(p, seen) });
  await loaded(page, SOUND);
  await countPlays(page);
  await expireAll();
  await seek(page, SOUND, 300);
  await settledAt(page, SOUND, 300);
  assert.deepEqual(refreshes(seen, SOUND).map((s) => s.refresh), ["1"]);

  // Well inside the thirty seconds the fresh address opened, it fails again —
  // at once, a fault rather than a lapse. That is not expiry, and it stops.
  await control("fail", `?key=${v.ids[SOUND]}`);
  try {
    await seek(page, SOUND, 560);
    await recoveryIs(page, SOUND, "failed");
    await page.waitForTimeout(3000);
    assert.deepEqual(refreshes(seen, SOUND).map((s) => s.refresh), ["1"], "a second automatic refresh inside the window");
    assert.equal(await failedLine(page, SOUND), true, "stopped with no way to try again");
  } finally {
    await control("reset");
  }

  // The person's own Try again is theirs, window or not — and still paused.
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await settledAt(page, SOUND, 560);
  assert.deepEqual(refreshes(seen, SOUND).map((s) => s.refresh), ["1", "2"]);
  assert.equal(await failedLine(page, SOUND), false);
  assert.equal(await plays(page), 0);
  assert.deepEqual(errors, []);
  await page.context().close();
});

test("M + N. an image and a PDF are exactly as they were: no refresh anywhere, and the point is where it was", { skip }, async () => {
  const seen: Seen[] = [];
  const { page, errors } = await open(clientPage(), { base: server, onPage: (p) => watch(p, seen) });
  await page.getByRole("button", { name: "On The board · Point", exact: true }).click();
  await pointIsOn(page, "Board.png", 0.25, 0.75);
  await expireAll();
  await page.waitForTimeout(1500);
  await pointIsOn(page, "Board.png", 0.25, 0.75);
  const sources = await page.evaluate(() => ({
    image: document.querySelector('img[alt="Board.png"]')!.getAttribute("src"),
    frame: document.querySelector("iframe")!.getAttribute("src"),
  }));
  assert.doesNotMatch(sources.image!, /refresh/);
  assert.doesNotMatch(sources.frame!, /refresh/);
  assert.equal(seen.filter((s) => s.kind === "view" && s.refresh !== null).length, 0);
  assert.deepEqual(errors, []);
  await page.context().close();
});

test("O. on a replaced version — the client's and Studio's — a locator on an expired player still ends paused at its moment", { skip }, async () => {
  assert.ok((await publishPresentation(owner, v.pid, (await findPresentation(v.pid))!.version)).ok);
  const loggedBefore = logLines();

  for (const path of [`${clientPage()}/revisions/1`, `${studioPage()}/revisions/1`]) {
    const seen: Seen[] = [];
    const { page, errors } = await open(path, { base: server, onPage: (p) => watch(p, seen) });
    await loaded(page, SOUND);
    await countPlays(page);
    await expireAll();
    await page.getByRole("button", { name: "On The long sound · At 7:30", exact: true }).click();
    await settledAt(page, SOUND, 450);
    assert.equal(refreshes(seen, SOUND).length, 1, path);
    assert.equal(await plays(page), 0);
    assert.equal(await page.getByLabel("What would you like to say?").count(), 0, "a replaced version took feedback");
    assert.deepEqual(errors, [], path);
    await page.context().close();
  }

  const routes = logLines().slice(loggedBefore.length).map((entry) => entry.route);
  assert.ok(routes.includes("client") && routes.includes("studio"), `refreshes logged as ${routes.join(", ")}`);
});

test("P. no signed address in the page or its flight payload, and the refresh log says two things only", { skip }, async () => {
  const headers = { cookie: `__Secure-yw_client.session_token=${fixture.clientCookie}` };
  for (const extra of [{}, { RSC: "1" }] as Record<string, string>[]) {
    const body = await (await fetch(`${server}${clientPage()}`, { headers: { ...headers, ...extra } })).text();
    assert.ok(body.length > 500, "an empty page proves nothing");
    assert.doesNotMatch(body, /X-Amz-|Signature=|\/__control\//, "a signed address in the page");
    assert.ok(!body.includes(new URL(endpoint!).host), "the bucket's address is in the page");
  }

  const lines = logLines();
  assert.ok(lines.length >= 1, "no refresh was logged, so nothing here was checked");
  for (const entry of lines) {
    assert.deepEqual(Object.keys(entry).sort(), ["at", "event", "level", "route", "viewer"], JSON.stringify(entry));
    assert.equal(entry.level, "info");
    assert.ok(entry.route === "client" || entry.route === "studio", JSON.stringify(entry));
    assert.ok(entry.viewer === "audio" || entry.viewer === "video", JSON.stringify(entry));
    assert.match(String(entry.at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }
});
