import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { and, eq, isNull } from "drizzle-orm";

import { db } from "../lib/db/index.ts";
import { presentationReviewNotes, presentationRevisionItems } from "../lib/db/schema.ts";
import {
  clientPage,
  fixture,
  inViewNow,
  locator,
  open,
  setUp,
  skip,
  studioPage,
  tearDown,
  type Page,
} from "./support/browser.ts";
import { UUID } from "./support/review-stage.ts";

/**
 * Stage F3 in a real browser: choosing a moment or a stretch in a recording,
 * from the composer, with the recording's own native player.
 *
 * Every flow ends where it matters — in PostgreSQL, through the ordinary
 * client action — and then goes back through F2's locator to prove the stored
 * time is the one that was chosen. The fixture (`support/browser.ts`) has two
 * recordings in the open round's version: *The sound* at position 3, the first
 * `<audio>` on the page, and *The voice* at position 5, the second.
 */

before(setUp);
after(tearDown);

const base = process.env.REVIEW_SERVER_URL;
const SOUND = 0;
const VOICE = 1;

/* -------------------------------------------------------------- helpers */

const about = (page: Page) => page.getByLabel("About");
const words = (page: Page) => page.getByLabel("What would you like to say?");
const setTime = (page: Page, name: string) => page.getByRole("button", { name: `Set precise time on ${name}`, exact: true });
const change = (page: Page, name: string) => page.getByRole("button", { name: `Change the precise time on ${name}`, exact: true });
const clear = (page: Page, name: string) => page.getByRole("button", { name: `Clear the precise time on ${name}`, exact: true });
const panel = (page: Page) => page.getByRole("group", { name: /^Precise time on / });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });

/** Moves a recording's own player, the way a person dragging it would. */
async function moveTo(page: Page, index: number, t: number): Promise<void> {
  await page.waitForFunction(
    (i: number) => {
      const audio = document.querySelectorAll("audio")[i];
      return audio && audio.readyState >= 1 && Number.isFinite(audio.duration);
    },
    index,
    { timeout: 10_000 },
  );
  await page.evaluate(
    ({ i, t }: { i: number; t: number }) =>
      new Promise<void>((resolve) => {
        const audio = document.querySelectorAll("audio")[i]!;
        audio.addEventListener("seeked", () => resolve(), { once: true });
        audio.currentTime = t;
      }),
    { i: index, t },
  );
}

async function audio(page: Page, index: number) {
  return page.evaluate((i: number) => {
    const element = document.querySelectorAll("audio")[i]!;
    return { time: element.currentTime, paused: element.paused };
  }, index);
}

/** The choice the capture panel is showing, in words. */
const choice = (page: Page) => panel(page).getByRole("status").last().textContent();

async function send(page: Page, body: string): Promise<void> {
  await words(page).fill(body);
  await button(page, "Send to the studio").click();
  await page.getByText(body, { exact: true }).waitFor({ timeout: 10_000 });
}

/** What was stored for a note, by its words: its block's position and its anchor. */
async function stored(body: string): Promise<{ position: number | null; anchor: unknown }> {
  const [row] = await db()
    .select({ anchor: presentationReviewNotes.anchor, position: presentationRevisionItems.position })
    .from(presentationReviewNotes)
    .leftJoin(presentationRevisionItems, eq(presentationRevisionItems.id, presentationReviewNotes.revisionItemId))
    .where(and(eq(presentationReviewNotes.body, body), isNull(presentationReviewNotes.parentNoteId)));
  assert.ok(row, `"${body}" was not stored`);
  return { position: row.position ?? null, anchor: row.anchor };
}

