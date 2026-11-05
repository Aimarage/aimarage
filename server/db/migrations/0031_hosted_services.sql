CREATE TABLE "service_usage" (
	"workspace_id" uuid NOT NULL,
	"day" date NOT NULL,
	"service" text NOT NULL,
	"units" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "service_usage_workspace_id_day_service_pk" PRIMARY KEY("workspace_id","day","service")
);
--> statement-breakpoint
ALTER TABLE "brave_usage" ADD COLUMN "hosted_calls" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "brave_usage" ADD COLUMN "blocked" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "service_usage" ADD CONSTRAINT "service_usage_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;