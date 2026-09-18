import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
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
  // Build 004.
  "workroom",
  "workroom_member",
  "workroom_invitation",
  "client_identity",
  // Build 005.
  "workroom_file",
  "presentation",
  "presentation_revision",
  "presentation_review",
  "presentation_approval",
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

/**
 * Who caused an audited event. Recorded in docs/architecture.md before either
 * of the non-staff kinds existed, so that the day one did, the model was
 * already decided.
 *
 * `team_user` points at `user`, `client_user` at `client_identities`. They are
 * separate columns because they are separate tables — a client is never a row
 * in the staff table, and a schema that pretended otherwise would be the first
 * place that rule broke.
 */
export const AUDIT_ACTOR_TYPES = ["team_user", "client_user", "anonymous_session"] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

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

    /**
     * Which identity system the actor belongs to. Defaulting to `team_user`
     * is what makes this additive: every event written before Build 004 was a
     * staff action, so the backfill is correct rather than a guess.
     */
    actorType: text("actor_type").notNull().default("team_user").$type<AuditActorType>(),

    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    /** Set instead of `actor_id` when a client caused the event. */
    clientActorId: text("client_actor_id").references(() => clientIdentity.id, {
      onDelete: "set null",
    }),
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

    index("audit_events_client_actor_id_idx").on(table.clientActorId),

    check("audit_events_entity_type_check", sql.raw(`entity_type IN (${quoted(AUDIT_ENTITY_TYPES)})`)),
    check("audit_events_actor_type_check", sql.raw(`actor_type IN (${quoted(AUDIT_ACTOR_TYPES)})`)),
    // A staff event may have no actor id at all — the column is SET NULL when
    // somebody is removed — but it may never carry a client's.
    check(
      "audit_events_actor_shape_check",
      sql.raw(
        "(actor_type = 'team_user' AND client_actor_id IS NULL)" +
          " OR (actor_type = 'client_user' AND actor_id IS NULL)" +
          " OR (actor_type = 'anonymous_session' AND actor_id IS NULL AND client_actor_id IS NULL)",
      ),
    ),
    check("audit_events_action_length_check", sql.raw("char_length(action) BETWEEN 3 AND 60")),
    check(
      "audit_events_entity_label_length_check",
      sql.raw("entity_label IS NULL OR char_length(entity_label) <= 200"),
    ),
  ],
);

/* ==========================================================================
   BUILD 004 — CLIENT WORKROOMS

   Two things live here and they are deliberately not one thing:

     the client's identity   — how somebody outside the company signs in
     the Workroom            — what they are allowed to see once they have

   A client is never a row in `user`. The tables below are the client half of
   Better Auth, renamed through `modelName` so the two instances share a
   library and nothing else. The reasoning is in docs/client-auth.md; the
   Workroom model is in docs/workrooms.md.
   ========================================================================== */

/** A client identity can sign in, or it cannot. Never deleted to revoke. */
export const CLIENT_IDENTITY_STATUSES = ["active", "inactive"] as const;
export type ClientIdentityStatus = (typeof CLIENT_IDENTITY_STATUSES)[number];

/**
 * The login. One per Contact, and most Contacts never have one.
 *
 * Exported under the name Better Auth is configured to look for — its Drizzle
 * adapter resolves a model against the schema export of that `modelName` — so
 * the export reads `clientIdentity` and the table is `client_identities`.
 * Nothing in this file calls a client a user.
 */
export const clientIdentity = pgTable(
  "client_identities",
  {
    id: text("id").primaryKey(),

    /** Better Auth writes this; the canonical name is the Contact's. */
    name: text("name").notNull(),

    /**
     * The verified access email, and a security credential rather than a
     * business field. It is set once, from the address an invitation was
     * actually sent to, and no edit of `contacts.email` ever changes it. See
     * docs/client-auth.md — silently moving a credential is how access ends up
     * in the wrong mailbox.
     */
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),

    /** The person. One identity per Contact, enforced below. */
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "restrict" }),

    status: text("status").notNull().default("active").$type<ClientIdentityStatus>(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("client_identities_email_idx").on(table.email),
    uniqueIndex("client_identities_contact_id_idx").on(table.contactId),
    index("client_identities_status_idx").on(table.status),
    check(
      "client_identities_status_check",
      sql.raw(`status IN (${quoted(CLIENT_IDENTITY_STATUSES)})`),
    ),
  ],
);

export const clientSession = pgTable(
  "client_sessions",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => clientIdentity.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("client_sessions_token_idx").on(table.token),
    index("client_sessions_user_id_idx").on(table.userId),
    index("client_sessions_expires_at_idx").on(table.expiresAt),
  ],
);

/**
 * Better Auth's `account` model. Magic-link sign-in never writes to it, exactly
 * as the staff `account` table has stayed empty since Build 002 — it is part of
 * the library's core schema rather than a feature anybody asked for, and
 * leaving it out would mean a missing-model error the first time some internal
 * path resolved it.
 */
export const clientCredential = pgTable(
  "client_credentials",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => clientIdentity.id, { onDelete: "cascade" }),
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
  (table) => [index("client_credentials_user_id_idx").on(table.userId)],
);

export const clientVerification = pgTable(
  "client_verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("client_verifications_identifier_idx").on(table.identifier),
    index("client_verifications_expires_at_idx").on(table.expiresAt),
  ],
);

/**
 * Better Auth's rate-limit storage, one table per instance.
 *
 * Both instances expose `/sign-in/magic-link`, and the limiter keys by path and
 * address — one shared table would let a staff sign-in and a client sign-in
 * from the same office spend each other's allowance. Database-backed rather
 * than the in-memory default, so the counters survive a deploy and would
 * survive a second instance, which closes an item open since Build 002.
 */
export const clientRateLimit = pgTable(
  "client_rate_limits",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    count: integer("count").notNull(),
    lastRequest: bigint("last_request", { mode: "number" }).notNull(),
  },
  (table) => [uniqueIndex("client_rate_limits_key_idx").on(table.key)],
);

export const authRateLimit = pgTable(
  "auth_rate_limits",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    count: integer("count").notNull(),
    lastRequest: bigint("last_request", { mode: "number" }).notNull(),
  },
  (table) => [uniqueIndex("auth_rate_limits_key_idx").on(table.key)],
);

