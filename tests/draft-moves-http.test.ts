import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The reorder controls as Studio actually serves them.
 *
 * `draft-moves.test.ts` proves the rule; this proves the page draws by it —
 * reading the real server-rendered markup of each seeded draft, splitting it
 * into its blocks in order, and counting the move controls inside each. A
 * control that is not offered must not be in the markup at all: not hidden,
 * not disabled, not an empty button a keyboard can land on.
 *
 * Needs a running deployment with the seeded Studio fixture:
 *
 *   WORKROOM_BASE_URL=http://localhost:3100 STUDIO_OWNER_COOKIE=… \
 *   STUDIO_WORKROOM_A_ID=… PRESENTATION_A_ID=… PRESENTATION_A_DRAFT_ID=… \
 *   PRESENTATION_A_WITHDRAWN_ID=… npm test
 */

const base = process.env.WORKROOM_BASE_URL;
const staff = process.env.STUDIO_OWNER_COOKIE;
const room = process.env.STUDIO_WORKROOM_A_ID;
const drafts = [
  process.env.PRESENTATION_A_ID,
  process.env.PRESENTATION_A_DRAFT_ID,
  process.env.PRESENTATION_A_WITHDRAWN_ID,
];

const configured = Boolean(base && staff && room && drafts.every(Boolean));
const skip = configured
  ? false
  : "set WORKROOM_BASE_URL, STUDIO_OWNER_COOKIE, STUDIO_WORKROOM_A_ID, PRESENTATION_A_ID, PRESENTATION_A_DRAFT_ID and PRESENTATION_A_WITHDRAWN_ID";

type Block = { up: number; down: number; upButtons: number; downButtons: number };

/** The draft's blocks, in the order the page draws them. */
async function blocks(presentationId: string): Promise<Block[]> {
  const response = await fetch(`${base}/studio/workrooms/${room}/presentations/${presentationId}`, {
    headers: { cookie: staff! },
    redirect: "manual",
  });
  assert.equal(response.status, 200, `the draft page answered ${response.status}`);
  const html = await response.text();

  // Only the server-rendered sequence — not the flight payload after it,
  // which carries every prop as data rather than as controls.
  const start = html.indexOf(">The sequence<");
  assert.ok(start > 0, "the page has no sequence section");
  const end = html.indexOf("</section>", start);
  const section = html.slice(start, end);

  const rows = section.split(/<div class="[^"]*__row">/).slice(1);
  assert.ok(rows.length > 0, "the sequence rendered no blocks, so nothing here is proved");

  const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;
  return rows.map((row) => ({
    up: count(row, /name="direction" value="up"/g),
    down: count(row, /name="direction" value="down"/g),
    upButtons: count(row, />Move up</g),
    downButtons: count(row, />Move down</g),
  }));
}

test("each seeded draft offers only the moves its blocks can make", { skip }, async () => {
  const sizes: number[] = [];

  for (const presentationId of drafts) {
    const drawn = await blocks(presentationId!);
    sizes.push(drawn.length);

    drawn.forEach((block, index) => {
      const first = index === 0;
      const last = index === drawn.length - 1;
      const where = `block ${index + 1} of ${drawn.length}`;

      assert.equal(block.up, first ? 0 : 1, `${where}: Move up ${first ? "offered" : "missing"}`);
      assert.equal(block.down, last ? 0 : 1, `${where}: Move down ${last ? "offered" : "missing"}`);
      // The button travels with its form, and there is no orphan of either.
      assert.equal(block.upButtons, block.up, `${where}: a Move up button without its form, or the reverse`);
      assert.equal(block.downButtons, block.down, `${where}: a Move down button without its form, or the reverse`);
    });
  }

  // The fixture has to hold the shapes worth proving, or this proves little.
  assert.ok(sizes.includes(1), `no single-block draft among ${sizes}`);
  assert.ok(sizes.some((size) => size >= 3), `no draft with a middle block among ${sizes}`);
});