/** A player paused at `t`, and still paused a moment later. */
async function pausedAt(page: Page, index: number, t: number): Promise<void> {
  await page.waitForFunction(
    ({ i, t }: { i: number; t: number }) => {
      const element = document.querySelectorAll("audio")[i];
      return element && !element.seeking && Math.abs(element.currentTime - t) < 0.05;
    },
    { i: index, t },
    { timeout: 10_000 },
  );
  await page.waitForTimeout(500);
  const later = await audio(page, index);
  assert.ok(later.paused, "the recording started playing");
  assert.ok(Math.abs(later.time - t) < 0.05, `the recording moved by itself to ${later.time}`);
}

const focused = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    return {
      tag: active?.tagName ?? "",
      label: active?.getAttribute("aria-label") ?? active?.getAttribute("aria-labelledby") ?? "",
      role: active?.getAttribute("role") ?? "",
      text: active?.textContent ?? "",
    };
  });

/* ---------------------------------------------------------- eligibility */

test("only a recording offers a precise time — an M4A included — not the version, a note, a picture, a video or a PDF", { skip }, async () => {
  const { page, errors } = await open(clientPage());

  for (const [label, offered] of [
    ["This version as a whole", false],
    ["Intro", false],
    ["The motion", false],
    ["The board", false],
    ["The sound", true],
    ["The poster", false],
    ["The voice", true],
    ["The deck", false],
    ["The memo", true],
  ] as const) {
    await about(page).selectOption({ label });
    const control = page.getByRole("button", { name: /^Set precise time/ });
    assert.equal(await control.count(), offered ? 1 : 0, `${label}: offered ${!offered}`);
  }

  assert.deepEqual(errors, []);
  await page.context().close();
});

/* ------------------------------------------------------------- moments */

test("a moment: chosen on the native player, kept in the draft, stored exactly, and found again", { skip }, async () => {
  const { page, errors } = await open(clientPage());

  await about(page).selectOption({ label: "The sound" });
  await setTime(page, "The sound").click();

  // The panel opens under *that* recording and takes focus.
  await panel(page).waitFor();
  assert.equal(await panel(page).getByText("Precise time on The sound", { exact: true }).count(), 1);
  assert.ok(
    await panel(page).evaluate((element: HTMLElement) =>
      element.parentElement!.querySelector("audio") === document.querySelectorAll("audio")[0] &&
      document.activeElement === element,
    ),
    "the panel is not under the sound, or did not take focus",
  );

  await moveTo(page, SOUND, 2.5);
  await panel(page).getByText("Player at 0:02").waitFor();
  await button(page, "Use this moment").click();
  assert.equal(await choice(page), "At 0:02");

  await button(page, "Done").click();
  assert.equal(await panel(page).count(), 0);
  assert.equal((await focused(page)).tag, "TEXTAREA", "focus did not come back to the words");
  assert.equal(await page.getByText("At 0:02", { exact: true }).count(), 1, "the draft does not show its time");
  assert.equal(await change(page, "The sound").count(), 1);
  assert.equal(await clear(page, "The sound").count(), 1);

  await send(page, "F3 moment.");
  assert.deepEqual(await stored("F3 moment."), { position: 3, anchor: { kind: "time", t: 2.5 } });

  // The composer is empty again, the version as a whole, no time.
  assert.equal(await about(page).inputValue(), "");
  assert.equal(await page.getByRole("button", { name: /^(Set|Change the) precise time/ }).count(), 0);

  // And F2 takes it from here: the locator pauses the same player there.
  await moveTo(page, SOUND, 0);
  await locator(page, "On The sound · At 0:02").click();
  await pausedAt(page, SOUND, 2.5);

  assert.deepEqual(errors, []);
  await page.context().close();
});

/* ------------------------------------------------------------ stretches */

