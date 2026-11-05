CREATE TABLE "experiments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"status" text DEFAULT 'vorschlag' NOT NULL,
	"hypothesis" text NOT NULL,
	"variable" text NOT NULL,
	"channel_key" text,
	"platform" text,
	"variant_a" text NOT NULL,
	"variant_b" text NOT NULL,
	"metric" text DEFAULT 'interaktionen' NOT NULL,
	"min_posts" integer DEFAULT 3 NOT NULL,
	"start_date" date,
	"end_date" date,
	"extensions" integer DEFAULT 0 NOT NULL,
	"strategy_id" uuid,
	"result" jsonb,
	"decision" text,
	"by_agent" boolean DEFAULT true NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"experiment_id" uuid,
	"variable" text NOT NULL,
	"channel_key" text,
	"winner" text,
	"loser" text,
	"diff" numeric,
	"text" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategy_weeks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"strategy_id" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"week" date NOT NULL,
	"dimension" text NOT NULL,
	"key" text DEFAULT '' NOT NULL,
	"posts" integer DEFAULT 0 NOT NULL,
	"measured" integer DEFAULT 0 NOT NULL,
	"reach" numeric DEFAULT 0 NOT NULL,
	"interactions" numeric DEFAULT 0 NOT NULL,
	"clicks" numeric DEFAULT 0 NOT NULL,
	"visits" integer DEFAULT 0 NOT NULL,
	"signups" integer DEFAULT 0 NOT NULL,
	"purchases" integer DEFAULT 0 NOT NULL,
	"cost_eur" numeric DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "experiment_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "experiment_arm" text;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_weeks" ADD CONSTRAINT "strategy_weeks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_weeks" ADD CONSTRAINT "strategy_weeks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_weeks" ADD CONSTRAINT "strategy_weeks_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "experiments_project_idx" ON "experiments" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "experiments_one_open_uq" ON "experiments" USING btree ("project_id") WHERE status in ('vorschlag', 'laeuft');--> statement-breakpoint
CREATE INDEX "insights_project_idx" ON "insights" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_weeks_uq" ON "strategy_weeks" USING btree ("project_id","week","version","dimension","key");--> statement-breakpoint
CREATE INDEX "strategy_weeks_ws_idx" ON "strategy_weeks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "tasks_experiment_idx" ON "tasks" USING btree ("experiment_id");