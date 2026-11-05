ALTER TABLE "drafts" ADD COLUMN "ai_generated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "drafts" SET "ai_generated" = true WHERE "by_agent" OR EXISTS (SELECT 1 FROM "drafts" d2 WHERE d2."task_id" = "drafts"."task_id" AND d2."by_agent" AND d2."version" < "drafts"."version");
