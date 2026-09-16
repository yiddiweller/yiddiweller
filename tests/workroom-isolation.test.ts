import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * What a client actually receives, in bytes.
 *
 * Not what is visible, and not what the domain layer returns — the whole
 * response: markup, RSC flight payload, headers and title together. Build 003
 * found a leak that was invisible in rendered text and sat in a redirect body,
 * and Build 004 puts one client's private information behind the same
 * machinery, so these read everything.
 *
 * They need a running deployment with two signed-in clients and two workrooms,
 * which is more than `npm test` should assume, so they run only when told where
 * to look:
 *
 *   WORKROOM_BASE_URL=http://localhost:3100 \
 *   WORKROOM_A_COOKIE='yw_client.session_token=…' WORKROOM_A_ID=… \
 *   WORKROOM_B_COOKIE='yw_client.session_token=…' WORKROOM_B_ID=… \
 *   STUDIO_OWNER_COOKIE='yw_studio.session_token=…' npm test
 *
 * Without those they skip loudly rather than passing quietly.
 */

const base = process.env.WORKROOM_BASE_URL;
const clientA = process.env.WORKROOM_A_COOKIE;
const clientB = process.env.WORKROOM_B_COOKIE;
const roomA = process.env.WORKROOM_A_ID;
const roomB = process.env.WORKROOM_B_ID;
const staff = process.env.STUDIO_OWNER_COOKIE;

const configured = Boolean(base && clientA && clientB && roomA && roomB && staff);
const skip = configured
  ? false
  : "set WORKROOM_BASE_URL, WORKROOM_A_COOKIE, WORKROOM_A_ID, WORKROOM_B_COOKIE, WORKROOM_B_ID and STUDIO_OWNER_COOKIE";

/** Seeded into every internal field the studio holds. None may ever appear. */
const MARKERS = [
  "MARKER-CLIENT-NOTE",
  "MARKER-CONTACT-NOTE",
  "MARKER-PROJECT-NOTE",
  "MARKER-PROJECT-DESCRIPTION",
  "MARKER-LEAD-SUMMARY",
];

