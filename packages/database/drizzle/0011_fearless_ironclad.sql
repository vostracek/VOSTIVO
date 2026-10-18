CREATE TYPE "app"."progression_application_command_action" AS ENUM('KEEP_ORIGINAL');--> statement-breakpoint
CREATE TYPE "app"."progression_application_command_outcome" AS ENUM('APPLIED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "app"."progression_application_status" AS ENUM('PENDING_REVIEW', 'APPLIED', 'KEPT_ORIGINAL', 'STALE', 'SUPERSEDED', 'REVOKED');--> statement-breakpoint
CREATE TABLE "app"."progression_application_commands" (
	"command_id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"action" "app"."progression_application_command_action" NOT NULL,
	"outcome" "app"."progression_application_command_outcome" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."progression_applications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"progression_decision_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"exercise_ref" text NOT NULL,
	"program_version_id" uuid NOT NULL,
	"training_block_id" uuid NOT NULL,
	"workout_order_index" integer NOT NULL,
	"exercise_order_index" integer NOT NULL,
	"effective_from_cycle_order_index" integer NOT NULL,
	"status" "app"."progression_application_status" DEFAULT 'PENDING_REVIEW' NOT NULL,
	"expected_effective_load" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"superseded_by_application_id" uuid,
	CONSTRAINT "progression_applications_effective_from_cycle_order_index_non_negative" CHECK ("app"."progression_applications"."effective_from_cycle_order_index" >= 0),
	CONSTRAINT "progression_applications_decided_at_decided_by_consistency" CHECK (("app"."progression_applications"."decided_at" IS NULL) = ("app"."progression_applications"."decided_by" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "app"."progression_application_commands" ADD CONSTRAINT "progression_application_commands_application_id_progression_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "app"."progression_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."progression_application_commands" ADD CONSTRAINT "progression_application_commands_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."progression_applications" ADD CONSTRAINT "progression_applications_progression_decision_id_progression_decisions_id_fk" FOREIGN KEY ("progression_decision_id") REFERENCES "app"."progression_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."progression_applications" ADD CONSTRAINT "progression_applications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."progression_applications" ADD CONSTRAINT "progression_applications_program_version_id_program_versions_id_fk" FOREIGN KEY ("program_version_id") REFERENCES "app"."program_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."progression_applications" ADD CONSTRAINT "progression_applications_training_block_id_training_blocks_id_fk" FOREIGN KEY ("training_block_id") REFERENCES "app"."training_blocks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."progression_applications" ADD CONSTRAINT "progression_applications_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."progression_applications" ADD CONSTRAINT "progression_applications_superseded_by_application_id_progression_applications_id_fk" FOREIGN KEY ("superseded_by_application_id") REFERENCES "app"."progression_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "progression_application_commands_application_id_idx" ON "app"."progression_application_commands" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "progression_applications_progression_decision_id_unique" ON "app"."progression_applications" USING btree ("progression_decision_id");--> statement-breakpoint
CREATE INDEX "progression_applications_user_id_status_idx" ON "app"."progression_applications" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "progression_applications_slot_lookup_idx" ON "app"."progression_applications" USING btree ("program_version_id","training_block_id","workout_order_index","exercise_order_index");