/* ------------------------------------------------------------- workrooms */

/** Where a Workroom is in its life. Archival is separate, as everywhere else. */
export const WORKROOM_STATUSES = ["draft", "published", "unpublished"] as const;
export type WorkroomStatus = (typeof WORKROOM_STATUSES)[number];

/**
 * The client-facing container around one Project.
 *
 * There is deliberately no `client_id`: it would be a second copy of
 * `projects.client_id` that could drift from it, and the Client is one join
 * away. See docs/workrooms.md.
 */
export const workrooms = pgTable(
  "workrooms",
  {
    id: uuid("id").primaryKey(),

    /**
     * What the URL carries. Not the UUIDv7, whose first 48 bits are the moment
     * the row was created — a client-facing address should not say when a piece
     * of work began, and unguessability is not authorization either way.
     */
    publicId: text("public_id").notNull(),

    /** One Workroom per Project, enforced by the unique index below. */
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),

    /** Written for the client. Never a copy of an internal field. */
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),

    status: text("status").notNull().default("draft").$type<WorkroomStatus>(),
    /** When it was first opened to the client. Null while it never has been. */
    publishedAt: timestamp("published_at", { withTimezone: true }),

    /** Optimistic concurrency; see the note on `clients.version`. */
    version: integer("version").notNull().default(1),

    archivedAt: timestamp("archived_at", { withTimezone: true }),

    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("workrooms_public_id_idx").on(table.publicId),
    uniqueIndex("workrooms_project_id_idx").on(table.projectId),
    index("workrooms_status_idx").on(table.status),
    index("workrooms_archived_at_idx").on(table.archivedAt),
    index("workrooms_updated_at_idx").on(table.updatedAt.desc()),

    check("workrooms_status_check", sql.raw(`status IN (${quoted(WORKROOM_STATUSES)})`)),
    check("workrooms_title_length_check", sql.raw("char_length(title) BETWEEN 1 AND 160")),
    check("workrooms_summary_length_check", sql.raw("char_length(summary) <= 4000")),
    check("workrooms_public_id_length_check", sql.raw("char_length(public_id) = 26")),
  ],
);

/** Access to one Workroom, for one person. Revoked, never removed. */
export const WORKROOM_MEMBER_STATUSES = ["active", "revoked"] as const;
export type WorkroomMemberStatus = (typeof WORKROOM_MEMBER_STATUSES)[number];

export const workroomMembers = pgTable(
  "workroom_members",
  {
    id: uuid("id").primaryKey(),
    workroomId: uuid("workroom_id")
      .notNull()
      .references(() => workrooms.id, { onDelete: "restrict" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "restrict" }),

    status: text("status").notNull().default("active").$type<WorkroomMemberStatus>(),

    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    grantedBy: text("granted_by").references(() => user.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by").references(() => user.id, { onDelete: "set null" }),

    /** Optimistic concurrency; see the note on `clients.version`. */
    version: integer("version").notNull().default(1),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One row per person per Workroom, whose status carries the current state.
    // Re-granting reactivates it rather than adding a second row, so "have they
    // ever had access" has exactly one answer. The history is in the audit log.
    uniqueIndex("workroom_members_pair_idx").on(table.workroomId, table.contactId),
    index("workroom_members_contact_id_idx").on(table.contactId),
    index("workroom_members_status_idx").on(table.status),

    check(
      "workroom_members_status_check",
      sql.raw(`status IN (${quoted(WORKROOM_MEMBER_STATUSES)})`),
    ),
  ],
);

/**
 * One invitation, to one Workroom, for one Contact.
 *
 * Only the digest of the token is stored, so a database read yields no usable
 * link — the same arrangement as `staff_invitations`.
 */
export const workroomInvitations = pgTable(
  "workroom_invitations",
  {
    id: uuid("id").primaryKey(),
    workroomId: uuid("workroom_id")
      .notNull()
      .references(() => workrooms.id, { onDelete: "restrict" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "restrict" }),

    /**
     * The address this link was sent to, snapshotted. Acceptance verifies this
     * address rather than whatever the Contact record says by then, so an
     * invitation cannot be redirected to a different mailbox by an edit.
     */
    email: text("email").notNull(),

    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),

    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("workroom_invitations_token_hash_idx").on(table.tokenHash),
    index("workroom_invitations_workroom_id_idx").on(table.workroomId),
    index("workroom_invitations_contact_id_idx").on(table.contactId),
    index("workroom_invitations_expires_at_idx").on(table.expiresAt),

    check("workroom_invitations_email_length_check", sql.raw("char_length(email) BETWEEN 3 AND 254")),
  ],
);

/* -------------------------------------------------------------- activity */

/**
 * What the client sees has happened. Twelve values: five from Build 004 and
 * seven from Build 005. The whole vocabulary is here so no page can invent one.
 */
export const ACTIVITY_KINDS = [
  "workroom.opened",
  "workroom.joined",
  "workroom.access_granted",
  "workroom.access_ended",
  "project.status_changed",
  // Build 005. The whole vocabulary lives here so no page can invent one.
  "file.shared",
  "presentation.published",
  "presentation.revised",
  "review.requested",
  "review.received",
  "approval.requested",
  "approval.decided",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/**
 * The client-facing timeline. **Not** `audit_events`, permanently: audit is who
 * changed what and is immutable; this is curated context for people outside the
 * company. Both are written from the same business event, in the same
 * transaction, with different content. See docs/activity.md.
 *
 * There is no `metadata` column, and that is the design. A row holds a value
 * from a fixed vocabulary and two short safe labels, so there is nowhere for an
 * internal note to be pasted by accident — the guarantee is structural rather
 * than a policy somebody has to remember at review time.
 */
export const workroomActivity = pgTable(
  "workroom_activity",
  {
    id: uuid("id").primaryKey(),
    workroomId: uuid("workroom_id")
      .notNull()
      .references(() => workrooms.id, { onDelete: "restrict" }),

    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),

    kind: text("kind").notNull().$type<ActivityKind>(),

    /** A person's name as it was then. History does not rewrite itself. */
    actorLabel: text("actor_label"),
    /** One safe word or short label — a status, a title. Never free text. */
    subject: text("subject"),
  },
  (table) => [
    index("workroom_activity_workroom_idx").on(table.workroomId, table.occurredAt.desc()),

    check("workroom_activity_kind_check", sql.raw(`kind IN (${quoted(ACTIVITY_KINDS)})`)),
    check(
      "workroom_activity_actor_label_length_check",
      sql.raw("actor_label IS NULL OR char_length(actor_label) <= 160"),
    ),
    check(
      "workroom_activity_subject_length_check",
      sql.raw("subject IS NULL OR char_length(subject) <= 160"),
    ),
  ],
);

