import { describe, expect, it } from "vitest";
import { getTableName } from "drizzle-orm";
import {
  PLANNED_EXERCISE_PRIORITY_TIER_VALUES,
  PLANNED_SET_LOAD_BASIS_VALUES,
  PLANNED_SET_LOAD_KIND_VALUES,
  PLANNED_SET_LOAD_UNIT_VALUES,
  PLANNED_SET_TYPE_VALUES,
  PLANNED_WORKOUT_STATUS_VALUES,
  PROGRAM_STATUS_VALUES,
  PROGRAM_VERSION_STATUS_VALUES,
  plannedExercises,
  plannedSets,
  plannedWorkouts,
  programVersions,
  programs,
  trainingBlocks,
  trainingCycles,
} from "./plan.js";

/**
 * Schema-shape tests only — no live Postgres connection required (same
 * precedent as workout.test.ts). The real migration is generated/applied
 * and inspected via psql separately (docs/architecture/PLAN-PRESCRIPTION.md).
 */
describe("plan schema", () => {
  it("defines the Program hierarchy tables in the app schema", () => {
    expect(getTableName(programs)).toBe("programs");
    expect(getTableName(programVersions)).toBe("program_versions");
    expect(getTableName(trainingBlocks)).toBe("training_blocks");
    expect(getTableName(trainingCycles)).toBe("training_cycles");
    expect(getTableName(plannedWorkouts)).toBe("planned_workouts");
    expect(getTableName(plannedExercises)).toBe("planned_exercises");
    expect(getTableName(plannedSets)).toBe("planned_sets");
  });

  it("locks Program/ProgramVersion status vocabularies", () => {
    expect(PROGRAM_STATUS_VALUES).toEqual(["ACTIVE", "ARCHIVED"]);
    expect(PROGRAM_VERSION_STATUS_VALUES).toEqual(["DRAFT", "ACTIVE", "SUPERSEDED"]);
  });

  it("locks PlannedWorkout to scheduling status only — never STARTED/COMPLETED", () => {
    expect(PLANNED_WORKOUT_STATUS_VALUES).toEqual([
      "PLANNED",
      "AVAILABLE",
      "SKIPPED",
      "RESCHEDULED",
      "CANCELLED",
    ]);
    expect(PLANNED_WORKOUT_STATUS_VALUES).not.toContain("STARTED");
    expect(PLANNED_WORKOUT_STATUS_VALUES).not.toContain("COMPLETED");
  });

  it("locks planned_sets to the Load Model Stage 1 subset — no second weight representation", () => {
    expect(PLANNED_SET_LOAD_KIND_VALUES).toEqual(["EXTERNAL_WEIGHT"]);
    expect(PLANNED_SET_LOAD_UNIT_VALUES).toEqual(["KG", "LB"]);
    expect(PLANNED_SET_LOAD_BASIS_VALUES).toEqual(["TOTAL", "PER_IMPLEMENT"]);
  });

  it("has no active_program_version_id column — the active version is derived, not a stored pointer", () => {
    expect(Object.keys(programs)).not.toContain("activeProgramVersionId");
  });

  it("supports a rep range on planned_sets, not a single fixed target", () => {
    expect(Object.keys(plannedSets)).toEqual(
      expect.arrayContaining(["targetRepsMin", "targetRepsMax"]),
    );
  });

  it("supports an optional prescribed rest duration on planned_sets", () => {
    expect(Object.keys(plannedSets)).toEqual(expect.arrayContaining(["restSeconds"]));
  });

  it("Progression Prerequisites V1: locks planned_sets.setType to exactly WORKING/WARM_UP — no reserved placeholders", () => {
    expect(PLANNED_SET_TYPE_VALUES).toEqual(["WORKING", "WARM_UP"]);
    expect(Object.keys(plannedSets)).toContain("setType");
  });

  it("Available-Time V1: planned_exercises carries authored priorityTier + minimumWorkingSets, tiers locked to TIER_1..TIER_3", () => {
    expect(PLANNED_EXERCISE_PRIORITY_TIER_VALUES).toEqual(["TIER_1", "TIER_2", "TIER_3"]);
    expect(Object.keys(plannedExercises)).toEqual(expect.arrayContaining(["priorityTier", "minimumWorkingSets"]));
    // Nullable by design: NULL = "not authored for available-time", never a product default.
    expect(plannedExercises.priorityTier.notNull).toBe(false);
    expect(plannedExercises.minimumWorkingSets.notNull).toBe(false);
    expect(plannedExercises.priorityTier.hasDefault).toBe(false);
    expect(plannedExercises.minimumWorkingSets.hasDefault).toBe(false);
  });
});
