CREATE TABLE "presentation_approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workroom_id" uuid NOT NULL,
	"presentation_revision_id" uuid NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"requested_at" timestamp with time zone,
	"requested_by" text,
	"decided_at" timestamp with time zone,
	"decided_by_identity_id" text,
	"decided_by_name" text,
	"decline_reason" text,
	"content_hash_at_decision" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "presentation_approvals_status_check" CHECK (status IN ('requested', 'granted', 'declined', 'withdrawn')),
	CONSTRAINT "presentation_approvals_decided_shape_check" CHECK ((status IN ('requested', 'withdrawn') AND decided_at IS NULL) OR (status IN ('granted', 'declined') AND decided_at IS NOT NULL)),
	CONSTRAINT "presentation_approvals_decline_reason_check" CHECK ((status = 'declined' AND decline_reason IS NOT NULL AND char_length(decline_reason) BETWEEN 3 AND 2000) OR (status <> 'declined' AND decline_reason IS NULL))
);
--> statement-breakpoint
CREATE TABLE "presentation_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workroom_id" uuid NOT NULL,
	"presentation_id" uuid NOT NULL,
	"file_id" uuid,
	"kind" text NOT NULL,
	"caption" text,
	"body" text,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "presentation_items_kind_check" CHECK (kind IN ('file', 'note')),
	CONSTRAINT "presentation_items_shape_check" CHECK ((kind = 'file' AND file_id IS NOT NULL AND body IS NULL) OR (kind = 'note' AND file_id IS NULL AND body IS NOT NULL)),
	CONSTRAINT "presentation_items_position_check" CHECK (position >= 0),
	CONSTRAINT "presentation_items_caption_length_check" CHECK (caption IS NULL OR char_length(caption) <= 500),
	CONSTRAINT "presentation_items_body_length_check" CHECK (body IS NULL OR char_length(body) <= 4000)
);
--> statement-breakpoint
CREATE TABLE "presentation_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workroom_id" uuid NOT NULL,
	"presentation_revision_id" uuid NOT NULL,
	"revision_item_id" uuid,
	"status" text DEFAULT 'requested' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requested_by" text,
	"response_body" text,
	"responded_at" timestamp with time zone,
	"responded_by_identity_id" text,
	"responded_by_name" text,
	"resolution_note" text,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "presentation_reviews_status_check" CHECK (status IN ('requested', 'responded', 'resolved', 'withdrawn')),
	CONSTRAINT "presentation_reviews_response_shape_check" CHECK ((response_body IS NULL AND responded_at IS NULL) OR (response_body IS NOT NULL AND responded_at IS NOT NULL)),
	CONSTRAINT "presentation_reviews_response_length_check" CHECK (response_body IS NULL OR char_length(response_body) <= 8000),
	CONSTRAINT "presentation_reviews_resolution_length_check" CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 8000)
);
--> statement-breakpoint
CREATE TABLE "presentation_revision_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workroom_id" uuid NOT NULL,
	"presentation_revision_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"file_id" uuid,
	"display_name_snapshot" text,
	"caption" text,
	"body" text,
	CONSTRAINT "presentation_revision_items_workroom_id_id_key" UNIQUE("workroom_id","id"),
	CONSTRAINT "presentation_revision_items_kind_check" CHECK (kind IN ('file', 'note')),
	CONSTRAINT "presentation_revision_items_shape_check" CHECK ((kind = 'file' AND file_id IS NOT NULL AND body IS NULL) OR (kind = 'note' AND file_id IS NULL AND body IS NOT NULL)),
	CONSTRAINT "presentation_revision_items_position_check" CHECK (position >= 0)
);
--> statement-breakpoint
CREATE TABLE "presentation_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workroom_id" uuid NOT NULL,
	"presentation_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by" text,
	"published_by_name" text,
	CONSTRAINT "presentation_revisions_workroom_id_id_key" UNIQUE("workroom_id","id"),
	CONSTRAINT "presentation_revisions_number_check" CHECK (revision_number >= 1),
	CONSTRAINT "presentation_revisions_hash_length_check" CHECK (char_length(content_hash) = 64)
);
--> statement-breakpoint
CREATE TABLE "presentations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"workroom_id" uuid NOT NULL,
	"title" text NOT NULL,
	"intro" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"current_revision_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "presentations_workroom_id_id_key" UNIQUE("workroom_id","id"),
	CONSTRAINT "presentations_status_check" CHECK (status IN ('draft', 'published', 'unpublished')),
	CONSTRAINT "presentations_public_id_length_check" CHECK (char_length(public_id) = 26),
	CONSTRAINT "presentations_title_length_check" CHECK (char_length(title) BETWEEN 1 AND 200),
	CONSTRAINT "presentations_intro_length_check" CHECK (char_length(intro) <= 4000)
);
--> statement-breakpoint
CREATE TABLE "workroom_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"workroom_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"original_filename" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" bigint,
	"storage_key" text NOT NULL,
	"storage_etag" text,
	"preview_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"visibility" text DEFAULT 'internal' NOT NULL,
	"shared_at" timestamp with time zone,
	"supersedes_file_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workroom_files_workroom_id_id_key" UNIQUE("workroom_id","id"),
	CONSTRAINT "workroom_files_status_check" CHECK (status IN ('pending', 'ready')),
	CONSTRAINT "workroom_files_visibility_check" CHECK (visibility IN ('internal', 'shared')),
	CONSTRAINT "workroom_files_public_id_length_check" CHECK (char_length(public_id) = 26),
	CONSTRAINT "workroom_files_display_name_length_check" CHECK (char_length(display_name) BETWEEN 1 AND 200),
	CONSTRAINT "workroom_files_original_filename_length_check" CHECK (char_length(original_filename) BETWEEN 1 AND 400),
	CONSTRAINT "workroom_files_content_type_length_check" CHECK (char_length(content_type) BETWEEN 1 AND 200),
	CONSTRAINT "workroom_files_ready_shape_check" CHECK ((status = 'pending' AND byte_size IS NULL AND storage_etag IS NULL) OR (status = 'ready' AND byte_size IS NOT NULL AND storage_etag IS NOT NULL)),
	CONSTRAINT "workroom_files_byte_size_check" CHECK (byte_size IS NULL OR (byte_size > 0 AND byte_size <= 2147483648)),
	CONSTRAINT "workroom_files_shared_shape_check" CHECK ((visibility = 'internal' AND shared_at IS NULL) OR (visibility = 'shared' AND shared_at IS NOT NULL AND status = 'ready')),
	CONSTRAINT "workroom_files_key_shape_check" CHECK ((status = 'pending' AND storage_key LIKE 'pending/%') OR (status = 'ready' AND storage_key LIKE 'w/%'))
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_entity_type_check";--> statement-breakpoint
ALTER TABLE "workroom_activity" DROP CONSTRAINT "workroom_activity_kind_check";--> statement-breakpoint
ALTER TABLE "presentation_approvals" ADD CONSTRAINT "presentation_approvals_workroom_id_workrooms_id_fk" FOREIGN KEY ("workroom_id") REFERENCES "public"."workrooms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_approvals" ADD CONSTRAINT "presentation_approvals_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_approvals" ADD CONSTRAINT "presentation_approvals_decided_by_identity_id_client_identities_id_fk" FOREIGN KEY ("decided_by_identity_id") REFERENCES "public"."client_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_approvals" ADD CONSTRAINT "presentation_approvals_revision_fk" FOREIGN KEY ("workroom_id","presentation_revision_id") REFERENCES "public"."presentation_revisions"("workroom_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_items" ADD CONSTRAINT "presentation_items_workroom_id_workrooms_id_fk" FOREIGN KEY ("workroom_id") REFERENCES "public"."workrooms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_items" ADD CONSTRAINT "presentation_items_presentation_fk" FOREIGN KEY ("workroom_id","presentation_id") REFERENCES "public"."presentations"("workroom_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_items" ADD CONSTRAINT "presentation_items_file_fk" FOREIGN KEY ("workroom_id","file_id") REFERENCES "public"."workroom_files"("workroom_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_reviews" ADD CONSTRAINT "presentation_reviews_workroom_id_workrooms_id_fk" FOREIGN KEY ("workroom_id") REFERENCES "public"."workrooms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_reviews" ADD CONSTRAINT "presentation_reviews_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_reviews" ADD CONSTRAINT "presentation_reviews_responded_by_identity_id_client_identities_id_fk" FOREIGN KEY ("responded_by_identity_id") REFERENCES "public"."client_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_reviews" ADD CONSTRAINT "presentation_reviews_resolved_by_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_reviews" ADD CONSTRAINT "presentation_reviews_revision_fk" FOREIGN KEY ("workroom_id","presentation_revision_id") REFERENCES "public"."presentation_revisions"("workroom_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_reviews" ADD CONSTRAINT "presentation_reviews_item_fk" FOREIGN KEY ("workroom_id","revision_item_id") REFERENCES "public"."presentation_revision_items"("workroom_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_revision_items" ADD CONSTRAINT "presentation_revision_items_workroom_id_workrooms_id_fk" FOREIGN KEY ("workroom_id") REFERENCES "public"."workrooms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_revision_items" ADD CONSTRAINT "presentation_revision_items_revision_fk" FOREIGN KEY ("workroom_id","presentation_revision_id") REFERENCES "public"."presentation_revisions"("workroom_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_revision_items" ADD CONSTRAINT "presentation_revision_items_file_fk" FOREIGN KEY ("workroom_id","file_id") REFERENCES "public"."workroom_files"("workroom_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_revisions" ADD CONSTRAINT "presentation_revisions_workroom_id_workrooms_id_fk" FOREIGN KEY ("workroom_id") REFERENCES "public"."workrooms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_revisions" ADD CONSTRAINT "presentation_revisions_published_by_user_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_revisions" ADD CONSTRAINT "presentation_revisions_presentation_fk" FOREIGN KEY ("workroom_id","presentation_id") REFERENCES "public"."presentations"("workroom_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentations" ADD CONSTRAINT "presentations_workroom_id_workrooms_id_fk" FOREIGN KEY ("workroom_id") REFERENCES "public"."workrooms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentations" ADD CONSTRAINT "presentations_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentations" ADD CONSTRAINT "presentations_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workroom_files" ADD CONSTRAINT "workroom_files_workroom_id_workrooms_id_fk" FOREIGN KEY ("workroom_id") REFERENCES "public"."workrooms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workroom_files" ADD CONSTRAINT "workroom_files_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workroom_files" ADD CONSTRAINT "workroom_files_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workroom_files" ADD CONSTRAINT "workroom_files_supersedes_fk" FOREIGN KEY ("supersedes_file_id") REFERENCES "public"."workroom_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "presentation_approvals_workroom_idx" ON "presentation_approvals" USING btree ("workroom_id","status");--> statement-breakpoint
CREATE INDEX "presentation_approvals_revision_idx" ON "presentation_approvals" USING btree ("presentation_revision_id");--> statement-breakpoint
CREATE INDEX "presentation_items_presentation_idx" ON "presentation_items" USING btree ("presentation_id","position");--> statement-breakpoint
CREATE INDEX "presentation_items_file_idx" ON "presentation_items" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "presentation_reviews_workroom_idx" ON "presentation_reviews" USING btree ("workroom_id","status");--> statement-breakpoint
CREATE INDEX "presentation_reviews_revision_idx" ON "presentation_reviews" USING btree ("presentation_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "presentation_revision_items_position_idx" ON "presentation_revision_items" USING btree ("presentation_revision_id","position");--> statement-breakpoint
CREATE INDEX "presentation_revision_items_file_idx" ON "presentation_revision_items" USING btree ("file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "presentation_revisions_number_idx" ON "presentation_revisions" USING btree ("presentation_id","revision_number");--> statement-breakpoint
CREATE INDEX "presentation_revisions_latest_idx" ON "presentation_revisions" USING btree ("presentation_id","revision_number" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "presentations_public_id_idx" ON "presentations" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "presentations_workroom_idx" ON "presentations" USING btree ("workroom_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "presentations_status_idx" ON "presentations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "presentations_archived_at_idx" ON "presentations" USING btree ("archived_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workroom_files_public_id_idx" ON "workroom_files" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workroom_files_storage_key_idx" ON "workroom_files" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "workroom_files_workroom_idx" ON "workroom_files" USING btree ("workroom_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "workroom_files_status_idx" ON "workroom_files" USING btree ("status");--> statement-breakpoint
CREATE INDEX "workroom_files_visibility_idx" ON "workroom_files" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX "workroom_files_archived_at_idx" ON "workroom_files" USING btree ("archived_at");--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_entity_type_check" CHECK (entity_type IN ('client', 'contact', 'lead', 'project', 'client_contact', 'project_contact', 'inquiry', 'staff', 'workroom', 'workroom_member', 'workroom_invitation', 'client_identity', 'workroom_file', 'presentation', 'presentation_revision', 'presentation_review', 'presentation_approval'));--> statement-breakpoint
ALTER TABLE "workroom_activity" ADD CONSTRAINT "workroom_activity_kind_check" CHECK (kind IN ('workroom.opened', 'workroom.joined', 'workroom.access_granted', 'workroom.access_ended', 'project.status_changed', 'file.shared', 'presentation.published', 'presentation.revised', 'review.requested', 'review.received', 'approval.requested', 'approval.decided'));--> statement-breakpoint

-- ===========================================================================
-- Written by hand from here down. Everything above is drizzle-kit's output.
--
-- The generated part is additive throughout: seven new tables and two CHECK
-- constraints replaced to widen their allowed values. PostgreSQL cannot widen
-- a CHECK, so each is dropped and re-added — the same shape 0003 used. Both
-- take an ACCESS EXCLUSIVE lock and scan their table; `audit_events` is
-- append-only and therefore grows for ever, so that scan is the one to measure
-- before any future widening.
--
-- No column is dropped, renamed or retyped. No Build 001-004 row is touched.
-- Build 004 code runs unchanged against this schema: every existing insert is
-- still valid, so a code rollback without a schema rollback is safe.
--
-- What is added below is the part a generator cannot know:
--
--   * `bump_version` on the tables a person edits, and `set_updated_at` on the
--     ones they do not.
--   * Append-only triggers on revisions and revision items. Storage offers no
--     immutability of its own — the bucket has no versioning and no object
--     locks — so this is the whole of it.
--   * Transition and immutability triggers on approvals. A terminal decision
--     is never rewritten, and that is enforced here rather than believed by
--     the application.
--   * Two partial unique indexes for open reviews, because one index over a
--     nullable column would treat NULLs as distinct and permit exactly the
--     thing it was meant to prevent.
-- ===========================================================================

-- The same `bump_version` from 0002: it raises `version` and `updated_at`
-- together, so an edit composed against an older row is refused rather than
-- silently overwriting somebody.
CREATE TRIGGER workroom_files_bump_version BEFORE UPDATE ON "workroom_files"
  FOR EACH ROW EXECUTE FUNCTION bump_version();
--> statement-breakpoint
CREATE TRIGGER presentations_bump_version BEFORE UPDATE ON "presentations"
  FOR EACH ROW EXECUTE FUNCTION bump_version();
--> statement-breakpoint
CREATE TRIGGER presentation_reviews_bump_version BEFORE UPDATE ON "presentation_reviews"
  FOR EACH ROW EXECUTE FUNCTION bump_version();
--> statement-breakpoint

-- Draft items carry no `version`: they are edited as a set, through their
-- presentation, whose version guards the whole edit. They still want
-- `updated_at` kept without the caller remembering.
CREATE TRIGGER presentation_items_set_updated_at BEFORE UPDATE ON "presentation_items"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- ------------------------------------------------------------ immutability

-- A Revision is what one person saw at one moment, and an approval names one.
-- If a revision could be edited, "approved" would mean whatever the row says
-- today rather than what was agreed. Refused for the same reason `audit_events`
-- is, and by the same shape of trigger.
CREATE OR REPLACE FUNCTION presentation_revisions_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'presentation revisions are immutable: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER presentation_revisions_immutable
  BEFORE UPDATE OR DELETE ON "presentation_revisions"
  FOR EACH ROW EXECUTE FUNCTION presentation_revisions_reject_mutation();
--> statement-breakpoint

-- TRUNCATE does not fire row triggers, so without a statement trigger every
-- revision could still be erased in one statement.
CREATE TRIGGER presentation_revisions_no_truncate
  BEFORE TRUNCATE ON "presentation_revisions"
  FOR EACH STATEMENT EXECUTE FUNCTION presentation_revisions_reject_mutation();
--> statement-breakpoint

-- The items are the revision. Protecting the parent and leaving its contents
-- editable would protect nothing.
CREATE TRIGGER presentation_revision_items_immutable
  BEFORE UPDATE OR DELETE ON "presentation_revision_items"
  FOR EACH ROW EXECUTE FUNCTION presentation_revisions_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER presentation_revision_items_no_truncate
  BEFORE TRUNCATE ON "presentation_revision_items"
  FOR EACH STATEMENT EXECUTE FUNCTION presentation_revisions_reject_mutation();
--> statement-breakpoint

-- -------------------------------------------------------------- approvals

-- An approval moves once, from `requested` to exactly one terminal state, and
-- then never again:
--
--     requested --> granted    terminal
--               --> declined   terminal
--               --> withdrawn  terminal
--
-- A new business decision about changed work requires a new Revision. There is
-- deliberately no path that rewrites a terminal one.
CREATE OR REPLACE FUNCTION presentation_approvals_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'approvals are business history: DELETE is not permitted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'approvals are business history: TRUNCATE is not permitted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status <> 'requested' THEN
    RAISE EXCEPTION 'approval % is already %, and a decision is never rewritten',
      OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.status NOT IN ('granted', 'declined', 'withdrawn') THEN
    RAISE EXCEPTION 'approval % may only move to granted, declined or withdrawn', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The things that identify the decision may not be moved underneath it.
  IF NEW.id <> OLD.id
     OR NEW.workroom_id <> OLD.workroom_id
     OR NEW.presentation_revision_id <> OLD.presentation_revision_id THEN
    RAISE EXCEPTION 'an approval may not be repointed at different work'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER presentation_approvals_guard_row
  BEFORE UPDATE OR DELETE ON "presentation_approvals"
  FOR EACH ROW EXECUTE FUNCTION presentation_approvals_guard();
--> statement-breakpoint

CREATE TRIGGER presentation_approvals_no_truncate
  BEFORE TRUNCATE ON "presentation_approvals"
  FOR EACH STATEMENT EXECUTE FUNCTION presentation_approvals_guard();
--> statement-breakpoint

-- At most one live approval per Revision. Two tabs pressing Approve produce one
-- approval and one clean refusal, decided by the database rather than by a read
-- both of them passed. `withdrawn` is excluded so a withdrawn request can be
-- asked again.
CREATE UNIQUE INDEX "presentation_approvals_one_live_idx"
  ON "presentation_approvals" ("presentation_revision_id")
  WHERE status IN ('requested', 'granted', 'declined');
--> statement-breakpoint

-- ---------------------------------------------------------------- reviews

-- Two indexes, not one, and this is the whole reason:
--
-- A unique index treats NULLs as DISTINCT, so a single index over
-- (revision_id, revision_item_id) would permit unlimited revision-level
-- reviews — precisely the case it was written to prevent. PostgreSQL 16 offers
-- NULLS NOT DISTINCT, which would also work; two partial indexes say what they
-- mean at the point of definition and do not depend on remembering a server
-- version feature.
CREATE UNIQUE INDEX "presentation_reviews_open_revision_idx"
  ON "presentation_reviews" ("presentation_revision_id")
  WHERE revision_item_id IS NULL AND status IN ('requested', 'responded');
--> statement-breakpoint

CREATE UNIQUE INDEX "presentation_reviews_open_item_idx"
  ON "presentation_reviews" ("presentation_revision_id", "revision_item_id")
  WHERE revision_item_id IS NOT NULL AND status IN ('requested', 'responded');
