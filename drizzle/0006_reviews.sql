-- Stage C — Reviews.
--
-- **Corrective, not additive, and this is the last moment it is free.**
-- `presentation_reviews` shipped in `0004` carrying a one-response model that
-- the Stage C architecture replaces: a Review is now a *round* holding many
-- feedback notes with replies, not a row holding one reply. Nothing has ever
-- written to it — beta's copy is empty and production does not have the table
-- at all, because production is Build 004 and `0004` has never run there. So
-- this drops eight columns rather than migrating data, and the guard below
-- refuses to run at all if that assumption has stopped being true.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM presentation_reviews) THEN
    RAISE EXCEPTION
      'presentation_reviews is not empty: 0006 rewrites this table and was only ever safe to run before Reviews shipped'
      USING ERRCODE = 'restrict_violation';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "presentation_review_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workroom_id" uuid NOT NULL,
	"presentation_review_id" uuid NOT NULL,
	"presentation_revision_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"parent_note_id" uuid,
	"is_root" boolean NOT NULL,
	"parent_is_root" boolean,
	"revision_item_id" uuid,
	"anchor" jsonb,
	"body" text NOT NULL,
	"author_side" text NOT NULL,
	"author_user_id" text,
	"author_identity_id" text,
	"author_name" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_side" text,
	"resolved_by_user_id" text,
	"resolved_by_identity_id" text,
	"resolved_by_name" text,
	"edited_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "presentation_review_notes_id_is_root_key" UNIQUE("id","is_root"),
	CONSTRAINT "presentation_review_notes_review_id_key" UNIQUE("presentation_review_id","id"),
	CONSTRAINT "presentation_review_notes_number_key" UNIQUE("presentation_review_id","number"),
	CONSTRAINT "presentation_review_notes_number_check" CHECK (number >= 1),
	CONSTRAINT "presentation_review_notes_body_length_check" CHECK (char_length(body) BETWEEN 1 AND 8000),
	CONSTRAINT "presentation_review_notes_is_root_check" CHECK (is_root = (parent_note_id IS NULL)),
	CONSTRAINT "presentation_review_notes_parent_is_root_check" CHECK (parent_is_root IS NOT DISTINCT FROM (CASE WHEN parent_note_id IS NULL THEN NULL ELSE true END)),
	CONSTRAINT "presentation_review_notes_author_side_check" CHECK (author_side IN ('studio', 'client')),
	CONSTRAINT "presentation_review_notes_author_shape_check" CHECK (NOT (author_user_id IS NOT NULL AND author_identity_id IS NOT NULL) AND (author_side <> 'studio' OR author_identity_id IS NULL) AND (author_side <> 'client' OR author_user_id IS NULL)),
	CONSTRAINT "presentation_review_notes_root_is_client_check" CHECK (author_side = 'client' OR parent_note_id IS NOT NULL),
	CONSTRAINT "presentation_review_notes_reply_shape_check" CHECK (parent_note_id IS NULL OR (anchor IS NULL AND revision_item_id IS NULL AND resolved_at IS NULL AND resolved_by_side IS NULL AND resolved_by_user_id IS NULL AND resolved_by_identity_id IS NULL AND resolved_by_name IS NULL)),
	CONSTRAINT "presentation_review_notes_anchor_subject_check" CHECK (anchor IS NULL OR revision_item_id IS NOT NULL),
	CONSTRAINT "presentation_review_notes_anchor_shape_check" CHECK (anchor IS NULL OR (jsonb_typeof(anchor) = 'object' AND (anchor->>'kind') IN ('point', 'region', 'time') AND CASE anchor->>'kind'   WHEN 'point' THEN jsonb_exists(anchor, 'x') AND jsonb_exists(anchor, 'y')   WHEN 'region' THEN jsonb_exists(anchor, 'x') AND jsonb_exists(anchor, 'y')     AND jsonb_exists(anchor, 'w') AND jsonb_exists(anchor, 'h')   WHEN 'time' THEN jsonb_exists(anchor, 't')   ELSE false END AND (NOT jsonb_exists(anchor, 'x') OR (jsonb_typeof(anchor->'x') = 'number'   AND (anchor->>'x')::numeric BETWEEN 0 AND 1)) AND (NOT jsonb_exists(anchor, 'y') OR (jsonb_typeof(anchor->'y') = 'number'   AND (anchor->>'y')::numeric BETWEEN 0 AND 1)) AND (NOT jsonb_exists(anchor, 'w') OR (jsonb_typeof(anchor->'w') = 'number'   AND (anchor->>'w')::numeric BETWEEN 0 AND 1)) AND (NOT jsonb_exists(anchor, 'h') OR (jsonb_typeof(anchor->'h') = 'number'   AND (anchor->>'h')::numeric BETWEEN 0 AND 1)) AND (NOT jsonb_exists(anchor, 't') OR (jsonb_typeof(anchor->'t') = 'number'   AND (anchor->>'t')::numeric >= 0)) AND (NOT jsonb_exists(anchor, 't2') OR (jsonb_typeof(anchor->'t2') = 'number'   AND jsonb_exists(anchor, 't')   AND (anchor->>'t2')::numeric > (anchor->>'t')::numeric)))),
	CONSTRAINT "presentation_review_notes_resolved_side_check" CHECK (resolved_by_side IS NULL OR resolved_by_side IN ('studio', 'client')),
	CONSTRAINT "presentation_review_notes_resolved_shape_check" CHECK ((resolved_at IS NULL AND resolved_by_side IS NULL AND resolved_by_name IS NULL AND resolved_by_user_id IS NULL AND resolved_by_identity_id IS NULL) OR (resolved_at IS NOT NULL AND resolved_by_side IS NOT NULL AND resolved_by_name IS NOT NULL AND NOT (resolved_by_user_id IS NOT NULL AND resolved_by_identity_id IS NOT NULL) AND (resolved_by_side <> 'studio' OR resolved_by_identity_id IS NULL) AND (resolved_by_side <> 'client' OR resolved_by_user_id IS NULL)))
);
--> statement-breakpoint
ALTER TABLE "presentation_reviews" DROP CONSTRAINT "presentation_reviews_response_shape_check";
--> statement-breakpoint
ALTER TABLE "presentation_reviews" DROP CONSTRAINT "presentation_reviews_response_length_check";
--> statement-breakpoint
ALTER TABLE "presentation_reviews" DROP CONSTRAINT "presentation_reviews_resolution_length_check";
--> statement-breakpoint
ALTER TABLE "presentation_reviews" DROP CONSTRAINT "presentation_reviews_status_check";
--> statement-breakpoint
ALTER TABLE "presentation_reviews" DROP CONSTRAINT "presentation_reviews_responded_by_identity_id_client_identities_id_fk";
--> statement-breakpoint
ALTER TABLE "presentation_reviews" DROP CONSTRAINT "presentation_reviews_resolved_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "presentation_reviews" DROP CONSTRAINT "presentation_reviews_item_fk";
--> statement-breakpoint
DROP INDEX "presentation_reviews_revision_idx";
--> statement-breakpoint
ALTER TABLE "presentation_reviews" ALTER COLUMN "status" SET DEFAULT 'open';
--> statement-breakpoint
ALTER TABLE "presentation_reviews" DROP COLUMN "revision_item_id";
--> statement-breakpoint
ALTER TABLE "presentation_reviews" DROP COLUMN "response_body";
--> statement-breakpoint
ALTER TABLE "presentation_reviews" DROP COLUMN "responded_at";
--> statement-breakpoint
ALTER TABLE "presentation_reviews" DROP COLUMN "responded_by_identity_id";
--> statement-breakpoint
ALTER TABLE "presentation_reviews" DROP COLUMN "responded_by_name";
--> statement-breakpoint
ALTER TABLE "presentation_reviews" DROP COLUMN "resolution_note";
--> statement-breakpoint
ALTER TABLE "presentation_reviews" DROP COLUMN "resolved_at";
--> statement-breakpoint
ALTER TABLE "presentation_reviews" DROP COLUMN "resolved_by";
--> statement-breakpoint
ALTER TABLE "presentation_reviews" ADD CONSTRAINT "presentation_reviews_revision_id_key" UNIQUE("presentation_revision_id");
--> statement-breakpoint
ALTER TABLE "presentation_reviews" ADD CONSTRAINT "presentation_reviews_workroom_id_revision_key" UNIQUE("workroom_id","id","presentation_revision_id");
--> statement-breakpoint
ALTER TABLE "presentation_revision_items" ADD CONSTRAINT "presentation_revision_items_revision_id_key" UNIQUE("workroom_id","presentation_revision_id","id");
--> statement-breakpoint
ALTER TABLE "presentation_reviews" ADD COLUMN "closed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "presentation_reviews" ADD COLUMN "closed_reason" text;
--> statement-breakpoint
ALTER TABLE "presentation_reviews" ADD COLUMN "closed_by_user_id" text;
--> statement-breakpoint
ALTER TABLE "presentation_reviews" ADD COLUMN "closed_by_revision_id" uuid;
--> statement-breakpoint
ALTER TABLE "presentation_reviews" ADD COLUMN "withdrawn_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "presentation_review_notes" ADD CONSTRAINT "presentation_review_notes_workroom_id_workrooms_id_fk" FOREIGN KEY ("workroom_id") REFERENCES "public"."workrooms"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "presentation_review_notes" ADD CONSTRAINT "presentation_review_notes_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "presentation_review_notes" ADD CONSTRAINT "presentation_review_notes_author_identity_id_client_identities_id_fk" FOREIGN KEY ("author_identity_id") REFERENCES "public"."client_identities"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "presentation_review_notes" ADD CONSTRAINT "presentation_review_notes_resolved_by_user_id_user_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "presentation_review_notes" ADD CONSTRAINT "presentation_review_notes_resolved_by_identity_id_client_identities_id_fk" FOREIGN KEY ("resolved_by_identity_id") REFERENCES "public"."client_identities"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "presentation_review_notes" ADD CONSTRAINT "presentation_review_notes_review_fk" FOREIGN KEY ("workroom_id","presentation_review_id","presentation_revision_id") REFERENCES "public"."presentation_reviews"("workroom_id","id","presentation_revision_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "presentation_review_notes" ADD CONSTRAINT "presentation_review_notes_item_fk" FOREIGN KEY ("workroom_id","presentation_revision_id","revision_item_id") REFERENCES "public"."presentation_revision_items"("workroom_id","presentation_revision_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "presentation_review_notes" ADD CONSTRAINT "presentation_review_notes_parent_fk" FOREIGN KEY ("presentation_review_id","parent_note_id") REFERENCES "public"."presentation_review_notes"("presentation_review_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "presentation_review_notes" ADD CONSTRAINT "presentation_review_notes_parent_is_root_fk" FOREIGN KEY ("parent_note_id","parent_is_root") REFERENCES "public"."presentation_review_notes"("id","is_root") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "presentation_reviews" ADD CONSTRAINT "presentation_reviews_closed_by_user_id_user_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "presentation_reviews" ADD CONSTRAINT "presentation_reviews_closed_by_revision_fk" FOREIGN KEY ("workroom_id","closed_by_revision_id") REFERENCES "public"."presentation_revisions"("workroom_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "presentation_review_notes_review_idx" ON "presentation_review_notes" USING btree ("workroom_id","presentation_review_id");
--> statement-breakpoint
CREATE INDEX "presentation_review_notes_parent_idx" ON "presentation_review_notes" USING btree ("parent_note_id");
--> statement-breakpoint
ALTER TABLE "presentation_reviews" ADD CONSTRAINT "presentation_reviews_status_check" CHECK (status IN ('open', 'closed', 'withdrawn'));
--> statement-breakpoint
ALTER TABLE "presentation_reviews" ADD CONSTRAINT "presentation_reviews_closure_shape_check" CHECK (CASE WHEN status = 'closed' THEN closed_at IS NOT NULL AND closed_reason IS NOT NULL AND ((closed_reason = 'staff' AND closed_by_revision_id IS NULL) OR (closed_reason = 'superseded' AND closed_by_revision_id IS NOT NULL AND closed_by_user_id IS NULL)) ELSE closed_at IS NULL AND closed_reason IS NULL AND closed_by_user_id IS NULL AND closed_by_revision_id IS NULL END);
--> statement-breakpoint
ALTER TABLE "presentation_reviews" ADD CONSTRAINT "presentation_reviews_withdrawn_shape_check" CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "presentation_reviews" ADD CONSTRAINT "presentation_reviews_superseded_by_other_check" CHECK (closed_by_revision_id IS NULL OR closed_by_revision_id <> presentation_revision_id);
-- ==========================================================================
--  Everything below is hand-written. Drizzle has no vocabulary for a trigger,
--  and these are where the model's harder promises actually live.
-- ==========================================================================

-- ------------------------------------------------------- review lifecycle

-- One Review round per published Revision, **ever** — and a UNIQUE constraint
-- only says that for as long as nobody deletes the row. The rows most likely to
-- look disposable are exactly the ones whose existence is the record: a round
-- withdrawn before anybody wrote, a round closed with no notes, a request never
-- answered. Deleting one would free the Revision to be reviewed again and erase
-- the lifecycle it existed to hold.
--
-- The transitions, and there are no others:
--
--     (no row) --request--> open --staff close----> closed/staff  <--> open
--                                --publish N+1----> closed/superseded  TERMINAL
--                                --withdraw-------> withdrawn      <--> open
--
-- Reopening is the domain's to allow, and only while that Revision is still the
-- Presentation's current one — a condition on another table, so it is checked
-- there rather than here. What *is* checked here is that a supersession can
-- never be undone, including by the two-step route of rewriting the reason to
-- 'staff' first and reopening afterwards.
CREATE OR REPLACE FUNCTION presentation_reviews_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a review round is its revision''s lifecycle record: DELETE is not permitted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'a review round is its revision''s lifecycle record: TRUNCATE is not permitted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- What a round *is* never moves. Without this, a row could be re-pointed at
  -- another Revision and the one-round-per-Revision rule would mean nothing.
  IF NEW.id <> OLD.id
     OR NEW.workroom_id <> OLD.workroom_id
     OR NEW.presentation_revision_id <> OLD.presentation_revision_id THEN
    RAISE EXCEPTION 'a review round belongs to one revision in one workroom, permanently'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- A supersession is history. Not one field of it is rewritable, which closes
  -- the two-write loophole: 'superseded' -> 'staff', then closed -> open.
  IF OLD.status = 'closed' AND OLD.closed_reason = 'superseded' THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.closed_reason IS DISTINCT FROM OLD.closed_reason
       OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
       OR NEW.closed_by_revision_id IS DISTINCT FROM OLD.closed_by_revision_id
       OR NEW.closed_by_user_id IS DISTINCT FROM OLD.closed_by_user_id
       OR NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at THEN
      RAISE EXCEPTION 'this review closed when a newer revision was published: that is permanent'
        USING ERRCODE = 'restrict_violation';
    END IF;
    -- `version` and `updated_at` may still move; nothing else reached here.
    RETURN NEW;
  END IF;

  -- One closure is never relabelled as the other kind.
  IF OLD.status = 'closed' AND NEW.status = 'closed'
     AND NEW.closed_reason IS DISTINCT FROM OLD.closed_reason THEN
    RAISE EXCEPTION 'a closure reason is history and is not rewritten: % to %',
      OLD.closed_reason, NEW.closed_reason
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status = 'open' AND NEW.status IN ('closed', 'withdrawn'))
      OR (OLD.status = 'closed' AND OLD.closed_reason = 'staff' AND NEW.status = 'open')
      OR (OLD.status = 'withdrawn' AND NEW.status = 'open')
    ) THEN
      RAISE EXCEPTION 'a review round does not move from % to %', OLD.status, NEW.status
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER presentation_reviews_guard_row
  BEFORE UPDATE OR DELETE ON "presentation_reviews"
  FOR EACH ROW EXECUTE FUNCTION presentation_reviews_guard();
