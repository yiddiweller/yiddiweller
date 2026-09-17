/**
 * Removes uploads that were started and never finished.
 *
 * Railway Storage Buckets have no lifecycle configuration, so nothing expires
 * `pending/` on our behalf. This is the whole of the cleanup, and until it is
 * scheduled abandoned uploads simply accumulate — which is a cost measured in
 * pennies and a fact worth stating rather than assuming away.
 *
 *   npm run storage:sweep                 24 hours, 100 rows
 *   SWEEP_HOURS=48 SWEEP_LIMIT=500 npm run storage:sweep
 *
 * Safe to run twice, and safe to run while it is already running: a missing
 * object is success, and the row is only deleted after its object is gone.
 *
 * Written as plain JavaScript for the same reason `migrate.mjs` is — it may
 * have to run in whatever image the platform builds, without depending on
 * Node's TypeScript stripping being present.
 */

const HOURS = Number(process.env.SWEEP_HOURS ?? 24);
const LIMIT = Number(process.env.SWEEP_LIMIT ?? 100);

async function main() {
  if (!process.env.DATABASE_URL?.trim()) {
    console.error(JSON.stringify({ level: "error", event: "sweep.no_database" }));
    process.exit(1);
  }

  const missing = [
    "BUCKET_ENDPOINT",
    "BUCKET_NAME",
    "BUCKET_REGION",
    "BUCKET_ACCESS_KEY_ID",
    "BUCKET_SECRET_ACCESS_KEY",
  ].filter((key) => !process.env[key]?.trim());

  if (missing.length > 0) {
    // Names only. A sweep that cannot reach storage must say so and stop,
    // rather than deleting rows whose objects would then be unreachable.
    console.error(
      JSON.stringify({ level: "error", event: "sweep.no_storage", missing: missing.join(",") }),
    );
    process.exit(1);
  }

  const { sweepPendingUploads } = await import("../lib/db/files.ts");
  const { closeDb } = await import("../lib/db/index.ts");

  try {
    const result = await sweepPendingUploads({ limit: LIMIT, olderThanHours: HOURS });
    // Counts only. No key, no filename, no workroom, nothing that would put a
    // client's work into a log line.
    console.log(JSON.stringify({ level: "info", event: "sweep.complete", ...result }));
  } finally {
    await closeDb();
  }
}

main().catch((cause) => {
  console.error(
    JSON.stringify({
      level: "error",
      event: "sweep.failed",
      error: cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error",
    }),
  );
  process.exit(1);
});
