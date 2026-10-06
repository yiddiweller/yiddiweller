-- Stage G1 — the durable notification foundation.
--
-- One operational table, `notification_deliveries`: one row per notification
-- event and intended recipient, holding **structured intent and delivery state
-- only** — no address, subject, body, rendered mail, title, name, feedback
-- text, anchor or URL. A dispatcher renders at send time from what is true
-- then. Not Audit, not Activity, not Review content.
--
-- Additive: nothing existing is rewritten and no existing row is touched. The
-- one change to an existing table is a UNIQUE (workroom_id, id) on
-- `presentation_reviews` — `id` is already its primary key, so the pair is
-- already unique and adding it cannot fail on any data — which is the target
-- the delivery's composite foreign key needs, so PostgreSQL itself refuses a
-- delivery whose round lives in another Workroom. It comes first: a foreign
-- key cannot name a key that does not exist yet.
--
-- G1 writes no rows. No Review action is wired to this table and nothing
-- dispatches from it; that is G2 and G3.
ALTER TABLE "presentation_reviews" ADD CONSTRAINT "presentation_reviews_workroom_id_id_key" UNIQUE("workroom_id","id");
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"workroom_id" uuid NOT NULL,
	"presentation_review_id" uuid NOT NULL,
	"requested_at" timestamp with time zone,
	"note_number" integer,
	"recipient_kind" text NOT NULL,
	"client_identity_id" text,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now(),
	"claimed_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"provider_message_id" text,
	"last_error" text,
	"suppressed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_deliveries_dedupe_key" UNIQUE("dedupe_key"),
	CONSTRAINT "notification_deliveries_kind_check" CHECK (kind IN ('review.requested', 'review.received')),
	CONSTRAINT "notification_deliveries_recipient_kind_check" CHECK (recipient_kind IN ('client', 'studio_inbox')),
	CONSTRAINT "notification_deliveries_status_check" CHECK (status IN ('pending', 'sending', 'sent', 'suppressed', 'failed')),
	CONSTRAINT "notification_deliveries_kind_shape_check" CHECK (CASE kind WHEN 'review.requested' THEN recipient_kind = 'client' AND requested_at IS NOT NULL AND note_number IS NULL WHEN 'review.received' THEN recipient_kind = 'studio_inbox' AND requested_at IS NULL AND (note_number IS NULL OR note_number >= 1) ELSE false END),
	CONSTRAINT "notification_deliveries_recipient_shape_check" CHECK (CASE recipient_kind WHEN 'client' THEN client_identity_id IS NOT NULL WHEN 'studio_inbox' THEN client_identity_id IS NULL ELSE false END),
	CONSTRAINT "notification_deliveries_status_shape_check" CHECK (CASE status WHEN 'pending' THEN next_attempt_at IS NOT NULL AND sent_at IS NULL AND suppressed_reason IS NULL WHEN 'sending' THEN claimed_at IS NOT NULL AND attempts >= 1 AND sent_at IS NULL AND suppressed_reason IS NULL WHEN 'sent' THEN sent_at IS NOT NULL AND attempts >= 1 AND suppressed_reason IS NULL AND last_error IS NULL WHEN 'suppressed' THEN suppressed_reason IS NOT NULL AND sent_at IS NULL WHEN 'failed' THEN last_error IS NOT NULL AND attempts >= 1 AND sent_at IS NULL AND suppressed_reason IS NULL ELSE false END),
	CONSTRAINT "notification_deliveries_suppressed_reason_check" CHECK (CASE WHEN suppressed_reason IS NULL THEN true ELSE suppressed_reason IN ('preview_capture', 'recipient_inactive', 'membership_revoked', 'workroom_unavailable', 'presentation_unavailable', 'withdrawn', 'closed', 'superseded', 'retracted', 'self_notification') END),
	CONSTRAINT "notification_deliveries_last_error_check" CHECK (CASE WHEN last_error IS NULL THEN true ELSE last_error IN ('network', 'rate_limited', 'provider_5xx', 'concurrent_idempotent_requests', 'validation_error', 'invalid_from_address', 'invalid_api_key', 'restricted_api_key', 'quota', 'unknown') END),
	CONSTRAINT "notification_deliveries_attempts_check" CHECK (attempts >= 0),
	CONSTRAINT "notification_deliveries_dedupe_key_check" CHECK (char_length(dedupe_key) BETWEEN 1 AND 200),
	CONSTRAINT "notification_deliveries_provider_message_id_check" CHECK (CASE WHEN provider_message_id IS NULL THEN true ELSE char_length(provider_message_id) <= 200 END)
);
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_client_identity_fk" FOREIGN KEY ("client_identity_id") REFERENCES "public"."client_identities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_review_fk" FOREIGN KEY ("workroom_id","presentation_review_id") REFERENCES "public"."presentation_reviews"("workroom_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_deliveries_due_idx" ON "notification_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "notification_deliveries_claimed_idx" ON "notification_deliveries" USING btree ("status","claimed_at");--> statement-breakpoint
CREATE INDEX "notification_deliveries_review_idx" ON "notification_deliveries" USING btree ("workroom_id","presentation_review_id");
