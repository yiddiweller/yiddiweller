import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";

import { eq } from "drizzle-orm";

import { db } from "../lib/db/index.ts";
import { authRateLimit, clientRateLimit, user, workroomMembers } from "../lib/db/schema.ts";
import { revokeMembership } from "../lib/db/workrooms.ts";
import { uuidv7 } from "../lib/db/id.ts";
import { fixture, open, pointIsOn, setUp, skip as browserSkip, studioPage, tearDown, type Page } from "./support/browser.ts";
import { magicLinkIn, MailCapture } from "./support/mail-capture.ts";
import { MARKERS, owner, person } from "./support/review-stage.ts";

/**
 * Stage G0: somebody signed out who follows a link to one exact page — a
 * version of a Presentation, one note in Studio — signs in and lands on
 * exactly that page, in their own world, with nothing granted by the trip.
 *
 * The real flow, every hop: the guard's redirect, the sign-in page, the form,
 * Better Auth's request, **the email itself** — delivered to `MailCapture`
 * through `RESEND_BASE_URL`, so the link followed is the one a person would
 * have been sent — the verification, and the page at the end.
 *
 *   REVIEW_SERVER_URL=http://localhost:3101   a server on this DATABASE_URL,
 *                                              started with RESEND_BASE_URL set
 *                                              to MAIL_CAPTURE_URL
 *   MAIL_CAPTURE_URL=http://127.0.0.1:44990
 *   AUTH_SERVER_LOG=/path/to/that/server.log
 *
 * Better Auth's limiter allows five sign-in requests and ten verifications per
 * five minutes per path; this file clears its own database's counters first
 * and stays inside both.
 */

const base = process.env.REVIEW_SERVER_URL;
const captureUrl = process.env.MAIL_CAPTURE_URL;
const serverLog = process.env.AUTH_SERVER_LOG;
const skip = browserSkip || (!captureUrl || !serverLog ? "set MAIL_CAPTURE_URL and AUTH_SERVER_LOG" : false);

const mail = new MailCapture();

const RIO = "rio-return@example.test";
const ANA = "ana-locator@example.test"; // the fixture's own client
const IVY = "ivy-return@example.test";
const ZED = "zed-return@example.test";

const v = { rioMember: "", ivy: "", zed: "", tokens: [] as string[] };

before(async () => {
  if (skip) return;
  await setUp();
  await mail.start(captureUrl!);
  await db().delete(clientRateLimit);
  await db().delete(authRateLimit);

  // Rio: a client of this Workroom whose access ends halfway through.
  const rio = await person("Rio", fixture.workroomId, RIO);
  const [member] = await db()
    .select({ id: workroomMembers.id })
    .from(workroomMembers)
    .where(eq(workroomMembers.contactId, rio.contactId));
  v.rioMember = member!.id;

  // Ivy and Zed: Studio members. Ivy is switched off after asking for a link;
  // Zed is switched off before.
  v.ivy = uuidv7();
  v.zed = uuidv7();
  await db().insert(user).values([
    { id: v.ivy, name: "Ivy Staff", email: IVY, role: "member", status: "active" },
    { id: v.zed, name: "Zed Staff", email: ZED, role: "member", status: "inactive" },
  ]);
});

after(async () => {
  if (skip) return;
  await mail.stop();
  await db().delete(user).where(eq(user.id, v.ivy));
  await db().delete(user).where(eq(user.id, v.zed));
  await tearDown();
});

/* -------------------------------------------------------------- helpers */

const clientVersion = () => `/workrooms/${fixture.room}/presentations/${fixture.presentation}/revisions/2`;
const studioNote = () => `${studioPage()}/revisions/2?note=1`;

const loginFor = (world: "workrooms" | "studio", path: string) => `/${world}/login?next=${encodeURIComponent(path)}`;

/** Where a request is sent, without following it. */
async function location(path: string, headers: Record<string, string> = {}): Promise<string | null> {
  const response = await fetch(`${base}${path}`, { redirect: "manual", headers });
  if (response.status < 300 || response.status >= 400) return null;
  const to = new URL(response.headers.get("location")!, base);
  assert.equal(to.origin, new URL(base!).origin, `${path} left the origin`);
  return `${to.pathname}${to.search}`;
}

