CREATE TABLE "mcp_calls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid,
	"token_id" uuid,
	"grant_id" uuid,
	"key_label" text NOT NULL,
	"client" text,
	"ip" text,
	"via" text DEFAULT 'mcp' NOT NULL,
	"tool" text NOT NULL,
	"project_id" uuid,
	"project" text,
	"args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ok" boolean NOT NULL,
	"error" text,
	"result_bytes" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "perms" jsonb DEFAULT '["read"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "project_ids" jsonb;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "last_client" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "review_needed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "expiry_warned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mcp_calls" ADD CONSTRAINT "mcp_calls_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_calls" ADD CONSTRAINT "mcp_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_calls" ADD CONSTRAINT "mcp_calls_token_id_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."api_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_calls" ADD CONSTRAINT "mcp_calls_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_calls_ws_idx" ON "mcp_calls" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "mcp_calls_token_idx" ON "mcp_calls" USING btree ("token_id","created_at");--> statement-breakpoint
UPDATE "api_tokens" SET "perms" = CASE WHEN "scope" = 'write' AND "can_approve" THEN '["read","private","draft","strategy","agent","approve"]'::jsonb WHEN "scope" = 'write' THEN '["read","private","draft","strategy","agent"]'::jsonb ELSE '["read","private"]'::jsonb END, "review_needed" = true, "expires_at" = now() + interval '90 days' WHERE "revoked_at" IS NULL;
