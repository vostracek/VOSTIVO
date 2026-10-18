CREATE TYPE "app"."planned_set_load_basis" AS ENUM('TOTAL', 'PER_IMPLEMENT');--> statement-breakpoint
CREATE TYPE "app"."planned_set_load_kind" AS ENUM('EXTERNAL_WEIGHT');--> statement-breakpoint
CREATE TYPE "app"."planned_set_load_unit" AS ENUM('KG', 'LB');--> statement-breakpoint
CREATE TYPE "app"."planned_workout_status" AS ENUM('PLANNED', 'AVAILABLE', 'SKIPPED', 'RESCHEDULED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "app"."program_status" AS ENUM('ACTIVE', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "app"."program_version_status" AS ENUM('DRAFT', 'ACTIVE', 'SUPERSEDED');--> statement-breakpoint
CREATE TABLE "app"."planned_exercises" (
	"id" uuid PRIMARY KEY NOT NULL,
	"planned_workout_id" uuid NOT NULL,
	"exercise_ref" text,
	"display_name" text NOT NULL,
	"order_index" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."planned_sets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"planned_exercise_id" uuid NOT NULL,
	"order_index" integer NOT NULL,
	"target_reps_min" integer,
	"target_reps_max" integer,
	"load_kind" "app"."planned_set_load_kind",
	"load_amount_milli" integer,
	"load_unit" "app"."planned_set_load_unit",
	"load_basis" "app"."planned_set_load_basis",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "planned_sets_load_all_or_nothing" CHECK (("app"."planned_sets"."load_kind" IS NULL AND "app"."planned_sets"."load_amount_milli" IS NULL AND "app"."planned_sets"."load_unit" IS NULL AND "app"."planned_sets"."load_basis" IS NULL)
          OR ("app"."planned_sets"."load_kind" IS NOT NULL AND "app"."planned_sets"."load_amount_milli" IS NOT NULL AND "app"."planned_sets"."load_unit" IS NOT NULL AND "app"."planned_sets"."load_basis" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "app"."planned_workouts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"training_cycle_id" uuid NOT NULL,
	"name" text NOT NULL,
	"focus" text,
	"order_index" integer NOT NULL,
	"scheduled_date" date,
	"estimated_duration_minutes" integer,
	"status" "app"."planned_workout_status" DEFAULT 'PLANNED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."program_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"program_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"status" "app"."program_version_status" DEFAULT 'DRAFT' NOT NULL,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."programs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"athlete_profile_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" "app"."program_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."training_blocks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"program_version_id" uuid NOT NULL,
	"name" text NOT NULL,
	"goal" text NOT NULL,
	"order_index" integer NOT NULL,
	"cycle_count" integer NOT NULL,
	"focus_areas" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."training_cycles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"training_block_id" uuid NOT NULL,
	"order_index" integer NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "training_cycles_end_date_not_before_start_date" CHECK ("app"."training_cycles"."end_date" >= "app"."training_cycles"."start_date")
);
--> statement-breakpoint
ALTER TABLE "app"."planned_exercises" ADD CONSTRAINT "planned_exercises_planned_workout_id_planned_workouts_id_fk" FOREIGN KEY ("planned_workout_id") REFERENCES "app"."planned_workouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."planned_sets" ADD CONSTRAINT "planned_sets_planned_exercise_id_planned_exercises_id_fk" FOREIGN KEY ("planned_exercise_id") REFERENCES "app"."planned_exercises"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."planned_workouts" ADD CONSTRAINT "planned_workouts_training_cycle_id_training_cycles_id_fk" FOREIGN KEY ("training_cycle_id") REFERENCES "app"."training_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."program_versions" ADD CONSTRAINT "program_versions_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "app"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."programs" ADD CONSTRAINT "programs_athlete_profile_id_athlete_profiles_id_fk" FOREIGN KEY ("athlete_profile_id") REFERENCES "app"."athlete_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."training_blocks" ADD CONSTRAINT "training_blocks_program_version_id_program_versions_id_fk" FOREIGN KEY ("program_version_id") REFERENCES "app"."program_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."training_cycles" ADD CONSTRAINT "training_cycles_training_block_id_training_blocks_id_fk" FOREIGN KEY ("training_block_id") REFERENCES "app"."training_blocks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "planned_exercises_planned_workout_id_order_index_unique" ON "app"."planned_exercises" USING btree ("planned_workout_id","order_index");--> statement-breakpoint
CREATE UNIQUE INDEX "planned_sets_planned_exercise_id_order_index_unique" ON "app"."planned_sets" USING btree ("planned_exercise_id","order_index");--> statement-breakpoint
CREATE UNIQUE INDEX "planned_workouts_training_cycle_id_order_index_unique" ON "app"."planned_workouts" USING btree ("training_cycle_id","order_index");--> statement-breakpoint
CREATE UNIQUE INDEX "program_versions_program_id_version_number_unique" ON "app"."program_versions" USING btree ("program_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "program_versions_one_active_per_program" ON "app"."program_versions" USING btree ("program_id") WHERE "app"."program_versions"."status" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "training_blocks_program_version_id_order_index_unique" ON "app"."training_blocks" USING btree ("program_version_id","order_index");--> statement-breakpoint
CREATE UNIQUE INDEX "training_cycles_training_block_id_order_index_unique" ON "app"."training_cycles" USING btree ("training_block_id","order_index");