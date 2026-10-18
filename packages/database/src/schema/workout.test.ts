import { describe, expect, it } from "vitest";
import { getTableName } from "drizzle-orm";
import {
  LOAD_BASIS_V1_VALUES,
  LOAD_KIND_V1_VALUES,
  LOAD_UNIT_VALUES,
  PERFORMED_SET_COMPLETION_STATE_VALUES,
  PERFORMED_SET_TYPE_VALUES,
  WORKOUT_COMMAND_OUTCOME_VALUES,
  WORKOUT_COMMAND_TYPE_VALUES,
  performedExercises,
  performedSets,
  workoutChangeCursor,
  workoutCommandReceipts,
  workoutSessions,
} from "./workout.js";

/**
 * Schema-shape tests only — no live Postgres connection required (spec
 * section 16 precedent). The actual migration is generated/applied and
 * inspected via psql separately (docs/architecture/WORKOUT-DATA-INTEGRITY.md).
 */
describe("workout schema", () => {
  it("defines the workout tables in the app schema", () => {
    expect(getTableName(workoutSessions)).toBe("workout_sessions");
    expect(getTableName(performedExercises)).toBe("performed_exercises");
    expect(getTableName(performedSets)).toBe("performed_sets");
    expect(getTableName(workoutCommandReceipts)).toBe("workout_command_receipts");
    expect(getTableName(workoutChangeCursor)).toBe("workout_change_cursor");
  });

  it("locks the Stage 1 Load Model subset", () => {
    expect(LOAD_KIND_V1_VALUES).toEqual(["EXTERNAL_WEIGHT"]);
    expect(LOAD_UNIT_VALUES).toEqual(["KG", "LB"]);
    expect(LOAD_BASIS_V1_VALUES).toEqual(["TOTAL", "PER_IMPLEMENT"]);
  });

  it("locks the performed-set completion states to the undo primitive", () => {
    expect(PERFORMED_SET_COMPLETION_STATE_VALUES).toEqual(["COMPLETED", "REOPENED"]);
  });

  it("locks the workout command type and outcome vocabularies", () => {
    expect(WORKOUT_COMMAND_TYPE_VALUES).toEqual([
      "START_WORKOUT_SESSION_V1",
      "COMPLETE_SET_V1",
      "REOPEN_SET_V1",
      "FINISH_WORKOUT_SESSION_V1",
    ]);
    expect(WORKOUT_COMMAND_OUTCOME_VALUES).toEqual(["APPLIED", "STALE", "REJECTED"]);
  });

  it("requires revision and load columns on performed_sets", () => {
    expect(Object.keys(performedSets)).toEqual(
      expect.arrayContaining(["revision", "loadKind", "loadAmountMilli", "loadUnit", "loadBasis"]),
    );
  });

  it("Progression Prerequisites V1: locks performed_sets.setType to exactly WORKING/WARM_UP — no reserved placeholders", () => {
    expect(PERFORMED_SET_TYPE_VALUES).toEqual(["WORKING", "WARM_UP"]);
    expect(Object.keys(performedSets)).toContain("setType");
  });

  it("Progression Prerequisites V1: performed_exercises carries a synchronized exerciseRef", () => {
    expect(Object.keys(performedExercises)).toContain("exerciseRef");
  });

  it("Exercise Ref Legacy Reconciliation: performed_exercises.exercise_ref is NOT NULL — no permanent unknown-exercise steady state", () => {
    expect(performedExercises.exerciseRef.notNull).toBe(true);
  });

  it("supports session completion via an optional completedAt, alongside status", () => {
    expect(Object.keys(workoutSessions)).toEqual(expect.arrayContaining(["status", "completedAt"]));
  });
});
