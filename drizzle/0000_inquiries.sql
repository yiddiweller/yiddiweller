CREATE TABLE "inquiries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"message" text NOT NULL,
	"source" text DEFAULT 'website_contact' NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inquiries_status_check" CHECK (status IN ('new', 'archived')),
	CONSTRAINT "inquiries_source_check" CHECK (source IN ('website_contact')),
	CONSTRAINT "inquiries_name_length_check" CHECK (char_length(name) BETWEEN 1 AND 100),
	CONSTRAINT "inquiries_email_length_check" CHECK (char_length(email) BETWEEN 3 AND 254),
	CONSTRAINT "inquiries_message_length_check" CHECK (char_length(message) BETWEEN 1 AND 4000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "inquiries_dedupe_key_idx" ON "inquiries" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "inquiries_created_at_idx" ON "inquiries" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "inquiries_status_idx" ON "inquiries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "inquiries_email_idx" ON "inquiries" USING btree ("email");--> statement-breakpoint
-- Keeps `updated_at` honest without every future write having to remember it.
-- Declared here rather than in the Drizzle schema because drizzle-kit does not
-- model triggers; it will not attempt to drop what it does not track.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $fn$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER inquiries_set_updated_at
  BEFORE UPDATE ON "inquiries"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
