ALTER TABLE "utm_stats" ADD COLUMN "path" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "utm_stats" DROP CONSTRAINT "utm_stats_project_id_day_source_medium_campaign_content_pk";--> statement-breakpoint
ALTER TABLE "utm_stats" ADD CONSTRAINT "utm_stats_project_id_day_source_medium_campaign_content_path_pk" PRIMARY KEY("project_id","day","source","medium","campaign","content","path");
