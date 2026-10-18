ALTER TYPE "app"."workout_command_type" ADD VALUE 'FINISH_WORKOUT_SESSION_V1';--> statement-breakpoint
ALTER TABLE "app"."workout_sessions" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."planned_sets" ADD COLUMN "rest_seconds" integer;