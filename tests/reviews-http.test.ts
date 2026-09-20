import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * What a Review surface actually puts on the wire.
 *
 * Every other Review suite runs inside the process, calling functions with an
 * actor passed as an argument. That proves the rules and proves nothing about
 * the request: the cookie, the guard that reads it, the route that guard sits
 * in, the RSC payload the framework serialises beside the markup. Build 003's
 * leak was in a redirect body nobody was inspecting, and Stage B's route defect
 * was a page borrowing the other world's file routes — both of them invisible
 * from inside the domain.
 *
 * So these hold a real session cookie, make a real request, and read the whole
 * response. **The RSC payload is fetched separately and checked as well**: it
 * is where a projection's fields travel as data rather than as text, so a body
 * that is absent from the markup can still be sitting in the flight stream.
 *
 * They need a running deployment with a seeded round, which is more than
 * `npm test` should assume, so they run only when told where to look:
 *
 *   WORKROOM_BASE_URL=http://localhost:3100 \
 *   WORKROOM_A_COOKIE=… WORKROOM_A_ID=… PRESENTATION_A=… \
 *   WORKROOM_B_COOKIE=… STUDIO_OWNER_COOKIE=… \
 *   STUDIO_WORKROOM_A_ID=… PRESENTATION_A_ID=… npm test
 *
 * Without those they skip loudly rather than passing quietly.
 */

const base = process.env.WORKROOM_BASE_URL;
const clientA = process.env.WORKROOM_A_COOKIE;
const clientB = process.env.WORKROOM_B_COOKIE;
const roomA = process.env.WORKROOM_A_ID;
const staff = process.env.STUDIO_OWNER_COOKIE;
const presentation = process.env.PRESENTATION_A;
const studioRoom = process.env.STUDIO_WORKROOM_A_ID;
const studioPresentation = process.env.PRESENTATION_A_ID;

const configured = Boolean(
  base && clientA && clientB && roomA && staff && presentation && studioRoom && studioPresentation,
);
const skip = configured
  ? false
  : "set WORKROOM_BASE_URL, WORKROOM_A_COOKIE, WORKROOM_B_COOKIE, WORKROOM_A_ID, STUDIO_OWNER_COOKIE, PRESENTATION_A, STUDIO_WORKROOM_A_ID and PRESENTATION_A_ID";

/** Seeded as the body of a note that was then taken back. */
const REMOVED = "MARKER-REMOVED-BODY-HTTP";

/** Anything shaped like a database identifier is a leak on a client surface. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const clientPath = `/workrooms/${roomA}/presentations/${presentation}`;
const studioPath = `/studio/workrooms/${studioRoom}/presentations/${studioPresentation}`;

async function get(path: string, cookie?: string, rsc = false) {
  const response = await fetch(`${base}${path}`, {
    headers: {
      ...(cookie ? { cookie } : {}),
      // The flight stream, rather than the document. Next serves a different
      // body for the same route, and only one of the two has ever been read.
      ...(rsc ? { RSC: "1" } : {}),
    },
    redirect: "manual",
  });
  return {
    status: response.status,
    location: response.headers.get("location") ?? "",
    body: await response.text(),
  };
}

/** Markup and flight payload together. One check, both bodies. */
async function whole(path: string, cookie?: string): Promise<string> {
  const [document, flight] = await Promise.all([get(path, cookie), get(path, cookie, true)]);
  return `${document.body}\n${flight.body}`;
}

/* ---------------------------------------------------------- the two worlds */

test("a client reads their own round, in full", { skip }, async () => {
  const page = await get(clientPath, clientA);
  assert.equal(page.status, 200);

  assert.match(page.body, /Feedback/, "the thread is not on the page at all");
  assert.match(page.body, /The studio asked for your thoughts/, "and it does not say why");
  assert.match(page.body, /touch heavy at small sizes/, "the client cannot read what they wrote");
  assert.match(page.body, /we will lighten it/, "nor what the studio replied");
});