test("a stretch: a start, an end after it, stored exactly, found again at its start", { skip }, async () => {
  const { page, errors } = await open(clientPage());

  await about(page).selectOption({ label: "The sound" });
  await setTime(page, "The sound").click();
  await moveTo(page, SOUND, 1.25);
  await button(page, "Start here").click();
  assert.equal(await choice(page), "Starts at 0:01 — now choose where it ends.");
  assert.ok(await button(page, "Done").isDisabled(), "half a stretch could be kept");

  await moveTo(page, SOUND, 3.5);
  await button(page, "End here").click();
  assert.equal(await choice(page), "0:01–0:03");
  await button(page, "Done").click();
  assert.equal(await page.getByText("0:01–0:03", { exact: true }).count(), 1);

  await send(page, "F3 stretch.");
  assert.deepEqual(await stored("F3 stretch."), { position: 3, anchor: { kind: "time", t: 1.25, t2: 3.5 } });

  await moveTo(page, SOUND, 0);
  await locator(page, "On The sound · 0:01–0:03").click();
  await pausedAt(page, SOUND, 1.25);

  assert.deepEqual(errors, []);
  await page.context().close();
});

test("an end at or before the start is refused and said, never swapped", { skip }, async () => {
  const { page } = await open(clientPage());

  await about(page).selectOption({ label: "The sound" });
  await setTime(page, "The sound").click();
  await moveTo(page, SOUND, 3);
  await button(page, "Start here").click();
  await moveTo(page, SOUND, 2);
  await button(page, "End here").click();

  assert.equal(await choice(page), "Choose an end after the start.");
  assert.equal(await panel(page).getByRole("status").last().getAttribute("aria-live"), "polite");
  assert.ok(await button(page, "Done").isDisabled(), "an invalid stretch could be kept");

  // The start is kept: move on and press End again.
  await moveTo(page, SOUND, 4);
  await button(page, "End here").click();
  assert.equal(await choice(page), "0:03–0:04");
  assert.ok(!(await button(page, "Done").isDisabled()));
  await page.context().close();
});

/* ------------------------------------------- Done, Cancel, Change, Clear */

test("Change then Cancel — or Escape — gives back the time that was there before", { skip }, async () => {
  const { page } = await open(clientPage());

  await about(page).selectOption({ label: "The sound" });
  await setTime(page, "The sound").click();
  await moveTo(page, SOUND, 2.5);
  await button(page, "Use this moment").click();
  await button(page, "Done").click();

  // Change starts from the time being changed…
  await change(page, "The sound").click();
  assert.equal(await choice(page), "At 0:02");
  await moveTo(page, SOUND, 5);
  await button(page, "Use this moment").click();
  assert.equal(await choice(page), "At 0:05");
  // …and Cancel puts it back, with focus on the control that opened it.
  await button(page, "Cancel").click();
  assert.equal(await panel(page).count(), 0);
  assert.equal(await page.getByText("At 0:02", { exact: true }).count(), 1);
  assert.equal((await focused(page)).label, "Change the precise time on The sound");

  // Escape is Cancel while a time is being chosen.
  await change(page, "The sound").click();
  await moveTo(page, SOUND, 1);
  await button(page, "Start here").click();
  await page.keyboard.press("Escape");
  assert.equal(await panel(page).count(), 0);
  assert.equal(await page.getByText("At 0:02", { exact: true }).count(), 1);

  // With nothing before, Cancel leaves nothing.
  await clear(page, "The sound").click();
  await setTime(page, "The sound").click();
  await moveTo(page, SOUND, 1);
  await button(page, "Use this moment").click();
  await page.keyboard.press("Escape");
  assert.equal(await setTime(page, "The sound").count(), 1);
  assert.equal(await page.getByText("At 0:01", { exact: true }).count(), 0);
  await page.context().close();
});

test("Clear takes away only the time: the words and the recording stay, and it sends as item-level", { skip }, async () => {
  const { page } = await open(clientPage());

  await about(page).selectOption({ label: "The sound" });
  await words(page).fill("F3 cleared.");
  await setTime(page, "The sound").click();
  await moveTo(page, SOUND, 2);
  await button(page, "Use this moment").click();
  await button(page, "Done").click();
  await clear(page, "The sound").click();

  assert.equal(await about(page).inputValue(), "3");
  assert.equal(await words(page).inputValue(), "F3 cleared.");
  assert.equal(await setTime(page, "The sound").count(), 1);
  assert.equal(await page.locator('input[name="anchor"]').inputValue(), "");

  await button(page, "Send to the studio").click();
  await page.getByText("F3 cleared.", { exact: true }).waitFor();
  assert.deepEqual(await stored("F3 cleared."), { position: 3, anchor: null });
  await page.context().close();
});

