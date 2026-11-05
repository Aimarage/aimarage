CREATE TABLE "geo_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"week" date NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"web" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" jsonb NOT NULL,
	"cost_eur" numeric DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "geo_checks" ADD CONSTRAINT "geo_checks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_checks" ADD CONSTRAINT "geo_checks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "geo_checks_project_week_uq" ON "geo_checks" USING btree ("project_id","week");