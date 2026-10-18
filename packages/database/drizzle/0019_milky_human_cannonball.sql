CREATE TYPE "app"."missed_workout_schedule_application_status" AS ENUM('ACTIVE', 'SUPERSEDED');--> statement-breakpoint
CREATE TYPE "app"."missed_workout_schedule_assignment_kind" AS ENUM('ROLL_FORWARD', 'RETAINED');--> statement-breakpoint
CREATE TABLE "app"."missed_workout_schedule_applications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"athlete_profile_id" uuid NOT NULL,
	"program_version_id" uuid NOT NULL,
	"training_block_id" uuid NOT NULL,
	"policy_version" text NOT NULL,
	"preview_fingerprint" text NOT NULL,
	"athlete_local_date" date NOT NULL,
	"training_time_zone" text NOT NULL,
	"missed_planned_workout_id" uuid NOT NULL,
	"missed_scheduled_local_date" date,
	"original_next_planned_workout_id" uuid,
	"reason_code" text NOT NULL,
	"applied_by_user_id" uuid NOT NULL,
	"applied_at" timestamp with time zone NOT NULL,
	"status" "app"."missed_workout_schedule_application_status" NOT NULL,
	"supersedes_application_id" uuid,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "missed_workout_schedule_applications_superseded_at_matches_status" CHECK (("app"."missed_workout_schedule_applications"."status" = 'SUPERSEDED') = ("app"."missed_workout_schedule_applications"."superseded_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "app"."missed_workout_schedule_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"sequence_position" integer NOT NULL,
	"planned_workout_id" uuid NOT NULL,
	"assignment_kind" "app"."missed_workout_schedule_assignment_kind" NOT NULL,
	"authored_scheduled_local_date" date,
	"effective_scheduled_local_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "missed_workout_schedule_assignments_position_non_negative" CHECK ("app"."missed_workout_schedule_assignments"."sequence_position" >= 0)
);
--> statement-breakpoint
ALTER TABLE "app"."missed_workout_schedule_applications" ADD CONSTRAINT "missed_workout_schedule_applications_athlete_profile_id_athlete_profiles_id_fk" FOREIGN KEY ("athlete_profile_id") REFERENCES "app"."athlete_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."missed_workout_schedule_applications" ADD CONSTRAINT "missed_workout_schedule_applications_program_version_id_program_versions_id_fk" FOREIGN KEY ("program_version_id") REFERENCES "app"."program_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."missed_workout_schedule_applications" ADD CONSTRAINT "missed_workout_schedule_applications_training_block_id_training_blocks_id_fk" FOREIGN KEY ("training_block_id") REFERENCES "app"."training_blocks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."missed_workout_schedule_applications" ADD CONSTRAINT "missed_workout_schedule_applications_missed_planned_workout_id_planned_workouts_id_fk" FOREIGN KEY ("missed_planned_workout_id") REFERENCES "app"."planned_workouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."missed_workout_schedule_applications" ADD CONSTRAINT "missed_workout_schedule_applications_original_next_planned_workout_id_planned_workouts_id_fk" FOREIGN KEY ("original_next_planned_workout_id") REFERENCES "app"."planned_workouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."missed_workout_schedule_applications" ADD CONSTRAINT "missed_workout_schedule_applications_applied_by_user_id_users_id_fk" FOREIGN KEY ("applied_by_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."missed_workout_schedule_applications" ADD CONSTRAINT "missed_workout_schedule_applications_supersedes_application_id_missed_workout_schedule_applications_id_fk" FOREIGN KEY ("supersedes_application_id") REFERENCES "app"."missed_workout_schedule_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."missed_workout_schedule_assignments" ADD CONSTRAINT "missed_workout_schedule_assignments_application_id_missed_workout_schedule_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "app"."missed_workout_schedule_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."missed_workout_schedule_assignments" ADD CONSTRAINT "missed_workout_schedule_assignments_planned_workout_id_planned_workouts_id_fk" FOREIGN KEY ("planned_workout_id") REFERENCES "app"."planned_workouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "missed_workout_schedule_applications_one_active_per_block" ON "app"."missed_workout_schedule_applications" USING btree ("athlete_profile_id","training_block_id") WHERE "app"."missed_workout_schedule_applications"."status" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "missed_workout_schedule_applications_fingerprint_unique" ON "app"."missed_workout_schedule_applications" USING btree ("athlete_profile_id","training_block_id","preview_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "missed_workout_schedule_assignments_application_workout_unique" ON "app"."missed_workout_schedule_assignments" USING btree ("application_id","planned_workout_id");--> statement-breakpoint
CREATE UNIQUE INDEX "missed_workout_schedule_assignments_application_position_unique" ON "app"."missed_workout_schedule_assignments" USING btree ("application_id","sequence_position");