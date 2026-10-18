CREATE TYPE "app"."progression_application_command_rejection_reason" AS ENUM('STALE', 'SUPERSEDED', 'PROPOSAL_REFRESH_REQUIRED', 'NO_CURRENT_LOAD', 'LOADING_CAPABILITY_UNAVAILABLE', 'LOADING_CAPABILITY_INVALID', 'CAPABILITY_INCOMPATIBLE', 'CURRENT_LOAD_UNSUPPORTED', 'NO_SUITABLE_INCREMENT');--> statement-breakpoint
ALTER TYPE "app"."progression_application_command_action" ADD VALUE 'APPLY';--> statement-breakpoint
ALTER TABLE "app"."progression_application_commands" ADD COLUMN "rejection_reason" "app"."progression_application_command_rejection_reason";--> statement-breakpoint
ALTER TABLE "app"."progression_applications" ADD COLUMN "loading_capability_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."progression_applications" ADD COLUMN "loading_capability_revision" integer;--> statement-breakpoint
ALTER TABLE "app"."progression_applications" ADD COLUMN "loading_capability_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "app"."progression_applications" ADD COLUMN "resolver_proposed_load" jsonb;--> statement-breakpoint
ALTER TABLE "app"."progression_applications" ADD COLUMN "applied_load" jsonb;--> statement-breakpoint
ALTER TABLE "app"."progression_applications" ADD COLUMN "applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."progression_applications" ADD CONSTRAINT "progression_applications_loading_capability_id_loading_capabilities_id_fk" FOREIGN KEY ("loading_capability_id") REFERENCES "app"."loading_capabilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "progression_applications_one_current_overlay_per_stream" ON "app"."progression_applications" USING btree ("user_id","program_version_id","training_block_id","workout_order_index","exercise_order_index") WHERE "app"."progression_applications"."status" = 'APPLIED';--> statement-breakpoint
ALTER TABLE "app"."progression_application_commands" ADD CONSTRAINT "progression_application_commands_rejection_reason_consistency" CHECK (("app"."progression_application_commands"."outcome" = 'REJECTED') OR "app"."progression_application_commands"."rejection_reason" IS NULL);--> statement-breakpoint
ALTER TABLE "app"."progression_applications" ADD CONSTRAINT "progression_applications_applied_audit_group_consistency" CHECK (("app"."progression_applications"."loading_capability_id" IS NULL) = ("app"."progression_applications"."loading_capability_revision" IS NULL)
          AND ("app"."progression_applications"."loading_capability_id" IS NULL) = ("app"."progression_applications"."loading_capability_snapshot" IS NULL)
          AND ("app"."progression_applications"."loading_capability_id" IS NULL) = ("app"."progression_applications"."resolver_proposed_load" IS NULL)
          AND ("app"."progression_applications"."loading_capability_id" IS NULL) = ("app"."progression_applications"."applied_load" IS NULL)
          AND ("app"."progression_applications"."loading_capability_id" IS NULL) = ("app"."progression_applications"."applied_at" IS NULL));--> statement-breakpoint
ALTER TABLE "app"."progression_applications" ADD CONSTRAINT "progression_applications_non_applied_states_audit_null" CHECK ("app"."progression_applications"."status" NOT IN ('PENDING_REVIEW', 'KEPT_ORIGINAL', 'STALE') OR "app"."progression_applications"."applied_at" IS NULL);--> statement-breakpoint
ALTER TABLE "app"."progression_applications" ADD CONSTRAINT "progression_applications_applied_status_requires_audit" CHECK ("app"."progression_applications"."status" != 'APPLIED' OR "app"."progression_applications"."applied_at" IS NOT NULL);