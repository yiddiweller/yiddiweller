CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" text,
	"actor_name" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"entity_label" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "audit_events_entity_type_check" CHECK (entity_type IN ('client', 'contact', 'lead', 'project', 'client_contact', 'project_contact', 'inquiry', 'staff')),
	CONSTRAINT "audit_events_action_length_check" CHECK (char_length(action) BETWEEN 3 AND 60),
	CONSTRAINT "audit_events_entity_label_length_check" CHECK (entity_label IS NULL OR char_length(entity_label) <= 200)
);
--> statement-breakpoint
CREATE TABLE "client_contacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"role" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_contacts_role_length_check" CHECK (role IS NULL OR char_length(role) <= 120)
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_type" text NOT NULL,
	"name" text NOT NULL,
	"website" text,
	"domain" text,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clients_account_type_check" CHECK (account_type IN ('organization', 'individual')),
	CONSTRAINT "clients_status_check" CHECK (status IN ('active', 'inactive')),
	CONSTRAINT "clients_name_length_check" CHECK (char_length(name) BETWEEN 1 AND 160),
	CONSTRAINT "clients_notes_length_check" CHECK (char_length(notes) <= 4000)
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"email_normalized" text,
	"phone" text,
	"title" text,
	"notes" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_name_length_check" CHECK (char_length(name) BETWEEN 1 AND 160),
	CONSTRAINT "contacts_email_length_check" CHECK (email IS NULL OR char_length(email) <= 254),
	CONSTRAINT "contacts_notes_length_check" CHECK (char_length(notes) <= 4000)
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"stage" text DEFAULT 'new' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"inquiry_id" uuid,
	"contact_id" uuid,
	"client_id" uuid,
	"prospect_name" text,
	"summary" text DEFAULT '' NOT NULL,
	"next_step" text DEFAULT '' NOT NULL,
	"follow_up_at" timestamp with time zone,
	"owner_id" text,
	"lost_reason" text,
	"won_at" timestamp with time zone,
	"lost_at" timestamp with time zone,
	"project_id" uuid,
	"converted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leads_stage_check" CHECK (stage IN ('new', 'discovery', 'proposal', 'won', 'lost')),
	CONSTRAINT "leads_source_check" CHECK (source IN ('inquiry', 'referral', 'existing_client', 'manual', 'other')),
	CONSTRAINT "leads_title_length_check" CHECK (char_length(title) BETWEEN 1 AND 160),
	CONSTRAINT "leads_summary_length_check" CHECK (char_length(summary) <= 4000),
	CONSTRAINT "leads_next_step_length_check" CHECK (char_length(next_step) <= 500),
	CONSTRAINT "leads_lost_reason_length_check" CHECK (lost_reason IS NULL OR char_length(lost_reason) <= 500)
);
--> statement-breakpoint
CREATE TABLE "project_contacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"role" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_contacts_role_length_check" CHECK (role IS NULL OR char_length(role) <= 120)
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"lead_id" uuid,
	"name" text NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"owner_id" text,
	"starts_on" date,
	"target_on" date,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_status_check" CHECK (status IN ('planned', 'active', 'on_hold', 'completed', 'cancelled')),
	CONSTRAINT "projects_name_length_check" CHECK (char_length(name) BETWEEN 1 AND 160),
	CONSTRAINT "projects_description_length_check" CHECK (char_length(description) <= 4000),
	CONSTRAINT "projects_notes_length_check" CHECK (char_length(notes) <= 4000)
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_contacts" ADD CONSTRAINT "client_contacts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_contacts" ADD CONSTRAINT "client_contacts_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_contacts" ADD CONSTRAINT "client_contacts_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_inquiry_id_inquiries_id_fk" FOREIGN KEY ("inquiry_id") REFERENCES "public"."inquiries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_contacts" ADD CONSTRAINT "project_contacts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_contacts" ADD CONSTRAINT "project_contacts_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_contacts" ADD CONSTRAINT "project_contacts_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_occurred_at_idx" ON "audit_events" USING btree ("occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_events_actor_id_idx" ON "audit_events" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_events_action_idx" ON "audit_events" USING btree ("action");--> statement-breakpoint
CREATE UNIQUE INDEX "client_contacts_pair_idx" ON "client_contacts" USING btree ("client_id","contact_id");--> statement-breakpoint
CREATE INDEX "client_contacts_contact_id_idx" ON "client_contacts" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "clients_name_idx" ON "clients" USING btree ("name");--> statement-breakpoint
CREATE INDEX "clients_domain_idx" ON "clients" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "clients_status_idx" ON "clients" USING btree ("status");--> statement-breakpoint
CREATE INDEX "clients_archived_at_idx" ON "clients" USING btree ("archived_at");--> statement-breakpoint
CREATE INDEX "clients_updated_at_idx" ON "clients" USING btree ("updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "contacts_name_idx" ON "contacts" USING btree ("name");--> statement-breakpoint
CREATE INDEX "contacts_email_normalized_idx" ON "contacts" USING btree ("email_normalized");--> statement-breakpoint
CREATE INDEX "contacts_archived_at_idx" ON "contacts" USING btree ("archived_at");--> statement-breakpoint
CREATE INDEX "contacts_updated_at_idx" ON "contacts" USING btree ("updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "leads_stage_idx" ON "leads" USING btree ("stage");--> statement-breakpoint
CREATE INDEX "leads_owner_id_idx" ON "leads" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "leads_client_id_idx" ON "leads" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "leads_contact_id_idx" ON "leads" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "leads_follow_up_at_idx" ON "leads" USING btree ("follow_up_at");--> statement-breakpoint
CREATE INDEX "leads_archived_at_idx" ON "leads" USING btree ("archived_at");--> statement-breakpoint
CREATE INDEX "leads_updated_at_idx" ON "leads" USING btree ("updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "project_contacts_pair_idx" ON "project_contacts" USING btree ("project_id","contact_id");--> statement-breakpoint
CREATE INDEX "project_contacts_contact_id_idx" ON "project_contacts" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "projects_client_id_idx" ON "projects" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "projects_status_idx" ON "projects" USING btree ("status");--> statement-breakpoint
CREATE INDEX "projects_owner_id_idx" ON "projects" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "projects_lead_id_idx" ON "projects" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "projects_archived_at_idx" ON "projects" USING btree ("archived_at");--> statement-breakpoint
CREATE INDEX "projects_updated_at_idx" ON "projects" USING btree ("updated_at" DESC NULLS LAST);--> statement-breakpoint
-- ===========================================================================
-- Written by hand: what drizzle-kit does not generate, and what
-- docs/business-core.md marks as an invariant. The database enforces these,
-- not the code that happens to call it.
-- ===========================================================================

-- Business-core rows carry a version as well as updated_at, because optimistic
-- concurrency cannot be built on the timestamp: Postgres keeps microseconds
-- and a JavaScript Date does not, so `updated_at = $1` never matches what the
-- application read back. An integer compares exactly.
CREATE OR REPLACE FUNCTION bump_version() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  NEW.version = OLD.version + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER clients_bump_version BEFORE UPDATE ON "clients"
  FOR EACH ROW EXECUTE FUNCTION bump_version();
--> statement-breakpoint
CREATE TRIGGER contacts_bump_version BEFORE UPDATE ON "contacts"
  FOR EACH ROW EXECUTE FUNCTION bump_version();
--> statement-breakpoint
CREATE TRIGGER client_contacts_bump_version BEFORE UPDATE ON "client_contacts"
  FOR EACH ROW EXECUTE FUNCTION bump_version();
--> statement-breakpoint
CREATE TRIGGER leads_bump_version BEFORE UPDATE ON "leads"
  FOR EACH ROW EXECUTE FUNCTION bump_version();
--> statement-breakpoint
CREATE TRIGGER projects_bump_version BEFORE UPDATE ON "projects"
  FOR EACH ROW EXECUTE FUNCTION bump_version();
--> statement-breakpoint
CREATE TRIGGER project_contacts_bump_version BEFORE UPDATE ON "project_contacts"
  FOR EACH ROW EXECUTE FUNCTION bump_version();
--> statement-breakpoint

-- A lead records what its conversion produced. Declared here rather than in
-- the schema file because leads and projects reference each other and Drizzle
-- cannot express the cycle. Postgres has no trouble: the conversion inserts
-- the project first, then points the lead at it.
ALTER TABLE "leads"
  ADD CONSTRAINT "leads_project_id_projects_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint

-- At most one lead per inquiry. Two people pressing "Create lead" on the same
-- inquiry produce one lead, because the database decides rather than a read
-- that both of them passed.
CREATE UNIQUE INDEX "leads_one_per_inquiry_idx"
  ON "leads" ("inquiry_id")
  WHERE inquiry_id IS NOT NULL;
--> statement-breakpoint

-- At most one primary contact per client, and per project.
CREATE UNIQUE INDEX "client_contacts_one_primary_idx"
  ON "client_contacts" ("client_id")
  WHERE is_primary;
--> statement-breakpoint
CREATE UNIQUE INDEX "project_contacts_one_primary_idx"
  ON "project_contacts" ("project_id")
  WHERE is_primary;
--> statement-breakpoint

-- Case-insensitive name lookups, which is how search actually reads them.
CREATE INDEX "clients_name_lower_idx" ON "clients" (lower("name"));
--> statement-breakpoint
CREATE INDEX "contacts_name_lower_idx" ON "contacts" (lower("name"));
--> statement-breakpoint
CREATE INDEX "contacts_email_lower_idx" ON "contacts" (lower("email"));
--> statement-breakpoint
CREATE INDEX "leads_title_lower_idx" ON "leads" (lower("title"));
--> statement-breakpoint
CREATE INDEX "projects_name_lower_idx" ON "projects" (lower("name"));
--> statement-breakpoint

-- Audit is append-only, and the application having no code path to change it
-- is not enough. A stray statement — a future bug, a console, a well-meant
-- cleanup — must fail loudly rather than quietly rewrite history.
CREATE OR REPLACE FUNCTION audit_events_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION audit_events_reject_mutation();
--> statement-breakpoint

-- TRUNCATE does not fire row triggers, so without this one the whole log could
-- still be erased in a single statement. A statement trigger closes it.
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON "audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_reject_mutation();
