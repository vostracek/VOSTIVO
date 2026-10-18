import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { sql } from "drizzle-orm";
import type { AvailableTimePreviewResponseV1, StartWorkoutSessionCommandV1 } from "@vostivo/contracts";
import { createEntityId } from "@vostivo/domain";
import { openTestLocalDatabase, type TestDatabaseConnection } from "../local-database/testing/node-sqlite-database";
import { PlanApplicationService, type WorkoutSessionGateway } from "../plan/plan-application-service";
import type { PlanApiClient } from "../plan/plan-api-client";
import { AdjustedWorkoutStartService } from "../workout/adjusted-workout-start";
import { previousPerformanceRefs, previousSetsFor, resolvePrefill } from "../workout/active-workout-presentation";
import type { PreviousSetPerformance } from "../workout/workout-repository";
import { WorkoutRepository } from "../workout/workout-repository";
import { BENCH_ID, BENCH_SETS, OHP_ID, OHP_SETS, WORKOUT_ID, adjustedWorkoutPreview, authoredWorkoutPreview } from "./testing/fixtures";

// The production default opens the native encrypted expo-sqlite database (not available under vitest);
// every repository here is given the real-SQLite test database explicitly instead.
vi.mock("../local-database/client", () => ({
  initializeLocalDatabase: () => Promise.reject(new Error("native expo-sqlite is not available under vitest")),
}));

/**
 * Temporary Equipment V1 Slice D — SERVER EFFECTIVE PRESCRIPTION DRIVES
 * START: after Apply, the ordinary Start Workout (and an Available-Time
 * adjusted START) snapshot the server's equipment-adjusted Workout Preview
 * verbatim, on the REAL local repository SQL (real SQLite). Mobile never
 * constructs or merges a prescription, and Active Workout presents the
 * performed substitute with its OWN load / Previous — never the authored one.
 */
const AUTHORED_LOADS = [80000, 40000];

function outboxStartCommands(connection: TestDatabaseConnection): StartWorkoutSessionCommandV1[] {
  return connection.db
    .all<{ payload_json: string }>(sql`SELECT payload_json FROM sync_outbox WHERE command_type = 'START_WORKOUT_SESSION_V1'`)
    .map((row) => JSON.parse(row.payload_json) as StartWorkoutSessionCommandV1);
}

function unusedPlanApi(): PlanApiClient {
  const fail = () => Promise.reject(new Error("no network in this test"));
  return { getCurrentPlan: fail, getWorkoutPreview: fail, previewAvailableTime: fail };
}