/* ==========================================================================
   BUILD 005 — DELIVERY

   Files, Presentations, Reviews and Approvals, all inside one Workroom.

   Two things here are unlike anything in Builds 001–004 and are the reason
   docs/delivery.md was written before this file:

     Composite tenancy keys. Every table carries `workroom_id` and references
     its parent by (workroom_id, parent_id) against a UNIQUE (workroom_id, id)
     on that parent. PostgreSQL then refuses a row reaching into another
     Workroom — not "should not", cannot. The redundant column does not repeat
     the `client_id` mistake that was kept off `workrooms`, because the foreign
     key makes it impossible to drift.

     Immutable tables. Revisions, their items and decided approvals refuse
     UPDATE and DELETE by trigger, as `audit_events` has since Build 003.
     Storage offers no immutability of its own — the bucket has no versioning
     and no object locks — so this is the whole of it.

   Stage A exposes only Files. The rest is created here because the model is
   locked and a half-built schema is harder to reason about than a finished
   one that is not yet used.
   ========================================================================== */

/** A file exists in the database before its bytes exist in the bucket. */
export const FILE_STATUSES = ["pending", "ready"] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

/** Something the studio is holding, or something the client has been given. */
export const FILE_VISIBILITIES = ["internal", "shared"] as const;
export type FileVisibility = (typeof FILE_VISIBILITIES)[number];

/** 2 GB. Verified against the bucket at finalization, never from the browser. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

export const workroomFiles = pgTable(
  "workroom_files",
  {
    id: uuid("id").primaryKey(),

    /** What a URL carries. Never the UUIDv7, whose first bits are a clock. */
    publicId: text("public_id").notNull(),

    workroomId: uuid("workroom_id")
      .notNull()
      .references(() => workrooms.id, { onDelete: "restrict" }),

    /** Client-facing, editable, chosen by somebody. */
    displayName: text("display_name").notNull(),

    /**
     * Recorded and never shown to a client — this is where
     * `final_v7_CLIENTNAME_dontsend.pdf` lives. It never reaches a projection
     * and never becomes part of a storage key.
     */
    originalFilename: text("original_filename").notNull(),

    /** Metadata. Never trusted to decide how anything is rendered. */
    contentType: text("content_type").notNull(),

    /** Verified by our own authenticated HEAD, not declared by the browser. */
    byteSize: bigint("byte_size", { mode: "number" }),

    /**
     * Where the bytes are. `pending/{id}` until finalization, then the
     * permanent `w/{workroom}/f/{file}` — which is never the target of any
     * presigned upload and is never written twice.
     */
    storageKey: text("storage_key").notNull(),

    /** The bucket's own integrity value. Opaque: compared, never parsed. */
    storageEtag: text("storage_etag"),

    /** An optional browser-made preview. Images only. Never the artefact. */
    previewKey: text("preview_key"),

    status: text("status").notNull().default("pending").$type<FileStatus>(),
    visibility: text("visibility").notNull().default("internal").$type<FileVisibility>(),
    sharedAt: timestamp("shared_at", { withTimezone: true }),

    /** Replacement is a new row. A ready file is never rewritten in place. */
    supersedesFileId: uuid("supersedes_file_id"),

    /** Optimistic concurrency; see the note on `clients.version`. */
    version: integer("version").notNull().default(1),

    archivedAt: timestamp("archived_at", { withTimezone: true }),

    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("workroom_files_public_id_idx").on(table.publicId),
    uniqueIndex("workroom_files_storage_key_idx").on(table.storageKey),
    // The composite tenancy key every child references.
    unique("workroom_files_workroom_id_id_key").on(table.workroomId, table.id),
    index("workroom_files_workroom_idx").on(table.workroomId, table.createdAt.desc()),
    index("workroom_files_status_idx").on(table.status),
    index("workroom_files_visibility_idx").on(table.visibility),
    index("workroom_files_archived_at_idx").on(table.archivedAt),

    foreignKey({
      columns: [table.supersedesFileId],
      foreignColumns: [table.id],
      name: "workroom_files_supersedes_fk",
    }).onDelete("set null"),

    check("workroom_files_status_check", sql.raw(`status IN (${quoted(FILE_STATUSES)})`)),
    check(
      "workroom_files_visibility_check",
      sql.raw(`visibility IN (${quoted(FILE_VISIBILITIES)})`),
    ),
    check("workroom_files_public_id_length_check", sql.raw("char_length(public_id) = 26")),
    check(
      "workroom_files_display_name_length_check",
      sql.raw("char_length(display_name) BETWEEN 1 AND 200"),
    ),
    check(
      "workroom_files_original_filename_length_check",
      sql.raw("char_length(original_filename) BETWEEN 1 AND 400"),
    ),
    check(
      "workroom_files_content_type_length_check",
      sql.raw("char_length(content_type) BETWEEN 1 AND 200"),
    ),
    // A ready file has bytes behind it and knows how many. A pending one does
    // not yet, and saying so in the schema is what stops half a file looking
    // like a whole one.
    check(
      "workroom_files_ready_shape_check",
      sql.raw(
        "(status = 'pending' AND byte_size IS NULL AND storage_etag IS NULL)" +
          " OR (status = 'ready' AND byte_size IS NOT NULL AND storage_etag IS NOT NULL)",
      ),
    ),
    check(
      "workroom_files_byte_size_check",
      sql.raw(`byte_size IS NULL OR (byte_size > 0 AND byte_size <= ${MAX_FILE_BYTES})`),
    ),
    // Shared is a state with a moment attached, and only a ready file can be
    // in it — sharing something whose bytes never arrived is not a thing.
    check(
      "workroom_files_shared_shape_check",
      sql.raw(
        "(visibility = 'internal' AND shared_at IS NULL)" +
          " OR (visibility = 'shared' AND shared_at IS NOT NULL AND status = 'ready')",
      ),
    ),
    // The key says which half of its life a row is in, so a pending row can
    // never name a permanent object and the sweep can never reach one.
    check(
      "workroom_files_key_shape_check",
      sql.raw(
        "(status = 'pending' AND storage_key LIKE 'pending/%')" +
          " OR (status = 'ready' AND storage_key LIKE 'w/%')",
      ),
    ),
  ],
);

