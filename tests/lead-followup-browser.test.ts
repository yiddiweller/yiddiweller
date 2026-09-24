import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { after, before, test } from "node:test";

import { eq, inArray } from "drizzle-orm";

import { closeDb, db } from "../lib/db/index.ts";
import { uuidv7 } from "../lib/db/id.ts";
import { createLead } from "../lib/db/leads.ts";
import { leads, session } from "../lib/db/schema.ts";
import { clearOwner, owner, seedOwner } from "./support/review-stage.ts";

/**
 * The bug as it was found: a Lead's follow-up, through Studio's own forms.
 *
 * The follow-up field is a `datetime-local`, and the server used to read it
 * with `new Date(raw)` — in the server process's zone. So a time typed in New
 * York was stored hours off, and **moved again every time anything else on the
 * lead was saved**, because the untouched field went back up with it. This
 * drives the real Edit and New lead dialogs against a server sharing this
 * database, from a browser in Los Angeles, and reads what PostgreSQL holds.
 *
 *   REVIEW_SERVER_URL=http://localhost:3101 PLAYWRIGHT_MODULE=… \
 *   CHROMIUM_PATH=… BETTER_AUTH_SECRET=… DATABASE_URL=… npm test
 */

const base = process.env.REVIEW_SERVER_URL;
const playwrightModule = process.env.PLAYWRIGHT_MODULE;
const staffSecret = process.env.BETTER_AUTH_SECRET;
const skip =
  base && playwrightModule && staffSecret
    ? false
    : "set REVIEW_SERVER_URL (a server sharing this DATABASE_URL), PLAYWRIGHT_MODULE and BETTER_AUTH_SECRET";

/* eslint-disable @typescript-eslint/no-explicit-any -- Playwright is loaded by path, untyped. */
let browser: any;
type Page = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

let cookie = "";
let leadId = "";
const created: string[] = [];

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
  cookie = encodeURIComponent(`${token}.${createHmac("sha256", staffSecret!).update(token).digest("base64")}`);

  const made = await createLead(owner, {
    title: "Follow-up lead",
    source: "manual",
    contactId: null,
    clientId: null,
    prospectName: "A prospect",
    summary: "",
    nextStep: "",
    followUpAt: null,
    ownerId: null,
  });
  assert.ok(made.ok);
  leadId = made.value;
  created.push(leadId);

  const playwright = await import(playwrightModule!);
  browser = await playwright.chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  );
});

after(async () => {
  if (browser) await browser.close();
  if (!skip) {
    const byTitle = await db().select({ id: leads.id }).from(leads).where(eq(leads.title, "A new lead with a time"));
    const ids = [...created, ...byTitle.map((row) => row.id)];
    if (ids.length > 0) await db().delete(leads).where(inArray(leads.id, ids));
    await clearOwner();
  }
  await closeDb();
});

/** Studio, from a browser whose own clock is in Los Angeles. */
async function open(path: string): Promise<Page> {
  const context = await browser.newContext({ timezoneId: "America/Los_Angeles", viewport: { width: 1280, height: 900 } });
  const host = new URL(base!).hostname;
  await context.addCookies([
    { name: "__Secure-yw_studio.session_token", value: cookie, domain: host, path: "/", secure: true, httpOnly: true, sameSite: "Lax" },
  ]);
  const page = await context.newPage();
  const response = await page.goto(`${base}${path}`);
  assert.equal(response.status(), 200, `${path} answered ${response.status()}`);
  return page;
}

async function followUp(id: string): Promise<string | null> {
  const [row] = await db().select({ at: leads.followUpAt, title: leads.title }).from(leads).where(eq(leads.id, id));
  return row?.at ? row.at.toISOString() : null;
}

/** Opens Edit, lets `fill` change what it wants, presses Save, and waits for the answer. */
async function edit(page: Page, fill: (dialog: Page) => Promise<void>): Promise<string> {
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit lead" });
  await dialog.waitFor();
  await fill(dialog);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(
    () => {
      const open = document.querySelector("dialog[open]");
      return !open || /New York|date and time/.test(open.textContent ?? "");
    },
    undefined,
    { timeout: 10_000 },
  );
  const stillOpen = await dialog.isVisible();
  const said = stillOpen ? ((await dialog.getByRole("status").allTextContents()) as string[]).join(" ").trim() : "";
  if (stillOpen) await page.keyboard.press("Escape");
  return said;
}

