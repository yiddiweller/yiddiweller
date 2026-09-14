import type { Config } from "drizzle-kit";

/**
 * drizzle-kit reads this only to generate and inspect migrations, which is a
 * developer task. It is never loaded by the running application — the app
 * connects through `lib/db/index.ts`.
 */
export default {
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
} satisfies Config;