/* ---------------------------------------------------------- presentations */

export const PRESENTATION_STATUSES = ["draft", "published", "unpublished"] as const;
export type PresentationStatus = (typeof PRESENTATION_STATUSES)[number];

/**
 * A deliberate delivery moment. Mutable while it is being built; publishing
 * freezes its contents into a Revision.
 *
 * Created in Stage A and used from Stage B. The model is locked, and half a
 * schema is harder to reason about than a finished one that is not yet read.
 */
export const presentations = pgTable(
  "presentations",
  {
    id: uuid("id").primaryKey(),
    publicId: text("public_id").notNull(),

    workroomId: uuid("workroom_id")
      .notNull()
      .references(() => workrooms.id, { onDelete: "restrict" }),

    title: text("title").notNull(),
    /** Client-safe, and the role `workrooms.summary` plays. */
    intro: text("intro").notNull().default(""),

    status: text("status").notNull().default("draft").$type<PresentationStatus>(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    /**
     * The Revision a client sees now. Null until first publication, and kept
     * after an unpublish — retracting a Presentation must not erase which
     * Revision it had reached.
     *
     * `0005` binds this to **its own** Presentation, not merely to the
     * revisions table, with a composite foreign key that PostgreSQL can only
     * satisfy from a Revision of this Presentation:
     *
     *     FOREIGN KEY (id, current_revision_id)
     *       REFERENCES presentation_revisions (presentation_id, id)
     *
     * It lives in SQL alone because the two tables reference each other and
     * `foreignKey()` needs its target already defined — the same reason the
     * triggers and partial indexes below are SQL-only.
     */
    currentRevisionId: uuid("current_revision_id"),

    version: integer("version").notNull().default(1),
    archivedAt: timestamp("archived_at", { withTimezone: true }),

    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("presentations_public_id_idx").on(table.publicId),
    unique("presentations_workroom_id_id_key").on(table.workroomId, table.id),
    index("presentations_workroom_idx").on(table.workroomId, table.createdAt.desc()),
    index("presentations_status_idx").on(table.status),
    index("presentations_archived_at_idx").on(table.archivedAt),

    check("presentations_status_check", sql.raw(`status IN (${quoted(PRESENTATION_STATUSES)})`)),
    check("presentations_public_id_length_check", sql.raw("char_length(public_id) = 26")),
    check("presentations_title_length_check", sql.raw("char_length(title) BETWEEN 1 AND 200")),
    check("presentations_intro_length_check", sql.raw("char_length(intro) <= 4000")),
    // Published means there is something to show. Deliberately one-directional:
    // an unpublished Presentation keeps the Revision it had reached.
    check(
      "presentations_published_shape_check",
      sql.raw(
        "(status = 'published' AND current_revision_id IS NOT NULL AND published_at IS NOT NULL)" +
          " OR (status <> 'published')",
      ),
    ),
  ],
);

/** A file reference, or words between files. Two kinds, not ten. */
export const PRESENTATION_ITEM_KINDS = ["file", "note"] as const;
export type PresentationItemKind = (typeof PRESENTATION_ITEM_KINDS)[number];

/** The mutable draft contents. Invisible to clients, replaced freely. */
export const presentationItems = pgTable(
  "presentation_items",
  {
    id: uuid("id").primaryKey(),

    /** Carried for the composite tenancy keys below, not as a convenience. */
    workroomId: uuid("workroom_id")
      .notNull()
      .references(() => workrooms.id, { onDelete: "restrict" }),

    presentationId: uuid("presentation_id").notNull(),
    fileId: uuid("file_id"),

    kind: text("kind").notNull().$type<PresentationItemKind>(),
    caption: text("caption"),
    body: text("body"),
    position: integer("position").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // A draft item has no life without its presentation.
    foreignKey({
      columns: [table.workroomId, table.presentationId],
      foreignColumns: [presentations.workroomId, presentations.id],
      name: "presentation_items_presentation_fk",
    }).onDelete("cascade"),
    // And it can only ever reference a file from its own Workroom.
    foreignKey({
      columns: [table.workroomId, table.fileId],
      foreignColumns: [workroomFiles.workroomId, workroomFiles.id],
      name: "presentation_items_file_fk",
    }).onDelete("restrict"),

    index("presentation_items_presentation_idx").on(table.presentationId, table.position),
    index("presentation_items_file_idx").on(table.fileId),

    check("presentation_items_kind_check", sql.raw(`kind IN (${quoted(PRESENTATION_ITEM_KINDS)})`)),
    check(
      "presentation_items_shape_check",
      sql.raw(
        "(kind = 'file' AND file_id IS NOT NULL AND body IS NULL)" +
          " OR (kind = 'note' AND file_id IS NULL AND body IS NOT NULL)",
      ),
    ),
    check("presentation_items_position_check", sql.raw("position >= 0")),
    check(
      "presentation_items_caption_length_check",
      sql.raw("caption IS NULL OR char_length(caption) <= 500"),
    ),
    check("presentation_items_body_length_check", sql.raw("body IS NULL OR char_length(body) <= 4000")),
  ],
);

/**
 * What one person saw at one moment. **Immutable**: the migration adds a
 * trigger refusing UPDATE and DELETE, because an approval names one of these
 * and a rewritable revision would make "approved" mean whatever it says today.
 */
export const presentationRevisions = pgTable(
  "presentation_revisions",
  {
    id: uuid("id").primaryKey(),

    workroomId: uuid("workroom_id")
      .notNull()
      .references(() => workrooms.id, { onDelete: "restrict" }),
    presentationId: uuid("presentation_id").notNull(),

    revisionNumber: integer("revision_number").notNull(),

    /**
     * The frozen client-safe projection, written only by serialising
     * `toClientPresentationView`. Never assembled by hand, never from a row.
     */
    snapshot: jsonb("snapshot").notNull(),
    /** sha256 over the canonical snapshot. Compared, never interpreted. */
    contentHash: text("content_hash").notNull(),

    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
    publishedBy: text("published_by").references(() => user.id, { onDelete: "set null" }),
    /** Snapshot, so history still reads after somebody leaves the studio. */
    publishedByName: text("published_by_name"),
  },
  (table) => [
    foreignKey({
      columns: [table.workroomId, table.presentationId],
      foreignColumns: [presentations.workroomId, presentations.id],
      name: "presentation_revisions_presentation_fk",
    }).onDelete("restrict"),

    unique("presentation_revisions_workroom_id_id_key").on(table.workroomId, table.id),
    // What `presentations.current_revision_id` points at, so a Presentation
    // cannot name a Revision belonging to a different Presentation.
    unique("presentation_revisions_presentation_id_id_key").on(table.presentationId, table.id),
    // Two publishes produce two numbers or one refusal, never a duplicate.
    uniqueIndex("presentation_revisions_number_idx").on(table.presentationId, table.revisionNumber),
    index("presentation_revisions_latest_idx").on(
      table.presentationId,
      table.revisionNumber.desc(),
    ),

    check("presentation_revisions_number_check", sql.raw("revision_number >= 1")),
    check("presentation_revisions_hash_length_check", sql.raw("char_length(content_hash) = 64")),
  ],
);

/**
 * The exact ordered contents of a Revision, relationally. **Immutable.**
 *
 * A JSON snapshot alone cannot carry a foreign key, support an archive guard,
 * give a review a target, or prove which physical file belonged to a decision.
 * These rows do all four; the snapshot stays as the frozen rendering.
 */
export const presentationRevisionItems = pgTable(
  "presentation_revision_items",
  {
    id: uuid("id").primaryKey(),

    workroomId: uuid("workroom_id")
      .notNull()
      .references(() => workrooms.id, { onDelete: "restrict" }),
    presentationRevisionId: uuid("presentation_revision_id").notNull(),

    position: integer("position").notNull(),
    kind: text("kind").notNull().$type<PresentationItemKind>(),
    fileId: uuid("file_id"),

    /** What the client was shown. A later rename does not rewrite history. */
    displayNameSnapshot: text("display_name_snapshot"),
    caption: text("caption"),
    body: text("body"),
  },
  (table) => [
    foreignKey({
      columns: [table.workroomId, table.presentationRevisionId],
      foreignColumns: [presentationRevisions.workroomId, presentationRevisions.id],
      name: "presentation_revision_items_revision_fk",
    }).onDelete("restrict"),
    // `restrict` is the archive guard's other half: a file inside a revision
    // cannot be removed by anything, including the pending sweep.
    foreignKey({
      columns: [table.workroomId, table.fileId],
      foreignColumns: [workroomFiles.workroomId, workroomFiles.id],
      name: "presentation_revision_items_file_fk",
    }).onDelete("restrict"),

    unique("presentation_revision_items_workroom_id_id_key").on(table.workroomId, table.id),
    // The FK target that proves an anchored Review note points at an item of
    // the **exact Revision being reviewed**. Tenancy alone is not enough: a
    // Workroom with two Revisions of one Presentation would otherwise accept a
    // note on Revision 2 anchored to an item that only existed in Revision 1.
    unique("presentation_revision_items_revision_id_key").on(
      table.workroomId,
      table.presentationRevisionId,
      table.id,
    ),
    uniqueIndex("presentation_revision_items_position_idx").on(
      table.presentationRevisionId,
      table.position,
    ),
    index("presentation_revision_items_file_idx").on(table.fileId),

    check(
      "presentation_revision_items_kind_check",
      sql.raw(`kind IN (${quoted(PRESENTATION_ITEM_KINDS)})`),
    ),
    // `display_name_snapshot` is the proof of what name the client read, so it
    // is required on exactly the rows that have one and refused on the rest.
    check(
      "presentation_revision_items_shape_check",
      sql.raw(
        "(kind = 'file' AND file_id IS NOT NULL AND body IS NULL" +
          " AND display_name_snapshot IS NOT NULL)" +
          " OR (kind = 'note' AND file_id IS NULL AND body IS NOT NULL" +
          " AND display_name_snapshot IS NULL)",
      ),
    ),
    check("presentation_revision_items_position_check", sql.raw("position >= 0")),
  ],
);

/* ------------------------------------------------ reviews and approvals */

export const REVIEW_STATUSES = ["open", "closed", "withdrawn"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/**
 * Why a round closed. The discriminator, and it is load-bearing.
 *
 * Every actor foreign key in this schema is `ON DELETE set null`, so
 * "exactly one of `closed_by_user_id` / `closed_by_revision_id`" would hold
 * until a staff row went away and then refuse the deletion from a constraint
 * that was never about staff. The reason is stored as a fact; the actor key is
 * only a join. Same device as `audit_events.actor_type`.
 */
export const REVIEW_CLOSURE_REASONS = ["staff", "superseded"] as const;
export type ReviewClosureReason = (typeof REVIEW_CLOSURE_REASONS)[number];

/** Which side of the relationship wrote or resolved something. */
export const NOTE_SIDES = ["studio", "client"] as const;
export type NoteSide = (typeof NOTE_SIDES)[number];

/** What a precise anchor points at. The exact shapes are parsed in the domain. */
export const REVIEW_ANCHOR_KINDS = ["point", "region", "time"] as const;
export type ReviewAnchorKind = (typeof REVIEW_ANCHOR_KINDS)[number];

/**
 * How long an author may still correct or remove what they wrote.
 *
 * The database holds this one, in `presentation_review_notes_guard`, so it
 * is a property of the row rather than a convention in a module. The relational
 * half of the same policy — no edit and no removal once a reply exists — is the
 * domain's, under the Review row lock, because a row trigger would pay a child
 * count on every write.
 */
export const NOTE_GRACE_MINUTES = 15;

/**
 * One round of client feedback on one published Revision.
 *
 * **One row per Revision, ever** — `UNIQUE (presentation_revision_id)`, a full
 * unique rather than a partial index over open rows. The difference is the
 * model: a partial index says "one at a time", which is scheduling; a full
 * unique says "one, ever", which is a fact about the Revision. The row is that
 * Revision's lifecycle record whether or not a word was ever written into it,
 * which is why the migration also refuses DELETE and TRUNCATE. A unique
 * constraint that someone can delete their way around is not a rule.
 *
 * Lifecycle, enforced by `presentation_reviews_guard` in the migration:
 *
 *     (no row) --request--> open --staff close----> closed/staff  <--> open
 *                                --publish N+1----> closed/superseded  TERMINAL
 *                                --withdraw-------> withdrawn      <--> open
 *
 * Reopening a staff closure or a withdrawal is the domain's to allow, and only
 * while that Revision is still the Presentation's current one. A supersession
 * never reopens and its closure fields can never be rewritten.
 */
export const presentationReviews = pgTable(
  "presentation_reviews",
  {
    id: uuid("id").primaryKey(),

    workroomId: uuid("workroom_id")
      .notNull()
      .references(() => workrooms.id, { onDelete: "restrict" }),
    presentationRevisionId: uuid("presentation_revision_id").notNull(),

    status: text("status").notNull().default("open").$type<ReviewStatus>(),

    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    requestedBy: text("requested_by").references(() => user.id, { onDelete: "set null" }),

    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedReason: text("closed_reason").$type<ReviewClosureReason>(),
    closedByUserId: text("closed_by_user_id").references(() => user.id, { onDelete: "set null" }),
    /** The Revision whose publication ended this round. Never its own. */
    closedByRevisionId: uuid("closed_by_revision_id"),

    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),

    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.workroomId, table.presentationRevisionId],
      foreignColumns: [presentationRevisions.workroomId, presentationRevisions.id],
      name: "presentation_reviews_revision_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.workroomId, table.closedByRevisionId],
      foreignColumns: [presentationRevisions.workroomId, presentationRevisions.id],
      name: "presentation_reviews_closed_by_revision_fk",
    }).onDelete("restrict"),

    // One round per Revision, ever.
    unique("presentation_reviews_revision_id_key").on(table.presentationRevisionId),
    // The note's FK target. Carrying the Revision through it is what lets a
    // note prove its own Revision is its Review's Revision.
    unique("presentation_reviews_workroom_id_revision_key").on(
      table.workroomId,
      table.id,
      table.presentationRevisionId,
    ),

    index("presentation_reviews_workroom_idx").on(table.workroomId, table.status),

    check("presentation_reviews_status_check", sql.raw(`status IN (${quoted(REVIEW_STATUSES)})`)),
    // Exactly one closure reason when closed, none otherwise — and the staff
    // branch deliberately does not require `closed_by_user_id`, so a later
    // `ON DELETE set null` cannot break a row that is already history.
    //
    // Written as CASE rather than `(closed AND …) OR (not closed AND …)`, and
    // that is not style. A CHECK passes when its expression is NULL, and the
    // OR form evaluates to NULL — not false — for a row that says `closed`
    // and names no reason, because `NULL IN (…)` is NULL. It let exactly the
    // row it exists to refuse straight through. Found by the test below, which
    // is the argument for asserting constraints against PostgreSQL rather than
    // reading them.
    check(
      "presentation_reviews_closure_shape_check",
      sql.raw(
        "CASE WHEN status = 'closed' THEN" +
          " closed_at IS NOT NULL AND closed_reason IS NOT NULL" +
          " AND ((closed_reason = 'staff' AND closed_by_revision_id IS NULL)" +
          " OR (closed_reason = 'superseded' AND closed_by_revision_id IS NOT NULL" +
          " AND closed_by_user_id IS NULL))" +
          " ELSE closed_at IS NULL AND closed_reason IS NULL" +
          " AND closed_by_user_id IS NULL AND closed_by_revision_id IS NULL END",
      ),
    ),
    check(
      "presentation_reviews_withdrawn_shape_check",
      sql.raw("(status = 'withdrawn') = (withdrawn_at IS NOT NULL)"),
    ),
    // A round cannot be superseded by the Revision it belongs to.
    check(
      "presentation_reviews_superseded_by_other_check",
      sql.raw(
        "closed_by_revision_id IS NULL OR closed_by_revision_id <> presentation_revision_id",
      ),
    ),
  ],
);

