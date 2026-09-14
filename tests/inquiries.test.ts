import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { closeDb, db } from "../lib/db/index.ts";
import { dedupeKey, normalizeInquiry, recordInquiry } from "../lib/db/inquiries.ts";
import { inquiries } from "../lib/db/schema.ts";
import { describeError } from "../lib/log.ts";

/** Drizzle wraps driver errors, so the constraint name lives down the chain. */
function causeChain(error: unknown): string {
  const seen: string[] = [];
  let current: unknown = error;
  for (let i = 0; current instanceof Error && i < 5; i++) {
    const e = current as Error & { constraint_name?: string; cause?: unknown };
    seen.push(e.message, e.constraint_name ?? "");
    current = e.cause;
  }
  return seen.join(" | ");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

before(async () => {
  await db().delete(inquiries);
});

after(async () => {
  await db().delete(inquiries);
  await closeDb();
});

test("normalizes before storing", () => {
  assert.deepEqual(
    normalizeInquiry({ name: "  Ada  ", email: "  Ada@Example.COM ", message: " Hi \n" }),
    { name: "Ada", email: "ada@example.com", message: "Hi", source: "website_contact" },
  );
});

test("stores an inquiry with the right defaults, id and timestamps", async () => {
  const before = Date.now();
  const { id, duplicate } = await recordInquiry({
    name: "  Ada Lovelace ",
    email: " Ada@Example.com ",
    message: "  Please quote for an identity.  ",
  });

  assert.equal(duplicate, false);
  assert.match(id, UUID);

  const [row] = await db().select().from(inquiries);

  assert.equal(row.name, "Ada Lovelace");
  assert.equal(row.email, "ada@example.com", "address is lowercased");
  assert.equal(row.message, "Please quote for an identity.");
  assert.equal(row.status, "new");
  assert.equal(row.source, "website_contact");
  assert.ok(row.createdAt.getTime() >= before - 1000);
  assert.equal(row.createdAt.getTime(), row.updatedAt.getTime());
  assert.notEqual(row.dedupeKey, row.message, "the key is a digest, not the text");
});

test("collapses an identical resubmission into the same row", async () => {
  await db().delete(inquiries);
  const input = { name: "Bo", email: "bo@example.com", message: "Twice." };

  const first = await recordInquiry(input);
  const second = await recordInquiry(input);

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.id, first.id, "the caller is told which row it already is");

  const rows = await db().select().from(inquiries);
  assert.equal(rows.length, 1, "no second row was written");
});

test("stores a genuinely different message separately", async () => {
  await db().delete(inquiries);
  await recordInquiry({ name: "Bo", email: "bo@example.com", message: "One." });
  await recordInquiry({ name: "Bo", email: "bo@example.com", message: "Two." });

  const rows = await db().select().from(inquiries);
  assert.equal(rows.length, 2);
});

test("stores the same message again once the window has passed", async () => {
  await db().delete(inquiries);
  const input = { name: "Bo", email: "bo@example.com", message: "Later." };
  const now = Date.now();

  const first = await recordInquiry(input, now);
  const later = await recordInquiry(input, now + 11 * 60 * 1000);

  assert.equal(first.duplicate, false);
  assert.equal(later.duplicate, false);
  assert.equal((await db().select().from(inquiries)).length, 2);
});

test("the dedupe key ignores address casing but not the message", () => {
  const now = Date.now();
  assert.equal(dedupeKey("A@b.com", "hi", now), dedupeKey("a@B.COM", "hi", now));
  assert.notEqual(dedupeKey("a@b.com", "hi", now), dedupeKey("a@b.com", "hi!", now));
});

test("the database refuses an over-length row even if the app does not", async () => {
  await db().delete(inquiries);
  const rejection = await recordInquiry({
    name: "x".repeat(101),
    email: "a@b.com",
    message: "hi",
  }).then(
    () => null,
    (error: unknown) => error,
  );

  assert.ok(rejection, "the CHECK constraint is the backstop for an application bug");
  assert.match(causeChain(rejection), /inquiries_name_length_check/);
  assert.equal((await db().select().from(inquiries)).length, 0, "nothing was written");
});

test("a database error is never summarised with the visitor's own words", async () => {
  await db().delete(inquiries);
  const secret = "commercially-sensitive-brief-text";
  const rejection = await recordInquiry({
    name: "y".repeat(101),
    email: "private@example.com",
    message: secret,
  }).then(
    () => null,
    (error: unknown) => error,
  );

  const summary = describeError(rejection);

  assert.doesNotMatch(summary, new RegExp(secret), "message body must not reach the logs");
  assert.doesNotMatch(summary, /private@example\.com/, "address must not reach the logs");
  assert.doesNotMatch(summary, /yyyy/, "name must not reach the logs");
  assert.match(summary, /inquiries_name_length_check/, "but the useful cause is still reported");
});

test("the database refuses a status outside the allowed set", async () => {
  await assert.rejects(
    async () => {
      await db()
        .insert(inquiries)
        .values({
          id: "00000000-0000-7000-8000-000000000001",
          name: "x", email: "a@b.com", message: "hi",
          dedupeKey: "manual-check", status: "converted" as "new",
        });
    },
    (error: unknown) => /inquiries_status_check/.test(causeChain(error)),
  );
});
