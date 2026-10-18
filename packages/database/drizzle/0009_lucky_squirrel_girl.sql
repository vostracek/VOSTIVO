CREATE TYPE "app"."progression_decision_type" AS ENUM('NO_CHANGE', 'MAINTAIN_LOAD_BUILD_REPS', 'INCREASE_LOAD');--> statement-breakpoint
CREATE TYPE "app"."progression_evidence_strength" AS ENUM('INSUFFICIENT', 'SINGLE_EXPOSURE', 'SUPPORTED', 'STRONG');--> statement-breakpoint
CREATE TYPE "app"."progression_reason_code" AS ENUM('TOP_OF_RANGE_ACHIEVED', 'REPS_PROGRESSING', 'PERFORMANCE_STABLE', 'INSUFFICIENT_EVIDENCE', 'SINGLE_EXPOSURE_ONLY', 'PERFORMANCE_REGRESSED_SINGLE_EXPOSURE', 'NON_COMPARABLE_CONTEXT', 'PARTIAL_EXPOSURE', 'PRESCRIPTION_CHANGED_RESET', 'NO_SUITABLE_LOAD_INCREMENT');--> statement-breakpoint
CREATE TABLE "app"."progression_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"exercise_ref" text NOT NULL,
	"source_workout_session_id" uuid NOT NULL,
	"source_performed_exercise_id" uuid NOT NULL,
	"source_prescription_exercise_id" text NOT NULL,
	"engine" text NOT NULL,
	"policy" text NOT NULL,
	"decision_type" "app"."progression_decision_type" NOT NULL,
	"reason_code" "app"."progression_reason_code" NOT NULL,
	"evidence_strength" "app"."progression_evidence_strength" NOT NULL,
	"progression_stalled" boolean NOT NULL,
	"recommended_change" jsonb,
	"normalized_input_snapshot" jsonb NOT NULL,
	"evidence_refs" jsonb NOT NULL,
	"evidence_fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"superseded_by_decision_id" uuid
);
--> statement-breakpoint
ALTER TABLE "app"."progression_decisions" ADD CONSTRAINT "progression_decisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."progression_decisions" ADD CONSTRAINT "progression_decisions_source_workout_session_id_workout_sessions_id_fk" FOREIGN KEY ("source_workout_session_id") REFERENCES "app"."workout_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."progression_decisions" ADD CONSTRAINT "progression_decisions_source_performed_exercise_id_performed_exercises_id_fk" FOREIGN KEY ("source_performed_exercise_id") REFERENCES "app"."performed_exercises"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."progression_decisions" ADD CONSTRAINT "progression_decisions_superseded_by_decision_id_progression_decisions_id_fk" FOREIGN KEY ("superseded_by_decision_id") REFERENCES "app"."progression_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "progression_decisions_evidence_fingerprint_unique" ON "app"."progression_decisions" USING btree ("evidence_fingerprint");--> statement-breakpoint
CREATE INDEX "progression_decisions_source_performed_exercise_id_idx" ON "app"."progression_decisions" USING btree ("source_performed_exercise_id");