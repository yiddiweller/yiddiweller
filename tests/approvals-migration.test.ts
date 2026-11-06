import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * Stage H1's migration proofs, against real PostgreSQL databases created for
 * the purpose on the `DATABASE_URL` server and dropped afterwards:
 *
 *   fresh        an empty database migrates 0000 → 0008 in one go
 *   upgrade      a database at 0007 takes 0008 when `presentation_approvals`
 *                is empty — the only state beta has ever been in
 *   refusal      0008 refuses outright when a legacy approval row exists, or
 *                an `approval.decided` Activity row does, and leaves the
 *                database exactly at 0007: the migrator runs every pending
 *                migration in one transaction, so a refusal rolls all of it back
 *
 * The 0007 database is made by migrating a copy of `drizzle/` whose journal
 * stops at 0007 — the real files, not a reconstruction.
 *
 * Needs a `DATABASE_URL` whose role may CREATE DATABASE, as the local and CI
 * test servers' roles can.
 */

const base = process.env.DATABASE_URL!;
const admin = postgres(base, { max: 1, onnotice: () => {} });
const created: string[] = [];
let upTo0007 = "";

function urlFor(name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

async function scratch(tag: string): Promise<string> {
  const name = `h1_${tag}_${process.pid}_${Date.now().toString(36)}`;
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  created.push(name);
  return name;
}

async function on<T>(name: string, work: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(urlFor(name), { max: 1, onnotice: () => {} });
  try {
    return await work(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function migrateTo(name: string, folder: string): Promise<void> {
  await on(name, (sql) => migrate(drizzle(sql), { migrationsFolder: folder }));
}

async function applied(name: string): Promise<number> {
  return on(name, async (sql) => Number((await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`)[0]!.n));
}

async function columns(name: string, table: string): Promise<string[]> {
  return on(name, async (sql) =>
    (await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table} ORDER BY 1`)
      .map((r) => r.column_name as string),
  );
}

/** What 0008 makes, checked by its consequences rather than its file. */
async function assertAt0008(name: string): Promise<void> {
  assert.equal(await applied(name), 9);
  assert.deepEqual(await columns(name, "presentation_approvals"), [
    "closed_at",
    "closed_by_revision_id",
    "closed_by_user_id",
    "content_hash",
    "created_at",
    "id",
    "presentation_revision_id",
    "requested_at",
    "requested_by",
    "status",
    "workroom_id",
  ]);
  assert.deepEqual(await columns(name, "presentation_approval_approvers"), [
    "client_identity_id",
    "created_at",
    "decided_at",
    "decision",
    "display_name",
    "id",
    "presentation_approval_id",
    "workroom_id",
  ]);
  await on(name, async (sql) => {
    const triggers = await sql`
      SELECT tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE NOT t.tgisinternal AND c.relname IN ('presentation_approvals', 'presentation_approval_approvers') ORDER BY 1`;
    assert.equal(triggers.length, 7);
    const old = await sql`SELECT 1 FROM pg_indexes WHERE indexname = 'presentation_approvals_one_live_idx'`;
    assert.equal(old.length, 0, "0004's index survived");
    const kinds = await sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'workroom_activity_kind_check'`;
    assert.match(kinds[0]!.def, /approval\.changes_requested/);
    assert.doesNotMatch(kinds[0]!.def, /approval\.decided/);
  });
}

/** Exactly where 0007 left things: 0004's dormant columns, no child table. */
async function assertAt0007(name: string): Promise<void> {
  assert.equal(await applied(name), 8);
  const approvals = await columns(name, "presentation_approvals");
  for (const old of ["decided_at", "decided_by_identity_id", "decided_by_name", "decline_reason", "content_hash_at_decision"]) {
    assert.ok(approvals.includes(old), `${old} is gone`);
  }
  assert.deepEqual(await columns(name, "presentation_approval_approvers"), []);
}

before(() => {
  // The real migration files, with a journal that stops at 0007.
  upTo0007 = mkdtempSync(join(tmpdir(), "h1-drizzle-"));
  cpSync("drizzle", upTo0007, { recursive: true });
  const journalPath = join(upTo0007, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<{ idx: number; tag: string }> };
  assert.equal(journal.entries.at(-1)!.tag, "0008_approvals");
  journal.entries = journal.entries.filter((entry) => entry.idx <= 7);
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  rmSync(join(upTo0007, "0008_approvals.sql"));
});

after(async () => {
  for (const name of created) await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.end({ timeout: 5 });
  if (upTo0007) rmSync(upTo0007, { recursive: true, force: true });
});

test("a fresh database migrates 0000 through 0008", async () => {
  const name = await scratch("fresh");
  await migrateTo(name, "drizzle");
  await assertAt0008(name);
});

test("a database at 0007 takes 0008 while presentation_approvals is empty", async () => {
  const name = await scratch("upgrade");
  await migrateTo(name, upTo0007);
  await assertAt0007(name);
  await migrateTo(name, "drizzle");
  await assertAt0008(name);
});

test("0008 refuses a legacy approval row, and leaves the database at 0007", async () => {
  const name = await scratch("legacy");
  await migrateTo(name, upTo0007);
  // A 0004-shaped row. Foreign keys are triggers, and replica mode silences
  // them, so the row needs no Workroom or Revision behind it: the guard is
  // about the table being non-empty, nothing else.
  await on(name, (sql) =>
    sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`INSERT INTO presentation_approvals (id, workroom_id, presentation_revision_id, status)
               VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'requested')`;
    }),
  );
  await assert.rejects(() => migrateTo(name, "drizzle"), (error: Error) => {
    const message = `${error.message} ${(error as Error & { cause?: Error }).cause?.message ?? ""}`;
    assert.match(message, /presentation_approvals is not empty: 0008 rewrites this table/);
    return true;
  });
  await assertAt0007(name);
  assert.equal(await on(name, async (sql) => (await sql`SELECT count(*)::int AS n FROM presentation_approvals`)[0]!.n), 1);
});

test("0008 refuses while an approval.decided Activity row exists", async () => {
  const name = await scratch("decided");
  await migrateTo(name, upTo0007);
  await on(name, (sql) =>
    sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`INSERT INTO workroom_activity (id, workroom_id, kind) VALUES (gen_random_uuid(), gen_random_uuid(), 'approval.decided')`;
    }),
  );
  await assert.rejects(() => migrateTo(name, "drizzle"), (error: Error) => {
    const message = `${error.message} ${(error as Error & { cause?: Error }).cause?.message ?? ""}`;
    assert.match(message, /workroom_activity holds approval\.decided/);
    return true;
  });
  await assertAt0007(name);
});
