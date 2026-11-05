CREATE TABLE "brave_usage" (
	"workspace_id" uuid NOT NULL,
	"project_id" text DEFAULT '' NOT NULL,
	"day" date NOT NULL,
	"purpose" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "brave_usage_workspace_id_day_purpose_project_id_pk" PRIMARY KEY("workspace_id","day","purpose","project_id")
);
--> statement-breakpoint
ALTER TABLE "brave_usage" ADD CONSTRAINT "brave_usage_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;