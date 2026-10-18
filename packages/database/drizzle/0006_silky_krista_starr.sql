-- Progression Prerequisites V1 (docs/domain/PROGRESSION-ENGINE-V1.md,
-- tech-lead-resolved OD-1/OD-3). Hand-edited after `drizzle-kit generate`
-- to apply the required safe ordering for `performed_sets.set_type` and
-- `performed_exercises.exercise_ref` (both need existing rows backfilled
-- before/without a NOT NULL constraint the auto-generated ALTER TABLE
-- would otherwise violate): 1) add column in migration-safe (nullable)
-- form, 2) backfill, 3) enforce NOT NULL where required, 4) new writes
-- are always explicit from here on (server/mobile application code).
--
-- `planned_sets.set_type` needed no such staging: `ADD COLUMN ... DEFAULT
-- 'WORKING' NOT NULL` backfills existing rows with the default and
-- enforces NOT NULL in one atomic, safe statement (Postgres 11+), so
-- drizzle-kit's generated form for it is used unchanged.
CREATE TYPE "app"."performed_set_type" AS ENUM('WORKING', 'WARM_UP');--> statement-breakpoint
CREATE TYPE "app"."planned_set_type" AS ENUM('WORKING', 'WARM_UP');--> statement-breakpoint
ALTER TABLE "app"."performed_exercises" ADD COLUMN "exercise_ref" text;--> statement-breakpoint
ALTER TABLE "app"."performed_sets" ADD COLUMN "set_type" "app"."performed_set_type";--> statement-breakpoint
-- Deterministic backfill: every existing performed_exercises row's
-- exerciseRef is recoverable from its own session's immutable
-- prescription_snapshot (PrescribedExerciseV1.exerciseRef), matched by
-- prescriptionExerciseId — proven against the real dev database before
-- writing this migration (every row matched; see the task's final
-- report). Never derived from display_name, never fuzzy-matched. A
-- session whose snapshot itself recorded a null exerciseRef (no reliable
-- identity at completion time) correctly backfills to null too — not a
-- data loss, the same "no reliable cross-session identity" semantics
-- ExerciseIdentityV1 already defines.
UPDATE "app"."performed_exercises" AS pe
SET "exercise_ref" = matched.exercise_ref
FROM (
  SELECT
    pe2.id AS performed_exercise_id,
    (elem.value ->> 'exerciseRef') AS exercise_ref
  FROM "app"."performed_exercises" pe2
  JOIN "app"."workout_sessions" ws ON ws.id = pe2.workout_session_id
  CROSS JOIN LATERAL jsonb_array_elements(ws.prescription_snapshot -> 'exercises') AS elem(value)
  WHERE (elem.value ->> 'prescriptionExerciseId') = pe2.prescription_exercise_id
) AS matched
WHERE pe.id = matched.performed_exercise_id;--> statement-breakpoint
-- Every PerformedSet created before this migration was logged through a
-- product that had no warm-up-logging capability at all (tech-lead
-- resolution, OD-3) — WORKING is the only value defensible from actual
-- historical behavior, not an assumption made silently.
UPDATE "app"."performed_sets" SET "set_type" = 'WORKING' WHERE "set_type" IS NULL;--> statement-breakpoint
ALTER TABLE "app"."performed_sets" ALTER COLUMN "set_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."planned_sets" ADD COLUMN "set_type" "app"."planned_set_type" DEFAULT 'WORKING' NOT NULL;
