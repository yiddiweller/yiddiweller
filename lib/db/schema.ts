import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
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

/* ==========================================================================
   BUSINESS CORE — clients, contacts, leads, projects. Build 003.

   The model and the reasoning are in `docs/business-core.md`. Every rule that
   file marks as an invariant is enforced below, in the database, rather than
   by the code that happens to call it.

   Ownership columns (`owner_id`, `created_by`, `updated_by`) are `text`
   because they reference `user.id`, which Better Auth defines as text. They
   are ON DELETE SET NULL: a record's history must survive a person leaving.
   ========================================================================== */

/** Organization or individual. The account, never the person. */
export const CLIENT_ACCOUNT_TYPES = ["organization", "individual"] as const;
export type ClientAccountType = (typeof CLIENT_ACCOUNT_TYPES)[number];

/** The state of the relationship, not of the record. Archival is separate. */
export const CLIENT_STATUSES = ["active", "inactive"] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

/** The pipeline. Centralized here so no page invents a sixth stage. */
export const LEAD_STAGES = ["new", "discovery", "proposal", "won", "lost"] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

/** Stages a lead cannot be worked out of without a conversion or a reason. */
export const LEAD_CLOSED_STAGES = ["won", "lost"] as const;

/** Where an opportunity came from. Deliberately five, not a taxonomy. */
export const LEAD_SOURCES = ["inquiry", "referral", "existing_client", "manual", "other"] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const PROJECT_STATUSES = [
  "planned",
  "active",
  "on_hold",
  "completed",
  "cancelled",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** A project that is neither finished nor put away still counts as live work. */
export const PROJECT_LIVE_STATUSES = ["planned", "active", "on_hold"] as const;

/** Every kind of thing the audit log can describe. */
export const AUDIT_ENTITY_TYPES = [
  "client",
  "contact",
  "lead",
  "project",
  "client_contact",
  "project_contact",
  "inquiry",
  "staff",
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

/* ------------------------------------------------------------------ clients */

export const clients = pgTable(
  "clients",
  {
    id: uuid("id").primaryKey(),

    accountType: text("account_type").notNull().$type<ClientAccountType>(),
    name: text("name").notNull(),

    /** As typed. `domain` is the normalized form, and only for duplicate warnings. */
    website: text("website"),
    domain: text("domain"),

    status: text("status").notNull().default("active").$type<ClientStatus>(),
    notes: text("notes").notNull().default(""),

    /**
     * Optimistic concurrency. Incremented by the `bump_version` trigger on
     * every update, and compared by every write, so a save that was composed
     * against an older version of the row is refused rather than silently
     * overwriting somebody else's edit.
     *
     * An integer rather than `updated_at`: Postgres keeps microseconds and a
     * JavaScript Date does not, so a timestamp comparison never matches.
     */
    version: integer("version").notNull().default(1),

    /** Null while live. Archival is reversible and never cascades. */
    archivedAt: timestamp("archived_at", { withTimezone: true }),

    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("clients_name_idx").on(table.name),
    index("clients_domain_idx").on(table.domain),
    index("clients_status_idx").on(table.status),
    index("clients_archived_at_idx").on(table.archivedAt),
    index("clients_updated_at_idx").on(table.updatedAt.desc()),

    check(
      "clients_account_type_check",
      sql.raw(`account_type IN (${quoted(CLIENT_ACCOUNT_TYPES)})`),
    ),
    check("clients_status_check", sql.raw(`status IN (${quoted(CLIENT_STATUSES)})`)),
    check("clients_name_length_check", sql.raw("char_length(name) BETWEEN 1 AND 160")),
    check("clients_notes_length_check", sql.raw("char_length(notes) <= 4000")),
  ],
);

/* ----------------------------------------------------------------- contacts */

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey(),

    name: text("name").notNull(),
    /** As typed. `emailNormalized` is what duplicate detection compares. */
    email: text("email"),
    emailNormalized: text("email_normalized"),
    phone: text("phone"),
    title: text("title"),
    notes: text("notes").notNull().default(""),

    /** Optimistic concurrency; see the note on `clients.version`. */
    version: integer("version").notNull().default(1),

    archivedAt: timestamp("archived_at", { withTimezone: true }),

    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("contacts_name_idx").on(table.name),
    // Not unique, deliberately: shared addresses and imports are real, and a
    // constraint would turn each into a dead end. See docs/business-core.md.
    index("contacts_email_normalized_idx").on(table.emailNormalized),
    index("contacts_archived_at_idx").on(table.archivedAt),
    index("contacts_updated_at_idx").on(table.updatedAt.desc()),

    check("contacts_name_length_check", sql.raw("char_length(name) BETWEEN 1 AND 160")),
    check("contacts_email_length_check", sql.raw("email IS NULL OR char_length(email) <= 254")),
    check("contacts_notes_length_check", sql.raw("char_length(notes) <= 4000")),
  ],
);

