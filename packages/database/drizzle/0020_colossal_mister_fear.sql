CREATE TYPE "app"."equipment_adaptation_application_result" AS ENUM('NO_CHANGE', 'ADJUST_SESSION');--> statement-breakpoint
CREATE TYPE "app"."equipment_adaptation_application_scope" AS ENUM('TODAY_ONLY');--> statement-breakpoint
CREATE TYPE "app"."equipment_adaptation_application_status" AS ENUM('ACTIVE', 'SUPERSEDED', 'CONSUMED');--> statement-breakpoint
CREATE TABLE "app"."equipment_adaptation_applications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"athlete_profile_id" uuid NOT NULL,
	"planned_workout_id" uuid NOT NULL,
	"program_version_id" uuid NOT NULL,
	"training_block_id" uuid NOT NULL,
	"scope" "app"."equipment_adaptation_application_scope" NOT NULL,
	"athlete_local_date" date NOT NULL,
	"training_time_zone" text NOT NULL,
	"preview_schema_version" text NOT NULL,
	"policy_version" text NOT NULL,
	"catalog_version" text NOT NULL,
	"preview_fingerprint" text NOT NULL,
	"available_equipment_ids" jsonb NOT NULL,
	"result" "app"."equipment_adaptation_application_result" NOT NULL,
	"replacements" jsonb NOT NULL,
	"status" "app"."equipment_adaptation_application_status" NOT NULL,
	"supersedes_application_id" uuid,
	"superseded_at" timestamp with time zone,
	"consumed_by_workout_session_id" uuid,
	"consumed_at" timestamp with time zone,
	"applied_by_user_id" uuid NOT NULL,
	"applied_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "equipment_adaptation_applications_superseded_consistent" CHECK (("app"."equipment_adaptation_applications"."status" = 'SUPERSEDED') = ("app"."equipment_adaptation_applications"."superseded_at" IS NOT NULL)),
	CONSTRAINT "equipment_adaptation_applications_consumed_consistent" CHECK (("app"."equipment_adaptation_applications"."status" = 'CONSUMED') = ("app"."equipment_adaptation_applications"."consumed_by_workout_session_id" IS NOT NULL AND "app"."equipment_adaptation_applications"."consumed_at" IS NOT NULL)),
	CONSTRAINT "equipment_adaptation_applications_result_consistent" CHECK (("app"."equipment_adaptation_applications"."result" = 'NO_CHANGE') = (jsonb_array_length("app"."equipment_adaptation_applications"."replacements") = 0))
);
--> statement-breakpoint
ALTER TABLE "app"."equipment_adaptation_applications" ADD CONSTRAINT "equipment_adaptation_applications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."equipment_adaptation_applications" ADD CONSTRAINT "equipment_adaptation_applications_athlete_profile_id_athlete_profiles_id_fk" FOREIGN KEY ("athlete_profile_id") REFERENCES "app"."athlete_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."equipment_adaptation_applications" ADD CONSTRAINT "equipment_adaptation_applications_planned_workout_id_planned_workouts_id_fk" FOREIGN KEY ("planned_workout_id") REFERENCES "app"."planned_workouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."equipment_adaptation_applications" ADD CONSTRAINT "equipment_adaptation_applications_program_version_id_program_versions_id_fk" FOREIGN KEY ("program_version_id") REFERENCES "app"."program_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."equipment_adaptation_applications" ADD CONSTRAINT "equipment_adaptation_applications_training_block_id_training_blocks_id_fk" FOREIGN KEY ("training_block_id") REFERENCES "app"."training_blocks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."equipment_adaptation_applications" ADD CONSTRAINT "equipment_adaptation_applications_supersedes_application_id_equipment_adaptation_applications_id_fk" FOREIGN KEY ("supersedes_application_id") REFERENCES "app"."equipment_adaptation_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."equipment_adaptation_applications" ADD CONSTRAINT "equipment_adaptation_applications_consumed_by_workout_session_id_workout_sessions_id_fk" FOREIGN KEY ("consumed_by_workout_session_id") REFERENCES "app"."workout_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."equipment_adaptation_applications" ADD CONSTRAINT "equipment_adaptation_applications_applied_by_user_id_users_id_fk" FOREIGN KEY ("applied_by_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "equipment_adaptation_applications_one_active_per_workout" ON "app"."equipment_adaptation_applications" USING btree ("user_id","planned_workout_id") WHERE "app"."equipment_adaptation_applications"."status" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "equipment_adaptation_applications_consumed_session_unique" ON "app"."equipment_adaptation_applications" USING btree ("consumed_by_workout_session_id");--> statement-breakpoint
CREATE INDEX "equipment_adaptation_applications_workout_lookup_idx" ON "app"."equipment_adaptation_applications" USING btree ("user_id","planned_workout_id","status");