/** React has attached to the form, so a press submits through it. */
async function hydrated(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const button = document.querySelector('button[type="submit"]');
    return button !== null && Object.keys(button).some((key) => key.startsWith("__reactProps"));
  });
}

/** Asks for a link on whichever entrance the page is on, and returns the one sent. */
async function askForLink(page: Page, email: string, button: string): Promise<string> {
  await hydrated(page);
  const mark = mail.count;
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: button }).click();
  const link = magicLinkIn(await mail.next(email, mark));
  v.tokens.push(new URL(link).searchParams.get("token")!);
  return link;
}

const here = (page: Page) => {
  const url = new URL(page.url());
  return `${url.pathname}${url.search}`;
};

/* ------------------------------------------------------- the guard's hop */

test("a signed-out deep link goes to its own world's entrance, carrying exactly that page", { skip }, async () => {
  assert.equal(await location(clientVersion()), loginFor("workrooms", clientVersion()));
  assert.equal(await location(studioNote()), loginFor("studio", studioNote()));

  // Nothing worth coming back to: the bare entrance, as before.
  assert.equal(await location("/workrooms"), "/workrooms/login");
  assert.equal(await location("/studio"), "/studio/login");
});

test("the return address is the page asked for, whatever the browser claims it was", { skip }, async () => {
  for (const spoof of ["https://evil.example", "//evil.example", "/studio/clients", "/workrooms/elsewhere"]) {
    assert.equal(
      await location(clientVersion(), { "x-yw-return-to": spoof }),
      loginFor("workrooms", clientVersion()),
      spoof,
    );
    assert.equal(await location(studioNote(), { "x-yw-return-to": spoof }), loginFor("studio", studioNote()), spoof);
  }
});

/* ---------------------------------------------------- the entrance's hop */

test("a signed-in visitor at the entrance goes to next — inside their own world only", { skip }, async () => {
  const client = { cookie: `__Secure-yw_client.session_token=${fixture.clientCookie}` };
  const staff = { cookie: `__Secure-yw_studio.session_token=${fixture.staffCookie}` };

  assert.equal(await location(loginFor("workrooms", clientVersion()), client), clientVersion());
  for (const next of ["https://evil.example", "//evil.example", "/\\evil.example", studioNote(), "/workrooms/login"]) {
    assert.equal(await location(loginFor("workrooms", next), client), "/workrooms", next);
  }

  assert.equal(await location(loginFor("studio", studioNote()), staff), studioNote());
  for (const next of ["https://evil.example", "//evil.example", "javascript:alert(1)", clientVersion(), "/studio/login"]) {
    assert.equal(await location(loginFor("studio", next), staff), "/studio", next);
  }
});

/* ------------------------------------------- the verification hop, on the wire */

test("a magic link can only land in its own world — success, error and new-user callbacks alike", { skip }, async () => {
  const verify = async (instance: "client-auth" | "auth", query: Record<string, string>) => {
    const params = new URLSearchParams({ token: "not-a-real-token", ...query });
    const response = await fetch(`${base}/api/${instance}/magic-link/verify?${params}`, { redirect: "manual" });
    assert.equal(response.status, 302, `${instance} ${params} — limiter spent?`);
    const to = new URL(response.headers.get("location")!, base);
    assert.equal(to.origin, new URL(base!).origin, `${instance} ${params} left the origin`);
    return to;
  };

  // The client instance: everything that is not /workrooms becomes /workrooms.
  assert.equal((await verify("client-auth", { callbackURL: "/studio/clients" })).pathname, "/workrooms");
  assert.equal((await verify("client-auth", { callbackURL: "/workrooms/x", errorCallbackURL: "//evil.example" })).pathname, "/workrooms");
  assert.equal((await verify("client-auth", { callbackURL: "/workrooms/x", errorCallbackURL: "/studio/login" })).pathname, "/workrooms");
  // A legitimate entrance with its destination comes back with both intact.
  const back = await verify("client-auth", {
    callbackURL: clientVersion(),
    errorCallbackURL: loginFor("workrooms", clientVersion()),
  });
  assert.equal(back.pathname, "/workrooms/login");
  assert.equal(back.searchParams.get("next"), clientVersion());

  // Studio: everything that is not /studio becomes /studio.
  assert.equal((await verify("auth", { callbackURL: clientVersion() })).pathname, "/studio");
  assert.equal((await verify("auth", { callbackURL: "/studio/x", errorCallbackURL: "https://evil.example/" })).pathname, "/studio");
  assert.equal((await verify("auth", { callbackURL: "/studio/x", errorCallbackURL: "/workrooms/login" })).pathname, "/studio");
  const studioBack = await verify("auth", { callbackURL: studioNote(), errorCallbackURL: loginFor("studio", studioNote()) });
  assert.equal(studioBack.pathname, "/studio/login");
  assert.equal(studioBack.searchParams.get("next"), studioNote());
});