test("a Studio session is a stranger on a client route", { skip }, async () => {
  const page = await get(clientPath, staff);

  assert.equal(page.status, 307, "a staff cookie opened a client page");
  assert.match(page.location, /\/workrooms\/login/, "and was not sent to the client entrance");
  assert.ok(
    !page.body.includes("touch heavy at small sizes"),
    "a refusal carried the round with it",
  );
});

test("a client session is nobody in Studio", { skip }, async () => {
  const page = await get(studioPath, clientA);

  assert.notEqual(page.status, 200, "a client cookie opened a Studio page");
  assert.ok(!page.body.includes("touch heavy"), "and a refusal carried the round with it");
});

test("an unauthenticated request reaches neither", { skip }, async () => {
  for (const path of [clientPath, studioPath]) {
    const page = await get(path);
    assert.notEqual(page.status, 200, `${path} is open to anybody`);
    assert.ok(!page.body.includes("touch heavy"), `${path} leaks in its refusal`);
  }
});

test("another client's session reaches none of it", { skip }, async () => {
  const page = await get(clientPath, clientB);

  assert.equal(page.status, 404, "somebody else's presentation is not found, not forbidden");
  const body = await whole(clientPath, clientB);
  assert.ok(!body.includes("touch heavy at small sizes"), "and its round is in the refusal");
  assert.ok(!body.includes("Brand"), "as is the name of the work");
});

/* ----------------------------------------------------------- what travels */

test("a removed body is in neither world's response, markup or flight", { skip }, async () => {
  for (const [world, path, cookie] of [
    ["the client", clientPath, clientA],
    ["Studio", studioPath, staff],
  ] as const) {
    const body = await whole(path, cookie);
    assert.ok(body.length > 1000, `${world} returned nothing to inspect`);
    assert.ok(!body.includes(REMOVED), `${world} can read a removed comment`);
    assert.match(body, /This was taken back/, `${world} does not show that one was removed`);
  }
});

test("no database identifier reaches a client page", { skip }, async () => {
  const body = await whole(clientPath, clientA);
  const found = body.match(new RegExp(UUID, "gi")) ?? [];
  assert.deepEqual([...new Set(found)], [], "a row id travelled to the browser");
});

test("a client page carries no version counter", { skip }, async () => {
  const body = await get(clientPath, clientA);

  // Every Review mutation holds the round's row lock from read to commit, so a
  // version in a form would add nothing and would put a raw column on a client
  // page to get it. The hidden fields are the whole of what a form may say.
  const named = [
    ...body.body.matchAll(/<(?:input|select|textarea)\b[^>]*\bname="([a-zA-Z]+)"/g),
  ].map((match) => match[1]);
  assert.ok(named.length > 0, "there are no Review forms on the page to inspect");

  for (const name of named) {
    assert.ok(
      ["room", "presentation", "revision", "n", "item", "body"].includes(name!),
      `a Review form carries a field called ${name}`,
    );
  }
});

/* -------------------------------------------------------- what is offered */

test("Studio is offered no way to open a feedback item", { skip }, async () => {
  const body = await get(studioPath, staff);
  assert.equal(body.status, 200);

  assert.match(body.body, /Feedback/, "the thread is not on the Studio page");
  assert.ok(
    !body.body.includes("Send to the studio"),
    "Studio is shown the client's composer",
  );
  assert.ok(
    !body.body.includes("What would you like to say?"),
    "Studio is shown a way to raise a point on its own work",
  );
});

test("a round that has been written in cannot be taken back", { skip }, async () => {
  const body = await get(studioPath, staff);

  assert.match(body.body, /Close feedback/, "an open round offers no way to close it");
  assert.ok(
    !body.body.includes("Take the request back"),
    "a round with feedback in it still offers a withdrawal",
  );
});

test("neither world's controls appear on the other's page", { skip }, async () => {
  const client = await get(clientPath, clientA);
  const studio = await get(studioPath, staff);

  for (const control of ["Ask for feedback", "Close feedback", "Take the request back"]) {
    assert.ok(!client.body.includes(control), `a client is shown "${control}"`);
  }
  assert.match(studio.body, /Exactly what the client is reading/);
});
