import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { after, before, test } from "node:test";

import { eq } from "drizzle-orm";

import { closeDb, db } from "../lib/db/index.ts";
import { uuidv7 } from "../lib/db/id.ts";
import { clientIdentity, clientSession, notificationDeliveries, session } from "../lib/db/schema.ts";
import { providerIdempotencyKey } from "../lib/notifications/dedupe.ts";
import { signed } from "./support/browser.ts";
import { clearOwner, owner, seedOwner, stage, type Stage } from "./support/review-stage.ts";

/**
 * Stage G2 end to end: a person presses the real buttons, in a real browser,
 * against real servers sharing this database — and the outbox, the drain and
 * the provider are watched from outside.
 *
 *   the preview server (SITE_ENV=preview, no redirect)   captures: rows settle
 *                                                         `preview_capture`, the
 *                                                         provider hears nothing
 *   the live server                                      sends, through the real
 *                                                         Resend adapter, to a
 *                                                         local stand-in that
 *                                                         fails, or holds the line
 *
 * Asking for feedback and writing the first note succeed whatever the provider
 * does, and say so before the provider has answered — the drain runs after the
 * response, and the row is durable either way.
 *
 *   REVIEW_SERVER_URL      a live-mode server on this DATABASE_URL
 *   RECOVERY_SERVER_URL    a preview-mode server on this DATABASE_URL
 *   RECOVERY_SERVER_LOG    that server's log file
 *   MAIL_CAPTURE_URL       where both servers' RESEND_BASE_URL points
 *   PLAYWRIGHT_MODULE, CHROMIUM_PATH, CLIENT_AUTH_SECRET, BETTER_AUTH_SECRET
 */

const liveBase = process.env.REVIEW_SERVER_URL;
const previewBase = process.env.RECOVERY_SERVER_URL;
const previewLog = process.env.RECOVERY_SERVER_LOG;
const providerUrl = process.env.MAIL_CAPTURE_URL;
const playwrightModule = process.env.PLAYWRIGHT_MODULE;
const clientSecret = process.env.CLIENT_AUTH_SECRET;
const staffSecret = process.env.BETTER_AUTH_SECRET;

const skip =
  liveBase && previewBase && previewLog && providerUrl && playwrightModule && clientSecret && staffSecret
    ? false
    : "set REVIEW_SERVER_URL, RECOVERY_SERVER_URL, RECOVERY_SERVER_LOG, MAIL_CAPTURE_URL, PLAYWRIGHT_MODULE, CLIENT_AUTH_SECRET and BETTER_AUTH_SECRET";

/* eslint-disable @typescript-eslint/no-explicit-any -- Playwright is loaded by path, untyped. */
let browser: any;
/* eslint-enable @typescript-eslint/no-explicit-any */
let staffCookie = "";

/* ------------------------------------------------------ provider stand-in */

type Received = { headers: IncomingHttpHeaders; body: Record<string, unknown> };

const provider = {
  requests: [] as Received[],
  /** What the next requests are answered with: 200, a status, or held until released. */
  mode: "ok" as "ok" | "fail" | "hold",
  held: [] as Array<() => void>,
  server: null as Server | null,
};

async function startProvider(): Promise<void> {
  const { hostname, port } = new URL(providerUrl!);
  provider.server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      provider.requests.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") });
      const answer = (status: number) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(
          status === 200
            ? JSON.stringify({ id: `standin-${provider.requests.length}` })
            : JSON.stringify({ name: "internal_server_error", message: "MARKER-PROVIDER-WORDS", statusCode: status }),
        );
      };
      if (provider.mode === "hold") provider.held.push(() => answer(200));
      else answer(provider.mode === "fail" ? 500 : 200);
    });
  });
  await new Promise<void>((resolve, reject) => {
    provider.server!.once("error", reject);
    provider.server!.listen(Number(port), hostname, resolve);
  });
}

/* ------------------------------------------------------------- fixture */

async function clientCookieFor(identityId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db().insert(clientSession).values({
    id: uuidv7(),
    token,
    userId: identityId,
    expiresAt: new Date(Date.now() + 3600_000),
    ipAddress: null,
    userAgent: null,
  });
  return signed(token, clientSecret!);
}

before(async () => {
  if (skip) return;
  await seedOwner();
  const token = randomBytes(32).toString("base64url");
  await db().insert(session).values({
    id: uuidv7(),
    token,
    userId: owner.id,
    expiresAt: new Date(Date.now() + 3600_000),
    ipAddress: null,
    userAgent: null,
  });
  staffCookie = signed(token, staffSecret!);
  await startProvider();
  const playwright = await import(playwrightModule!);
  browser = await playwright.chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});

after(async () => {
  if (browser) await browser.close();
  if (provider.server) await new Promise<void>((resolve) => provider.server!.close(() => resolve()));
  if (!skip) await clearOwner();
  await closeDb();
});

/* ------------------------------------------------------------ helpers */