/**
 * One feedback item, or one reply to one. **Depth is exactly one**, and
 * PostgreSQL holds that rather than the interface: a reply's parent must itself
 * be a root, proved by `(parent_note_id, parent_is_root)` referencing
 * `(id, is_root)`. A depth-2 reply cannot be stored.
 *
 * Three integrity properties are worth naming because each was a real hole
 * before it was closed:
 *
 *   exact Revision   `(workroom_id, presentation_review_id,
 *                      presentation_revision_id)` proves the note's Revision is
 *                    its Review's, and `(workroom_id, presentation_revision_id,
 *                    revision_item_id)` proves an anchored item belongs to that
 *                    same Revision. Tenancy alone would have allowed a note on
 *                    Revision 2 to point at an item from Revision 1.
 *   authorship       `author_side` is the durable fact. The actor keys are
 *                    joins that go null when somebody leaves, so nothing may
 *                    infer which side wrote a note from which key is set.
 *   removal          Additive. `removed_at` is written **beside** the body,
 *                    never over it, so the immutability trigger needs no
 *                    exception and the record is not falsified. No projection
 *                    returns a removed body to either surface.
 */
export const presentationReviewNotes = pgTable(
  "presentation_review_notes",
  {
    id: uuid("id").primaryKey(),

    workroomId: uuid("workroom_id")
      .notNull()
      .references(() => workrooms.id, { onDelete: "restrict" }),
    presentationReviewId: uuid("presentation_review_id").notNull(),
    /** Redundant with the Review's, and constrained so it cannot diverge. */
    presentationRevisionId: uuid("presentation_revision_id").notNull(),

    /** Creation order within the round. The only handle a client receives. */
    number: integer("number").notNull(),

    parentNoteId: uuid("parent_note_id"),
    isRoot: boolean("is_root").notNull(),
    /** Always true when there is a parent, null when there is not. */
    parentIsRoot: boolean("parent_is_root"),

    /** The subject. Null means the note is about the Revision as a whole. */
    revisionItemId: uuid("revision_item_id"),
    /**
     * Where inside that item. Normalised fractions of the media's own intrinsic
     * box and seconds from its start — never viewport pixels, so a phone and a
     * desktop resolve to the same place and a later overlay stays possible.
     */
    anchor: jsonb("anchor"),

    body: text("body").notNull(),

    authorSide: text("author_side").notNull().$type<NoteSide>(),
    authorUserId: text("author_user_id").references(() => user.id, { onDelete: "set null" }),
    authorIdentityId: text("author_identity_id").references(() => clientIdentity.id, {
      onDelete: "set null",
    }),
    /** Snapshot, so history reads correctly after somebody leaves. */
    authorName: text("author_name").notNull(),

    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBySide: text("resolved_by_side").$type<NoteSide>(),
    resolvedByUserId: text("resolved_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    resolvedByIdentityId: text("resolved_by_identity_id").references(() => clientIdentity.id, {
      onDelete: "set null",
    }),
    resolvedByName: text("resolved_by_name"),

    editedAt: timestamp("edited_at", { withTimezone: true }),
    /** The tombstone. Set once, inside the grace window, and never cleared. */
    removedAt: timestamp("removed_at", { withTimezone: true }),

    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The note's Revision is its Review's Revision. Proved, not trusted.
    foreignKey({
      columns: [table.workroomId, table.presentationReviewId, table.presentationRevisionId],
      foreignColumns: [
        presentationReviews.workroomId,
        presentationReviews.id,
        presentationReviews.presentationRevisionId,
      ],
      name: "presentation_review_notes_review_fk",
    }).onDelete("restrict"),
    // An anchored item belongs to that same Revision. MATCH SIMPLE is the
    // default and is load-bearing: with `revision_item_id` null the constraint
    // is skipped, which is exactly how general feedback passes. MATCH FULL
    // here would refuse every general note.
    foreignKey({
      columns: [table.workroomId, table.presentationRevisionId, table.revisionItemId],
      foreignColumns: [
        presentationRevisionItems.workroomId,
        presentationRevisionItems.presentationRevisionId,
        presentationRevisionItems.id,
      ],
      name: "presentation_review_notes_item_fk",
    }).onDelete("restrict"),
    // A reply belongs to the same round as its root.
    foreignKey({
      columns: [table.presentationReviewId, table.parentNoteId],
      foreignColumns: [table.presentationReviewId, table.id],
      name: "presentation_review_notes_parent_fk",
    }).onDelete("restrict"),
    // …and that root is a root. This is the depth-one guarantee.
    foreignKey({
      columns: [table.parentNoteId, table.parentIsRoot],
      foreignColumns: [table.id, table.isRoot],
      name: "presentation_review_notes_parent_is_root_fk",
    }).onDelete("restrict"),

    unique("presentation_review_notes_id_is_root_key").on(table.id, table.isRoot),
    unique("presentation_review_notes_review_id_key").on(table.presentationReviewId, table.id),
    // Ordinals are allocated under the Review row lock; this is the last line.
    unique("presentation_review_notes_number_key").on(table.presentationReviewId, table.number),

    index("presentation_review_notes_review_idx").on(table.workroomId, table.presentationReviewId),
    index("presentation_review_notes_parent_idx").on(table.parentNoteId),

    check("presentation_review_notes_number_check", sql.raw("number >= 1")),
    check(
      "presentation_review_notes_body_length_check",
      sql.raw("char_length(body) BETWEEN 1 AND 8000"),
    ),

    check("presentation_review_notes_is_root_check", sql.raw("is_root = (parent_note_id IS NULL)")),
    check(
      "presentation_review_notes_parent_is_root_check",
      sql.raw(
        "parent_is_root IS NOT DISTINCT FROM" +
          " (CASE WHEN parent_note_id IS NULL THEN NULL ELSE true END)",
      ),
    ),

    check(
      "presentation_review_notes_author_side_check",
      sql.raw(`author_side IN (${quoted(NOTE_SIDES)})`),
    ),
    // At most one, never exactly one: a deleted actor sets its key null and
    // `author_name` carries the identity from then on.
    check(
      "presentation_review_notes_author_shape_check",
      sql.raw(
        "NOT (author_user_id IS NOT NULL AND author_identity_id IS NOT NULL)" +
          " AND (author_side <> 'studio' OR author_identity_id IS NULL)" +
          " AND (author_side <> 'client' OR author_user_id IS NULL)",
      ),
    ),
    // Staff cannot open a feedback item. Their contribution is replies and
    // resolutions; the round is the client's voice.
    check(
      "presentation_review_notes_root_is_client_check",
      sql.raw("author_side = 'client' OR parent_note_id IS NOT NULL"),
    ),

    // A reply inherits its root's subject and carries no state of its own.
    check(
      "presentation_review_notes_reply_shape_check",
      sql.raw(
        "parent_note_id IS NULL OR (anchor IS NULL AND revision_item_id IS NULL" +
          " AND resolved_at IS NULL AND resolved_by_side IS NULL" +
          " AND resolved_by_user_id IS NULL AND resolved_by_identity_id IS NULL" +
          " AND resolved_by_name IS NULL)",
      ),
    ),
    // Precision requires a subject: there is no point at 42% of a Revision.
    check(
      "presentation_review_notes_anchor_subject_check",
      sql.raw("anchor IS NULL OR revision_item_id IS NOT NULL"),
    ),
    // Cheap structural and range validation only. The exact shape is parsed by
    // a whitelist in the domain, the way every client-safe projection is.
    // `jsonb_typeof` guards each cast so a wrong type refuses rather than
    // raising, and `jsonb_exists` is spelled out rather than `?` so no tool in
    // the chain can mistake it for a parameter marker.
    check(
      "presentation_review_notes_anchor_shape_check",
      sql.raw(
        "anchor IS NULL OR (jsonb_typeof(anchor) = 'object'" +
          ` AND (anchor->>'kind') IN (${quoted(REVIEW_ANCHOR_KINDS)})` +
          " AND CASE anchor->>'kind'" +
          "   WHEN 'point' THEN jsonb_exists(anchor, 'x') AND jsonb_exists(anchor, 'y')" +
          "   WHEN 'region' THEN jsonb_exists(anchor, 'x') AND jsonb_exists(anchor, 'y')" +
          "     AND jsonb_exists(anchor, 'w') AND jsonb_exists(anchor, 'h')" +
          "   WHEN 'time' THEN jsonb_exists(anchor, 't')" +
          "   ELSE false END" +
          " AND (NOT jsonb_exists(anchor, 'x') OR (jsonb_typeof(anchor->'x') = 'number'" +
          "   AND (anchor->>'x')::numeric BETWEEN 0 AND 1))" +
          " AND (NOT jsonb_exists(anchor, 'y') OR (jsonb_typeof(anchor->'y') = 'number'" +
          "   AND (anchor->>'y')::numeric BETWEEN 0 AND 1))" +
          " AND (NOT jsonb_exists(anchor, 'w') OR (jsonb_typeof(anchor->'w') = 'number'" +
          "   AND (anchor->>'w')::numeric BETWEEN 0 AND 1))" +
          " AND (NOT jsonb_exists(anchor, 'h') OR (jsonb_typeof(anchor->'h') = 'number'" +
          "   AND (anchor->>'h')::numeric BETWEEN 0 AND 1))" +
          " AND (NOT jsonb_exists(anchor, 't') OR (jsonb_typeof(anchor->'t') = 'number'" +
          "   AND (anchor->>'t')::numeric >= 0))" +
          " AND (NOT jsonb_exists(anchor, 't2') OR (jsonb_typeof(anchor->'t2') = 'number'" +
          "   AND jsonb_exists(anchor, 't')" +
          "   AND (anchor->>'t2')::numeric > (anchor->>'t')::numeric)))",
      ),
    ),

    check(
      "presentation_review_notes_resolved_side_check",
      sql.raw(`resolved_by_side IS NULL OR resolved_by_side IN (${quoted(NOTE_SIDES)})`),
    ),
    // The name snapshot is what makes resolution provenance survive a deleted
    // actor, so it is the column the shape requires — not the foreign key.
    check(
      "presentation_review_notes_resolved_shape_check",
      sql.raw(
        "(resolved_at IS NULL AND resolved_by_side IS NULL AND resolved_by_name IS NULL" +
          " AND resolved_by_user_id IS NULL AND resolved_by_identity_id IS NULL)" +
          " OR (resolved_at IS NOT NULL AND resolved_by_side IS NOT NULL" +
          " AND resolved_by_name IS NOT NULL" +
          " AND NOT (resolved_by_user_id IS NOT NULL AND resolved_by_identity_id IS NOT NULL)" +
          " AND (resolved_by_side <> 'studio' OR resolved_by_identity_id IS NULL)" +
          " AND (resolved_by_side <> 'client' OR resolved_by_user_id IS NULL))",
      ),
    ),
  ],
);

