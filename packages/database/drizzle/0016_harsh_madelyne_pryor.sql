CREATE TYPE "app"."available_time_application_scope" AS ENUM('TODAY_ONLY');--> statement-breakpoint
CREATE TYPE "app"."available_time_verification_status" AS ENUM('VERIFIED', 'STALE', 'UNVERIFIED');--> statement-breakpoint
CREATE TABLE "app"."available_time_applications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workout_session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"planned_workout_id" uuid NOT NULL,
	"source_program_version_id" uuid NOT NULL,
	"scope" "app"."available_time_application_scope" NOT NULL,
	"policy_version" text NOT NULL,
	"available_minutes" integer NOT NULL,
	"preview_fingerprint" text NOT NULL,
	"original_estimated_seconds" integer NOT NULL,
	"adjusted_estimated_seconds" integer NOT NULL,
	"structural_diff" jsonb NOT NULL,
	"verification_status" "app"."available_time_verification_status" NOT NULL,
	"verification_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "available_time_applications_policy_version_v1" CHECK ("app"."available_time_applications"."policy_version" = 'available-time/v1'),
	CONSTRAINT "available_time_applications_available_minutes_range" CHECK ("app"."available_time_applications"."available_minutes" BETWEEN 1 AND 240),
	CONSTRAINT "available_time_applications_estimates_non_negative" CHECK ("app"."available_time_applications"."original_estimated_seconds" >= 0 AND "app"."available_time_applications"."adjusted_estimated_seconds" >= 0)
);
--> statement-breakpoint
ALTER TABLE "app"."available_time_applications" ADD CONSTRAINT "available_time_applications_workout_session_id_workout_sessions_id_fk" FOREIGN KEY ("workout_session_id") REFERENCES "app"."workout_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."available_time_applications" ADD CONSTRAINT "available_time_applications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "available_time_applications_workout_session_id_unique" ON "app"."available_time_applications" USING btree ("workout_session_id");