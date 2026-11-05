ALTER TABLE "tasks" ADD COLUMN "service" jsonb;--> statement-breakpoint
UPDATE "tasks" SET "target_url" = 'https://dailyplaylists.com/submit-song/add-song', "updated_at" = now() WHERE "code" = 'THE-DIR-001' AND "target_url" IS NULL AND "title" ILIKE '%dailyplaylists%';--> statement-breakpoint
UPDATE "drafts" SET "target_url" = 'https://dailyplaylists.com/submit-song/add-song' WHERE "target_url" IS NULL AND "status" IN ('offen', 'freigegeben') AND "task_id" IN (SELECT "id" FROM "tasks" WHERE "code" = 'THE-DIR-001' AND "title" ILIKE '%dailyplaylists%');
