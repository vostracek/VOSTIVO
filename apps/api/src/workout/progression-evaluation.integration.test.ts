import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import {
  createDatabaseClient,
  performedExercises,
  performedSets,
  programVersions,
  progressionDecisions,
  users,
  workoutChangeCursor,
  workoutCommandReceipts,
  workoutSessions,
  type Database,
  athleteProfiles,
  programs,
  trainingBlocks,
  trainingCycles,
  plannedWorkouts,
  plannedExercises,
  plannedSets,
  plannedWorkoutOccurrenceClaims,
} from "@vostivo/database";
import { createEntityId, type WorkoutPrescriptionV1 } from "@vostivo/domain";
import type { CompleteSetCommandV1, FinishWorkoutSessionCommandV1, ReopenSetCommandV1, StartWorkoutSessionCommandV1 } from "@vostivo/contracts";
import { ensureProgressionEvaluateSessionQueues, ProgressionEvaluationService, WorkoutHistoryService } from "@vostivo/progression-application";
import { processWorkoutCommand } from "./workout-command-processing.js";

/**
 * Real Postgres integration tests for Progression EngineDecision
 * Persistence & Evidence Integration V1 (docs/domain/
 * PROGRESSION-ENGINE-V1.md §18/§19/§29). Run via `pnpm test:integration`,
 * not part of the default `pnpm test` gate. Uses the real
 * `processWorkoutCommand` path to create canonical evidence — never
 * hand-inserted rows — so these tests prove the whole real system, not a
 * synthetic shortcut.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://vostivo_api:vostivo_api@localhost:5432/vostivo_dev";

const EXERCISE_REF = "progression-slice-c-bench-press";
const OTHER_EXERCISE_REF = "progression-slice-c-overhead-press";

function rangeTarget(minReps: number, maxReps: number) {
  return { kind: "RANGE" as const, minReps, maxReps };
}
function exactTarget(reps: number) {
  return { kind: "EXACT" as const, reps };
}
function load(amountMilli: number, unit: "KG" | "LB" = "KG", basis: "TOTAL" | "PER_IMPLEMENT" = "TOTAL") {
  return { kind: "EXTERNAL_WEIGHT" as const, amountMilli, unit, basis };
}

function buildPrescription(overrides: {
  readonly prescriptionExerciseId?: string;
  readonly exerciseRef?: string;
  readonly exerciseOrder?: number;
  readonly targetReps?: ReturnType<typeof rangeTarget> | ReturnType<typeof exactTarget>;
  readonly targetLoad?: ReturnType<typeof load>;
  readonly workingSetCount?: number;
  readonly includeWarmUp?: boolean;
} = {}): WorkoutPrescriptionV1 {
  const targetReps = overrides.targetReps ?? rangeTarget(8, 12);
  const targetLoad = overrides.targetLoad ?? load(60000);
  const workingSetCount = overrides.workingSetCount ?? 3;
  const workingSets = Array.from({ length: workingSetCount }, (_, i) => ({
    prescriptionSetId: `set-${i + 1}`,
    order: i + 1,
    targetReps,
    targetLoad,
    restSeconds: null,
    setType: "WORKING" as const,
  }));
  const sets = overrides.includeWarmUp
    ? [
        { prescriptionSetId: "warmup-1", order: 0, targetReps: exactTarget(5), targetLoad: null, restSeconds: null, setType: "WARM_UP" as const },
        ...workingSets,
      ]
    : workingSets;

  return {
    schemaVersion: 1,
    prescriptionId: `presc-${createEntityId()}`,
    name: "Slice C Test Day",
    exercises: [
      {
        prescriptionExerciseId: overrides.prescriptionExerciseId ?? "presc-ex-1",
        exerciseRef: overrides.exerciseRef ?? EXERCISE_REF,
        displayName: "Bench Press",
        order: overrides.exerciseOrder ?? 0,
        sets,
      },
    ],
  };
}

function startCommand(workoutSessionId: string, prescription: WorkoutPrescriptionV1): StartWorkoutSessionCommandV1 {
  return {
    commandId: createEntityId(),
    type: "START_WORKOUT_SESSION_V1",
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    workoutSessionId,
    prescription,
    startedAt: new Date().toISOString(),
  };
}

function completeCommand(workoutSessionId: string, overrides: Partial<CompleteSetCommandV1> = {}): CompleteSetCommandV1 {
  return {
    commandId: createEntityId(),
    type: "COMPLETE_SET_V1",
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    workoutSessionId,
    performedExerciseId: createEntityId(),
    prescriptionExerciseId: "presc-ex-1",
    exerciseRef: EXERCISE_REF,
    exerciseDisplayName: "Bench Press",
    exerciseOrder: 0,
    performedSetId: createEntityId(),
    prescriptionSetId: "set-1",
    setOrder: 1,
    actualReps: 10,
    actualLoad: load(60000),
    setType: "WORKING",
    revision: 1,
    completedAt: new Date().toISOString(),
    sessionSeq: 1,
    ...overrides,
  };
}

function finishCommand(workoutSessionId: string, finishSeq: number): FinishWorkoutSessionCommandV1 {
  return {
    commandId: createEntityId(),
    type: "FINISH_WORKOUT_SESSION_V1",
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    workoutSessionId,
    completedAt: new Date().toISOString(),
    finishSeq,
  };
}

function reopenCommand(performedSetId: string, revision: number, sessionSeq: number): ReopenSetCommandV1 {
  return {
    commandId: createEntityId(),
    type: "REOPEN_SET_V1",
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    performedSetId,
    revision,
    sessionSeq,
  };
}

describe("ProgressionEvaluationService (real Postgres)", () => {
  let db: Database;
  let historyService: WorkoutHistoryService;
  let service: ProgressionEvaluationService;
  let userId: string;
  let otherUserId: string;
  // Progression Evaluation Orchestration V1: `processWorkoutCommand` (used
  // here via `runCompletedSession`/`finishCommand` to build real canonical
  // evidence) now enqueues a durable pg-boss job transactionally — a real,
  // started producer instance, shared across this suite's tests.
  let testBoss: PgBoss;

  beforeAll(async () => {
    testBoss = new PgBoss({ connectionString: DATABASE_URL, migrate: false, supervise: false, schedule: false });
    await testBoss.start();
    await ensureProgressionEvaluateSessionQueues(testBoss);
  });

  afterAll(async () => {
    await testBoss.stop();
  });

  beforeEach(async () => {
    db = createDatabaseClient(DATABASE_URL);
    historyService = new WorkoutHistoryService(db);
    service = new ProgressionEvaluationService(db, historyService);
    userId = createEntityId();
    otherUserId = createEntityId();
    await db.insert(users).values([
      { id: userId, status: "ACTIVE" },
      { id: otherUserId, status: "ACTIVE" },
    ]);
  });

  async function cleanup(): Promise<void> {
    const allUserIds = [userId, otherUserId];
    const sessions = await db.select({ id: workoutSessions.id }).from(workoutSessions).where(inArray(workoutSessions.userId, allUserIds));
    const sessionIds = sessions.map((s) => s.id);
    if (sessionIds.length > 0) {
      const exercises = await db.select({ id: performedExercises.id }).from(performedExercises).where(inArray(performedExercises.workoutSessionId, sessionIds));
      const exerciseIds = exercises.map((e) => e.id);
      await db.delete(progressionDecisions).where(inArray(progressionDecisions.userId, allUserIds));
      if (exerciseIds.length > 0) {
        await db.delete(performedSets).where(inArray(performedSets.performedExerciseId, exerciseIds));
      }
      await db.delete(performedExercises).where(inArray(performedExercises.workoutSessionId, sessionIds));
    }
    await db.delete(workoutChangeCursor).where(inArray(workoutChangeCursor.userId, allUserIds));
    await db.delete(workoutCommandReceipts).where(inArray(workoutCommandReceipts.userId, allUserIds));
    await db.delete(workoutSessions).where(inArray(workoutSessions.userId, allUserIds));
    await db.delete(users).where(inArray(users.id, allUserIds));
  }

  /** Starts, completes, and finishes a session in one shot — the normal anchor shape for most tests. */
  async function runCompletedSession(
    forUserId: string,
    options: {
      readonly prescription?: WorkoutPrescriptionV1;
      readonly reps?: readonly number[];
      readonly setIds?: readonly (string | null)[];
      readonly includeWarmUp?: boolean;
    } = {},
  ): Promise<{ readonly workoutSessionId: string; readonly performedExerciseId: string; readonly setIds: readonly string[] }> {
    const workoutSessionId = createEntityId();
    const prescription = options.prescription ?? buildPrescription(options.includeWarmUp !== undefined ? { includeWarmUp: options.includeWarmUp } : {});
    await processWorkoutCommand(db, testBoss, forUserId, startCommand(workoutSessionId, prescription));

    const exercise = prescription.exercises[0]!;
    const performedExerciseId = createEntityId();
    const reps = options.reps ?? [10, 10, 10];
    const setIds: string[] = [];

    if (options.includeWarmUp) {
      await processWorkoutCommand(
        db, testBoss,
        forUserId,
        completeCommand(workoutSessionId, {
          performedExerciseId,
          prescriptionExerciseId: exercise.prescriptionExerciseId,
          exerciseRef: exercise.exerciseRef!,
          exerciseOrder: exercise.order,
          performedSetId: createEntityId(),
          prescriptionSetId: "warmup-1",
          setOrder: 0,
          actualReps: 5,
          actualLoad: load(20000),
          setType: "WARM_UP",
          sessionSeq: 1,
        }),
      );
    }

    let seq = options.includeWarmUp ? 2 : 1;
    for (const [i, actualReps] of reps.entries()) {
      const performedSetId = createEntityId();
      setIds.push(performedSetId);
      const prescriptionSetId = options.setIds ? options.setIds[i] : `set-${i + 1}`;
      await processWorkoutCommand(
        db, testBoss,
        forUserId,
        completeCommand(workoutSessionId, {
          performedExerciseId,
          prescriptionExerciseId: exercise.prescriptionExerciseId,
          exerciseRef: exercise.exerciseRef!,
          exerciseOrder: exercise.order,
          performedSetId,
          prescriptionSetId: prescriptionSetId ?? null,
          setOrder: i + 1,
          actualReps,
          sessionSeq: seq++,
        }),
      );
    }

    await processWorkoutCommand(db, testBoss, forUserId, finishCommand(workoutSessionId, seq - 1));
    return { workoutSessionId, performedExerciseId, setIds };
  }

  // 1-4, 7, 10, 13
  it("1/7/10/13: a real completed WORKING exposure assembles and evaluates -> full top of range -> INCREASE_LOAD, engine/policy=progression/v1", async () => {
    const anchor = await runCompletedSession(userId, { reps: [12, 12, 12] });

    const outcome = await service.evaluateAndPersist({ userId }, anchor);
    expect(outcome.status).toBe("PERSISTED");
    if (outcome.status !== "PERSISTED") throw new Error("expected PERSISTED");
    expect(outcome.decision.data.decisionType).toBe("INCREASE_LOAD");
    expect(outcome.decision.data.reasonCode).toBe("TOP_OF_RANGE_ACHIEVED");
    expect(outcome.decision.data.evidenceStrength).toBe("SINGLE_EXPOSURE");
    expect(outcome.decision.engine).toBe("progression");
    expect(outcome.decision.policy).toBe("v1");
    expect(outcome.decision.appliedAt).toBeNull();

    await cleanup();
  });

  // 2: WARM_UP excluded
  it("2: WARM_UP history exists but never enters the normalized engine evidence", async () => {
    const anchor = await runCompletedSession(userId, { reps: [12, 12, 12], includeWarmUp: true });

    const outcome = await service.evaluateAndPersist({ userId }, anchor);
    expect(outcome.status).toBe("PERSISTED");
    if (outcome.status !== "PERSISTED") throw new Error("expected PERSISTED");

    // WARM_UP is real canonical history (proven independently)...
    const allSets = await db.select().from(performedSets).where(eq(performedSets.performedExerciseId, anchor.performedExerciseId));
    expect(allSets.some((s) => s.setType === "WARM_UP")).toBe(true);
    // ...but the persisted normalized input snapshot contains only WORKING.
    const snapshot = outcome.decision.normalizedInputSnapshot;
    const allWorkingSets = snapshot.exposures.flatMap((e) => e.workingSets);
    expect(allWorkingSets.every((s) => s.setType === "WORKING")).toBe(true);
    expect(allWorkingSets).toHaveLength(3);

    await cleanup();
  });

  // 3/4: exact exerciseRef only, another exercise excluded
  it("3/4: only the exact exerciseRef contributes evidence — a different exerciseRef never appears", async () => {
    const anchor = await runCompletedSession(userId, { reps: [10, 10, 10] });
    // A prior session for a DIFFERENT exercise — must never be treated as comparable history.
    await runCompletedSession(userId, {
      prescription: buildPrescription({ exerciseRef: OTHER_EXERCISE_REF }),
      reps: [12, 12, 12],
    });

    const outcome = await service.evaluateAndPersist({ userId }, anchor);
    expect(outcome.status).toBe("PERSISTED");
    if (outcome.status !== "PERSISTED") throw new Error("expected PERSISTED");
    expect(outcome.decision.normalizedInputSnapshot.exposures).toHaveLength(1); // only the anchor — the other exercise never counted
    expect(outcome.decision.exerciseRef).toBe(EXERCISE_REF);

    await cleanup();
  });

  // 5: another user's history excluded (BOLA)
  it("5: another user's workout history is never consumed, and User A cannot evaluate User B's exposure", async () => {
    const otherAnchor = await runCompletedSession(otherUserId, { reps: [12, 12, 12] });

    const asWrongUser = await service.evaluateAndPersist({ userId }, otherAnchor);
    expect(asWrongUser.status).toBe("SOURCE_NOT_FOUND");

    await cleanup();
  });

  // 6: zero evidence case
  it("6: zero WORKING sets exist for the exercise (only WARM_UP) -> NO_CHANGE / INSUFFICIENT_EVIDENCE is supported and persisted", async () => {
    // A performedExercise with literally zero performed sets is not a
    // reachable real state (a row is only ever created as a side effect
    // of completing a set — see applyCompleteSet) — this is the real
    // reachable "no usable WORKING evidence yet" case instead.
    const anchor = await runCompletedSession(userId, { reps: [], includeWarmUp: true });

    const outcome = await service.evaluateAndPersist({ userId }, anchor);
    expect(outcome.status).toBe("PERSISTED");
    if (outcome.status !== "PERSISTED") throw new Error("expected PERSISTED");
    expect(outcome.decision.data.decisionType).toBe("NO_CHANGE");
    expect(outcome.decision.data.reasonCode).toBe("INSUFFICIENT_EVIDENCE");

    await cleanup();
  });

  // 8: positive progression
  it("8: positive non-regressing progression across two exposures -> MAINTAIN_LOAD_BUILD_REPS", async () => {
    await runCompletedSession(userId, { reps: [10, 9, 9] });
    const anchor = await runCompletedSession(userId, { reps: [11, 10, 9] });

    const outcome = await service.evaluateAndPersist({ userId }, anchor);
    expect(outcome.status).toBe("PERSISTED");
    if (outcome.status !== "PERSISTED") throw new Error("expected PERSISTED");
    expect(outcome.decision.data.decisionType).toBe("MAINTAIN_LOAD_BUILD_REPS");
    expect(outcome.decision.data.reasonCode).toBe("REPS_PROGRESSING");

    await cleanup();
  });

  // 9: RANGE precedence regression case (11/10/9 -> 12/9/8)
  it("9: regression case 11/10/9 -> 12/9/8 -> NO_CHANGE (RANGE precedence fix, not masked by one set touching maxReps)", async () => {
    await runCompletedSession(userId, { reps: [11, 10, 9] });
    const anchor = await runCompletedSession(userId, { reps: [12, 9, 8] });

    const outcome = await service.evaluateAndPersist({ userId }, anchor);
    expect(outcome.status).toBe("PERSISTED");
    if (outcome.status !== "PERSISTED") throw new Error("expected PERSISTED");
    expect(outcome.decision.data.decisionType).toBe("NO_CHANGE");
    expect(outcome.decision.data.reasonCode).toBe("PERFORMANCE_REGRESSED_SINGLE_EXPOSURE");

    await cleanup();
  });

  // 11: partial exposure
  it("11: partial exposure (2 of 3 required sets, both at max) -> MAINTAIN_LOAD_BUILD_REPS / PARTIAL_EXPOSURE, never treated as failure", async () => {
    const anchor = await runCompletedSession(userId, { reps: [12, 12], setIds: ["set-1", "set-2"] });

    const outcome = await service.evaluateAndPersist({ userId }, anchor);
    expect(outcome.status).toBe("PERSISTED");
    if (outcome.status !== "PERSISTED") throw new Error("expected PERSISTED");
    expect(outcome.decision.data.decisionType).toBe("MAINTAIN_LOAD_BUILD_REPS");
    expect(outcome.decision.data.reasonCode).toBe("PARTIAL_EXPOSURE");

    await cleanup();
  });

  // 12: changed prescription/reset
  it("12: a prior exposure under a different targetReps is excluded (PRESCRIPTION_CHANGED_RESET), not treated as ordinary evidence", async () => {
    await runCompletedSession(userId, { prescription: buildPrescription({ targetReps: exactTarget(5) }), reps: [5, 5, 5] });
    const anchor = await runCompletedSession(userId, { reps: [12, 12, 12] });

    const outcome = await service.evaluateAndPersist({ userId }, anchor);
    expect(outcome.status).toBe("PERSISTED");
    if (outcome.status !== "PERSISTED") throw new Error("expected PERSISTED");
    expect(outcome.decision.normalizedInputSnapshot.exposures).toHaveLength(1); // the incompatible prior exposure was excluded
    expect(outcome.decision.normalizedInputSnapshot.priorExposuresExcludedByPrescriptionChange).toBe(true);
    expect(outcome.decision.data.decisionType).toBe("INCREASE_LOAD"); // the anchor alone still independently qualifies (§11.1/OD-5)

    await cleanup();
  });

  // 14: NOT_COMPARABLE exclusion (different load unit)
  it("14: a prior exposure under a different load unit is NOT_COMPARABLE and excluded, never auto-converted", async () => {
    await runCompletedSession(userId, { prescription: buildPrescription({ targetLoad: load(135000, "LB") }), reps: [10, 10, 10] });
    const anchor = await runCompletedSession(userId, { reps: [10, 10, 10] });

    const outcome = await service.evaluateAndPersist({ userId }, anchor);
    expect(outcome.status).toBe("PERSISTED");
    if (outcome.status !== "PERSISTED") throw new Error("expected PERSISTED");
    expect(outcome.decision.normalizedInputSnapshot.exposures).toHaveLength(1);

    await cleanup();
  });

  // 15: bounded 3-exposure engine input
  it("15: more than 2 prior comparable exposures exist, but the engine input never exceeds 3 total exposures", async () => {
    await runCompletedSession(userId, { reps: [9, 9, 9] });
    await runCompletedSession(userId, { reps: [9, 9, 9] });
    await runCompletedSession(userId, { reps: [9, 9, 9] });
    const anchor = await runCompletedSession(userId, { reps: [10, 10, 10] });

    const outcome = await service.evaluateAndPersist({ userId }, anchor);
    expect(outcome.status).toBe("PERSISTED");
    if (outcome.status !== "PERSISTED") throw new Error("expected PERSISTED");
    expect(outcome.decision.normalizedInputSnapshot.exposures.length).toBeLessThanOrEqual(3);

    await cleanup();
  });

  // 16/17: persisted engineVersion + output equals evaluateProgression output
  it("16/17: persisted decision output matches exactly what evaluateProgression would produce for the same input", async () => {
    const anchor = await runCompletedSession(userId, { reps: [12, 12, 12] });
    const outcome = await service.evaluateAndPersist({ userId }, anchor);
    expect(outcome.status).toBe("PERSISTED");
    if (outcome.status !== "PERSISTED") throw new Error("expected PERSISTED");

    const { evaluateProgression } = await import("@vostivo/training-engine");
    const replay = evaluateProgression(outcome.decision.normalizedInputSnapshot);
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.data).toEqual(outcome.decision.data);
      expect(replay.value.version).toEqual({ engine: outcome.decision.engine, policy: outcome.decision.policy });
    }

    await cleanup();
  });

  // 18/19: normalized input snapshot round-trip + evidence refs
  it("18/19: normalized input snapshot round-trips and evidence refs contain the exact performedSetId + revision", async () => {
    const anchor = await runCompletedSession(userId, { reps: [10, 10, 10] });
    const outcome = await service.evaluateAndPersist({ userId }, anchor);
    expect(outcome.status).toBe("PERSISTED");
    if (outcome.status !== "PERSISTED") throw new Error("expected PERSISTED");

    expect(outcome.decision.normalizedInputSnapshot.prescription.exerciseRef).toBe(EXERCISE_REF);
    expect(outcome.decision.evidenceRefs).toHaveLength(3);
    for (const ref of outcome.decision.evidenceRefs) {
      expect(anchor.setIds).toContain(ref.performedSetId);
      expect(ref.revisionEvaluated).toBe(1);
    }

    await cleanup();
  });

  // 20/21: idempotency + concurrency
  it("20: the same exact evaluation twice creates exactly one persistent record", async () => {
    const anchor = await runCompletedSession(userId, { reps: [12, 12, 12] });

    const first = await service.evaluateAndPersist({ userId }, anchor);
    const second = await service.evaluateAndPersist({ userId }, anchor);
    expect(first.status).toBe("PERSISTED");
    expect(second.status).toBe("PERSISTED");
    if (first.status !== "PERSISTED" || second.status !== "PERSISTED") throw new Error("expected PERSISTED");
    expect(first.wasNewlyCreated).toBe(true);
    expect(second.wasNewlyCreated).toBe(false);
    expect(first.decision.id).toBe(second.decision.id);

    const rows = await db.select().from(progressionDecisions).where(eq(progressionDecisions.sourcePerformedExerciseId, anchor.performedExerciseId));
    expect(rows).toHaveLength(1);

    await cleanup();
  });

  it("21: two concurrent evaluations of the exact same evidence produce exactly one persisted record (real Postgres race)", async () => {
    const anchor = await runCompletedSession(userId, { reps: [12, 12, 12] });

    const [a, b] = await Promise.all([service.evaluateAndPersist({ userId }, anchor), service.evaluateAndPersist({ userId }, anchor)]);
    expect(a.status).toBe("PERSISTED");
    expect(b.status).toBe("PERSISTED");
    if (a.status !== "PERSISTED" || b.status !== "PERSISTED") throw new Error("expected PERSISTED");
    expect(a.decision.id).toBe(b.decision.id);
    // Exactly one of the two calls actually created the row.
    expect([a.wasNewlyCreated, b.wasNewlyCreated].filter(Boolean)).toHaveLength(1);

    const rows = await db.select().from(progressionDecisions).where(eq(progressionDecisions.sourcePerformedExerciseId, anchor.performedExerciseId));
    expect(rows).toHaveLength(1);

    await cleanup();
  });

  // Slice C identity gate (2026-09-23), required test §6 — the most important
  // new case: a revision-only correction where the CANONICAL VALUES are
  // identical (100x10 -> 100x10, only the revision changes) must still be
  // treated as a genuinely new historical evaluation event.
  it("identity gate §6: a revision-only correction with IDENTICAL values still produces a new decision, superseding the old one", async () => {
    const workoutSessionId = createEntityId();
    const prescription = buildPrescription();
    const exercise = prescription.exercises[0]!;
    await processWorkoutCommand(db, testBoss, userId, startCommand(workoutSessionId, prescription));

    const performedExerciseId = createEntityId();
    const setId = createEntityId();
    await processWorkoutCommand(
      db, testBoss,
      userId,
      completeCommand(workoutSessionId, {
        performedExerciseId,
        prescriptionExerciseId: exercise.prescriptionExerciseId,
        exerciseRef: exercise.exerciseRef!,
        exerciseOrder: exercise.order,
        performedSetId: setId,
        prescriptionSetId: "set-1",
        setOrder: 1,
        actualReps: 10,
        actualLoad: load(100000),
        sessionSeq: 1,
      }),
    );
    // finishSeq=3 reserves seq 2/3 for the not-yet-delivered, value-identical correction below.
    await processWorkoutCommand(db, testBoss, userId, finishCommand(workoutSessionId, 3));
    const anchor = { workoutSessionId, performedExerciseId };

    const d1Outcome = await service.evaluateAndPersist({ userId }, anchor);
    expect(d1Outcome.status).toBe("PERSISTED");
    if (d1Outcome.status !== "PERSISTED") throw new Error("expected PERSISTED");
    const d1 = d1Outcome.decision;
    expect(d1.evidenceRefs).toEqual([{ performedSetId: setId, revisionEvaluated: 1 }]);

    // The correction: revision 1 -> 2, but actualReps/actualLoad are BYTE-IDENTICAL (100 x 10).
    await processWorkoutCommand(db, testBoss, userId, reopenCommand(setId, 2, 2));
    await processWorkoutCommand(
      db, testBoss,
      userId,
      completeCommand(workoutSessionId, {
        performedExerciseId,
        prescriptionExerciseId: exercise.prescriptionExerciseId,
        exerciseRef: exercise.exerciseRef!,
        exerciseOrder: exercise.order,
        performedSetId: setId,
        prescriptionSetId: "set-1",
        setOrder: 1,
        actualReps: 10,
        actualLoad: load(100000),
        revision: 3,
        sessionSeq: 3,
      }),
    );

    const d2Outcome = await service.evaluateAndPersist({ userId }, anchor);
    expect(d2Outcome.status).toBe("PERSISTED");
    if (d2Outcome.status !== "PERSISTED") throw new Error("expected PERSISTED");
    const d2 = d2Outcome.decision;

    // A genuinely NEW decision was created — never treated as idempotent-identical.
    expect(d2.id).not.toBe(d1.id);
    expect(d2Outcome.wasNewlyCreated).toBe(true);
    expect(d2.evidenceFingerprint).not.toBe(d1.evidenceFingerprint);
    expect(d2.evidenceRefs).toEqual([{ performedSetId: setId, revisionEvaluated: 3 }]);

    // The engine OUTPUT may be identical (same values -> same decision) —
    // audit identity is evidence-revision-based, not merely output-based.
    expect(d2.data).toEqual(d1.data);

    // D1 remains intact and is now superseded.
    const [d1Reread] = await db.select().from(progressionDecisions).where(eq(progressionDecisions.id, d1.id));
    expect(d1Reread).toBeDefined();
    expect(d1Reread!.evidenceRefs).toEqual([{ performedSetId: setId, revisionEvaluated: 1 }]);
    expect(d1Reread!.supersededByDecisionId).toBe(d2.id);

    // Both stored snapshots replay deterministically.
    const { evaluateProgression } = await import("@vostivo/training-engine");
    const replayD1 = evaluateProgression(d1Reread!.normalizedInputSnapshot as typeof d1.normalizedInputSnapshot);
    const replayD2 = evaluateProgression(d2.normalizedInputSnapshot);
    expect(replayD1.ok && replayD1.value.data).toEqual(d1.data);
    expect(replayD2.ok && replayD2.value.data).toEqual(d2.data);

    await cleanup();
  });

  // Slice C identity gate §7 — two structurally distinct source exposures
  // (different sessions, different performed exercises) that happen to
  // produce semantically identical normalized values must NOT collapse
  // into one persisted row.
  it("identity gate §7: two distinct source exposures with identical normalized values do not collide", async () => {
    const anchorA = await runCompletedSession(userId, { reps: [10, 10, 10] });
    const anchorB = await runCompletedSession(userId, { reps: [10, 10, 10] });
    expect(anchorA.workoutSessionId).not.toBe(anchorB.workoutSessionId);
    expect(anchorA.performedExerciseId).not.toBe(anchorB.performedExerciseId);

    const outcomeA = await service.evaluateAndPersist({ userId }, anchorA);
    const outcomeB = await service.evaluateAndPersist({ userId }, anchorB);
    expect(outcomeA.status).toBe("PERSISTED");
    expect(outcomeB.status).toBe("PERSISTED");
    if (outcomeA.status !== "PERSISTED" || outcomeB.status !== "PERSISTED") throw new Error("expected PERSISTED");

    // Two distinct historical evaluation events — never collapsed into one row.
    expect(outcomeA.decision.id).not.toBe(outcomeB.decision.id);
    expect(outcomeA.decision.evidenceFingerprint).not.toBe(outcomeB.decision.evidenceFingerprint);
    expect(outcomeA.decision.sourceWorkoutSessionId).not.toBe(outcomeB.decision.sourceWorkoutSessionId);
    expect(outcomeA.decision.sourcePerformedExerciseId).not.toBe(outcomeB.decision.sourcePerformedExerciseId);
    expect(outcomeA.wasNewlyCreated).toBe(true);
    expect(outcomeB.wasNewlyCreated).toBe(true);

    // Both may legitimately share the same engine output (same values, same decision).
    expect(outcomeA.decision.data).toEqual(outcomeB.decision.data);

    const rows = await db
      .select()
      .from(progressionDecisions)
      .where(inArray(progressionDecisions.sourcePerformedExerciseId, [anchorA.performedExerciseId, anchorB.performedExerciseId]));
    expect(rows).toHaveLength(2);

    await cleanup();
  });

  // 22-25 / 42: correction -> new decision, old retained+superseded, replay
  it("22/23/24/25 (audit reproducibility): a corrected set revision creates a new decision; the old one is retained, unchanged, and superseded", async () => {
    // Built manually (not via runCompletedSession) so finishSeq can
    // legitimately cover a correction delivered AFTER the session is
    // already COMPLETED — exactly the Finish causal boundary's own
    // "late-delivered but causally-earlier" allowance (ADR-0007): a real
    // offline client can locally reopen+recomplete a set, allocating
    // sessionSeq values, before ever locally finishing, and have those
    // specific commands' sync arrive at the server after FINISH already
    // landed. sessionSeq 4/5 are reserved up front for that correction.
    const workoutSessionId = createEntityId();
    const prescription = buildPrescription();
    const exercise = prescription.exercises[0]!;
    await processWorkoutCommand(db, testBoss, userId, startCommand(workoutSessionId, prescription));

    const performedExerciseId = createEntityId();
    const setIds = [createEntityId(), createEntityId(), createEntityId()];
    const reps = [10, 10, 10];
    for (const [i, actualReps] of reps.entries()) {
      await processWorkoutCommand(
        db, testBoss,
        userId,
        completeCommand(workoutSessionId, {
          performedExerciseId,
          prescriptionExerciseId: exercise.prescriptionExerciseId,
          exerciseRef: exercise.exerciseRef!,
          exerciseOrder: exercise.order,
          performedSetId: setIds[i]!,
          prescriptionSetId: `set-${i + 1}`,
          setOrder: i + 1,
          actualReps,
          sessionSeq: i + 1,
        }),
      );
    }
    // finishSeq=5 reserves seq 4/5 for the not-yet-delivered correction below.
    await processWorkoutCommand(db, testBoss, userId, finishCommand(workoutSessionId, 5));
    const anchor = { workoutSessionId, performedExerciseId, setIds };

    const d1Outcome = await service.evaluateAndPersist({ userId }, anchor);
    expect(d1Outcome.status).toBe("PERSISTED");
    if (d1Outcome.status !== "PERSISTED") throw new Error("expected PERSISTED");
    const d1 = d1Outcome.decision;
    expect(d1.data.decisionType).toBe("NO_CHANGE"); // 10 < maxReps 12, single exposure -> SINGLE_EXPOSURE_ONLY
    const originalSnapshot = d1.normalizedInputSnapshot;
    const originalOutput = d1.data;

    // The correction arrives late — real reopen -> recomplete path
    // (revision 1 -> 3), valid post-Finish because sessionSeq 4/5 <= finishSeq 5.
    const correctedSetId = anchor.setIds[0]!;
    await processWorkoutCommand(db, testBoss, userId, reopenCommand(correctedSetId, 2, 4));
    await processWorkoutCommand(
      db, testBoss,
      userId,
      completeCommand(anchor.workoutSessionId, {
        performedExerciseId: anchor.performedExerciseId,
        prescriptionExerciseId: exercise.prescriptionExerciseId,
        exerciseRef: exercise.exerciseRef!,
        exerciseOrder: exercise.order,
        performedSetId: correctedSetId,
        prescriptionSetId: "set-1",
        setOrder: 1,
        actualReps: 12,
        revision: 3,
        sessionSeq: 5,
      }),
    );

    const d2Outcome = await service.evaluateAndPersist({ userId }, anchor);
    expect(d2Outcome.status).toBe("PERSISTED");
    if (d2Outcome.status !== "PERSISTED") throw new Error("expected PERSISTED");
    const d2 = d2Outcome.decision;
    expect(d2.id).not.toBe(d1.id);
    expect(d2.data.decisionType).toBe("MAINTAIN_LOAD_BUILD_REPS"); // now one set touched the bar -> genuinely different output

    // D1 remains intact — unchanged snapshot/output/refs.
    const [d1Reread] = await db.select().from(progressionDecisions).where(eq(progressionDecisions.id, d1.id));
    expect(d1Reread).toBeDefined();
    expect(d1Reread!.normalizedInputSnapshot).toEqual(originalSnapshot);
    expect({
      decisionType: d1Reread!.decisionType,
      reasonCode: d1Reread!.reasonCode,
      evidenceStrength: d1Reread!.evidenceStrength,
      progressionStalled: d1Reread!.progressionStalled,
      recommendedChange: d1Reread!.recommendedChange,
    }).toEqual(originalOutput);
    expect(d1Reread!.supersededByDecisionId).toBe(d2.id);

    // Engine replay test (§43): re-running the STORED old snapshot still reproduces the STORED old output.
    const { evaluateProgression } = await import("@vostivo/training-engine");
    const replay = evaluateProgression(d1Reread!.normalizedInputSnapshot as typeof originalSnapshot);
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.value.data).toEqual(originalOutput);

    await cleanup();
  });

  // 26: appliedAt remains null
  it("26: appliedAt is always null for every decision this slice creates", async () => {
    const anchor = await runCompletedSession(userId, { reps: [12, 12, 12] });
    const outcome = await service.evaluateAndPersist({ userId }, anchor);
    expect(outcome.status).toBe("PERSISTED");
    if (outcome.status !== "PERSISTED") throw new Error("expected PERSISTED");
    expect(outcome.decision.appliedAt).toBeNull();

    await cleanup();
  });

  // 27: no Plan/ProgramVersion/PlannedSet mutation occurs
  /**
   * Test 27's isolation: everything it compares is the plan graph OWNED by
   * this test's user, walked by id ownership (user -> AthleteProfile ->
   * Program -> ProgramVersion -> TrainingBlock -> TrainingCycle ->
   * PlannedWorkout -> PlannedExercise -> PlannedSet) — never a global table
   * snapshot, which parallel integration files legitimately change.
   */
  async function seedOwnedPlan(forUserId: string): Promise<{ readonly workoutId: string; readonly exerciseId: string; readonly setIds: readonly string[] }> {
    const athleteProfileId = createEntityId();
    await db.insert(athleteProfiles).values({ id: athleteProfileId, userId: forUserId, experienceMode: "ADAPTIVE", unitSystem: "METRIC" });
    const [program] = await db.insert(programs).values({ id: createEntityId(), athleteProfileId, name: "Test Program", status: "ACTIVE" }).returning();
    const [version] = await db.insert(programVersions).values({ id: createEntityId(), programId: program!.id, versionNumber: 1, status: "ACTIVE", activatedAt: new Date() }).returning();
    const [block] = await db.insert(trainingBlocks).values({ id: createEntityId(), programVersionId: version!.id, name: "Block 1", goal: "Hypertrophy", orderIndex: 1, cycleCount: 1, focusAreas: [] }).returning();
    const today = new Date().toISOString().slice(0, 10);
    const [cycle] = await db.insert(trainingCycles).values({ id: createEntityId(), trainingBlockId: block!.id, orderIndex: 1, startDate: today, endDate: today }).returning();
    const [workout] = await db
      .insert(plannedWorkouts)
      .values({ id: createEntityId(), trainingCycleId: cycle!.id, name: "Upper Body A", focus: null, orderIndex: 1, scheduledDate: today, estimatedDurationMinutes: 60, status: "PLANNED" })
      .returning();
    const [exercise] = await db.insert(plannedExercises).values({ id: createEntityId(), plannedWorkoutId: workout!.id, exerciseRef: EXERCISE_REF, displayName: "Bench Press", orderIndex: 0 }).returning();
    const setIds: string[] = [];
    for (let order = 1; order <= 3; order++) {
      const [set] = await db
        .insert(plannedSets)
        .values({ id: createEntityId(), plannedExerciseId: exercise!.id, orderIndex: order, targetRepsMin: 8, targetRepsMax: 12, setType: "WORKING", loadKind: "EXTERNAL_WEIGHT", loadAmountMilli: 60000, loadUnit: "KG", loadBasis: "TOTAL" })
        .returning();
      setIds.push(set!.id);
    }
    return { workoutId: workout!.id, exerciseId: exercise!.id, setIds };
  }

  /** Full persisted rows of the user's owned plan graph, each level ordered by id. */
  async function ownedPlanGraph(forUserId: string) {
    const byId = <T extends { readonly id: string }>(rows: T[]): T[] => [...rows].sort((a, b) => a.id.localeCompare(b.id));
    const profiles = byId(await db.select().from(athleteProfiles).where(eq(athleteProfiles.userId, forUserId)));
    const ownedPrograms = profiles.length === 0 ? [] : byId(await db.select().from(programs).where(inArray(programs.athleteProfileId, profiles.map((r) => r.id))));
    const versions = ownedPrograms.length === 0 ? [] : byId(await db.select().from(programVersions).where(inArray(programVersions.programId, ownedPrograms.map((r) => r.id))));
    const blocks = versions.length === 0 ? [] : byId(await db.select().from(trainingBlocks).where(inArray(trainingBlocks.programVersionId, versions.map((r) => r.id))));
    const cycles = blocks.length === 0 ? [] : byId(await db.select().from(trainingCycles).where(inArray(trainingCycles.trainingBlockId, blocks.map((r) => r.id))));
    const workouts = cycles.length === 0 ? [] : byId(await db.select().from(plannedWorkouts).where(inArray(plannedWorkouts.trainingCycleId, cycles.map((r) => r.id))));
    const exercises = workouts.length === 0 ? [] : byId(await db.select().from(plannedExercises).where(inArray(plannedExercises.plannedWorkoutId, workouts.map((r) => r.id))));
    const sets = exercises.length === 0 ? [] : byId(await db.select().from(plannedSets).where(inArray(plannedSets.plannedExerciseId, exercises.map((r) => r.id))));
    return { profiles, programs: ownedPrograms, versions, blocks, cycles, workouts, exercises, sets };
  }

  async function deleteOwnedPlan(forUserId: string): Promise<void> {
    const graph = await ownedPlanGraph(forUserId);
    await db.delete(plannedWorkoutOccurrenceClaims).where(eq(plannedWorkoutOccurrenceClaims.userId, forUserId));
    if (graph.sets.length > 0) await db.delete(plannedSets).where(inArray(plannedSets.id, graph.sets.map((r) => r.id)));
    if (graph.exercises.length > 0) await db.delete(plannedExercises).where(inArray(plannedExercises.id, graph.exercises.map((r) => r.id)));
    if (graph.workouts.length > 0) await db.delete(plannedWorkouts).where(inArray(plannedWorkouts.id, graph.workouts.map((r) => r.id)));
    if (graph.cycles.length > 0) await db.delete(trainingCycles).where(inArray(trainingCycles.id, graph.cycles.map((r) => r.id)));
    if (graph.blocks.length > 0) await db.delete(trainingBlocks).where(inArray(trainingBlocks.id, graph.blocks.map((r) => r.id)));
    if (graph.versions.length > 0) await db.delete(programVersions).where(inArray(programVersions.id, graph.versions.map((r) => r.id)));
    if (graph.programs.length > 0) await db.delete(programs).where(inArray(programs.id, graph.programs.map((r) => r.id)));
    if (graph.profiles.length > 0) await db.delete(athleteProfiles).where(inArray(athleteProfiles.id, graph.profiles.map((r) => r.id)));
  }

  it("27: evaluating progression never mutates Program/ProgramVersion/PlannedSet state", async () => {
    // A real planned session of the athlete's OWN plan (owned provenance, real START path),
    // so the evaluation genuinely operates over plan-linked evidence.
    const plan = await seedOwnedPlan(userId);
    const base = buildPrescription({ prescriptionExerciseId: plan.exerciseId });
    const prescription: WorkoutPrescriptionV1 = {
      ...base,
      prescriptionId: plan.workoutId,
      exercises: base.exercises.map((exercise) => ({ ...exercise, sets: exercise.sets.map((set, i) => ({ ...set, prescriptionSetId: plan.setIds[i]! })) })),
    };
    const anchor = await runCompletedSession(userId, { prescription, reps: [12, 12, 12], setIds: plan.setIds });

    const before = await ownedPlanGraph(userId);
    expect(before.programs).toHaveLength(1);
    expect(before.versions).toHaveLength(1);
    expect(before.sets).toHaveLength(3);

    const outcome = await service.evaluateAndPersist({ userId }, anchor);
    expect(outcome.status).toBe("PERSISTED"); // the evaluation really ran

    expect(await ownedPlanGraph(userId)).toEqual(before);

    // Negative control: the comparison is sensitive to a real mutation of an owned planned set.
    await db.update(plannedSets).set({ targetRepsMax: 15 }).where(eq(plannedSets.id, plan.setIds[0]!));
    expect(await ownedPlanGraph(userId)).not.toEqual(before);

    await deleteOwnedPlan(userId);
    await cleanup();
  });

  // Preconditions: source not found / session not completed / no prescription context
  it("preconditions: an unfinished (ACTIVE) session is not a valid evaluation anchor", async () => {
    const workoutSessionId = createEntityId();
    await processWorkoutCommand(db, testBoss, userId, startCommand(workoutSessionId, buildPrescription()));
    const performedExerciseId = createEntityId();
    await processWorkoutCommand(
      db, testBoss,
      userId,
      completeCommand(workoutSessionId, { performedExerciseId, performedSetId: createEntityId(), actualReps: 12 }),
    );

    const outcome = await service.evaluateAndPersist({ userId }, { workoutSessionId, performedExerciseId });
    expect(outcome.status).toBe("SOURCE_SESSION_NOT_COMPLETED");

    await cleanup();
  });

  it("preconditions: an unplanned/extra exercise with no prescriptionExerciseId cannot be evaluated (NO_PRESCRIPTION_CONTEXT)", async () => {
    const workoutSessionId = createEntityId();
    await processWorkoutCommand(db, testBoss, userId, startCommand(workoutSessionId, buildPrescription()));
    const performedExerciseId = createEntityId();
    await processWorkoutCommand(
      db, testBoss,
      userId,
      completeCommand(workoutSessionId, {
        performedExerciseId,
        performedSetId: createEntityId(),
        prescriptionExerciseId: null,
        prescriptionSetId: null,
        actualReps: 12,
      }),
    );
    await processWorkoutCommand(db, testBoss, userId, finishCommand(workoutSessionId, 1));

    const outcome = await service.evaluateAndPersist({ userId }, { workoutSessionId, performedExerciseId });
    expect(outcome.status).toBe("NO_PRESCRIPTION_CONTEXT");

    await cleanup();
  });

  it("preconditions: a nonexistent performedExerciseId returns SOURCE_NOT_FOUND, not an exception", async () => {
    const outcome = await service.evaluateAndPersist({ userId }, { workoutSessionId: createEntityId(), performedExerciseId: createEntityId() });
    expect(outcome.status).toBe("SOURCE_NOT_FOUND");
  });
});