test("a time never follows the comment to another block", { skip }, async () => {
  const { page } = await open(clientPage());

  await about(page).selectOption({ label: "The sound" });
  await setTime(page, "The sound").click();
  await moveTo(page, SOUND, 2);
  await button(page, "Use this moment").click();
  await button(page, "Done").click();

  // To the other recording: its own control, no time.
  await about(page).selectOption({ label: "The voice" });
  assert.equal(await setTime(page, "The voice").count(), 1);
  assert.equal(await page.getByText("At 0:02", { exact: true }).count(), 0);
  assert.equal(await page.locator('input[name="anchor"]').inputValue(), "");

  // To a picture, and back: nothing carried either way.
  await about(page).selectOption({ label: "The board" });
  assert.equal(await page.locator('input[name="anchor"]').count(), 0);
  await about(page).selectOption({ label: "The sound" });
  assert.equal(await setTime(page, "The sound").count(), 1);

  // An open panel goes when the subject does.
  await setTime(page, "The sound").click();
  await panel(page).waitFor();
  await about(page).selectOption({ label: "This version as a whole" });
  assert.equal(await panel(page).count(), 0);
  await page.context().close();
});

/* ------------------------------------------------ two recordings, one page */

test("with two recordings, the panel opens under the one the comment is about", { skip }, async () => {
  const { page, errors } = await open(clientPage());

  await about(page).selectOption({ label: "The voice" });
  await setTime(page, "The voice").click();
  assert.ok(
    await panel(page).evaluate(
      (element: HTMLElement) => element.parentElement!.querySelector("audio") === document.querySelectorAll("audio")[1],
    ),
    "the panel opened under the wrong recording",
  );

  await moveTo(page, VOICE, 7.5);
  await button(page, "Use this moment").click();
  await button(page, "Done").click();
  await send(page, "F3 voice.");
  assert.deepEqual(await stored("F3 voice."), { position: 5, anchor: { kind: "time", t: 7.5 } });

  await locator(page, "On The voice · At 0:07").click();
  await pausedAt(page, VOICE, 7.5);
  assert.equal((await audio(page, SOUND)).time, 0, "the other recording was moved");
  assert.deepEqual(errors, []);
  await page.context().close();
});

/* ---------------------------------------------------------- when it fails */

test("until a recording has loaded, nothing can be chosen, and the reason is said", { skip }, async () => {
  const { page, release } = await open(clientPage(), { hold: `/files/${fixture.voiceFile}/view` });

  await about(page).selectOption({ label: "The voice" });
  await setTime(page, "The voice").click();
  assert.ok(await button(page, "Use this moment").isDisabled());
  assert.ok(await button(page, "Start here").isDisabled());
  assert.equal(
    await panel(page).getByText("Available once the recording has loaded — press play if it has not.").count(),
    1,
  );

  release();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some((b) => b.textContent === "Use this moment" && !b.disabled),
  );
  await page.context().close();
});

test("a recording that will not load leaves ordinary feedback about it untouched", { skip }, async () => {
  const { page, errors } = await open(clientPage(), { fail: `/files/${fixture.voiceFile}/view` });

  await about(page).selectOption({ label: "The voice" });
  await setTime(page, "The voice").click();
  await panel(page).getByText(/could not be loaded here/).waitFor();
  assert.ok(await button(page, "Use this moment").isDisabled());
  await button(page, "Cancel").click();

  await send(page, "F3 about the voice.");
  assert.deepEqual(await stored("F3 about the voice."), { position: 5, anchor: null });
  assert.deepEqual(errors, []);
  await page.context().close();
});

