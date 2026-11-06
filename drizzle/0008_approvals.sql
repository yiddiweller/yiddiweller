-- Stage H1 — the Approvals foundation.
--
-- **Corrective, not additive, exactly as `0006` was for Reviews.**
-- `presentation_approvals` shipped in `0004` carrying a one-decider model that
-- the H0 architecture replaces: a request is now asked of **named** client
-- members, chosen by Studio for that one request, each of whom decides once —
-- not "any active member", not one decider, and with no mandatory reason for
-- asking for changes. Nothing has ever written to the table: no product code
-- reads or writes it, beta's copy is empty, and production does not have it at
-- all, because production is Build 004 and `0004` has never run there. So this
-- drops five columns rather than migrating data, and the guard below refuses to
-- run at all if that assumption has stopped being true. **No row is migrated,
-- silently or otherwise.**
--
-- The second guard is the same promise about the Activity vocabulary: the
-- dormant `approval.decided` is replaced by `approval.approved` and
-- `approval.changes_requested`, and narrowing a CHECK is only safe while no row
-- uses the value it removes. Nothing has ever written one.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM presentation_approvals) THEN
    RAISE EXCEPTION
      'presentation_approvals is not empty: 0008 rewrites this table and was only ever safe to run before Approvals shipped'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM workroom_activity WHERE kind = 'approval.decided') THEN
    RAISE EXCEPTION
      'workroom_activity holds approval.decided: 0008 removes that kind and was only ever safe to run before anything wrote it'
      USING ERRCODE = 'restrict_violation';
  END IF;
