ALTER TYPE "public"."actor_type" ADD VALUE 'mcp';--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "can_approve" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "approved_via" text;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "release_at" timestamp with time zone;