--> statement-breakpoint

-- TRUNCATE fires no row triggers, so without this the whole lifecycle record
-- could still be erased in one statement.
CREATE TRIGGER presentation_reviews_no_truncate
  BEFORE TRUNCATE ON "presentation_reviews"
  FOR EACH STATEMENT EXECUTE FUNCTION presentation_reviews_guard();
--> statement-breakpoint

-- ----------------------------------------------------------- review notes

CREATE TRIGGER presentation_review_notes_bump_version
  BEFORE UPDATE ON "presentation_review_notes"
  FOR EACH ROW EXECUTE FUNCTION bump_version();
--> statement-breakpoint

-- What the database can hold about a note, it holds. The rest is the domain's,
-- under the Review row lock, and the split is deliberate rather than partial:
--
--   here            identity, subject and authorship never change; the body is
--                   correctable for fifteen minutes and then never; a removal
--                   may only be made inside that window and may never be undone
--   the domain      no edit and no removal once a reply exists, the round must
--                   be open, and the actor must be the author — all of which
--                   need another row, which a per-row trigger should not be
--                   paying for on every write
--
-- Nothing below is a partial version of a domain rule. A CHECK that half-holds
-- a relational invariant reads like protection and is not.
CREATE OR REPLACE FUNCTION presentation_review_notes_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'review notes are business history: DELETE is not permitted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'review notes are business history: TRUNCATE is not permitted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- What the note is, which round and revision it belongs to, where it sits in
  -- the thread, and what it points at. `presentation_revision_id` is in here
  -- because it is half of the proof that an anchor belongs to the exact
  -- revision reviewed; letting it move would unpick that.
  IF NEW.id <> OLD.id
     OR NEW.workroom_id <> OLD.workroom_id
     OR NEW.presentation_review_id <> OLD.presentation_review_id
     OR NEW.presentation_revision_id <> OLD.presentation_revision_id
     OR NEW.number <> OLD.number
     OR NEW.is_root <> OLD.is_root
     OR NEW.parent_note_id IS DISTINCT FROM OLD.parent_note_id
     OR NEW.parent_is_root IS DISTINCT FROM OLD.parent_is_root
     OR NEW.created_at <> OLD.created_at
     OR NEW.revision_item_id IS DISTINCT FROM OLD.revision_item_id
     OR NEW.anchor IS DISTINCT FROM OLD.anchor THEN
    RAISE EXCEPTION 'what a review note is, and what it points at, do not change'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Authorship is the durable fact. The actor keys are joins and are allowed to
  -- go null when somebody leaves the studio or an identity is removed — that is
  -- `ON DELETE set null` doing its job, and it is why `author_side` and
  -- `author_name` exist. Anything else is a rewrite of who spoke.
  IF NEW.author_side <> OLD.author_side
     OR NEW.author_name <> OLD.author_name
     OR (NEW.author_user_id IS DISTINCT FROM OLD.author_user_id
         AND NEW.author_user_id IS NOT NULL)
     OR (NEW.author_identity_id IS DISTINCT FROM OLD.author_identity_id
         AND NEW.author_identity_id IS NOT NULL) THEN
    RAISE EXCEPTION 'a review note''s author does not change'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.body IS DISTINCT FROM OLD.body THEN
    IF OLD.removed_at IS NOT NULL THEN
      RAISE EXCEPTION 'a removed review note is not edited'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF now() - OLD.created_at > interval '15 minutes' THEN
      RAISE EXCEPTION 'a review note may only be corrected within 15 minutes of being written'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  -- Removal is additive: it writes a timestamp *beside* the body rather than
  -- over it, so the record is not falsified and the immutability rule above
  -- needs no exception. No projection ever returns a removed body to either
  -- surface, which is where the client-facing promise is actually kept.
  IF OLD.removed_at IS NOT NULL AND NEW.removed_at IS DISTINCT FROM OLD.removed_at THEN
    RAISE EXCEPTION 'a removal is permanent: removed_at cannot be changed or cleared'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL
     AND now() - OLD.created_at > interval '15 minutes' THEN
    RAISE EXCEPTION 'a review note may only be removed within 15 minutes of being written'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- A tombstone takes no new resolution state. The resolver foreign keys are
  -- left out on purpose, so `ON DELETE set null` still works on a note that was
  -- resolved before it was removed.
  IF OLD.removed_at IS NOT NULL
     AND (NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
          OR NEW.resolved_by_side IS DISTINCT FROM OLD.resolved_by_side
          OR NEW.resolved_by_name IS DISTINCT FROM OLD.resolved_by_name) THEN
    RAISE EXCEPTION 'a removed review note takes no new resolution state'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER presentation_review_notes_guard_row
  BEFORE UPDATE OR DELETE ON "presentation_review_notes"
  FOR EACH ROW EXECUTE FUNCTION presentation_review_notes_guard();
--> statement-breakpoint

CREATE TRIGGER presentation_review_notes_no_truncate
  BEFORE TRUNCATE ON "presentation_review_notes"
  FOR EACH STATEMENT EXECUTE FUNCTION presentation_review_notes_guard();