/* ------------------------------------------------------- the whole journey */

test("client: a version's link, signed out → entrance → email → exactly that version", { skip }, async () => {
  const { page, errors } = await open(clientVersion(), { signedOut: true });
  assert.equal(here(page), loginFor("workrooms", clientVersion()));

  const link = await askForLink(page, RIO, "Send me a link");
  const sent = new URL(link);
  assert.equal(sent.searchParams.get("callbackURL"), clientVersion(), "the email does not carry the destination");
  assert.equal(sent.searchParams.get("errorCallbackURL"), loginFor("workrooms", clientVersion()));

  await page.goto(link);
  await page.waitForURL(`${base}${clientVersion()}`);
  // The page's own authorization ran and let Rio in: this version's work.
  await page.getByText("The board", { exact: true }).waitFor();
  await page.getByRole("link", { name: "← Latest version" }).waitFor();

  // Access ends. The same page, the same session: the route says no.
  const [member] = await db().select({ version: workroomMembers.version }).from(workroomMembers).where(eq(workroomMembers.id, v.rioMember));
  assert.ok((await revokeMembership(owner, v.rioMember, member!.version)).ok);
  const refused = await page.reload();
  assert.equal(refused.status(), 404, "a revoked member still reaches the version");
  // And the entrance is no back door either.
  const viaEntrance = await page.goto(`${base}${loginFor("workrooms", clientVersion())}`);
  assert.equal(viaEntrance.status(), 404);
  assert.deepEqual(errors, []);
  await page.context().close();
});

test("client: a link that has already been used comes back to the entrance, destination kept", { skip }, async () => {
  const used = v.tokens[0]!;
  const { page } = await open(loginFor("workrooms", clientVersion()), { signedOut: true });
  const params = new URLSearchParams({
    token: used,
    callbackURL: clientVersion(),
    errorCallbackURL: loginFor("workrooms", clientVersion()),
  });
  await page.goto(`${base}/api/client-auth/magic-link/verify?${params}`);
  const url = new URL(page.url());
  assert.equal(url.pathname, "/workrooms/login");
  assert.equal(url.searchParams.get("next"), clientVersion());
  await page.getByRole("button", { name: "Send me a link" }).waitFor();
  await page.context().close();
});

test("client: an ordinary sign-in still lands on /workrooms", { skip }, async () => {
  const { page } = await open("/workrooms/login", { signedOut: true });
  const link = await askForLink(page, ANA, "Send me a link");
  assert.equal(new URL(link).searchParams.get("callbackURL"), "/workrooms");
  assert.equal(new URL(link).searchParams.get("errorCallbackURL"), null);
  await page.goto(link);
  await page.waitForURL(`${base}/workrooms`);
  await page.context().close();
});

test("Studio: one note in one version, signed out → entrance → email → that note, ?note=1 and all", { skip }, async () => {
  const { page, errors } = await open(studioNote(), { signedOut: true });
  assert.equal(here(page), loginFor("studio", studioNote()));

  const link = await askForLink(page, MARKERS.staffEmail, "Send sign-in link");
  const sent = new URL(link);
  assert.equal(sent.searchParams.get("callbackURL"), studioNote());
  assert.equal(sent.searchParams.get("errorCallbackURL"), loginFor("studio", studioNote()));

  await page.goto(link);
  await page.waitForURL(`${base}${studioNote()}`);
  assert.equal(here(page), studioNote(), "the note did not survive");
  // The note opened itself, as `?note=1` does: Version 2's note 1, its point.
  await pointIsOn(page, "Board.png", 0.25, 0.75);
  assert.deepEqual(errors, []);
  await page.context().close();
});

