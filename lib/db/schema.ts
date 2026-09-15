import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

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

/* ==========================================================================
   STUDIO — staff identity and access. Build 002.

   Four of these tables have their shape dictated by Better Auth: `user`,
   `session`, `account` and `verification`. Their ids are `text` rather than
   `uuid` because the adapter writes string ids through a generic interface,
   and forcing a Postgres uuid column risks an insert from a plugin path we do
   not control. The VALUES are still UUIDv7 from `lib/db/id.ts`, configured
   through Better Auth's generateId hook, so the convention's actual intent
   holds: non-sequential, time-ordered, not enumerable.

   `staff_invitations` is ours and keeps a `uuid` id. Its `invited_by` column
   is `text` only because it references `user.id`.
   ========================================================================== */

/** Studio access level. Deliberately two values; see docs/architecture.md. */
export const STAFF_ROLES = ["owner", "member"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** Access is revoked by deactivation, never by deleting the person. */
export const STAFF_STATUSES = ["active", "inactive"] as const;
export type StaffStatus = (typeof STAFF_STATUSES)[number];

export const user = pgTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),

    role: text("role").notNull().default("member").$type<StaffRole>(),
    status: text("status").notNull().default("active").$type<StaffStatus>(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("user_email_idx").on(table.email),
    index("user_status_idx").on(table.status),
    check("user_role_check", sql.raw(`role IN (${quoted(STAFF_ROLES)})`)),
    check("user_status_check", sql.raw(`status IN (${quoted(STAFF_STATUSES)})`)),
  ],
);

/**
 * Server-side sessions. Address and user agent are kept here deliberately: the
 * privacy rule that keeps visitor metadata out of `inquiries` is about members
 * of the public, and this is staff security data that makes a suspicious sign-in
 * investigable.
 */
export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("session_token_idx").on(table.token),
    index("session_user_id_idx").on(table.userId),
    index("session_expires_at_idx").on(table.expiresAt),
  ],
);

/**
 * Required by Better Auth's core schema. Unused today: sign-in is by magic
 * link, so there is no password and no OAuth provider. It exists so passkeys
 * or two-factor can be added later without a schema migration at that moment.
 */
export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("account_user_id_idx").on(table.userId)],
);

/** Short-lived magic-link tokens. Better Auth writes and consumes these. */
export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("verification_identifier_idx").on(table.identifier),
    index("verification_expires_at_idx").on(table.expiresAt),
  ],
);

/**
 * The only route to a Studio account. There is no open registration: sign-in
 * is restricted to addresses that already have a user row, and a user row is
 * created only by accepting one of these.
 *
 * The token is stored as a SHA-256 digest, never in the clear, so a database
 * read cannot be turned into a working invitation link.
 */
export const staffInvitations = pgTable(
  "staff_invitations",
  {
    id: uuid("id").primaryKey(),
    email: text("email").notNull(),
    role: text("role").notNull().default("member").$type<StaffRole>(),
    tokenHash: text("token_hash").notNull(),
    invitedBy: text("invited_by").references(() => user.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("staff_invitations_token_hash_idx").on(table.tokenHash),
    index("staff_invitations_email_idx").on(table.email),
    check("staff_invitations_role_check", sql.raw(`role IN (${quoted(STAFF_ROLES)})`)),
  ],
);
