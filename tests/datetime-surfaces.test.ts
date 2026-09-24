import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { and, asc, eq, isNull } from "drizzle-orm";

import { closeDb, db } from "../lib/db/index.ts";
import { replyToReviewNote } from "../lib/db/reviews.ts";
import {
  presentationReviewNotes,
  presentationReviews,
  presentationRevisions,
  workroomActivity,
} from "../lib/db/schema.ts";
import { formatMoment } from "../lib/studio-format.ts";
import { fixture, seed } from "./support/browser.ts";
import { clearOwner, staff } from "./support/review-stage.ts";

/**
 * The New York, 12-hour convention on the pages people actually read — both
 * worlds, served by a real server sharing this database.
 *
 * Every `<time>` element on each page is checked against the formatter for its
 * own `dateTime`, and the instants that matter — a version's publication, a
 * comment, a reply, an activity line — are looked up in PostgreSQL and found on
 * the page written the one way. There is no second formatter to agree with.
 */

const base = process.env.REVIEW_SERVER_URL;
const skip =
  base && process.env.BUCKET_ENDPOINT && process.env.CLIENT_AUTH_SECRET && process.env.BETTER_AUTH_SECRET
    ? false
    : "set REVIEW_SERVER_URL (a server sharing this DATABASE_URL and bucket), BUCKET_*, CLIENT_AUTH_SECRET and BETTER_AUTH_SECRET";

const HOUSE = /^\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}( · \d{1,2}:\d{2} (AM|PM))?$|^\d{1,2}:\d{2} (AM|PM)$/;

let revisionTimes = new Map<number, Date>();
let notes: { body: string; createdAt: Date; revision: number; reply: boolean }[] = [];
let activity: Date[] = [];
let requested: Date | null = null;

before(async () => {
  if (skip) return;
  await seed();

  // A studio reply, so a reply's time is on the page too.
  const [current] = await db()
    .select({ reviewId: presentationReviews.id, requestedAt: presentationReviews.requestedAt })
    .from(presentationReviews)
    .innerJoin(presentationRevisions, eq(presentationRevisions.id, presentationReviews.presentationRevisionId))
    .where(eq(presentationRevisions.revisionNumber, 3));
  assert.ok(current);
  requested = current.requestedAt;
  const replied = await replyToReviewNote(staff, { reviewId: current.reviewId, parentNumber: 1, body: "A studio reply." });
  assert.ok(replied.ok);

  revisionTimes = new Map(
    (await db().select({ n: presentationRevisions.revisionNumber, at: presentationRevisions.publishedAt }).from(presentationRevisions)).map(
      (row) => [row.n, row.at],
    ),
  );
  notes = (
    await db()
      .select({
        body: presentationReviewNotes.body,
        createdAt: presentationReviewNotes.createdAt,
        revision: presentationRevisions.revisionNumber,
        parent: presentationReviewNotes.parentNoteId,
        removed: presentationReviewNotes.removedAt,
      })
      .from(presentationReviewNotes)
      .innerJoin(presentationRevisions, eq(presentationRevisions.id, presentationReviewNotes.presentationRevisionId))
      .where(isNull(presentationReviewNotes.removedAt))
      .orderBy(asc(presentationReviewNotes.createdAt))
  ).map((row) => ({ body: row.body, createdAt: row.createdAt, revision: row.revision, reply: row.parent !== null }));
  activity = (
    await db()
      .select({ at: workroomActivity.occurredAt })
      .from(workroomActivity)
      .where(and(eq(workroomActivity.workroomId, fixture.workroomId)))
  ).map((row) => row.at);
});

after(async () => {
  if (!skip) await clearOwner();
  await closeDb();
});

async function page(path: string, world: "client" | "studio"): Promise<string> {
  const cookie =
    world === "client"
      ? `__Secure-yw_client.session_token=${fixture.clientCookie}`
      : `__Secure-yw_studio.session_token=${fixture.staffCookie}`;
  const response = await fetch(`${base}${path}`, { headers: { cookie }, redirect: "manual" });
  assert.equal(response.status, 200, `${path} answered ${response.status}`);
  return response.text();
}

