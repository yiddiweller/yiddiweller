import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { databaseUrl } from "../env.ts";

import * as schema from "./schema.ts";

/**
 * The single database entry point. Server-only.
 *
 * The connection is created on first use rather than at module load, for the
 * same reason the env accessors are functions: `next build` runs without
 * DATABASE_URL, and a module-level connection would fail the build instead of
 * the request. It also means a page that never touches the database never
 * opens a socket, which keeps the static routes static.
 */

let pool: ReturnType<typeof postgres> | null = null;
let instance: ReturnType<typeof drizzle<typeof schema>> | null = null;

function assertServer(): void {
  if (typeof window !== "undefined") {
    throw new Error("lib/db may only be used on the server.");
  }
}

export function db() {
  assertServer();

  if (!instance) {
    pool = postgres(databaseUrl(), {
      // Railway runs one long-lived Node process per service rather than a
      // serverless function, so a small persistent pool is correct here.
      max: 5,
      idle_timeout: 20,
      connect_timeout: 10,
      onnotice: () => {},
    });
    instance = drizzle(pool, { schema });
  }

  return instance;
}

/** Closes the pool. For tests and graceful shutdown only. */
export async function closeDb(): Promise<void> {
  if (pool) await pool.end({ timeout: 5 });
  pool = null;
  instance = null;
}

/** Re-exported for the Better Auth Drizzle adapter, which needs the whole map. */
export { schema };
