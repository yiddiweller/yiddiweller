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

/** The block a **live** point is about, and the line that must say so. */
const SUBJECT = "How the motion system feels";
const LOCATOR = `On ${SUBJECT}`;

/**
 * Everything a removed note would have carried, seeded where nothing else can
 * produce it.
 *
 * The fixture is built against false positives, which is most of the work in a
 * test like this. The two removed notes are written by a member who writes
 * **nothing else**, so their display name has no legitimate reason to be on
 * the page; the **only** item-level point is the one that gets removed, so no
 * locator may render at all; and the **only** resolution is on that same note,
 * so `Dealt with` may not appear either. Asserting the absence of a name that
 * is also on a note somebody can still read would pass for the wrong reason
 * for ever.
 */
const REMOVED = {
  author: "MARKER-REMOVED-AUTHOR",
  rootBody: "MARKER-REMOVED-BODY-HTTP",
  replyBody: "MARKER-REMOVED-REPLY-HTTP",
  /**
   * The block the *removed* point was about — a different one from the live
   * point's, so this string can only come from a tombstone's locator.
   */
  locator: "On Primary identity direction",
  /** Only a rendered resolution produces this — "Mark as dealt with" is lower case. */
  resolution: "Dealt with",
};

/** What a removed note renders as, in both worlds, and the whole of it. */
const TOMBSTONE = "Comment removed";

/** Every `<li>` holding a tombstone, with its markup. */
function tombstones(body: string): string[] {
  const found: string[] = [];
  let from = 0;

  for (;;) {
    const at = body.indexOf(TOMBSTONE, from);
    if (at === -1) break;
    from = at + TOMBSTONE.length;

    const opens = body.lastIndexOf("<li", at);
    const closes = body.indexOf("</li>", at);
    // The flight payload carries the same words without any markup around
    // them; only the document has list items to measure.
    if (opens === -1 || closes === -1) continue;
    found.push(body.slice(opens, closes + 5));
  }

  return found;
}

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
    // **Followed for the flight, and only for it.** An `RSC: 1` request is
    // answered with a 307 to the same path plus `?_rsc`, so reading it
    // manually gets a zero-byte body — which is a leak test that passes by
    // inspecting nothing. The document's redirects are the subject of other
    // tests here and stay manual.
    redirect: rsc ? "follow" : "manual",
  });
  return {
    status: response.status,
    location: response.headers.get("location") ?? "",
    body: await response.text(),
  };
}

/**
 * Markup and flight payload together. One check, both bodies.
 *
 * The flight body is asserted non-empty before it is searched: everything below
 * looks for something that must **not** be there, and an empty string satisfies
 * that without proving anything.
 */
async function whole(path: string, cookie?: string): Promise<string> {
  const [document, flight] = await Promise.all([get(path, cookie), get(path, cookie, true)]);
  assert.ok(
    flight.body.length > 500,
    `the flight payload for ${path} came back empty, so nothing was inspected`,
  );
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
    assert.ok(!body.includes(REMOVED.rootBody), `${world} can read a removed comment`);
    assert.ok(!body.includes(REMOVED.replyBody), `${world} can read a removed reply`);
    assert.ok(body.includes(TOMBSTONE), `${world} does not show that one was removed`);
  }
});

test("a point about a block says which block, in both worlds", { skip }, async () => {
  // The defect beta found. It survived every in-process test because both
  // halves of it were the number 1 — so this reads the page, in both worlds,
  // and looks for the words a person would look for.
  for (const [world, path, cookie] of [
    ["the client", clientPath, clientA],
    ["Studio", studioPath, staff],
  ] as const) {
    const page = await get(path, cookie);
    assert.equal(page.status, 200, `${world} could not open the page`);
    assert.ok(page.body.includes(LOCATOR), `${world} does not say what the point is about`);

    // And in the flight payload too, because that is where the projection
    // travels as data rather than as text.
    const flight = await get(path, cookie, true);
    assert.ok(
      flight.body.includes(SUBJECT),
      `${world}'s RSC payload carries no subject for the point`,
    );
  }
});

test("a general point says nothing about a block", { skip }, async () => {
  const body = await whole(clientPath, clientA);

  // One locator on the page, for the one point that has a subject — not one
  // per note, and not none.
  const locators = body.match(new RegExp(`On ${SUBJECT}`, "g")) ?? [];
  assert.ok(locators.length > 0, "the item-level point lost its locator");
  assert.ok(
    !body.includes("On undefined") && !body.includes("Item NaN"),
    "a general point was given a locator anyway",
  );
});

/* -------------------------------------------------------------- tombstones */

test("a removed comment renders as one line, and only that line", { skip }, async () => {
  // The defect beta found: the note's header was drawn around the tombstone,
  // so a removal narrated who took something back and when. The structure is
  // asserted rather than the text, because "no author" is a fact about what is
  // in the element, not about what a reader happens to notice.
  for (const [world, path, cookie] of [
    ["the client", clientPath, clientA],
    ["Studio", studioPath, staff],
  ] as const) {
    const page = await get(path, cookie);
    assert.equal(page.status, 200, `${world} could not open the page`);

    const found = tombstones(page.body);
    assert.equal(found.length, 2, `${world} rendered ${found.length} tombstones, expected 2`);

    for (const item of found) {
      // Exactly one paragraph, holding exactly the tombstone's words.
      const stripped = item.replace(/<[^>]+>/g, "").trim();
      assert.equal(stripped, TOMBSTONE, `${world}: a tombstone carries "${stripped}"`);

      for (const [what, pattern] of [
        ["a timestamp", /<time/],
        ["a control", /<button|<form/],
        ["a nested thread", /<ul/],
        ["an input", /<input|<textarea|<select/],
      ] as const) {
        assert.ok(!pattern.test(item), `${world}: a tombstone still renders ${what}`);
      }

      // One element inside the item, and it is the tombstone's own paragraph.
      const elements = item.match(/<(?!\/)[a-z]+/g) ?? [];
      assert.deepEqual(elements, ["<li", "<p"], `${world}: a tombstone has extra elements`);
    }
  }
});

test("a removed comment carries nothing of itself into the response", { skip }, async () => {
  for (const [world, path, cookie] of [
    ["the client", clientPath, clientA],
    ["Studio", studioPath, staff],
  ] as const) {
    const body = await whole(path, cookie);
    assert.ok(body.includes(TOMBSTONE), `${world} does not show that a comment was removed`);

    for (const [what, marker] of Object.entries(REMOVED)) {
      assert.ok(!body.includes(marker), `${world}: a removed note still carries its ${what}`);
    }

    // And the fixture is doing its job: the live half of the conversation is
    // there, so these absences mean something.
    assert.ok(body.includes("Ana Alder"), `${world} lost the live notes entirely`);
    assert.ok(
      body.includes("touch heavy at small sizes"),
      `${world} lost the live words entirely`,
    );
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