async function get(path: string, cookie?: string) {
  const response = await fetch(`${base}${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
  return {
    status: response.status,
    body: await response.text(),
    cacheControl: response.headers.get("cache-control") ?? "",
  };
}

function leaks(body: string, extra: string[] = []): string[] {
  return [...MARKERS, ...extra].filter((marker) => body.includes(marker));
}

test("a client reaches their own workroom and nothing of anybody else's", { skip }, async () => {
  const own = await get(`/workrooms/${roomA}`, clientA);
  assert.equal(own.status, 200);

  const theirs = await get(`/workrooms/${roomB}`, clientA);
  assert.equal(theirs.status, 404, "somebody else's workroom is not found, not forbidden");
  assert.deepEqual(leaks(theirs.body, ["Birch"]), [], "and its name is nowhere in the refusal");

  // Symmetrically, so this is isolation rather than one lucky direction.
  assert.equal((await get(`/workrooms/${roomB}`, clientB)).status, 200);
  const other = await get(`/workrooms/${roomA}`, clientB);
  assert.equal(other.status, 404);
  assert.deepEqual(leaks(other.body, ["Alder"]), []);
});

test("a workroom that never existed answers exactly as somebody else's does", { skip }, async () => {
  const ghost = await get("/workrooms/00000000000000000000000000", clientA);
  const theirs = await get(`/workrooms/${roomB}`, clientA);
  assert.equal(ghost.status, theirs.status);
  assert.equal(ghost.status, 404);
});

test("the index lists only what the viewer may open", { skip }, async () => {
  const mine = await get("/workrooms", clientA);
  assert.equal(mine.status, 200);
  assert.ok(!mine.body.includes("Birch"), "another client's name reached the index");
  assert.ok(!mine.body.includes(roomB!), "another workroom's id reached the index");
});

test("nothing internal is anywhere in a client's own workroom", { skip }, async () => {
  const own = await get(`/workrooms/${roomA}`, clientA);
  assert.deepEqual(leaks(own.body), [], "an internal field reached the client");
  // Nor the other tenant, nor Studio.
  assert.ok(!own.body.includes("Birch"));
  assert.ok(!own.body.includes("/studio/"));
});

test("an anonymous request learns nothing before it is sent to sign in", { skip }, async () => {
  for (const path of ["/workrooms", `/workrooms/${roomA}`]) {
    const response = await get(path, undefined);
    assert.equal(response.status, 307, path);
    assert.deepEqual(leaks(response.body, ["Alder", "Ana Alder"]), [], path);
  }
});

test("a workroom's title says nothing, to anybody", { skip }, async () => {
  for (const cookie of [clientA, clientB, undefined]) {
    const response = await get(`/workrooms/${roomA}`, cookie);
    assert.match(response.body, /<title>Workroom — Yiddi Weller<\/title>/);
  }
});

test("staff and client sessions cannot stand in for each other", { skip }, async () => {
  // A Studio session is not a way into a client's private space.
  const staffOnWorkroom = await get(`/workrooms/${roomA}`, staff);
  assert.equal(staffOnWorkroom.status, 307);
  assert.deepEqual(leaks(staffOnWorkroom.body, ["Alder"]), []);

  // And a client session is not a way into Studio.
  const clientOnStudio = await get("/studio/clients", clientA);
  assert.equal(clientOnStudio.status, 307);
  assert.deepEqual(leaks(clientOnStudio.body), []);

  // Holding both at once confuses neither: each answers its own world.
  assert.equal((await get(`/workrooms/${roomA}`, `${staff}; ${clientA}`)).status, 200);
  assert.equal((await get("/studio/clients", `${staff}; ${clientA}`)).status, 200);
});

test("a private response is never stored by anything in between", { skip }, async () => {
  for (const path of [`/workrooms/${roomA}`, "/workrooms", "/workrooms/login"]) {
    const response = await get(path, clientA);
    assert.match(response.cacheControl, /no-store/, path);
    assert.match(response.cacheControl, /private/, path);
  }
});

test("public pages are untouched by any of it", { skip }, async () => {
  for (const path of ["/", "/work", "/contact"]) {
    const response = await get(path);
    assert.equal(response.status, 200, path);
    assert.ok(!response.cacheControl.includes("no-store"), `${path} lost its caching`);
    assert.ok(!response.body.includes("/workrooms"), `${path} links into a private area`);
  }

  const robots = await get("/robots.txt");
  assert.match(robots.body, /Disallow: \/workrooms\//);
  assert.match(robots.body, /Allow: \//);

  const sitemap = await get("/sitemap.xml");
  assert.ok(!sitemap.body.includes("workroom"), "a private path reached the sitemap");
});

/**
 * The same rule as `workroom-redirect.test.ts`, asserted on the wire.
 *
 * That file proves the predicate; this proves it is actually wired into both
 * halves of the flow. The token is deliberately invalid: Better Auth still
 * honours `callbackURL` when it refuses one, which is exactly the redirect an
 * attacker would want, and is how the original `/studio/clients` hole was
 * found.
 *
 * Costs five of the ten `/magic-link/verify` attempts the limiter allows in
 * five minutes, so run it once per window.
 */
test("a sign-in can only ever land inside the client world", { skip }, async () => {
  const cases: Array<[string, string]> = [
    ["/studio/clients", "/workrooms"],
    ["/workrooms/../studio/clients", "/workrooms"],
    ["https://evil.test/anywhere", "/workrooms"],
    ["//evil.test/anywhere", "/workrooms"],
    // A real destination survives untouched, so this is a rule and not a wall.
    [`/workrooms/${roomA}`, `/workrooms/${roomA}`],
  ];

  for (const [asked, expected] of cases) {
    const response = await fetch(
      `${base}/api/client-auth/magic-link/verify?token=invalid&callbackURL=${encodeURIComponent(asked)}`,
      { redirect: "manual" },
    );
    assert.equal(response.status, 302, `${asked} — limiter spent?`);

    const location = new URL(response.headers.get("location") ?? "", base);
    assert.equal(location.origin, new URL(base!).origin, asked);
    assert.equal(location.pathname, expected, asked);
  }
});
