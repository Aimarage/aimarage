ALTER TABLE "campaigns" ADD COLUMN "release" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "release_ok" boolean DEFAULT false NOT NULL;