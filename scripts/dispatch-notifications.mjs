/**
 * Delivers the Stage G notifications that are due — one bounded pass of the
 * same dispatcher the application drains with after a Review action commits.
 *
 *   npm run notifications:dispatch
 *
 * This is the reliability half of Stage G: an action's transaction writes the
 * row, and this finds it, however the process that wrote it ended. Safe to run
 * repeatedly and concurrently — rows are claimed with `FOR UPDATE SKIP LOCKED`,
 * so two runs never take the same one. At most 25 rows per run; anything more
 * waits for the next.
 *
 * **Not scheduled yet.** G3 installs and verifies the schedule; until then this
 * runs only when somebody runs it.
 *
 * Exits 0 whenever the pass completed, including when nothing was due and
 * when individual rows were retried, failed or suppressed — those are settled
 * outcomes, recorded on their rows. Exits 1 only when the pass itself could
 * not run: no database configured, or the database unreachable.
 *
 * Counts only, in the log. No address, no title, no link, no provider words.
 */

async function main() {
  if (!process.env.DATABASE_URL?.trim()) {
    console.error(JSON.stringify({ level: "error", event: "notification.dispatch_no_database" }));
    process.exit(1);
  }

  const { dispatchDue, SCHEDULED_BATCH } = await import("../lib/notifications/dispatch.ts");
  const { logNotification } = await import("../lib/notifications/log.ts");
  const { closeDb } = await import("../lib/db/index.ts");

  try {
    const summary = await dispatchDue({ limit: SCHEDULED_BATCH });
    logNotification("notification.dispatched", summary);
  } finally {
    await closeDb();
  }
}

main().catch(() => {
  // The class of failure, never its message: a failed query's message carries
  // its parameters.
  console.error(JSON.stringify({ level: "error", event: "notification.dispatch_failed" }));
  process.exit(1);
});
