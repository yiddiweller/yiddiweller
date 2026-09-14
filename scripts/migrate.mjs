import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * Applies every pending migration, then exits.
 *
 * Runs from the Railway start command ahead of `next start`, so a deploy can
 * never serve code that expects a column the database does not have yet.
 *
 * Two deliberate behaviours:
 *
 *   No DATABASE_URL  -> warn and exit 0. The public site does not need the
 *                       database to render, and a service that has not been
 *                       given one yet must still boot rather than take the
 *                       site down.
 *   Migration fails  -> exit 1. That is a real fault and the deploy should
 *                       stop rather than start against a half-migrated schema.
 *
 * A session-level advisory lock makes concurrent deploys safe: the second
 * process waits, then finds nothing pending.
 *
 * Written as plain JavaScript on purpose: this runs before the server starts on
 * every deploy, so it must not depend on Node's TypeScript stripping being
 * present in whatever image the platform builds.
 */
const LOCK_KEY = 4_517_301; // arbitrary, fixed for this repository

async function main() {
  const url = process.env.DATABASE_URL?.trim();

  if (!url) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "migrate.skipped",
        reason: "DATABASE_URL is not set",
      }),
    );
    return;
  }

  const sql = postgres(url, { max: 1, onnotice: () => {} });

  try {
    await sql`SELECT pg_advisory_lock(${LOCK_KEY})`;
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
    console.log(JSON.stringify({ level: "info", event: "migrate.complete" }));
  } finally {
    await sql`SELECT pg_advisory_unlock(${LOCK_KEY})`.catch(() => {});
    await sql.end({ timeout: 5 });
  }
}

main().catch((cause) => {
  console.error(
    JSON.stringify({
      level: "error",
      event: "migrate.failed",
      error: cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error",
    }),
  );
  process.exit(1);
});