describe("equipment-adjusted START + Active Workout presentation (real SQLite)", () => {
  let path: string;
  let connection: TestDatabaseConnection;
  let repository: WorkoutRepository;

  beforeEach(() => {
    path = `${tmpdir()}/vostivo-equipment-start-${createEntityId()}.db`;
    connection = openTestLocalDatabase(path);
    const db = connection.db;
    repository = new WorkoutRepository(() => Promise.resolve(db));
  });

  afterEach(() => {
    connection.close();
    rmSync(path, { force: true });
  });

  it("ordinary Start Workout snapshots the server's effective adjusted prescription verbatim — substitute identity + provenance, own loads", async () => {
    const preview = adjustedWorkoutPreview();
    const gateway: WorkoutSessionGateway = { startWorkoutSession: (p) => repository.startWorkoutSession(p), getActiveWorkoutSession: () => repository.getActiveWorkoutSession() };
    const service = new PlanApplicationService(unusedPlanApi(), gateway);
    const outcome = await service.startWorkout(preview);
    expect(outcome.status).toBe("STARTED");

    const session = await repository.getActiveWorkoutSession();
    expect(session!.prescription).toEqual(preview.prescription);
    expect(session!.prescription.exercises.map((e) => [e.prescriptionExerciseId, e.exerciseRef, e.displayName, e.substitution?.authoredExerciseRef])).toEqual([
      [BENCH_ID, "dumbbell-bench-press", "Dumbbell Bench Press", "bench-press"],
      [OHP_ID, "seated-dumbbell-overhead-press", "Seated Dumbbell Overhead Press", "overhead-press"],
    ]);
    // The START command carries the same snapshot (the server verifies it against the durable application).
    expect(outboxStartCommands(connection)[0]!.prescription).toEqual(preview.prescription);
    const loads = session!.prescription.exercises.flatMap((e) => e.sets.map((s) => s.targetLoad?.amountMilli ?? null));
    expect(loads).toEqual([24000, 24000, 24000, null, null]);
    expect(loads.some((l) => l !== null && AUTHORED_LOADS.includes(l))).toBe(false);
  });

  it("Available-Time on top of the applied equipment (composition): the adjusted START keeps the substitutes and removes only sets", async () => {
    const sync = { requestSync: () => undefined };
    const service = new AdjustedWorkoutStartService(repository, sync);
    const timePreview: AvailableTimePreviewResponseV1 = {
      policyVersion: "available-time/v1",
      plannedWorkoutId: WORKOUT_ID,
      sourceProgramVersionId: "00000000-0000-7000-8000-000000000002",
      availableMinutes: 20,
      result: "ADJUST_SESSION",
      fitsAvailableTime: true,
      originalEstimatedSeconds: 900,
      adjustedEstimatedSeconds: 700,
      minimumEstimatedSeconds: null,
      previewFingerprint: "e".repeat(64),
      exercises: [
        { plannedExerciseId: BENCH_ID, exerciseRef: "bench-press", displayName: "Bench Press", priorityTier: "TIER_1", originalWorkingSetCount: 3, retainedWorkingSetCount: 2, removedWorkingSetCount: 1, originalTotalSetCount: 3, retainedTotalSetCount: 2, minimumWorkingSets: 2, removedEntireExercise: false, retainedPlannedSetIds: [BENCH_SETS[0], BENCH_SETS[1]], removedPlannedSetIds: [BENCH_SETS[2]] },
        { plannedExerciseId: OHP_ID, exerciseRef: "overhead-press", displayName: "Overhead Press", priorityTier: "TIER_2", originalWorkingSetCount: 2, retainedWorkingSetCount: 2, removedWorkingSetCount: 0, originalTotalSetCount: 2, retainedTotalSetCount: 2, minimumWorkingSets: 1, removedEntireExercise: false, retainedPlannedSetIds: [...OHP_SETS], removedPlannedSetIds: [] },
      ],
    };
    const outcome = await service.startAdjustedWorkout({ workoutPreview: adjustedWorkoutPreview(), availableTimePreview: timePreview });
    expect(outcome.status).toBe("STARTED");
    if (outcome.status !== "STARTED") return;
    expect(outcome.session.prescription.exercises.map((e) => [e.exerciseRef, e.substitution?.equipmentApplicationId !== undefined, e.sets.map((s) => s.prescriptionSetId)])).toEqual([
      ["dumbbell-bench-press", true, [BENCH_SETS[0], BENCH_SETS[1]]],
      ["seated-dumbbell-overhead-press", true, [...OHP_SETS]],
    ]);
    expect(outboxStartCommands(connection)[0]!.prescription).toEqual(outcome.session.prescription);
  });

  it("Previous performance is looked up and shown ONLY for the performed substitute identity, never the authored exercise", () => {
    const prescription = adjustedWorkoutPreview().prescription;
    expect(previousPerformanceRefs(prescription)).toEqual(["dumbbell-bench-press", "seated-dumbbell-overhead-press"]);
    const benchHistory: PreviousSetPerformance[] = [{ order: 1, actualReps: 10, actualLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: 80000, unit: "KG", basis: "TOTAL" } }];
    const byRef = new Map<string, readonly PreviousSetPerformance[]>([["bench-press", benchHistory]]);
    // Authored Bench Press history exists, but the substituted slot shows nothing from it.
    expect(previousSetsFor(prescription.exercises[0]!, byRef)).toBeUndefined();
    expect(previousSetsFor(authoredWorkoutPreview().prescription.exercises[0]!, byRef)).toBe(benchHistory);
  });

  it("the logger prefill never shows the authored load as the substitute's: own load when the server resolved one, empty otherwise", () => {
    const [dbBench, dbOhp] = adjustedWorkoutPreview().prescription.exercises;
    expect(resolvePrefill(dbBench!.sets[0]!, undefined, undefined, undefined)).toEqual({ reps: "", load: "24", unit: "KG", basis: "PER_IMPLEMENT" });
    // No substitute history and no target -> the existing empty state (never 40 kg from the authored OHP).
    expect(resolvePrefill(dbOhp!.sets[0]!, undefined, undefined, undefined)).toEqual({ reps: "", load: "", unit: "KG", basis: "TOTAL" });
  });
});
