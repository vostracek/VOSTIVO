ALTER TABLE "app"."workout_command_receipts" ADD COLUMN "workout_session_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."workout_command_receipts" ADD COLUMN "session_seq" integer;--> statement-breakpoint
ALTER TABLE "app"."workout_sessions" ADD COLUMN "finish_seq" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "workout_command_receipts_session_seq_unique" ON "app"."workout_command_receipts" USING btree ("workout_session_id","session_seq") WHERE "app"."workout_command_receipts"."session_seq" IS NOT NULL;