CREATE TYPE "app"."planned_exercise_priority_tier" AS ENUM('TIER_1', 'TIER_2', 'TIER_3');--> statement-breakpoint
ALTER TABLE "app"."planned_exercises" ADD COLUMN "priority_tier" "app"."planned_exercise_priority_tier";--> statement-breakpoint
ALTER TABLE "app"."planned_exercises" ADD COLUMN "minimum_working_sets" integer;--> statement-breakpoint
ALTER TABLE "app"."planned_exercises" ADD CONSTRAINT "planned_exercises_minimum_working_sets_non_negative" CHECK ("app"."planned_exercises"."minimum_working_sets" IS NULL OR "app"."planned_exercises"."minimum_working_sets" >= 0);