test("general and item-level feedback are exactly as they were", { skip }, async () => {
  const { page } = await open(clientPage());
  await send(page, "F3 general.");
  assert.deepEqual(await stored("F3 general."), { position: null, anchor: null });

  await about(page).selectOption({ label: "The sound" });
  await send(page, "F3 item-level.");
  assert.deepEqual(await stored("F3 item-level."), { position: 3, anchor: null });
  await page.context().close();
});

/* ---------------------------------------------------------------- phone */

test("at 390px: nothing overflows, every control is reachable and big enough, and both shapes work", { skip }, async () => {
  const { page, errors } = await open(clientPage(), { viewport: { width: 390, height: 844 }, mobile: true });
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

  await about(page).selectOption({ label: "The sound" });
  assert.ok((await overflow()) <= 0, "the composer overflows");
  await setTime(page, "The sound").click();
  await panel(page).waitFor();
  assert.ok((await overflow()) <= 0, "the panel overflows");

  for (const name of ["Use this moment", "Start here", "End here", "Done"]) {
    const box = await button(page, name).boundingBox();
    assert.ok(box && box.height >= 38 && box.x >= 0 && box.x + box.width <= 390, `${name} is cramped or off screen`);
  }
  for (const name of ["Use this moment", "Start here", "End here"]) {
    const box = await button(page, name).boundingBox();
    assert.ok(box!.height >= 44, `${name} is smaller than a thumb`);
  }

  await moveTo(page, SOUND, 1.5);
  await button(page, "Start here").tap();
  await moveTo(page, SOUND, 4.25);
  await button(page, "End here").tap();
  assert.equal(await choice(page), "0:01–0:04");
  await button(page, "Done").tap();
  assert.equal((await focused(page)).tag, "TEXTAREA");
  assert.ok((await overflow()) <= 0, "the summary overflows");

  await send(page, "F3 phone stretch.");
  assert.deepEqual(await stored("F3 phone stretch."), { position: 3, anchor: { kind: "time", t: 1.5, t2: 4.25 } });

  await about(page).selectOption({ label: "The sound" });
  await setTime(page, "The sound").tap();
  await moveTo(page, SOUND, 5);
  await button(page, "Use this moment").tap();
  await button(page, "Done").tap();
  await send(page, "F3 phone moment.");
  assert.deepEqual(await stored("F3 phone moment."), { position: 3, anchor: { kind: "time", t: 5 } });

  await moveTo(page, SOUND, 0);
  await locator(page, "On The sound · 0:01–0:04").tap();
  await pausedAt(page, SOUND, 1.5);
  assert.deepEqual(errors, []);
  await page.context().close();
});

/* -------------------------------------------------------- accessibility */

test("by keyboard alone: into the panel, a moment, back to the words — and nothing ever plays", { skip }, async () => {
  const { page } = await open(clientPage(), { reducedMotion: "reduce" });

  await about(page).selectOption({ label: "The sound" });
  await about(page).focus();
  await page.keyboard.press("Tab");
  assert.equal((await focused(page)).label, "Set precise time on The sound");
  await page.keyboard.press("Enter");

  await panel(page).waitFor();
  assert.equal((await focused(page)).role, "group", "focus did not move to the panel");
  // Reduced motion: the recording is on screen at once, not after a glide.
  assert.ok(await inViewNow(page, '[role="group"][aria-labelledby]'), "the jump animated under reduced motion");

  await moveTo(page, SOUND, 3);
  await page.keyboard.press("Tab");
  assert.equal((await focused(page)).text, "Use this moment");
  await page.keyboard.press("Space");
  assert.equal(await choice(page), "At 0:03");

  await button(page, "Done").focus();
  await page.keyboard.press("Enter");
  assert.equal((await focused(page)).tag, "TEXTAREA");

  assert.ok((await audio(page, SOUND)).paused, "capture played the recording");
  await page.context().close();
});

