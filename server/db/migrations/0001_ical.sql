ALTER TABLE "users" ADD COLUMN "calendar_token" text;--> statement-breakpoint
CREATE UNIQUE INDEX "users_calendar_token_uq" ON "users" USING btree ("calendar_token");