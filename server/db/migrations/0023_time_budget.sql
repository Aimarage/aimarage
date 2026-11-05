ALTER TABLE "tasks" ADD COLUMN "for_claude" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "planned_for" date;