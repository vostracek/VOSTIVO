CREATE TYPE "app"."load_basis_v1" AS ENUM('TOTAL', 'PER_IMPLEMENT');--> statement-breakpoint
CREATE TYPE "app"."load_kind_v1" AS ENUM('EXTERNAL_WEIGHT');--> statement-breakpoint
CREATE TYPE "app"."load_unit" AS ENUM('KG', 'LB');--> statement-breakpoint
CREATE TYPE "app"."performed_set_completion_state" AS ENUM('COMPLETED', 'REOPENED');--> statement-breakpoint
CREATE TYPE "app"."workout_command_outcome" AS ENUM('APPLIED', 'STALE', 'REJECTED');--> statement-breakpoint
CREATE TYPE "app"."workout_command_type" AS ENUM('START_WORKOUT_SESSION_V1', 'COMPLETE_SET_V1', 'REOPEN_SET_V1');--> statement-breakpoint
CREATE TYPE "app"."workout_session_status" AS ENUM('ACTIVE', 'COMPLETED');--> statement-breakpoint
CREATE TABLE "app"."performed_exercises" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workout_session_id" uuid NOT NULL,
	"prescription_exercise_id" text,
	"display_name" text NOT NULL,
	"order_index" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."performed_sets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"performed_exercise_id" uuid NOT NULL,
	"prescription_set_id" text,
	"order_index" integer NOT NULL,
	"actual_reps" integer NOT NULL,
	"load_kind" "app"."load_kind_v1" NOT NULL,
	"load_amount_milli" integer NOT NULL,
	"load_unit" "app"."load_unit" NOT NULL,
	"load_basis" "app"."load_basis_v1" NOT NULL,
	"completion_state" "app"."performed_set_completion_state" NOT NULL,
	"completed_at" timestamp with time zone,
	"revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."workout_change_cursor" (
	"cursor_seq" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"command_type" "app"."workout_command_type" NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."workout_command_receipts" (
	"command_id" uuid PRIMARY KEY NOT NULL,
	"command_type" "app"."workout_command_type" NOT NULL,
	"schema_version" integer NOT NULL,
	"user_id" uuid NOT NULL,
	"outcome" "app"."workout_command_outcome" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."workout_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"prescription_snapshot" jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"status" "app"."workout_session_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."performed_exercises" ADD CONSTRAINT "performed_exercises_workout_session_id_workout_sessions_id_fk" FOREIGN KEY ("workout_session_id") REFERENCES "app"."workout_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."performed_sets" ADD CONSTRAINT "performed_sets_performed_exercise_id_performed_exercises_id_fk" FOREIGN KEY ("performed_exercise_id") REFERENCES "app"."performed_exercises"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workout_change_cursor" ADD CONSTRAINT "workout_change_cursor_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workout_command_receipts" ADD CONSTRAINT "workout_command_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workout_sessions" ADD CONSTRAINT "workout_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;