/* ------------------------------------------------ where it must not appear */

test("no capture on a closed version, in a reply, in a correction, or anywhere in Studio", { skip }, async () => {
  // Version 2's round was superseded: no composer at all.
  {
    const { page } = await open(`${clientPage()}/revisions/2`);
    assert.equal(await page.getByLabel("What would you like to say?").count(), 0);
    assert.equal(await page.getByRole("button", { name: /precise time/ }).count(), 0);
    await page.context().close();
  }

  // The current round: a reply and a correction have no subject and no time.
  {
    const { page } = await open(clientPage());
    await about(page).selectOption({ label: "The sound" });
    await setTime(page, "The sound").click();
    await moveTo(page, SOUND, 2.75);
    await button(page, "Use this moment").click();
    await button(page, "Done").click();
    await send(page, "F3 to correct.");

    const thread = page.getByRole("region", { name: "Feedback" });
    await thread.getByRole("button", { name: "Reply" }).first().click();
    await thread.getByRole("button", { name: "Correct" }).first().click();
    for (const field of ["Your reply", "What you meant"]) {
      const form = page.locator("form").filter({ has: page.getByLabel(field) });
      assert.equal(await form.count(), 1, `no ${field} form opened`);
      assert.equal(await form.getByRole("button", { name: /precise time/ }).count(), 0, `${field} offers a time`);
      assert.equal(await form.locator("select, input[name=anchor]").count(), 0, `${field} has a subject or an anchor`);
    }
    // The one composer that may choose a block is the new comment's.
    assert.equal(await page.getByLabel("About").count(), 1);
    await page.context().close();
  }

  for (const path of [studioPage(), `${studioPage()}/revisions/3`, `${studioPage()}/revisions/2`]) {
    const { page } = await open(path);
    assert.equal(await page.getByRole("button", { name: /precise time|Use this moment|Start here|End here/ }).count(), 0, path);
    await page.context().close();
  }
});

/* ------------------------------------------------------ leaks and history */

test("a precise comment taken back leaves only 'Comment removed', and nothing of its time anywhere", { skip }, async () => {
  const { page } = await open(clientPage());

  await about(page).selectOption({ label: "The voice" });
  await setTime(page, "The voice").click();
  await moveTo(page, VOICE, 6.125);
  await button(page, "Use this moment").click();
  await button(page, "Done").click();
  await send(page, "F3 taken back.");
  assert.equal(await locator(page, "On The voice · At 0:06").count(), 1);

  const thread = page.getByRole("region", { name: "Feedback" });
  const note = thread.locator("li").filter({ hasText: "F3 taken back." });
  await note.getByRole("button", { name: "Take back" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Take back" }).click();
  await page.getByText("F3 taken back.", { exact: true }).waitFor({ state: "detached" });
  assert.equal(await locator(page, "On The voice · At 0:06").count(), 0);

  // Nothing in the browser kept the draft either.
  assert.deepEqual(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, url: location.search })),
    { local: 0, session: 0, url: "" },
  );
  await page.context().close();

  const headers = { cookie: `__Secure-yw_client.session_token=${fixture.clientCookie}` };
  const document = await (await fetch(`${base}${clientPage()}`, { headers })).text();
  const flight = await (await fetch(`${base}${clientPage()}`, { headers: { ...headers, RSC: "1" } })).text();
  for (const [what, body] of [["document", document], ["flight", flight]] as const) {
    assert.ok(body.length > 500, `${what} is empty, so this proves nothing`);
    assert.doesNotMatch(body, /6\.125|0:06/, `${what} still carries the removed note's time`);
    assert.doesNotMatch(body, UUID, `${what} carries an identifier`);
    assert.doesNotMatch(body, /\/original\b|X-Amz-|Signature=/, `${what} carries a storage address`);
  }
});