/** Every `<time>` on the page: its instant and what it says. */
function times(html: string): { iso: string; text: string }[] {
  return [...html.matchAll(/<time[^>]*?datetime="([^"]+)"[^>]*>([^<]*)<\/time>/gi)].map((match) => ({
    iso: match[1]!,
    text: match[2]!,
  }));
}

/** Every time on the page is the house style, for its own instant. */
function allInHouseStyle(html: string, path: string): string[] {
  const found = times(html);
  assert.ok(found.length > 0, `${path} shows no times, so this proves nothing`);
  for (const { iso, text } of found) {
    assert.match(text, HOUSE, `${path}: "${text}" is not the house style`);
    assert.ok(
      [formatMoment(iso, "exact"), formatMoment(iso, "day"), formatMoment(iso, "time")].includes(text),
      `${path}: "${text}" is not ${iso} in New York`,
    );
  }
  assert.doesNotMatch(html, /\d Sept\b/, `${path} still says Sept`);
  return found.map((entry) => entry.text);
}

const exact = (value: Date) => formatMoment(value.toISOString(), "exact");

test("the client's presentation: its version, earlier versions, comments and a reply", { skip }, async () => {
  const path = `/workrooms/${fixture.room}/presentations/${fixture.presentation}`;
  const shown = allInHouseStyle(await page(path, "client"), path);

  assert.ok(shown.includes(exact(revisionTimes.get(3)!)), "Version 3's publication");
  assert.ok(shown.includes(exact(revisionTimes.get(1)!)), "an earlier version in the list");
  for (const note of notes.filter((entry) => entry.revision === 3)) {
    assert.ok(shown.includes(exact(note.createdAt)), `${note.reply ? "reply" : "comment"} "${note.body}"`);
  }
  assert.ok(notes.some((entry) => entry.revision === 3 && entry.reply), "the reply was not seeded");
});

test("the client's historical Version 2, and its closed round", { skip }, async () => {
  const path = `/workrooms/${fixture.room}/presentations/${fixture.presentation}/revisions/2`;
  const shown = allInHouseStyle(await page(path, "client"), path);
  assert.ok(shown.includes(exact(revisionTimes.get(2)!)));
  for (const note of notes.filter((entry) => entry.revision === 2)) {
    assert.ok(shown.includes(exact(note.createdAt)), `comment "${note.body}"`);
  }
});

test("the client's Workroom: activity and presentations", { skip }, async () => {
  for (const path of [`/workrooms/${fixture.room}`, `/workrooms/${fixture.room}/presentations`]) {
    const shown = allInHouseStyle(await page(path, "client"), path);
    if (path === `/workrooms/${fixture.room}`) {
      assert.ok(activity.some((at) => shown.includes(exact(at))), "no activity line in the house style");
    }
  }
});

test("Studio: the presentation, its versions, a frozen version, the Workroom and its activity", { skip }, async () => {
  const studio = `/studio/workrooms/${fixture.workroomId}`;
  const draft = allInHouseStyle(await page(`${studio}/presentations/${fixture.presentationId}`, "studio"), "draft page");
  for (const n of [1, 2, 3]) assert.ok(draft.includes(exact(revisionTimes.get(n)!)), `Version ${n} in the list`);
  // The Review's *Open since* line is a day.
  assert.ok(draft.includes(formatMoment(requested!.toISOString(), "day")), "the round's requested day");
  for (const note of notes.filter((entry) => entry.revision === 3)) {
    assert.ok(draft.includes(exact(note.createdAt)), `the same comment, the same way, in Studio: "${note.body}"`);
  }

  const frozen = allInHouseStyle(await page(`${studio}/presentations/${fixture.presentationId}/revisions/2`, "studio"), "Version 2");
  assert.ok(frozen.includes(exact(revisionTimes.get(2)!)));

  for (const path of [studio, `${studio}/presentations`, `${studio}/files`, "/studio/workrooms"]) {
    allInHouseStyle(await page(path, "studio"), path);
  }
});