END $$;
--> statement-breakpoint
-- The named approver's composite foreign key targets this pair, and a foreign
-- key cannot name a key that does not exist yet, so it comes first. `id` is
-- already the primary key, so the pair is already unique.
ALTER TABLE "presentation_approvals" ADD CONSTRAINT "presentation_approvals_workroom_id_id_key" UNIQUE("workroom_id","id");--> statement-breakpoint
CREATE TABLE "presentation_approval_approvers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workroom_id" uuid NOT NULL,
	"presentation_approval_id" uuid NOT NULL,
	"client_identity_id" text NOT NULL,
	"display_name" text NOT NULL,
	"decision" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "presentation_approval_approvers_identity_key" UNIQUE("presentation_approval_id","client_identity_id"),
	CONSTRAINT "presentation_approval_approvers_decision_check" CHECK (CASE WHEN decision IS NULL THEN true ELSE decision IN ('approved', 'changes_requested') END),
	CONSTRAINT "presentation_approval_approvers_decided_shape_check" CHECK ((decision IS NULL) = (decided_at IS NULL)),
	CONSTRAINT "presentation_approval_approvers_display_name_check" CHECK (char_length(display_name) BETWEEN 1 AND 160)
);
--> statement-breakpoint
ALTER TABLE "presentation_approvals" DROP CONSTRAINT "presentation_approvals_decided_shape_check";--> statement-breakpoint
ALTER TABLE "presentation_approvals" DROP CONSTRAINT "presentation_approvals_decline_reason_check";--> statement-breakpoint
ALTER TABLE "presentation_approvals" DROP CONSTRAINT "presentation_approvals_status_check";--> statement-breakpoint
ALTER TABLE "workroom_activity" DROP CONSTRAINT "workroom_activity_kind_check";--> statement-breakpoint
ALTER TABLE "presentation_approvals" DROP CONSTRAINT "presentation_approvals_decided_by_identity_id_client_identities_id_fk";
--> statement-breakpoint
ALTER TABLE "presentation_approvals" ALTER COLUMN "requested_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "presentation_approvals" ALTER COLUMN "requested_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "presentation_approvals" ADD COLUMN "content_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "presentation_approvals" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "presentation_approvals" ADD COLUMN "closed_by_user_id" text;--> statement-breakpoint
ALTER TABLE "presentation_approvals" ADD COLUMN "closed_by_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "presentation_approval_approvers" ADD CONSTRAINT "presentation_approval_approvers_workroom_id_workrooms_id_fk" FOREIGN KEY ("workroom_id") REFERENCES "public"."workrooms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_approval_approvers" ADD CONSTRAINT "presentation_approval_approvers_approval_fk" FOREIGN KEY ("workroom_id","presentation_approval_id") REFERENCES "public"."presentation_approvals"("workroom_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_approval_approvers" ADD CONSTRAINT "presentation_approval_approvers_identity_fk" FOREIGN KEY ("client_identity_id") REFERENCES "public"."client_identities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "presentation_approval_approvers_identity_idx" ON "presentation_approval_approvers" USING btree ("client_identity_id");--> statement-breakpoint
ALTER TABLE "presentation_approvals" ADD CONSTRAINT "presentation_approvals_closed_by_revision_fk" FOREIGN KEY ("workroom_id","closed_by_revision_id") REFERENCES "public"."presentation_revisions"("workroom_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_approvals" ADD CONSTRAINT "presentation_approvals_closed_by_user_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
DROP INDEX "presentation_approvals_one_live_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "presentation_approvals_one_standing_idx" ON "presentation_approvals" USING btree ("presentation_revision_id") WHERE status <> 'withdrawn';--> statement-breakpoint
ALTER TABLE "presentation_approvals" DROP COLUMN "decided_at";--> statement-breakpoint
ALTER TABLE "presentation_approvals" DROP COLUMN "decided_by_identity_id";--> statement-breakpoint
ALTER TABLE "presentation_approvals" DROP COLUMN "decided_by_name";--> statement-breakpoint
ALTER TABLE "presentation_approvals" DROP COLUMN "decline_reason";--> statement-breakpoint
ALTER TABLE "presentation_approvals" DROP COLUMN "content_hash_at_decision";--> statement-breakpoint
ALTER TABLE "presentation_approvals" ADD CONSTRAINT "presentation_approvals_closure_shape_check" CHECK (CASE status WHEN 'requested' THEN closed_at IS NULL AND closed_by_user_id IS NULL AND closed_by_revision_id IS NULL WHEN 'withdrawn' THEN closed_at IS NOT NULL AND closed_by_user_id IS NOT NULL AND closed_by_revision_id IS NULL WHEN 'superseded' THEN closed_at IS NOT NULL AND closed_by_revision_id IS NOT NULL AND closed_by_user_id IS NULL WHEN 'approved' THEN closed_at IS NOT NULL AND closed_by_user_id IS NULL AND closed_by_revision_id IS NULL WHEN 'changes_requested' THEN closed_at IS NOT NULL AND closed_by_user_id IS NULL AND closed_by_revision_id IS NULL ELSE false END);--> statement-breakpoint
ALTER TABLE "presentation_approvals" ADD CONSTRAINT "presentation_approvals_closed_after_request_check" CHECK (CASE WHEN closed_at IS NULL THEN true ELSE closed_at >= requested_at END);--> statement-breakpoint
ALTER TABLE "presentation_approvals" ADD CONSTRAINT "presentation_approvals_superseded_by_other_check" CHECK (CASE WHEN closed_by_revision_id IS NULL THEN true ELSE closed_by_revision_id <> presentation_revision_id END);--> statement-breakpoint
ALTER TABLE "presentation_approvals" ADD CONSTRAINT "presentation_approvals_hash_length_check" CHECK (char_length(content_hash) = 64);--> statement-breakpoint
ALTER TABLE "presentation_approvals" ADD CONSTRAINT "presentation_approvals_status_check" CHECK (status IN ('requested', 'approved', 'changes_requested', 'withdrawn', 'superseded'));--> statement-breakpoint
ALTER TABLE "workroom_activity" ADD CONSTRAINT "workroom_activity_kind_check" CHECK (kind IN ('workroom.opened', 'workroom.joined', 'workroom.access_granted', 'workroom.access_ended', 'project.status_changed', 'file.shared', 'presentation.published', 'presentation.revised', 'review.requested', 'review.received', 'approval.requested', 'approval.approved', 'approval.changes_requested'));
--> statement-breakpoint
-- ==========================================================================
--  Everything below is hand-written. Drizzle has no vocabulary for a trigger,
--  and these are where the model's harder promises actually live.
--
--  What the database holds, and what it leaves to the domain (H2):
--
--    here        a request begins `requested`, carrying its Revision's own
--                content hash, at the transaction's own time; it moves once,
--                to one terminal status, and never again; it is never deleted,
--                truncated or repointed; a supersession names a newer Revision
--                of the same Presentation; approvers are named with the request
--                and never after, are people with active access to that
--                Workroom, are never removed or moved, and decide once, only
--                while the request is `requested`; and at commit the request's
--                status agrees with its approvers' decisions
--    the domain  who may ask and who may decide, that the Revision is its
--                Presentation's current published one, which members are
--                eligible, Activity and Audit, and locking the request row
--                before any approver row — the order is presentations →
--                presentation_reviews → presentation_approvals →
--                presentation_approval_approvers, never upward
-- ==========================================================================

-- ------------------------------------------------------- request lifecycle

--     requested --> approved           terminal
--               --> changes_requested  terminal
--               --> withdrawn          terminal (the Revision may be asked again)
--               --> superseded         terminal
--
-- The function and both triggers already exist from `0004`; only the body
-- changes, to the new vocabulary and the new closure fields.
CREATE OR REPLACE FUNCTION presentation_approvals_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'approval requests are business history: DELETE is not permitted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'approval requests are business history: TRUNCATE is not permitted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- What a request is never moves: which Revision, in which Workroom, with
  -- which content, asked when. Without this a row could be repointed at other
  -- work and every decision on it would silently mean something else.
  IF NEW.id <> OLD.id
     OR NEW.workroom_id <> OLD.workroom_id
     OR NEW.presentation_revision_id <> OLD.presentation_revision_id
     OR NEW.content_hash <> OLD.content_hash
     OR NEW.requested_at <> OLD.requested_at
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'an approval request belongs to one revision in one workroom, permanently'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The requester is a join that `ON DELETE set null` may clear; it is never
  -- rewritten to somebody else.
  IF NEW.requested_by IS DISTINCT FROM OLD.requested_by AND NEW.requested_by IS NOT NULL THEN
    RAISE EXCEPTION 'who asked for an approval does not change'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Terminal is terminal: not its status, not one field of its closure.
  IF OLD.status <> 'requested' THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
       OR NEW.closed_by_user_id IS DISTINCT FROM OLD.closed_by_user_id
       OR NEW.closed_by_revision_id IS DISTINCT FROM OLD.closed_by_revision_id THEN
      RAISE EXCEPTION 'approval request % is already %, and that is final', OLD.id, OLD.status
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- From `requested`, the CHECKs hold the vocabulary and each status's shape.
  -- What they cannot see is the other table: a supersession is by a newer
  -- Revision of this same Presentation, never an older one or another's.
  -- (A supersession naming no Revision at all is the shape CHECK's to refuse.)
  IF NEW.status = 'superseded' AND NEW.closed_by_revision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM presentation_revisions mine
      JOIN presentation_revisions newer
        ON newer.presentation_id = mine.presentation_id
       AND newer.revision_number > mine.revision_number
     WHERE mine.id = NEW.presentation_revision_id
       AND newer.id = NEW.closed_by_revision_id
  ) THEN
    RAISE EXCEPTION 'an approval request is superseded only by a newer revision of the same presentation'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- A request is born `requested`, now, about content that is still exactly what
-- the Revision holds. `requested_at = now()` is what lets the approver trigger
-- below say "named in the same transaction as the request" without trusting
-- the caller: `now()` is the transaction's own start time.
CREATE OR REPLACE FUNCTION presentation_approvals_insert_guard() RETURNS trigger AS $$
DECLARE
  revision_hash text;
BEGIN
  IF NEW.status <> 'requested' THEN
    RAISE EXCEPTION 'an approval request begins as requested, not %', NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.requested_at <> now() THEN
    RAISE EXCEPTION 'an approval request is requested at the moment it is written'
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT content_hash INTO revision_hash
    FROM presentation_revisions
   WHERE id = NEW.presentation_revision_id AND workroom_id = NEW.workroom_id;
  -- No such Revision in this Workroom: the composite foreign key says so.
  IF FOUND AND revision_hash <> NEW.content_hash THEN
    RAISE EXCEPTION 'an approval request carries its revision''s own content hash'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER presentation_approvals_insert_row
  BEFORE INSERT ON "presentation_approvals"
  FOR EACH ROW EXECUTE FUNCTION presentation_approvals_insert_guard();
--> statement-breakpoint

-- --------------------------------------------------------- named approvers

-- Named once, decided once, never removed. A withdrawn or superseded request
-- keeps whatever partial decisions it held, as history.
CREATE OR REPLACE FUNCTION presentation_approval_approvers_guard() RETURNS trigger AS $$
DECLARE
  request_status text;
  request_time timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a named approver is part of the request: DELETE is not permitted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'a named approver is part of the request: TRUNCATE is not permitted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT status, requested_at INTO request_status, request_time
      FROM presentation_approvals
     WHERE id = NEW.presentation_approval_id AND workroom_id = NEW.workroom_id;
    -- No such request in this Workroom: the composite foreign key says so.
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;

    -- The set of people asked is part of the request. Adding one later would
    -- change what "everyone approved" means after some of them had decided.
    IF request_status <> 'requested' OR request_time <> now() THEN
      RAISE EXCEPTION 'approvers are named in the transaction that makes the request, and never after'
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.decision IS NOT NULL OR NEW.decided_at IS NOT NULL THEN
      RAISE EXCEPTION 'a named approver begins undecided'
        USING ERRCODE = 'restrict_violation';
    END IF;

    -- Tenancy, not eligibility: somebody who cannot open this Workroom at all
    -- cannot be named on a request inside it. Who is *eligible* is the
    -- domain's (H2), which knows more than this does.
    IF NOT EXISTS (
      SELECT 1
        FROM client_identities ci
        JOIN workroom_members m ON m.contact_id = ci.contact_id
       WHERE ci.id = NEW.client_identity_id
         AND ci.status = 'active'
         AND m.workroom_id = NEW.workroom_id
         AND m.status = 'active'
    ) THEN
      RAISE EXCEPTION 'an approver is a person with active access to this workroom'
        USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
  END IF;

  -- UPDATE. Who was named, on which request, in which Workroom, under which
  -- name, never moves.
  IF NEW.id <> OLD.id
     OR NEW.workroom_id <> OLD.workroom_id
     OR NEW.presentation_approval_id <> OLD.presentation_approval_id
     OR NEW.client_identity_id <> OLD.client_identity_id
     OR NEW.display_name <> OLD.display_name
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a named approver stays on one request, in one workroom, as the person named'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- A decision is made once: never changed, never reversed, never cleared,
  -- and its time never rewritten.
  IF OLD.decision IS NOT NULL THEN
    IF NEW.decision IS DISTINCT FROM OLD.decision
       OR NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
      RAISE EXCEPTION 'a decision is made once: it is never changed or cleared'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Still undecided. The CHECK keeps `decided_at` empty alongside it.
  IF NEW.decision IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT status, requested_at INTO request_status, request_time
    FROM presentation_approvals
   WHERE id = NEW.presentation_approval_id;
  IF request_status <> 'requested' THEN
    RAISE EXCEPTION 'a decision is made only while its request is requested; this one is %', request_status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.decided_at < request_time THEN
    RAISE EXCEPTION 'a decision cannot precede the request it answers'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER presentation_approval_approvers_guard_row
  BEFORE INSERT OR UPDATE OR DELETE ON "presentation_approval_approvers"
  FOR EACH ROW EXECUTE FUNCTION presentation_approval_approvers_guard();
--> statement-breakpoint

-- TRUNCATE fires no row triggers.
CREATE TRIGGER presentation_approval_approvers_no_truncate
  BEFORE TRUNCATE ON "presentation_approval_approvers"
  FOR EACH STATEMENT EXECUTE FUNCTION presentation_approval_approvers_guard();
--> statement-breakpoint

-- ------------------------------------------------------- the agreement rule

-- At commit, a request's status is what its approvers' decisions say it is —
-- the statement `agreesWithApprovers` in `lib/workrooms/approval-rules.ts`
-- makes, held here so no write can commit a request that disagrees:
--
--   approved            every named approver approved
--   changes_requested   exactly one asked for changes: the first ends it, and
--                       nobody decides after it
--   requested, withdrawn, superseded
--                       nobody asked for changes and not everybody approved
--   any status          at least one approver was named
--
-- Deferred, so the domain writes in the natural order — the approver's
-- decision, then the request's outcome — inside one transaction. It sees only
-- committed rows and its own, which is why the domain must lock the request row
-- before deciding: two deciders who did not serialise on it could each commit a
-- state the other's decision contradicts.
CREATE OR REPLACE FUNCTION presentation_approvals_agree() RETURNS trigger AS $$
DECLARE
  target uuid;
  request_status text;
  total integer;
  approved integer;
  changes integer;
BEGIN
  IF TG_TABLE_NAME = 'presentation_approvals' THEN
    target := NEW.id;
  ELSE
    target := NEW.presentation_approval_id;
  END IF;

  SELECT status INTO request_status FROM presentation_approvals WHERE id = target;
  SELECT count(*),
         count(*) FILTER (WHERE decision = 'approved'),
         count(*) FILTER (WHERE decision = 'changes_requested')
    INTO total, approved, changes
    FROM presentation_approval_approvers
   WHERE presentation_approval_id = target;

  IF total = 0 THEN
    RAISE EXCEPTION 'approval request % names nobody: at least one approver is required', target
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT (CASE request_status
            WHEN 'approved' THEN approved = total
            WHEN 'changes_requested' THEN changes = 1
            WHEN 'requested' THEN changes = 0 AND approved < total
            WHEN 'withdrawn' THEN changes = 0 AND approved < total
            WHEN 'superseded' THEN changes = 0 AND approved < total
            ELSE false
          END) THEN
    RAISE EXCEPTION 'approval request % is %, and its approvers say otherwise (% of % approved, % asked for changes)',
      target, request_status, approved, total, changes
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER presentation_approvals_agree_request
  AFTER INSERT OR UPDATE ON "presentation_approvals"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION presentation_approvals_agree();
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER presentation_approvals_agree_approver
  AFTER INSERT OR UPDATE ON "presentation_approval_approvers"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION presentation_approvals_agree();
