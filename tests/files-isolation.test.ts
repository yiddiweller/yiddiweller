import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * What a client actually receives when files are involved, in bytes.
 *
 * The same discipline as `workroom-isolation.test.ts`: not what is visible, but
 * the whole response — markup, RSC flight payload, headers and title together.
 * Build 003 found a leak that was invisible in rendered text and sat in a
 * redirect body, and a storage key in a flight payload would be the same class
 * of mistake with a worse consequence.
 *
 * Needs a running deployment with two signed-in clients, two workrooms and at
 * least one shared file, which is more than `npm test` should assume:
 *
 *   WORKROOM_BASE_URL=http://localhost:3100 \
 *   WORKROOM_A_COOKIE=… WORKROOM_A_ID=… WORKROOM_A_FILE=… \
 *   WORKROOM_A_INTERNAL_FILE=… \
 *   WORKROOM_B_COOKIE=… WORKROOM_B_ID=… WORKROOM_B_FILE=… \
 *   STUDIO_OWNER_COOKIE=… npm test
 */

const base = process.env.WORKROOM_BASE_URL;
const clientA = process.env.WORKROOM_A_COOKIE;
const clientB = process.env.WORKROOM_B_COOKIE;
const roomA = process.env.WORKROOM_A_ID;
const roomB = process.env.WORKROOM_B_ID;
const fileA = process.env.WORKROOM_A_FILE;
const fileB = process.env.WORKROOM_B_FILE;
const internalA = process.env.WORKROOM_A_INTERNAL_FILE;
const staff = process.env.STUDIO_OWNER_COOKIE;

const configured = Boolean(base && clientA && clientB && roomA && roomB && fileA && fileB && internalA && staff);
const skip = configured
  ? false
  : "set WORKROOM_BASE_URL, WORKROOM_{A,B}_COOKIE, WORKROOM_{A,B}_ID, WORKROOM_{A,B}_FILE, WORKROOM_A_INTERNAL_FILE and STUDIO_OWNER_COOKIE";

/** Seeded into every internal field. None may appear in any client response. */
const MARKERS = [
  "MARKER-CLIENT-NOTE",
  "MARKER-CONTACT-NOTE",
  "MARKER-PROJECT-NOTE",
  "MARKER-PROJECT-DESCRIPTION",
  "MARKER-LEAD-SUMMARY",
  "MARKER-ORIGINAL-FILENAME",
];

async function get(path: string, cookie?: string) {
  const response = await fetch(`${base}${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
  return {
    status: response.status,
    body: await response.text(),
    location: response.headers.get("location") ?? "",
    cacheControl: response.headers.get("cache-control") ?? "",
  };
}

function leaks(body: string, extra: string[] = []): string[] {
  return [...MARKERS, ...extra].filter((marker) => body.includes(marker));
}

test("a client's files page carries nothing internal", { skip }, async () => {
  const page = await get(`/workrooms/${roomA}/files`, clientA);
  assert.equal(page.status, 200);

  assert.deepEqual(leaks(page.body), [], "an internal field reached the client");
  // The two things a file adds to the leak surface.
  assert.ok(!page.body.includes("pending/"), "a pending storage key reached the client");
  assert.ok(!/\bw\/[0-9a-f-]{36}\/f\//.test(page.body), "a permanent storage key reached the client");
  assert.ok(!page.body.includes("Birch"), "another tenant reached the client");
  assert.ok(!page.body.includes("/studio/"), "a studio path reached the client");
});

test("a files page says nothing in its title, to anybody", { skip }, async () => {
  // The same title as every other page in the client world: it reveals neither
  // the work nor which page you are on, and a refusal carries it too.
  for (const cookie of [clientA, clientB, undefined]) {
    const response = await get(`/workrooms/${roomA}/files`, cookie);
    assert.match(response.body, /<title>Workroom — Yiddi Weller<\/title>/, String(cookie));
  }
  const other = await get(`/workrooms/${roomB}/files`, clientA);
  assert.match(other.body, /<title>Workroom — Yiddi Weller<\/title>/);
});

test("a download is authorized, and every refusal looks the same", { skip }, async () => {
  const own = await get(`/workrooms/${roomA}/files/${fileA}/download`, clientA);
  assert.equal(own.status, 302, "a member could not download their own file");
  assert.ok(own.location.length > 0);
  // The signed URL goes in a header, never into a page.
  assert.ok(!own.body.includes("http"), "a signed URL reached the body");

  const refusals = [
    [`/workrooms/${roomA}/files/${fileB}/download`, clientA, "another workroom's file"],
    [`/workrooms/${roomB}/files/${fileA}/download`, clientB, "another workroom's file, reversed"],
    [`/workrooms/${roomA}/files/${internalA}/download`, clientA, "an internal file"],
    [`/workrooms/${roomA}/files/00000000000000000000000000/download`, clientA, "a file that never existed"],
    [`/workrooms/${roomA}/files/not-a-public-id/download`, clientA, "a malformed id"],
  ] as const;

  for (const [path, cookie, what] of refusals) {
    const response = await get(path, cookie);
    assert.equal(response.status, 404, what);
    assert.equal(response.body.length, 0, `${what} answered with a body to compare`);
    assert.equal(response.location, "", `${what} leaked a location`);
  }
});

test("an anonymous request learns nothing before it is sent to sign in", { skip }, async () => {
  for (const path of [`/workrooms/${roomA}/files`, `/workrooms/${roomA}/files/${fileA}/download`]) {
    const response = await get(path, undefined);
    assert.ok([302, 307].includes(response.status), `${path} answered ${response.status}`);
    assert.deepEqual(leaks(response.body, ["Alder", "Ana Alder"]), [], path);
  }
});

test("a studio session is not a way into a client's files", { skip }, async () => {
  const page = await get(`/workrooms/${roomA}/files`, staff);
  assert.ok([302, 307].includes(page.status));

  const download = await get(`/workrooms/${roomA}/files/${fileA}/download`, staff);
  assert.ok([302, 307].includes(download.status));
  // Not a signed storage URL: a redirect to the client sign-in page.
  assert.ok(!download.location.includes("X-Amz-Signature"), "staff were handed a client's file");
});

test("a client session is not a way into the studio's files", { skip }, async () => {
  const response = await get(`/studio/workrooms/${roomA}/files`, clientA);
  assert.ok([302, 307, 404].includes(response.status));
  assert.deepEqual(leaks(response.body), []);
});

test("a private file response is never stored by anything in between", { skip }, async () => {
  for (const path of [`/workrooms/${roomA}/files`, `/workrooms/${roomA}/files/${fileA}/download`]) {
    const response = await get(path, clientA);
    assert.match(response.cacheControl, /no-store/, path);
    assert.match(response.cacheControl, /private/, path);
  }
});

test("public pages and robots are untouched by any of it", { skip }, async () => {
  for (const path of ["/", "/work", "/contact"]) {
    const response = await get(path);
    assert.equal(response.status, 200, path);
    assert.ok(!response.cacheControl.includes("no-store"), `${path} lost its caching`);
    assert.ok(!response.body.includes("/files"), `${path} links into a private area`);
  }

  const robots = await get("/robots.txt");
  assert.match(robots.body, /Disallow: \/workrooms$/m);

  const sitemap = await get("/sitemap.xml");
  assert.ok(!sitemap.body.includes("files"), "a private path reached the sitemap");
});
