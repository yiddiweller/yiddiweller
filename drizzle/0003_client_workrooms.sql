-- ===========================================================================
-- Build 004 — client workrooms.
--
-- Ten new tables and three additive changes to `audit_events`. Nothing else in
-- the database is touched: no Build 001, 002 or 003 table loses a column, a
-- row or a constraint it depends on.
--
-- **There is exactly one DROP in this file**, and it is a CHECK
-- constraint that is re-added three statements later with four more allowed
-- values. PostgreSQL has no ALTER for widening a CHECK — constraints are ANDed,
-- so adding a second one would leave the old one still rejecting — which makes
-- drop-and-replace the only way to say it. No data is read, moved or removed by
-- either statement.
--
-- `actor_type` defaults to 'team_user', which backfills every existing audit
-- event correctly rather than by guess: before Build 004 there was no other
-- kind of actor. `client_actor_id` is a second column rather than a widening of
-- `actor_id` because a client is a row in a different table, and a schema that
-- pretended otherwise would be the first place that rule broke.
-- ===========================================================================

CREATE TABLE "auth_rate_limits" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"contact_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_identities_status_check" CHECK (status IN ('active', 'inactive'))
);
--> statement-breakpoint
CREATE TABLE "client_rate_limits" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workroom_activity" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workroom_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"actor_label" text,
	"subject" text,
	CONSTRAINT "workroom_activity_kind_check" CHECK (kind IN ('workroom.opened', 'workroom.joined', 'workroom.access_granted', 'workroom.access_ended', 'project.status_changed')),
	CONSTRAINT "workroom_activity_actor_label_length_check" CHECK (actor_label IS NULL OR char_length(actor_label) <= 160),
	CONSTRAINT "workroom_activity_subject_length_check" CHECK (subject IS NULL OR char_length(subject) <= 160)
);
--> statement-breakpoint
CREATE TABLE "workroom_invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workroom_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workroom_invitations_email_length_check" CHECK (char_length(email) BETWEEN 3 AND 254)
);
--> statement-breakpoint
CREATE TABLE "workroom_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workroom_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_by" text,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workroom_members_status_check" CHECK (status IN ('active', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "workrooms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workrooms_status_check" CHECK (status IN ('draft', 'published', 'unpublished')),
	CONSTRAINT "workrooms_title_length_check" CHECK (char_length(title) BETWEEN 1 AND 160),
	CONSTRAINT "workrooms_summary_length_check" CHECK (char_length(summary) <= 4000),
	CONSTRAINT "workrooms_public_id_length_check" CHECK (char_length(public_id) = 26)
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_entity_type_check";--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "actor_type" text DEFAULT 'team_user' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "client_actor_id" text;--> statement-breakpoint
ALTER TABLE "client_credentials" ADD CONSTRAINT "client_credentials_user_id_client_identities_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."client_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_identities" ADD CONSTRAINT "client_identities_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_sessions" ADD CONSTRAINT "client_sessions_user_id_client_identities_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."client_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workroom_activity" ADD CONSTRAINT "workroom_activity_workroom_id_workrooms_id_fk" FOREIGN KEY ("workroom_id") REFERENCES "public"."workrooms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workroom_invitations" ADD CONSTRAINT "workroom_invitations_workroom_id_workrooms_id_fk" FOREIGN KEY ("workroom_id") REFERENCES "public"."workrooms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workroom_invitations" ADD CONSTRAINT "workroom_invitations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workroom_invitations" ADD CONSTRAINT "workroom_invitations_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workroom_members" ADD CONSTRAINT "workroom_members_workroom_id_workrooms_id_fk" FOREIGN KEY ("workroom_id") REFERENCES "public"."workrooms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workroom_members" ADD CONSTRAINT "workroom_members_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workroom_members" ADD CONSTRAINT "workroom_members_granted_by_user_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workroom_members" ADD CONSTRAINT "workroom_members_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workrooms" ADD CONSTRAINT "workrooms_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workrooms" ADD CONSTRAINT "workrooms_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workrooms" ADD CONSTRAINT "workrooms_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_rate_limits_key_idx" ON "auth_rate_limits" USING btree ("key");--> statement-breakpoint
CREATE INDEX "client_credentials_user_id_idx" ON "client_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "client_identities_email_idx" ON "client_identities" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "client_identities_contact_id_idx" ON "client_identities" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "client_identities_status_idx" ON "client_identities" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "client_rate_limits_key_idx" ON "client_rate_limits" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "client_sessions_token_idx" ON "client_sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "client_sessions_user_id_idx" ON "client_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "client_sessions_expires_at_idx" ON "client_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "client_verifications_identifier_idx" ON "client_verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "client_verifications_expires_at_idx" ON "client_verifications" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "workroom_activity_workroom_idx" ON "workroom_activity" USING btree ("workroom_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "workroom_invitations_token_hash_idx" ON "workroom_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "workroom_invitations_workroom_id_idx" ON "workroom_invitations" USING btree ("workroom_id");--> statement-breakpoint
CREATE INDEX "workroom_invitations_contact_id_idx" ON "workroom_invitations" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "workroom_invitations_expires_at_idx" ON "workroom_invitations" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workroom_members_pair_idx" ON "workroom_members" USING btree ("workroom_id","contact_id");--> statement-breakpoint
CREATE INDEX "workroom_members_contact_id_idx" ON "workroom_members" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "workroom_members_status_idx" ON "workroom_members" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "workrooms_public_id_idx" ON "workrooms" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workrooms_project_id_idx" ON "workrooms" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "workrooms_status_idx" ON "workrooms" USING btree ("status");--> statement-breakpoint
CREATE INDEX "workrooms_archived_at_idx" ON "workrooms" USING btree ("archived_at");--> statement-breakpoint
CREATE INDEX "workrooms_updated_at_idx" ON "workrooms" USING btree ("updated_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_client_actor_id_client_identities_id_fk" FOREIGN KEY ("client_actor_id") REFERENCES "public"."client_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_client_actor_id_idx" ON "audit_events" USING btree ("client_actor_id");--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_type_check" CHECK (actor_type IN ('team_user', 'client_user', 'anonymous_session'));--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_shape_check" CHECK ((actor_type = 'team_user' AND client_actor_id IS NULL) OR (actor_type = 'client_user' AND actor_id IS NULL) OR (actor_type = 'anonymous_session' AND actor_id IS NULL AND client_actor_id IS NULL));--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_entity_type_check" CHECK (entity_type IN ('client', 'contact', 'lead', 'project', 'client_contact', 'project_contact', 'inquiry', 'staff', 'workroom', 'workroom_member', 'workroom_invitation', 'client_identity'));
--> statement-breakpoint
-- ===========================================================================
-- Written by hand: the invariants docs/workrooms.md marks as such, and the
-- version triggers the concurrency model depends on. PostgreSQL enforces
-- these, not the code that happens to call it.
-- ===========================================================================

-- The same `bump_version` from 0002: it raises `version` and `updated_at`
-- together, so an edit composed against an older row is refused rather than
-- silently overwriting somebody.
CREATE TRIGGER workrooms_bump_version BEFORE UPDATE ON "workrooms"
  FOR EACH ROW EXECUTE FUNCTION bump_version();
--> statement-breakpoint
CREATE TRIGGER workroom_members_bump_version BEFORE UPDATE ON "workroom_members"
  FOR EACH ROW EXECUTE FUNCTION bump_version();
--> statement-breakpoint

-- `workroom_invitations` carries no version — an invitation is created,
-- accepted or revoked, never edited — but it still wants `updated_at` kept.
CREATE TRIGGER workroom_invitations_set_updated_at BEFORE UPDATE ON "workroom_invitations"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER client_identities_set_updated_at BEFORE UPDATE ON "client_identities"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER client_sessions_set_updated_at BEFORE UPDATE ON "client_sessions"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER client_credentials_set_updated_at BEFORE UPDATE ON "client_credentials"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER client_verifications_set_updated_at BEFORE UPDATE ON "client_verifications"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- At most one open invitation per Workroom and Contact. Two people pressing
-- "Invite" at the same moment produce one invitation, because the database
-- decides rather than a read that both of them passed.
CREATE UNIQUE INDEX "workroom_invitations_one_open_idx"
  ON "workroom_invitations" ("workroom_id", "contact_id")
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
--> statement-breakpoint

-- Case-insensitive lookups of the access email, which is how sign-in reads it.
CREATE INDEX "client_identities_email_lower_idx" ON "client_identities" (lower("email"));