const field = (dialog: Page) => dialog.locator("#edit-lead-followUpAt");

test("a follow-up typed in the Edit dialog is stored as that time in New York, and shown as it", { skip }, async () => {
  const page = await open(`/studio/leads/${leadId}`);

  await edit(page, (dialog) => field(dialog).fill("2026-09-24T14:30"));
  assert.equal(await followUp(leadId), "2026-09-24T18:30:00.000Z", "not 2:30 PM in New York");

  await page.reload();
  assert.equal(await page.getByText("24 Sep 2026 · 2:30 PM", { exact: true }).count(), 1, "the lead does not say what was typed");

  // The field comes back holding exactly what was typed.
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  assert.equal(await field(page.getByRole("dialog", { name: "Edit lead" })).inputValue(), "2026-09-24T14:30");
  await page.context().close();
});

test("saving anything else on the lead leaves the follow-up exactly where it was — summer and winter", { skip }, async () => {
  for (const [typed, instant, shown] of [
    ["2026-07-15T14:00", "2026-07-15T18:00:00.000Z", "15 Jul 2026 · 2:00 PM"],
    ["2026-01-15T14:00", "2026-01-15T19:00:00.000Z", "15 Jan 2026 · 2:00 PM"],
  ] as const) {
    const page = await open(`/studio/leads/${leadId}`);
    await edit(page, (dialog) => field(dialog).fill(typed));
    assert.equal(await followUp(leadId), instant);

    // Three saves that change only the title. The old parse moved the
    // follow-up on every one of these.
    for (const title of ["Renamed once", "Renamed twice", "Follow-up lead"]) {
      await page.reload();
      await edit(page, (dialog) => dialog.locator("#edit-lead-title").fill(title));
      assert.equal(await followUp(leadId), instant, `saving "${title}" moved the follow-up`);
    }

    await page.reload();
    assert.equal(await page.getByText(shown, { exact: true }).count(), 1);
    await page.context().close();
  }
});

test("a time New York skips or lives twice is refused in the dialog, and nothing is saved", { skip }, async () => {
  const page = await open(`/studio/leads/${leadId}`);
  const before = await followUp(leadId);

  const skipped = await edit(page, (dialog) => field(dialog).fill("2026-03-08T02:30"));
  assert.equal(skipped, "That time does not happen in New York — the clocks go forward then. Choose another time.");
  assert.equal(await followUp(leadId), before);

  await page.reload();
  const twice = await edit(page, (dialog) => field(dialog).fill("2026-11-01T01:30"));
  assert.equal(twice, "That time happens twice in New York — the clocks go back then. Choose a different time.");
  assert.equal(await followUp(leadId), before);
  await page.context().close();
});

test("emptying the field clears the follow-up", { skip }, async () => {
  const page = await open(`/studio/leads/${leadId}`);
  await edit(page, (dialog) => field(dialog).fill(""));
  assert.equal(await followUp(leadId), null);
  await page.reload();
  assert.equal(await page.getByText("Not set", { exact: true }).count(), 1);
  await page.context().close();
});

test("a new lead with a follow-up is stored as that time in New York", { skip }, async () => {
  const page = await open("/studio/leads");
  await page.getByRole("button", { name: "New lead", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New lead" });
  await dialog.locator("#new-lead-title").fill("A new lead with a time");
  await dialog.locator("#new-lead-followUpAt").fill("2026-09-24T09:05");
  await dialog.getByRole("button", { name: "Add lead", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("dialog[open]"), undefined, { timeout: 10_000 });

  const [row] = await db().select({ id: leads.id, at: leads.followUpAt }).from(leads).where(eq(leads.title, "A new lead with a time"));
  assert.ok(row, "the lead was not created");
  created.push(row.id);
  assert.equal(row.at?.toISOString(), "2026-09-24T13:05:00.000Z", "not 9:05 AM in New York");
  await page.context().close();
});
