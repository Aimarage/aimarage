CREATE TABLE IF NOT EXISTS "mails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid,
	"direction" text NOT NULL,
	"status" text DEFAULT 'empfangen' NOT NULL,
	"kind" text DEFAULT 'other' NOT NULL,
	"message_id" text,
	"in_reply_to" text,
	"from_addr" text,
	"to_addr" text,
	"subject" text,
	"body" text,
	"code" text,
	"link" text,
	"sent_at" timestamp with time zone,
	"scheduled_at" timestamp with time zone,
	"contact_id" uuid,
	"task_id" uuid,
	"draft_id" uuid,
	"mode" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'neu' NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "notes" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "rules" text;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "mails" ADD CONSTRAINT "mails_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "mails" ADD CONSTRAINT "mails_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "mails" ADD CONSTRAINT "mails_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "mails" ADD CONSTRAINT "mails_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "mails" ADD CONSTRAINT "mails_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mails_project_msg_uq" ON "mails" USING btree ("project_id","message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mails_ws_idx" ON "mails" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mails_task_idx" ON "mails" USING btree ("task_id");