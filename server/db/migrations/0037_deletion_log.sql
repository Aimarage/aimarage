CREATE TABLE "deletion_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"workspace_id" uuid,
	"actor_user_id" uuid,
	"via" text DEFAULT 'web' NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "deletion_log_created_idx" ON "deletion_log" USING btree ("created_at");