async function open(base: string, path: string, clientCookie?: string) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const host = new URL(base).hostname;
  await context.addCookies([
    { name: "__Secure-yw_studio.session_token", value: staffCookie, domain: host, path: "/", secure: true, httpOnly: true, sameSite: "Lax" },
    ...(clientCookie
      ? [{ name: "__Secure-yw_client.session_token", value: clientCookie, domain: host, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]
      : []),
  ]);
  const page = await context.newPage();
  const response = await page.goto(`${base}${path}`, { waitUntil: "load" });
  assert.equal(response.status(), 200, `${path} answered ${response.status()}`);
  return { page, close: () => context.close() };
}

const studioPath = (s: Stage) => `/studio/workrooms/${s.workroomId}/presentations/${s.presentationId}`;
const clientPath = (s: Stage) => `/workrooms/${s.room}/presentations/${s.presentation}`;

type Delivery = typeof notificationDeliveries.$inferSelect;

async function deliveriesOf(s: Stage): Promise<Delivery[]> {
  return db().select().from(notificationDeliveries).where(eq(notificationDeliveries.workroomId, s.workroomId));
}

/** Waits for the rows to reach a state — the drain runs after the response, so this polls. */
async function until(s: Stage, done: (rows: Delivery[]) => boolean, what: string, timeoutMs = 20_000): Promise<Delivery[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await deliveriesOf(s);
    if (done(rows)) return rows;
    if (Date.now() > deadline) throw new Error(`${what}: ${JSON.stringify(rows.map((r) => [r.kind, r.status, r.lastError, r.suppressedReason]))}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** Studio: press Ask for feedback, read the dialog, confirm, and return the dialog's words and the announcement. */
async function ask(base: string, s: Stage): Promise<{ dialog: string; announced: string }> {
  const { page, close } = await open(base, studioPath(s));
  try {
    await page.getByRole("button", { name: "Ask for feedback", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ state: "visible" });
    const words = await dialog.innerText();
    await dialog.getByRole("button", { name: "Ask", exact: true }).click();
    const status = page.getByRole("status").filter({ hasText: "Asked the client" });
    await status.waitFor({ state: "visible", timeout: 15_000 });
    // The round is open on the refreshed page, and the sentence outlived the button.
    await page.getByRole("button", { name: "Close feedback", exact: true }).waitFor({ state: "visible" });
    assert.equal(await page.getByRole("button", { name: "Ask for feedback", exact: true }).count(), 0);
    return { dialog: words, announced: (await status.innerText()).trim() };
  } finally {
    await close();
  }
}

/** The client writes their first feedback, as a person does. */
async function writeFeedback(base: string, s: Stage, body: string): Promise<void> {
  const cookie = await clientCookieFor(s.ana.identityId);
  const { page, close } = await open(base, clientPath(s), cookie);
  try {
    await page.getByPlaceholder("Anything at all — a change, a question, or that it is right.").fill(body);
    await page.getByRole("button", { name: "Send to the studio", exact: true }).click();
    await page.getByText(body).first().waitFor({ state: "visible", timeout: 15_000 });
    const text = await page.locator("body").innerText();
    assert.ok(!/emailed|email sent|notified/i.test(text), "the client is told about email");
  } finally {
    await close();
  }
}

async function email(identityId: string): Promise<string> {
  return (await db().select().from(clientIdentity).where(eq(clientIdentity.id, identityId)))[0]!.email;
}

/* --------------------------------------------------------------- preview */

test("preview: asking and first feedback are captured — rows settle preview_capture, the provider hears nothing", { skip }, async () => {
  provider.requests.length = 0;
  provider.mode = "ok";
  const logStart = readFileSync(previewLog!, "utf8").length;
  const s = await stage("BP");

  const { dialog, announced } = await ask(previewBase!, s);
  assert.match(dialog, /Beta captures notification emails; no client email will be sent\./);
  assert.ok(!/will be emailed/.test(dialog));
  assert.equal(announced, "Asked the client for their thoughts on this version. Beta captured the email for 2 client members; no client email was sent.");

  const requested = await until(
    s,
    (rows) => rows.length === 2 && rows.every((r) => r.status === "suppressed"),
    "the drain never captured the request",
  );
  assert.ok(requested.every((r) => r.suppressedReason === "preview_capture" && r.attempts === 1));

  await writeFeedback(previewBase!, s, "MARKER-BROWSER-PREVIEW-FEEDBACK");
  const all = await until(
    s,
    (rows) => rows.some((r) => r.kind === "review.received" && r.status === "suppressed"),
    "the drain never captured the feedback",
  );
  const received = all.filter((r) => r.kind === "review.received");
  assert.equal(received.length, 1);
  assert.equal(received[0]!.suppressedReason, "preview_capture");
  assert.equal(received[0]!.noteNumber, 1);

  assert.equal(provider.requests.length, 0, "the preview reached the provider");

  const log = readFileSync(previewLog!, "utf8").slice(logStart);
  const lines = log.split("\n").filter((line) => line.includes('"event":"notification.'));
  assert.equal(lines.filter((line) => line.includes("notification.captured")).length, 3, log);
  assert.equal(lines.filter((line) => line.includes("notification.created")).length, 2);
  for (const secret of [await email(s.ana.identityId), await email(s.ben.identityId), "MARKER-BROWSER-PREVIEW-FEEDBACK", "Brand Direction", "/workrooms/", "yw-notification/"]) {
    assert.ok(!log.includes(secret), `the preview server logged ${secret}`);
  }
});

/* ------------------------------------------------------------------ live */

test("live: a failing provider never fails the action — the request and the first note succeed, the rows wait to retry", { skip }, async () => {
  provider.requests.length = 0;
  provider.mode = "fail";
  const s = await stage("BL");

  const { dialog, announced } = await ask(liveBase!, s);
  assert.match(dialog, /Active client members of this workroom will be emailed a link to this version\./);
  assert.equal(announced, "Asked the client for their thoughts on this version. 2 client members will be emailed.");

  const rows = await until(s, (rows) => rows.length === 2 && rows.every((r) => r.lastError === "provider_5xx"), "the drain never tried");
  for (const row of rows) {
    assert.equal(row.status, "pending", "a 5xx was not left to retry");
    assert.equal(row.attempts, 1);
    assert.ok(row.nextAttemptAt!.getTime() > Date.now() + 30_000, "the retry is not on the schedule");
  }
  assert.equal(provider.requests.length, 2);
  assert.deepEqual(
    provider.requests.map((r) => r.headers["idempotency-key"]).sort(),
    rows.map((r) => providerIdempotencyKey(r.id)).sort(),
  );
  assert.deepEqual(
    provider.requests.map((r) => [r.body.to].flat()[0]).sort(),
    [await email(s.ana.identityId), await email(s.ben.identityId)].sort(),
  );
  assert.ok(provider.requests.every((r) => JSON.stringify(r.body).includes(`/workrooms/${s.room}/presentations/${s.presentation}/revisions/2`)));

  await writeFeedback(liveBase!, s, "MARKER-BROWSER-LIVE-FEEDBACK");
  const received = await until(
    s,
    (rows) => rows.some((r) => r.kind === "review.received" && r.lastError === "provider_5xx"),
    "the drain never tried the feedback",
  );
  assert.equal(received.filter((r) => r.kind === "review.received")[0]!.status, "pending");
  const studio = provider.requests.find((r) => r.body.subject === "New feedback in a workroom")!;
  assert.ok(studio, "the studio's message never reached the provider");
  assert.ok(String(studio.body.text).includes(`/workrooms/${s.workroomId}/presentations/${s.presentationId}/revisions/2?note=1`));
  assert.ok(!JSON.stringify(provider.requests).includes("MARKER-BROWSER-LIVE-FEEDBACK"), "feedback text reached the provider");
});

test("live: the action answers while the provider is still on the line — the drain is never awaited", { skip }, async () => {
  provider.requests.length = 0;
  provider.held.length = 0;
  provider.mode = "hold";
  const s = await stage("BH");

  const { announced } = await ask(liveBase!, s);
  assert.equal(announced, "Asked the client for their thoughts on this version. 2 client members will be emailed.");
  // The answer is on screen; the provider has been asked and has not replied.
  const deadline = Date.now() + 10_000;
  while (provider.held.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(provider.held.length >= 1, "the drain never reached the provider");
  assert.ok((await deliveriesOf(s)).some((r) => r.status === "sending"), "a row was settled while the provider was silent");

  provider.mode = "ok";
  for (const release of provider.held.splice(0)) release();
  await until(s, (rows) => rows.length === 2 && rows.every((r) => r.status === "sent"), "the held sends never settled");
});

/* -------------------------------------------------------- auth mail */

test("preview capture never touches sign-in mail: both worlds' links still reach the person", { skip }, async () => {
  provider.requests.length = 0;
  provider.mode = "ok";
  const s = await stage("BA");
  const clientAddress = await email(s.ana.identityId);
  const staffAddress = "marker-staff-email@example.com"; // the seeded owner's

  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    for (const [path, address, button] of [
      ["/workrooms/login", clientAddress, "Send me a link"],
      ["/studio/login", staffAddress, "Send sign-in link"],
    ] as const) {
      await page.goto(`${previewBase}${path}`, { waitUntil: "load" });
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll("button")).some((b) => Object.keys(b).some((k) => k.startsWith("__reactProps"))),
      );
      await page.getByLabel("Email").fill(address);
      await page.getByRole("button", { name: button }).click();
      const deadline = Date.now() + 15_000;
      while (!provider.requests.some((r) => [r.body.to].flat().includes(address)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const sent = provider.requests.find((r) => [r.body.to].flat().includes(address));
      assert.ok(sent, `the preview swallowed the sign-in link to ${path}`);
      assert.match(String(sent!.body.text), /magic-link\/verify\?/);
    }
  } finally {
    await context.close();
  }
  assert.equal((await deliveriesOf(s)).length, 0, "signing in wrote a notification");
});
