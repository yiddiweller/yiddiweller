import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Schema conventions for every table added from Phase 1 onward. The reasoning
 * behind each is in `docs/database.md`; this file is where they are enforced.
 *
 *   Identity    UUIDv7 primary key named `id`, generated in the application.
 *   Time        `timestamptz` only, stored UTC, converted for display.
 *   Naming      snake_case columns, plural table names.
 *   Enums       `text` plus a CHECK constraint, not a Postgres ENUM type.
 *   Deletion    Hard delete unless a table documents a `deleted_at` policy.
 *   Money       Integer minor units plus a currency column. Never a float.
 *   Provider    External ids live in their own nullable `<provider>_*` column.
 */

/** Handling state of a single inquiry. Lead pipeline stages arrive in Phase 3. */
export const INQUIRY_STATUSES = ["new", "archived"] as const;
export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];

/** Where an inquiry entered the system. Adding a value requires a migration. */
export const INQUIRY_SOURCES = ["website_contact"] as const;
export type InquirySource = (typeof INQUIRY_SOURCES)[number];

function quoted(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

/**
 * The first persisted business record: a message submitted through the public
 * contact form. Before this table existed, an inquiry's only copy was an email
 * in one inbox, so a delivery failure lost it permanently.
 *
 * Deliberately not a CRM row. It carries no IP address, user agent, referrer
 * or any other visitor metadata, because the contact form does not need them
 * and Phase 1 is not permission to begin profiling visitors.
 */
export const inquiries = pgTable(
  "inquiries",
  {
    id: uuid("id").primaryKey(),

    name: text("name").notNull(),
    email: text("email").notNull(),
    message: text("message").notNull(),

    source: text("source").notNull().default("website_contact").$type<InquirySource>(),
    status: text("status").notNull().default("new").$type<InquiryStatus>(),

    /**
     * Collapses an accidental resubmission of the same message into one row.
     * A digest of the submitter, the message and a coarse time bucket, so the
     * uniqueness is enforced by the database rather than by a read-then-write
     * that two concurrent requests could both pass.
     */
    dedupeKey: text("dedupe_key").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("inquiries_dedupe_key_idx").on(table.dedupeKey),
    index("inquiries_created_at_idx").on(table.createdAt.desc()),
    index("inquiries_status_idx").on(table.status),
    index("inquiries_email_idx").on(table.email),

    check("inquiries_status_check", sql.raw(`status IN (${quoted(INQUIRY_STATUSES)})`)),
    check("inquiries_source_check", sql.raw(`source IN (${quoted(INQUIRY_SOURCES)})`)),

    // Defence in depth: the application enforces the same limits, but a bug
    // there must not be able to write an unbounded row.
    check("inquiries_name_length_check", sql.raw("char_length(name) BETWEEN 1 AND 100")),
    check("inquiries_email_length_check", sql.raw("char_length(email) BETWEEN 3 AND 254")),
    check("inquiries_message_length_check", sql.raw("char_length(message) BETWEEN 1 AND 4000")),
  ],
);
