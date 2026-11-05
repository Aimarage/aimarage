CREATE TABLE "search_stats" (
	"project_id" uuid NOT NULL,
	"day" date NOT NULL,
	"query" text DEFAULT '' NOT NULL,
	"page" text DEFAULT '' NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"position" numeric DEFAULT 0 NOT NULL,
	CONSTRAINT "search_stats_project_id_day_query_page_pk" PRIMARY KEY("project_id","day","query","page")
);
--> statement-breakpoint
CREATE TABLE "seo_audits" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pages" integer DEFAULT 0 NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "search_stats" ADD CONSTRAINT "search_stats_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_audits" ADD CONSTRAINT "seo_audits_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;