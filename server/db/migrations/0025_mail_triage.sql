ALTER TABLE "mails" ADD COLUMN "from_name" text;--> statement-breakpoint
ALTER TABLE "mails" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "mails" ADD COLUMN "category_by" text;--> statement-breakpoint
ALTER TABLE "mails" ADD COLUMN "note" text;--> statement-breakpoint
UPDATE "mails" SET "category" = CASE "kind" WHEN 'reply' THEN 'antwort' ELSE 'wichtig' END, "category_by" = 'regel' WHERE "direction" = 'in' AND "message_id" IS NOT NULL AND "category" IS NULL AND "kind" IN ('reply', 'code');
