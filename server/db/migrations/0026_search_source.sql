ALTER TABLE "search_stats" ADD COLUMN "source" text DEFAULT 'google' NOT NULL;--> statement-breakpoint
ALTER TABLE "search_stats" DROP CONSTRAINT "search_stats_project_id_day_query_page_pk";--> statement-breakpoint
ALTER TABLE "search_stats" ADD CONSTRAINT "search_stats_project_id_source_day_query_page_pk" PRIMARY KEY("project_id","source","day","query","page");