test("Studio: a used link comes back to the entrance saying so, destination kept", { skip }, async () => {
  const used = v.tokens[v.tokens.length - 1]!;
  const { page } = await open(loginFor("studio", studioNote()), { signedOut: true });
  const params = new URLSearchParams({ token: used, callbackURL: studioNote(), errorCallbackURL: loginFor("studio", studioNote()) });
  await page.goto(`${base}/api/auth/magic-link/verify?${params}`);
  const url = new URL(page.url());
  assert.equal(url.pathname, "/studio/login");
  assert.equal(url.searchParams.get("next"), studioNote());
  await page.getByText("That link did not work.").waitFor();
  await page.context().close();
});

test("Studio: an ordinary sign-in still lands on /studio", { skip }, async () => {
  const { page } = await open("/studio/login", { signedOut: true });
  const link = await askForLink(page, MARKERS.staffEmail, "Send sign-in link");
  assert.equal(new URL(link).searchParams.get("callbackURL"), "/studio");
  assert.equal(new URL(link).searchParams.get("errorCallbackURL"), "/studio/login");
  await page.goto(link);
  await page.waitForURL(`${base}/studio`);
  await page.context().close();
});

test("an unsafe next is carried nowhere: the email sent from it is the ordinary one", { skip }, async () => {
  // Next.js echoes the page's own URL in its router state, so the value is in
  // the HTML whatever the page does; what matters is what the page does with
  // it. A link sent from an entrance given somewhere unsafe goes home.
  {
    const { page } = await open(loginFor("workrooms", "https://evil.example/x"), { signedOut: true });
    const link = new URL(await askForLink(page, ANA, "Send me a link"));
    assert.equal(link.searchParams.get("callbackURL"), "/workrooms");
    assert.equal(link.searchParams.get("errorCallbackURL"), null);
    await page.context().close();
  }
  {
    const { page } = await open(loginFor("studio", clientVersion()), { signedOut: true });
    const link = new URL(await askForLink(page, MARKERS.staffEmail, "Send sign-in link"));
    assert.equal(link.searchParams.get("callbackURL"), "/studio");
    assert.equal(link.searchParams.get("errorCallbackURL"), "/studio/login");
    await page.context().close();
  }
});

test("Studio: a next URL opens nothing for somebody whose access has ended", { skip }, async () => {
  // Switched off before asking: no link is sent at all.
  {
    const { page } = await open(studioNote(), { signedOut: true });
    await hydrated(page);
    const mark = mail.count;
    await page.getByLabel("Email").fill(ZED);
    await page.getByRole("button", { name: "Send sign-in link" }).click();
    await page.getByText("Check your email.").waitFor();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(mail.since(mark, ZED).length, 0, "an inactive member was sent a link");
    await page.context().close();
  }
  // Switched off after asking: the link signs in, and the note is still refused.
  {
    const { page } = await open(studioNote(), { signedOut: true });
    const link = await askForLink(page, IVY, "Send sign-in link");
    await db().update(user).set({ status: "inactive" }).where(eq(user.id, v.ivy));
    await page.goto(link);
    await page.getByText("This account no longer has access.").waitFor();
    assert.equal(new URL(page.url()).pathname, "/studio/login");
    assert.equal(await page.locator('img[alt="Board.png"]').count(), 0, "the note's work was shown");
    await page.context().close();
  }
});

/* ------------------------------------------------------------- the logs */

test("no sign-in token, link or full address reaches the server's log", { skip }, () => {
  assert.ok(v.tokens.length >= 4, "the journeys above did not run");
  const log = readFileSync(serverLog!, "utf8");
  for (const token of v.tokens) assert.ok(!log.includes(token), "a sign-in token is in the log");
  assert.doesNotMatch(log, /magic-link\/verify\?token=/);
  for (const address of [RIO, ANA, IVY, ZED, MARKERS.staffEmail]) {
    assert.ok(!log.includes(address), `${address} is in the log`);
  }
});
