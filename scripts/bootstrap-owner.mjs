import { randomBytes } from "node:crypto";

import postgres from "postgres";

/**
 * Creates the first Studio Owner. Run once per environment, by hand.
 *
 * Deliberately not an HTTP endpoint and deliberately not "the first person to
 * sign in becomes owner", because both of those are a race anyone who reaches
 * the deployment first can win. This needs database credentials and a shell,
 * which only we have.
 *
 * It refuses if an active Owner already exists, so running it twice cannot
 * quietly mint a second one. The address comes from the environment, never
 * from source, so no personal address is ever committed.
 *
 *   DATABASE_URL=...  STUDIO_OWNER_EMAIL=...  STUDIO_OWNER_NAME="..." \
 *     node scripts/bootstrap-owner.mjs
 *
 * Plain JavaScript for the same reason as the migration runner: it must run in
 * whatever image the platform built, without depending on type stripping.
 */

function uuidv7(now = Date.now()) {
  const bytes = randomBytes(16);
  const ms = Math.floor(now);
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function fail(message) {
  console.error(JSON.stringify({ level: "error", event: "bootstrap.failed", reason: message }));
  process.exit(1);
}

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  const email = process.env.STUDIO_OWNER_EMAIL?.trim().toLowerCase();
  const name = process.env.STUDIO_OWNER_NAME?.trim();

  if (!url) fail("DATABASE_URL is not set");
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    fail("STUDIO_OWNER_EMAIL is missing or not an email address");
  }

  const sql = postgres(url, { max: 1, onnotice: () => {} });

  try {
    const [{ count }] = await sql`
      SELECT count(*)::int AS count FROM "user" WHERE role = 'owner' AND status = 'active'
    `;

    if (count > 0) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "bootstrap.refused",
          reason: "an active owner already exists",
          owners: count,
        }),
      );
      process.exit(1);
    }

    const existing = await sql`SELECT id, role FROM "user" WHERE email = ${email} LIMIT 1`;

    if (existing.length > 0) {
      // Already a member: promote rather than create a duplicate identity.
      await sql`
        UPDATE "user" SET role = 'owner', status = 'active' WHERE email = ${email}
      `;
      console.log(JSON.stringify({ level: "info", event: "bootstrap.promoted" }));
    } else {
      await sql`
        INSERT INTO "user" (id, name, email, email_verified, role, status)
        VALUES (${uuidv7()}, ${name || email.split("@")[0]}, ${email}, true, 'owner', 'active')
      `;
      console.log(JSON.stringify({ level: "info", event: "bootstrap.created" }));
    }

    // The address is not logged. Sign in with a magic link to confirm it worked.
    console.log(
      JSON.stringify({ level: "info", event: "bootstrap.complete", next: "sign in at /studio/login" }),
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((cause) => {
  fail(cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error");
});
