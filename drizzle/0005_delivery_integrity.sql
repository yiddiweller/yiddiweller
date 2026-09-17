ALTER TABLE "presentation_revision_items" DROP CONSTRAINT "presentation_revision_items_shape_check";--> statement-breakpoint
ALTER TABLE "presentation_revisions" ADD CONSTRAINT "presentation_revisions_presentation_id_id_key" UNIQUE("presentation_id","id");--> statement-breakpoint
ALTER TABLE "presentation_revision_items" ADD CONSTRAINT "presentation_revision_items_shape_check" CHECK ((kind = 'file' AND file_id IS NOT NULL AND body IS NULL AND display_name_snapshot IS NOT NULL) OR (kind = 'note' AND file_id IS NULL AND body IS NOT NULL AND display_name_snapshot IS NULL));--> statement-breakpoint
ALTER TABLE "presentations" ADD CONSTRAINT "presentations_published_shape_check" CHECK ((status = 'published' AND current_revision_id IS NOT NULL AND published_at IS NOT NULL) OR (status <> 'published'));--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Hand-written, as in 0003 and 0004. Drizzle cannot express this one: the two
-- tables reference each other, and `foreignKey()` needs its target defined
-- before the table that uses it.
--
-- `presentations.current_revision_id` shipped in 0004 with no foreign key at
-- all — a bare uuid that could name another Presentation's Revision, another
-- Workroom's Revision, or nothing. This binds it to a Revision **of this
-- Presentation**, which is the fact worth enforcing; binding it merely to the
-- table would still permit the first two.
--
-- The circularity is only apparent. The column is nullable, so a Presentation
-- is inserted with it NULL, its first Revision is inserted against it, and the
-- UPDATE closes the loop inside the publish transaction. No deferral needed.
-- ---------------------------------------------------------------------------
ALTER TABLE "presentations"
  ADD CONSTRAINT "presentations_current_revision_fk"
  FOREIGN KEY ("id", "current_revision_id")
  REFERENCES "presentation_revisions" ("presentation_id", "id");