/* --------------------------------------------------------- client ↔ contact */

export const clientContacts = pgTable(
  "client_contacts",
  {
    id: uuid("id").primaryKey(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),

    role: text("role"),
    isPrimary: boolean("is_primary").notNull().default(false),

    /** Optimistic concurrency; see the note on `clients.version`. */
    version: integer("version").notNull().default(1),

    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The same person cannot be attached to the same client twice.
    uniqueIndex("client_contacts_pair_idx").on(table.clientId, table.contactId),
    index("client_contacts_contact_id_idx").on(table.contactId),
    check("client_contacts_role_length_check", sql.raw("role IS NULL OR char_length(role) <= 120")),
  ],
);

/* -------------------------------------------------------------------- leads */

export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey(),

    title: text("title").notNull(),
    stage: text("stage").notNull().default("new").$type<LeadStage>(),
    source: text("source").notNull().default("manual").$type<LeadSource>(),

    /** The intake record this came from. At most one lead per inquiry. */
    inquiryId: uuid("inquiry_id").references(() => inquiries.id, { onDelete: "set null" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    /** Set from the start for repeat work, or by conversion for a new prospect. */
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    /** An organization's name before it is a client. */
    prospectName: text("prospect_name"),

    summary: text("summary").notNull().default(""),
    nextStep: text("next_step").notNull().default(""),
    followUpAt: timestamp("follow_up_at", { withTimezone: true }),

    /** Operational ownership. Never an access control. */
    ownerId: text("owner_id").references(() => user.id, { onDelete: "set null" }),

    lostReason: text("lost_reason"),
    wonAt: timestamp("won_at", { withTimezone: true }),
    lostAt: timestamp("lost_at", { withTimezone: true }),

    /** What the conversion produced, and the guard that makes it happen once. */
    projectId: uuid("project_id"),
    convertedAt: timestamp("converted_at", { withTimezone: true }),

    /** Optimistic concurrency; see the note on `clients.version`. */
    version: integer("version").notNull().default(1),

    archivedAt: timestamp("archived_at", { withTimezone: true }),

    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("leads_stage_idx").on(table.stage),
    index("leads_owner_id_idx").on(table.ownerId),
    index("leads_client_id_idx").on(table.clientId),
    index("leads_contact_id_idx").on(table.contactId),
    index("leads_follow_up_at_idx").on(table.followUpAt),
    index("leads_archived_at_idx").on(table.archivedAt),
    index("leads_updated_at_idx").on(table.updatedAt.desc()),

    check("leads_stage_check", sql.raw(`stage IN (${quoted(LEAD_STAGES)})`)),
    check("leads_source_check", sql.raw(`source IN (${quoted(LEAD_SOURCES)})`)),
    check("leads_title_length_check", sql.raw("char_length(title) BETWEEN 1 AND 160")),
    check("leads_summary_length_check", sql.raw("char_length(summary) <= 4000")),
    check("leads_next_step_length_check", sql.raw("char_length(next_step) <= 500")),
    check(
      "leads_lost_reason_length_check",
      sql.raw("lost_reason IS NULL OR char_length(lost_reason) <= 500"),
    ),
  ],
);

