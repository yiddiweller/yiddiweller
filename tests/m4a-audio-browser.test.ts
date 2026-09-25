import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { and, eq, isNull } from "drizzle-orm";

import { db } from "../lib/db/index.ts";
import { presentationReviewNotes, presentationRevisionItems } from "../lib/db/schema.ts";
import {
  clientPage,
  fixture,
  locator,
  open,
  setUp,
  skip,
  studioPage,
  tearDown,
  type Page,
} from "./support/browser.ts";

/**
 * An `.m4a` renders as audio — the blocker beta found on a real iPhone.
 *
 * *Schick's Take Home Foods.m4a* read *audio · 70 KB* in the Files list and
 * rendered as *No preview for this kind of file* in the Presentation: the list's
 * label takes an `audio/` prefix, the viewer takes an exact list, and the list
 * did not have `audio/x-m4a` — the type Safari and Chromium declare for an M4A.
 * No `<audio>` meant no precise time either.
 *
 * *The memo* in the shared fixture is that case: a real MPEG-4 audio file,
 * `.m4a`, declared `audio/x-m4a`, at position 7 of both published versions.
 */

before(setUp);
after(tearDown);

const MEMO = "Take Home Foods.m4a";

/** The memo's block: its `<audio>`, and whether a download card stands in for it. */
async function memo(page: Page) {
  return page.evaluate((name: string) => {
    const download = [...document.querySelectorAll("a")].find((a) => a.textContent === `Download ${name}`);
    const piece = download?.closest("section");
    const audio = piece?.querySelector("audio") ?? null;
    return {
      found: Boolean(piece),
      audio: Boolean(audio),
      controls: audio?.controls ?? false,
      autoplay: audio?.autoplay ?? false,
      card: Boolean(piece?.textContent?.includes("No preview for this kind of file")),
      index: audio ? [...document.querySelectorAll("audio")].indexOf(audio) : -1,
    };
  }, MEMO);
}

async function playable(page: Page, index: number): Promise<number> {
  await page.waitForFunction(
    (i: number) => {
      const audio = document.querySelectorAll("audio")[i];
      return audio && audio.readyState >= 1 && Number.isFinite(audio.duration);
    },
    index,
    { timeout: 10_000 },
  );
  return page.evaluate((i: number) => document.querySelectorAll("audio")[i]!.duration, index);
}

test("the client's Presentation plays the M4A in the native player, current version and history", { skip }, async () => {
  for (const path of [clientPage(), `${clientPage()}/revisions/2`]) {
    const { page, errors } = await open(path);
    const block = await memo(page);
    assert.ok(block.found, `${path}: the memo is not on the page`);
    assert.ok(!block.card, `${path}: the memo is a download card`);
    assert.ok(block.audio && block.controls, `${path}: no native player for the memo`);
    assert.ok(!block.autoplay);
    assert.ok(Math.abs((await playable(page, block.index)) - 6.14) < 0.1, `${path}: the memo does not load`);
    assert.deepEqual(errors, []);
    await page.context().close();
  }
});

test("Studio's frozen versions render the same player", { skip }, async () => {
  for (const n of [2, 3]) {
    const { page } = await open(`${studioPage()}/revisions/${n}`);
    const block = await memo(page);
    assert.ok(block.audio && block.controls && !block.card, `Version ${n} in Studio`);
    await playable(page, block.index);
    await page.context().close();
  }
});

test("the Files viewer, in both worlds, agrees", { skip }, async () => {
  for (const path of [
    `/workrooms/${fixture.room}/files/${fixture.memoFile}`,
    `/studio/workrooms/${fixture.workroomId}/files/${fixture.memoFile}`,
  ]) {
    const { page } = await open(path);
    assert.equal(await page.locator("audio[controls]").count(), 1, `${path}: no native player`);
    assert.equal(await page.getByText("No preview for this kind of file.").count(), 0, `${path}: a download card`);
    await playable(page, 0);
    await page.context().close();
  }
});

test("a precise time is captured on the M4A and found again, with nothing played", { skip }, async () => {
  const { page, errors } = await open(clientPage());
  const block = await memo(page);

  await page.getByLabel("About").selectOption({ label: "The memo" });
  await page.getByRole("button", { name: "Set precise time on The memo", exact: true }).click();
  const panel = page.getByRole("group", { name: "Precise time on The memo" });
  await panel.waitFor();
  assert.ok(
    await panel.evaluate(
      (element: HTMLElement, i: number) => element.parentElement!.querySelector("audio") === document.querySelectorAll("audio")[i],
      block.index,
    ),
    "the panel is not under the memo's own player",
  );

  await playable(page, block.index);
  const move = (t: number) =>
    page.evaluate(
      ({ i, t }: { i: number; t: number }) =>
        new Promise<void>((resolve) => {
          const audio = document.querySelectorAll("audio")[i]!;
          audio.addEventListener("seeked", () => resolve(), { once: true });
          audio.currentTime = t;
        }),
      { i: block.index, t },
    );

  // The memo is the last block, so its panel opens partly below the fold.
  // Each button is brought into view and given a frame before it is pressed:
  // Playwright's own scroll-then-click can land in the PDF viewer's
  // out-of-process frame just above while Chromium's hit-testing catches up —
  // no event reaches the page at all, which is not something a finger can do.
  const press = async (name: string) => {
    const button = page.getByRole("button", { name, exact: true });
    await button.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await button.click();
  };

  // A stretch, then a moment in the same session: both shapes read this file.
  await move(1.5);
  await press("Start here");
  await move(4);
  await press("End here");
  assert.equal(await panel.getByRole("status").last().textContent(), "0:01–0:04");
  await move(2.5);
  await press("Use this moment");
  assert.equal(await panel.getByRole("status").last().textContent(), "At 0:02");
  await press("Done");
  assert.equal(await panel.count(), 0, "Done did not close the panel");

  await page.getByLabel("What would you like to say?").fill("About the memo, here.");
  await page.getByRole("button", { name: "Send to the studio", exact: true }).click();
  await page.getByText("About the memo, here.", { exact: true }).waitFor();

  const [row] = await db()
    .select({ anchor: presentationReviewNotes.anchor, position: presentationRevisionItems.position })
    .from(presentationReviewNotes)
    .innerJoin(presentationRevisionItems, eq(presentationRevisionItems.id, presentationReviewNotes.revisionItemId))
    .where(and(eq(presentationReviewNotes.body, "About the memo, here."), isNull(presentationReviewNotes.parentNoteId)));
  assert.deepEqual(row, { anchor: { kind: "time", t: 2.5 }, position: 7 });

  await move(0);
  await locator(page, "On The memo · At 0:02").click();
  await page.waitForFunction(
    (i: number) => {
      const audio = document.querySelectorAll("audio")[i]!;
      return !audio.seeking && Math.abs(audio.currentTime - 2.5) < 0.05 && audio.paused;
    },
    block.index,
  );
  await page.waitForTimeout(500);
  assert.ok(await page.evaluate((i: number) => document.querySelectorAll("audio")[i]!.paused, block.index), "the memo played");
  assert.deepEqual(errors, []);
  await page.context().close();
});
