CREATE TABLE "utm_stats" (
	"project_id" uuid NOT NULL,
	"day" date NOT NULL,
	"source" text NOT NULL,
	"medium" text DEFAULT '' NOT NULL,
	"campaign" text DEFAULT '' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"visits" integer DEFAULT 0 NOT NULL,
	"signups" integer DEFAULT 0 NOT NULL,
	"interests" integer DEFAULT 0 NOT NULL,
	"purchases" integer DEFAULT 0 NOT NULL,
	"net_cents" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "utm_stats_project_id_day_source_medium_campaign_content_pk" PRIMARY KEY("project_id","day","source","medium","campaign","content")
);
--> statement-breakpoint
ALTER TABLE "utm_stats" ADD CONSTRAINT "utm_stats_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;