/* ----------------------------------------------------------------- projects */

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey(),

    /** Required: work is always for somebody. */
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "restrict" }),
    /** The opportunity it came from, when there was one. */
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),

    name: text("name").notNull(),
    status: text("status").notNull().default("planned").$type<ProjectStatus>(),
    description: text("description").notNull().default(""),
    notes: text("notes").notNull().default(""),

    ownerId: text("owner_id").references(() => user.id, { onDelete: "set null" }),

    /** Dates, not timestamps: a project starts on a day, not at an instant. */
    startsOn: date("starts_on"),
    targetOn: date("target_on"),

    /** Optimistic concurrency; see the note on `clients.version`. */
    version: integer("version").notNull().default(1),

    archivedAt: timestamp("archived_at", { withTimezone: true }),

    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("projects_client_id_idx").on(table.clientId),
    index("projects_status_idx").on(table.status),
    index("projects_owner_id_idx").on(table.ownerId),
    index("projects_lead_id_idx").on(table.leadId),
    index("projects_archived_at_idx").on(table.archivedAt),
    index("projects_updated_at_idx").on(table.updatedAt.desc()),

    check("projects_status_check", sql.raw(`status IN (${quoted(PROJECT_STATUSES)})`)),
    check("projects_name_length_check", sql.raw("char_length(name) BETWEEN 1 AND 160")),
    check("projects_description_length_check", sql.raw("char_length(description) <= 4000")),
    check("projects_notes_length_check", sql.raw("char_length(notes) <= 4000")),
  ],
);

/* -------------------------------------------------------- project ↔ contact */

export const projectContacts = pgTable(
  "project_contacts",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),

    role: text("role"),
    isPrimary: boolean("is_primary").notNull().default(false),

    /** Optimistic concurrency; see the note on `clients.version`. */
    version: integer("version").notNull().default(1),

    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("project_contacts_pair_idx").on(table.projectId, table.contactId),
    index("project_contacts_contact_id_idx").on(table.contactId),
    check(
      "project_contacts_role_length_check",
      sql.raw("role IS NULL OR char_length(role) <= 120"),
    ),
  ],
);

/* ------------------------------------------------------------ audit events */

/**
 * Append-only. Who changed what, when — never what the thing said.
 *
 * No foreign key to the entity it describes: audit outlives what it records,
 * and a key would turn a removal into either an integrity error or, worse, a
 * cascade that erases the history. `entity_id` is `text` because business
 * records use UUIDs and Better Auth's staff ids are strings.
 *
 * The migration adds a trigger that refuses UPDATE and DELETE outright. The
 * policy, and what may never be written into `metadata`, is in docs/audit.md.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),

    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    /** Snapshot, so the log still reads after someone leaves. */
    actorName: text("actor_name"),

    action: text("action").notNull(),
    entityType: text("entity_type").notNull().$type<AuditEntityType>(),
    entityId: text("entity_id"),
    /** A safe label — a name or a title. Never a note, a message or a secret. */
    entityLabel: text("entity_label"),

    metadata: jsonb("metadata").notNull().default({}),
  },
  (table) => [
    index("audit_events_occurred_at_idx").on(table.occurredAt.desc()),
    index("audit_events_entity_idx").on(table.entityType, table.entityId),
    index("audit_events_actor_id_idx").on(table.actorId),
    index("audit_events_action_idx").on(table.action),

    check("audit_events_entity_type_check", sql.raw(`entity_type IN (${quoted(AUDIT_ENTITY_TYPES)})`)),
    check("audit_events_action_length_check", sql.raw("char_length(action) BETWEEN 3 AND 60")),
    check(
      "audit_events_entity_label_length_check",
      sql.raw("entity_label IS NULL OR char_length(entity_label) <= 200"),
    ),
  ],
);