export const APPROVAL_STATUSES = ["requested", "granted", "declined", "withdrawn"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/**
 * A business decision, recorded once and never edited.
 *
 * No `version` and no `updated_at`: nothing about a decided approval is
 * editable. The migration adds triggers that refuse UPDATE on a terminal row,
 * refuse any transition but `requested` → one terminal state, refuse DELETE
 * outright and refuse TRUNCATE — the same three-way protection `audit_events`
 * carries, because business history that can be truncated is not history.
 *
 * Declining requires a reason. A decline with no reason is a dead end for both
 * sides, and the reason is the most useful sentence in the record.
 */
export const presentationApprovals = pgTable(
  "presentation_approvals",
  {
    id: uuid("id").primaryKey(),

    workroomId: uuid("workroom_id")
      .notNull()
      .references(() => workrooms.id, { onDelete: "restrict" }),
    presentationRevisionId: uuid("presentation_revision_id").notNull(),

    status: text("status").notNull().default("requested").$type<ApprovalStatus>(),

    requestedAt: timestamp("requested_at", { withTimezone: true }),
    requestedBy: text("requested_by").references(() => user.id, { onDelete: "set null" }),

    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedByIdentityId: text("decided_by_identity_id").references(() => clientIdentity.id, {
      onDelete: "set null",
    }),
    /** Snapshot. The record still reads after an identity is disabled. */
    decidedByName: text("decided_by_name"),
    declineReason: text("decline_reason"),

    /**
     * The revision's hash as it was at the moment of the decision. A tripwire:
     * if this ever disagrees with the revision's own hash, something mutated a
     * supposedly immutable row and the system should say so loudly.
     */
    contentHashAtDecision: text("content_hash_at_decision"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.workroomId, table.presentationRevisionId],
      foreignColumns: [presentationRevisions.workroomId, presentationRevisions.id],
      name: "presentation_approvals_revision_fk",
    }).onDelete("restrict"),

    index("presentation_approvals_workroom_idx").on(table.workroomId, table.status),
    index("presentation_approvals_revision_idx").on(table.presentationRevisionId),

    check("presentation_approvals_status_check", sql.raw(`status IN (${quoted(APPROVAL_STATUSES)})`)),
    check(
      "presentation_approvals_decided_shape_check",
      sql.raw(
        "(status IN ('requested', 'withdrawn') AND decided_at IS NULL)" +
          " OR (status IN ('granted', 'declined') AND decided_at IS NOT NULL)",
      ),
    ),
    // A decline says why. Nothing else may carry a reason.
    check(
      "presentation_approvals_decline_reason_check",
      sql.raw(
        "(status = 'declined' AND decline_reason IS NOT NULL" +
          " AND char_length(decline_reason) BETWEEN 3 AND 2000)" +
          " OR (status <> 'declined' AND decline_reason IS NULL)",
      ),
    ),
  ],
);
