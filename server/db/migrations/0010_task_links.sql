CREATE TABLE "task_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid,
	"task_id" uuid NOT NULL,
	"platform" text,
	"url" text NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_links" ADD CONSTRAINT "task_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_links" ADD CONSTRAINT "task_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_links" ADD CONSTRAINT "task_links_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_links_task_url_uq" ON "task_links" USING btree ("task_id","url");--> statement-breakpoint
CREATE INDEX "task_links_ws_idx" ON "task_links" USING btree ("workspace_id","posted_at");--> statement-breakpoint
INSERT INTO "task_links" ("workspace_id", "project_id", "task_id", "platform", "url", "posted_at")
SELECT sp."workspace_id", sp."project_id", sp."task_id", r->>'platform', r->>'url', coalesce(sp."posted_at", sp."updated_at")
FROM "social_posts" sp, jsonb_array_elements(sp."results") r
WHERE sp."status" IN ('gepostet', 'teilweise') AND (r->>'ok')::boolean IS TRUE AND coalesce(r->>'url', '') <> ''
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "task_links" ("workspace_id", "project_id", "task_id", "platform", "url", "posted_at")
SELECT "workspace_id", "project_id", "id", NULL, "posted_url", coalesce("done_at", "updated_at")
FROM "tasks"
WHERE coalesce("posted_url", '') <> ''
ON CONFLICT DO NOTHING;
