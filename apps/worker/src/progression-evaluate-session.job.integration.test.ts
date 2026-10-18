import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import {
  athleteProfiles,
  createDatabaseClient,
  exerciseLoadingCapabilityBindings,
  gymProfiles,
  loadingCapabilities,
  performedExercises,
  performedSets,
  plannedExercises,
  plannedSets,
  plannedWorkouts,
  programVersions,
  programs,
  progressionApplicationCommands,
  progressionApplications,
  progressionDecisions,
  trainingBlocks,
  trainingCycles,
  users,
  workoutSessions,
  plannedWorkoutOccurrenceClaims,
  type Database,
} from "@vostivo/database";
import { createEntityId, type WorkoutPrescriptionV1 } from "@vostivo/domain";
import {
  PROGRESSION_APPLICATION_DISPATCH_QUEUE_V1,
  bindExerciseToCapability,
  createLoadingCapability,
  ensureProgressionApplicationDispatchQueues,
  getOrCreateDefaultGymProfileForAthlete,
} from "@vostivo/progression-application";
import { processProgressionEvaluateSessionJob } from "./progression-evaluate-session.job.js";
import { processProgressionApplicationDispatchJob } from "./progression-application-dispatch.job.js";

/**
 * Real Postgres integration test for the ONE place in this codebase that
 * calls `ProgressionEvaluationService.evaluateAndPersist` (Progression
 * Evaluation Orchestration V1). Deliberately builds canonical fixture rows
 * with DIRECT Drizzle inserts, never by importing `apps/api`'s
 * `processWorkoutCommand` — `apps/worker` must never depend on `apps/api`
 * source, and that boundary applies to this test suite too, not only to
 * `apps/worker`'s own production code.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://vostivo_api:vostivo_api@localhost:5432/vostivo_dev";

const EXERCISE_REF = "worker-progression-bench-press";

function prescription(overrides: { readonly exerciseRef?: string; readonly prescriptionExerciseId?: string } = {}): WorkoutPrescriptionV1 {
  return {
    schemaVersion: 1,
    prescriptionId: "presc-worker-test-1",
    name: "Worker Test Day",
    exercises: [
      {
        prescriptionExerciseId: overrides.prescriptionExerciseId ?? "presc-ex-1",
        exerciseRef: overrides.exerciseRef ?? EXERCISE_REF,
        displayName: "Bench Press",
        order: 0,
        sets: [
          { prescriptionSetId: "set-1", order: 0, targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 }, targetLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: 60000, unit: "KG", basis: "TOTAL" }, restSeconds: null, setType: "WORKING" },
        ],
      },
    ],
  };
}

describe("processProgressionEvaluateSessionJob (real Postgres)", () => {
  let db: Database;
  let boss: PgBoss;
  let userId: string;
  const sessionIds: string[] = [];

  beforeAll(async () => {
    // Progression Application V1 Slice D — the job now also enqueues a
    // `progression-application-dispatch-v1` job for any INCREASE_LOAD
    // decision, so a real (started) pg-boss instance is required here too.
    boss = new PgBoss({ connectionString: DATABASE_URL, migrate: false, supervise: false, schedule: false });
    await boss.start();
  });

  afterAll(async () => {
    await boss.stop();
  });

  beforeEach(async () => {
    db = createDatabaseClient(DATABASE_URL);
    userId = createEntityId();
    await db.insert(users).values({ id: userId, status: "ACTIVE" });
  });

  afterEach(async () => {
    if (sessionIds.length > 0) {
      const exercises = await db.select({ id: performedExercises.id }).from(performedExercises).where(inArray(performedExercises.workoutSessionId, sessionIds));
      const exerciseIds = exercises.map((e) => e.id);
      await db.delete(progressionDecisions).where(eq(progressionDecisions.userId, userId));
      if (exerciseIds.length > 0) {
        await db.delete(performedSets).where(inArray(performedSets.performedExerciseId, exerciseIds));
      }
      await db.delete(performedExercises).where(inArray(performedExercises.workoutSessionId, sessionIds));
      await db.delete(plannedWorkoutOccurrenceClaims).where(eq(plannedWorkoutOccurrenceClaims.userId, userId));
      await db.delete(workoutSessions).where(inArray(workoutSessions.id, sessionIds));
    }
    await db.delete(users).where(eq(users.id, userId));
    sessionIds.length = 0;
  });

  async function insertPerformedExercise(
    workoutSessionId: string,
    overrides: { readonly exerciseRef?: string; readonly prescriptionExerciseId?: string | null; readonly orderIndex?: number } = {},
  ): Promise<string> {
    const performedExerciseId = createEntityId();
    await db.insert(performedExercises).values({
      id: performedExerciseId,
      workoutSessionId,
      prescriptionExerciseId: overrides.prescriptionExerciseId === undefined ? "presc-ex-1" : overrides.prescriptionExerciseId,
      exerciseRef: overrides.exerciseRef ?? EXERCISE_REF,
      displayName: "Bench Press",
      orderIndex: overrides.orderIndex ?? 0,
    });
    await db.insert(performedSets).values({
      id: createEntityId(),
      performedExerciseId,
      prescriptionSetId: "set-1",
      orderIndex: 1,
      actualReps: 12,
      loadKind: "EXTERNAL_WEIGHT",
      loadAmountMilli: 60000,
      loadUnit: "KG",
      loadBasis: "TOTAL",
      setType: "WORKING",
      completionState: "COMPLETED",
      completedAt: new Date(),
      revision: 1,
    });
    return performedExerciseId;
  }

  async function insertSession(status: "ACTIVE" | "COMPLETED"): Promise<string> {
    const workoutSessionId = createEntityId();
    sessionIds.push(workoutSessionId);
    await db.insert(workoutSessions).values({
      id: workoutSessionId,
      userId,
      prescriptionSnapshot: prescription(),
      startedAt: new Date(),
      completedAt: status === "COMPLETED" ? new Date() : null,
      status,
      finishSeq: status === "COMPLETED" ? 1 : null,
    });
    return workoutSessionId;
  }

  it("evaluates every performed exercise in a COMPLETED session and persists a decision for each", async () => {
    const workoutSessionId = await insertSession("COMPLETED");
    const exerciseA = await insertPerformedExercise(workoutSessionId, { orderIndex: 0 });
    const exerciseB = await insertPerformedExercise(workoutSessionId, { exerciseRef: "worker-progression-overhead-press", prescriptionExerciseId: null, orderIndex: 1 });

    const result = await processProgressionEvaluateSessionJob(db, boss, { workoutSessionId, triggerCommandId: "trigger-1" });

    // exerciseB has no matching prescriptionExerciseId -> NO_PRESCRIPTION_CONTEXT (skipped, not an error).
    expect(result).toEqual({ workoutSessionId, evaluated: 1, skipped: 1 });

    const decisions = await db.select().from(progressionDecisions).where(eq(progressionDecisions.sourceWorkoutSessionId, workoutSessionId));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.sourcePerformedExerciseId).toBe(exerciseA);
    // The worker's own authority for userId is the canonical session row —
    // never anything from the job payload (which never even carries one).
    expect(decisions[0]?.userId).toBe(userId);
    expect(decisions[0]?.appliedAt).toBeNull();

    // exerciseB genuinely produced no row (skipped, not silently evaluated).
    const exerciseBDecisions = await db.select().from(progressionDecisions).where(eq(progressionDecisions.sourcePerformedExerciseId, exerciseB));
    expect(exerciseBDecisions).toHaveLength(0);
  });

  it("is idempotent — running the same job twice never creates duplicate decisions", async () => {
    const workoutSessionId = await insertSession("COMPLETED");
    await insertPerformedExercise(workoutSessionId);

    const first = await processProgressionEvaluateSessionJob(db, boss, { workoutSessionId, triggerCommandId: "trigger-1" });
    const second = await processProgressionEvaluateSessionJob(db, boss, { workoutSessionId, triggerCommandId: "trigger-2" });

    expect(first.evaluated).toBe(1);
    expect(second.evaluated).toBe(1);

    const decisions = await db.select().from(progressionDecisions).where(eq(progressionDecisions.sourceWorkoutSessionId, workoutSessionId));
    expect(decisions).toHaveLength(1);
  });

  it("skips (never evaluates, never throws) a session that is still ACTIVE — structurally shouldn't happen, but must fail safe", async () => {
    const workoutSessionId = await insertSession("ACTIVE");
    await insertPerformedExercise(workoutSessionId);

    const result = await processProgressionEvaluateSessionJob(db, boss, { workoutSessionId, triggerCommandId: "trigger-1" });

    expect(result).toEqual({ workoutSessionId, evaluated: 0, skipped: 0 });
    const decisions = await db.select().from(progressionDecisions).where(eq(progressionDecisions.sourceWorkoutSessionId, workoutSessionId));
    expect(decisions).toHaveLength(0);
  });

  it("skips (never throws) a job whose workoutSessionId does not exist in canonical state", async () => {
    const result = await processProgressionEvaluateSessionJob(db, boss, { workoutSessionId: createEntityId(), triggerCommandId: "trigger-1" });
    expect(result.evaluated).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it("a session with zero performed exercises completes as a genuine no-op", async () => {
    const workoutSessionId = await insertSession("COMPLETED");
    const result = await processProgressionEvaluateSessionJob(db, boss, { workoutSessionId, triggerCommandId: "trigger-1" });
    expect(result).toEqual({ workoutSessionId, evaluated: 0, skipped: 0 });
  });

  it("Planned Workout Occurrence Authority V1: a SECONDARY session's job completes normally (no throw, no retry) and creates no decision; the CANONICAL one still evaluates", async () => {
    // Two devices finished the SAME claimed planned occurrence; the claim (written by the
    // real START handler in production) names the first as canonical.
    const plannedWorkoutId = createEntityId();
    const canonicalSessionId = await insertSession("COMPLETED");
    const secondarySessionId = await insertSession("COMPLETED");
    await db
      .update(workoutSessions)
      .set({ prescriptionSnapshot: { ...prescription(), prescriptionId: plannedWorkoutId } })
      .where(inArray(workoutSessions.id, [canonicalSessionId, secondarySessionId]));
    await db.insert(plannedWorkoutOccurrenceClaims).values({ id: createEntityId(), userId, plannedWorkoutId, canonicalWorkoutSessionId: canonicalSessionId });
    await insertPerformedExercise(canonicalSessionId);
    await insertPerformedExercise(secondarySessionId);

    // Secondary first: a deliberate, final skip — the job resolves, so pg-boss never retries it.
    const secondary = await processProgressionEvaluateSessionJob(db, boss, { workoutSessionId: secondarySessionId, triggerCommandId: "occ-secondary" });
    expect(secondary).toEqual({ workoutSessionId: secondarySessionId, evaluated: 0, skipped: 1 });
    expect(await db.select().from(progressionDecisions).where(eq(progressionDecisions.sourceWorkoutSessionId, secondarySessionId))).toHaveLength(0);

    const canonical = await processProgressionEvaluateSessionJob(db, boss, { workoutSessionId: canonicalSessionId, triggerCommandId: "occ-canonical" });
    expect(canonical).toEqual({ workoutSessionId: canonicalSessionId, evaluated: 1, skipped: 0 });
    expect(await db.select().from(progressionDecisions).where(eq(progressionDecisions.userId, userId))).toHaveLength(1);
  });

  it("Temporary Equipment Adaptation V1 Slice C: a substituted exercise is a final skip (no throw, no retry, no decision); the session's other exercises still evaluate", async () => {
    const workoutSessionId = await insertSession("COMPLETED");
    const base = prescription();
    const authored = base.exercises[0]!;
    await db
      .update(workoutSessions)
      .set({
        prescriptionSnapshot: {
          ...base,
          exercises: [
            authored,
            {
              ...authored,
              prescriptionExerciseId: "presc-ex-2",
              exerciseRef: "worker-progression-dumbbell-row",
              displayName: "Dumbbell Row",
              order: 1,
              substitution: { kind: "TEMPORARY_EQUIPMENT", reasonCode: "TEMPORARY_EQUIPMENT_UNAVAILABLE", authoredExerciseRef: "worker-progression-barbell-row", authoredDisplayName: "Barbell Row", equipmentApplicationId: createEntityId(), policyVersion: "equipment-adaptation/v1", catalogVersion: "exercise-equipment-catalog/v1" },
            },
          ],
        },
      })
      .where(eq(workoutSessions.id, workoutSessionId));
    await insertPerformedExercise(workoutSessionId, { orderIndex: 0 });
    const substituted = await insertPerformedExercise(workoutSessionId, { exerciseRef: "worker-progression-dumbbell-row", prescriptionExerciseId: "presc-ex-2", orderIndex: 1 });

    const result = await processProgressionEvaluateSessionJob(db, boss, { workoutSessionId, triggerCommandId: "equipment-substitution" });
    expect(result).toEqual({ workoutSessionId, evaluated: 1, skipped: 1 });
    expect(await db.select().from(progressionDecisions).where(eq(progressionDecisions.sourcePerformedExerciseId, substituted))).toHaveLength(0);
  });
});

/**
 * Progression Application V1 — Slice D — Final Durability / Crash-Window
 * Gate. Empirical (real Postgres + real pg-boss) proof of the
 * EngineDecision -> dispatch-job crash windows, per the tech-lead's own
 * narrow evidence-gate task. Deliberately a SEPARATE `describe` block (own
 * lifecycle, own fixtures) rather than extending the suite above, because
 * these fixtures need a full Plan/GymProfile/LoadingCapability context (so
 * the resulting `progression_applications` workflow can actually reach
 * `SYSTEM_APPLY_ATTEMPTED`/`PENDING_REVIEW`), which the suite above
 * deliberately does not carry.
 */
describe("Slice D — Final Durability / Crash-Window Gate (real Postgres + real pg-boss)", () => {
  let db2: Database;
  let boss2: PgBoss;
  const userIds: string[] = [];

  beforeAll(async () => {
    boss2 = new PgBoss({ connectionString: DATABASE_URL, migrate: false, supervise: false, schedule: false });
    await boss2.start();
    await ensureProgressionApplicationDispatchQueues(boss2);
  });

  afterAll(async () => {
    await boss2.stop();
  });

  beforeEach(() => {
    db2 = createDatabaseClient(DATABASE_URL);
  });

  /**
   * Narrow test-only fault-injection seam (task §5): the real, started
   * `PgBoss` instance is the ONLY thing wrapped, and only its `send`
   * method is intercepted — every other property/method is delegated,
   * bound back to the REAL instance (never the proxy) so pg-boss's own
   * private class fields keep working. `failOnCallNumbers` names which
   * 1-indexed `.send()` invocation(s) across this wrapper's lifetime
   * should throw a simulated transient failure; every other call reaches
   * the real `boss.send`. No production code changes for this.
   */
  function createFlakySendBoss(realBoss: PgBoss, failOnCallNumbers: readonly number[]): PgBoss {
    let callIndex = 0;
    return new Proxy(realBoss, {
      get(target, prop, receiver) {
        if (prop === "send") {
          return async (name: string, data?: object | null) => {
            callIndex += 1;
            if (failOnCallNumbers.includes(callIndex)) {
              throw new Error(`SIMULATED_TRANSIENT_DISPATCH_ENQUEUE_FAILURE_CALL_${callIndex}`);
            }
            return target.send(name, data);
          };
        }
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  }

  async function createAthlete(experienceMode: "GUIDED" | "ADAPTIVE" | "EXPERT"): Promise<{ readonly userId: string; readonly athleteProfileId: string }> {
    const userId = createEntityId();
    const athleteProfileId = createEntityId();
    await db2.insert(users).values({ id: userId, status: "ACTIVE" });
    await db2.insert(athleteProfiles).values({ id: athleteProfileId, userId, experienceMode, unitSystem: "METRIC" });
    userIds.push(userId);
    return { userId, athleteProfileId };
  }

  interface SlotFixture {
    readonly exerciseId: string;
    readonly exerciseRef: string;
  }

  async function seedProgram(athleteProfileId: string, exerciseRef: string, loadAmountMilli = 100000): Promise<SlotFixture> {
    const [program] = await db2.insert(programs).values({ id: createEntityId(), athleteProfileId, name: "Durability Gate Program", status: "ACTIVE" }).returning();
    const [version] = await db2
      .insert(programVersions)
      .values({ id: createEntityId(), programId: program!.id, versionNumber: 1, status: "ACTIVE", activatedAt: new Date() })
      .returning();
    const [block] = await db2
      .insert(trainingBlocks)
      .values({ id: createEntityId(), programVersionId: version!.id, name: "Block 1", goal: "Hypertrophy", orderIndex: 1, cycleCount: 6, focusAreas: [] })
      .returning();
    const today = new Date().toISOString().slice(0, 10);
    const [cycle] = await db2.insert(trainingCycles).values({ id: createEntityId(), trainingBlockId: block!.id, orderIndex: 1, startDate: today, endDate: today }).returning();
    const [workout] = await db2.insert(plannedWorkouts).values({ id: createEntityId(), trainingCycleId: cycle!.id, name: "Upper A", orderIndex: 1, status: "PLANNED" }).returning();
    const [exercise] = await db2
      .insert(plannedExercises)
      .values({ id: createEntityId(), plannedWorkoutId: workout!.id, exerciseRef, displayName: "Bench Press", orderIndex: 1 })
      .returning();
    await db2.insert(plannedSets).values({
      id: createEntityId(),
      plannedExerciseId: exercise!.id,
      orderIndex: 1,
      targetRepsMin: 8,
      targetRepsMax: 12,
      setType: "WORKING",
      loadKind: "EXTERNAL_WEIGHT",
      loadAmountMilli,
      loadUnit: "KG",
      loadBasis: "TOTAL",
    });
    return { exerciseId: exercise!.id, exerciseRef };
  }

  async function setupCapability(athleteProfileId: string, exerciseRef: string, incrementAmountMilli = 2500): Promise<void> {
    const gym = await getOrCreateDefaultGymProfileForAthlete(db2, athleteProfileId);
    const created = await createLoadingCapability(db2, { kind: "FIXED_INCREMENT", gymProfileId: gym.id, unit: "KG", basis: "TOTAL", incrementAmountMilli });
    if (created.status !== "CREATED") throw new Error("expected CREATED");
    await bindExerciseToCapability(db2, gym.id, exerciseRef, created.loadingCapabilityId);
  }

  /**
   * A `prescriptionSnapshot`/performed-exercise pair whose
   * `prescriptionExerciseId` is the REAL `plannedExercises.id` from
   * `seedProgram` (never a placeholder string like "presc-ex-1") — this is
   * the exact join key `resolvePlanContext` uses to turn a persisted
   * `EngineDecision` into a real Program Slot Identity, which the
   * dispatch job needs to reach `SYSTEM_APPLY_ATTEMPTED`/`PENDING_REVIEW`
   * rather than a domain `NO_APPLICATION`. One exposure with
   * `actualReps` at the top of the 8-12 target range is sufficient on its
   * own to produce `INCREASE_LOAD`/`TOP_OF_RANGE_ACHIEVED` (§12.1/§12.2 —
   * never gated by exposure count).
   */
  function planPrescription(plan: SlotFixture): WorkoutPrescriptionV1 {
    return {
      schemaVersion: 1,
      prescriptionId: "presc-durability-gate-1",
      name: "Durability Gate Test Day",
      exercises: [
        {
          prescriptionExerciseId: plan.exerciseId,
          exerciseRef: plan.exerciseRef,
          displayName: "Bench Press",
          order: 0,
          sets: [
            { prescriptionSetId: "set-1", order: 0, targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 }, targetLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: 100000, unit: "KG", basis: "TOTAL" }, restSeconds: null, setType: "WORKING" },
          ],
        },
      ],
    };
  }

  async function insertEvaluableSession(userId: string, ...plans: readonly SlotFixture[]): Promise<string> {
    const workoutSessionId = createEntityId();
    const snapshot: WorkoutPrescriptionV1 =
      plans.length === 1
        ? planPrescription(plans[0]!)
        : {
            schemaVersion: 1,
            prescriptionId: "presc-durability-gate-multi",
            name: "Durability Gate Test Day",
            exercises: plans.map((plan, index) => ({
              prescriptionExerciseId: plan.exerciseId,
              exerciseRef: plan.exerciseRef,
              displayName: "Bench Press",
              order: index,
              sets: [{ prescriptionSetId: "set-1", order: 0, targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 }, targetLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: 100000, unit: "KG", basis: "TOTAL" }, restSeconds: null, setType: "WORKING" }],
            })),
          };
    await db2.insert(workoutSessions).values({
      id: workoutSessionId,
      userId,
      prescriptionSnapshot: snapshot,
      startedAt: new Date(),
      completedAt: new Date(),
      status: "COMPLETED",
      finishSeq: 1,
    });
    for (const [index, plan] of plans.entries()) {
      const performedExerciseId = createEntityId();
      await db2.insert(performedExercises).values({
        id: performedExerciseId,
        workoutSessionId,
        prescriptionExerciseId: plan.exerciseId,
        exerciseRef: plan.exerciseRef,
        displayName: "Bench Press",
        orderIndex: index,
      });
      await db2.insert(performedSets).values({
        id: createEntityId(),
        performedExerciseId,
        prescriptionSetId: "set-1",
        orderIndex: 1,
        actualReps: 12,
        loadKind: "EXTERNAL_WEIGHT",
        loadAmountMilli: 100000,
        loadUnit: "KG",
        loadBasis: "TOTAL",
        setType: "WORKING",
        completionState: "COMPLETED",
        completedAt: new Date(),
        revision: 1,
      });
    }
    return workoutSessionId;
  }

  afterEach(async () => {
    if (userIds.length === 0) return;

    const applicationRows = await db2.select({ id: progressionApplications.id }).from(progressionApplications).where(inArray(progressionApplications.userId, userIds));
    const applicationIds = applicationRows.map((r) => r.id);
    if (applicationIds.length > 0) {
      await db2.delete(progressionApplicationCommands).where(inArray(progressionApplicationCommands.applicationId, applicationIds));
    }
    await db2.delete(progressionApplications).where(inArray(progressionApplications.userId, userIds));
    await db2.delete(progressionDecisions).where(inArray(progressionDecisions.userId, userIds));

    const sessionRows = await db2.select({ id: workoutSessions.id }).from(workoutSessions).where(inArray(workoutSessions.userId, userIds));
    const sessionIds = sessionRows.map((r) => r.id);
    if (sessionIds.length > 0) {
      const exerciseRows = await db2.select({ id: performedExercises.id }).from(performedExercises).where(inArray(performedExercises.workoutSessionId, sessionIds));
      const exerciseIds = exerciseRows.map((r) => r.id);
      if (exerciseIds.length > 0) await db2.delete(performedSets).where(inArray(performedSets.performedExerciseId, exerciseIds));
      if (exerciseIds.length > 0) await db2.delete(performedExercises).where(inArray(performedExercises.id, exerciseIds));
      await db2.delete(workoutSessions).where(inArray(workoutSessions.id, sessionIds));
    }

    const athleteRows = await db2.select({ id: athleteProfiles.id }).from(athleteProfiles).where(inArray(athleteProfiles.userId, userIds));
    const athleteProfileIds = athleteRows.map((r) => r.id);
    if (athleteProfileIds.length > 0) {
      const gymRows = await db2.select({ id: gymProfiles.id }).from(gymProfiles).where(inArray(gymProfiles.athleteProfileId, athleteProfileIds));
      const gymProfileIds = gymRows.map((r) => r.id);
      if (gymProfileIds.length > 0) {
        await db2.delete(exerciseLoadingCapabilityBindings).where(inArray(exerciseLoadingCapabilityBindings.gymProfileId, gymProfileIds));
        await db2.delete(loadingCapabilities).where(inArray(loadingCapabilities.gymProfileId, gymProfileIds));
        await db2.delete(gymProfiles).where(inArray(gymProfiles.id, gymProfileIds));
      }
      const programRows = await db2.select({ id: programs.id }).from(programs).where(inArray(programs.athleteProfileId, athleteProfileIds));
      const programIds = programRows.map((r) => r.id);
      if (programIds.length > 0) {
        const versionRows = await db2.select({ id: programVersions.id }).from(programVersions).where(inArray(programVersions.programId, programIds));
        const versionIds = versionRows.map((r) => r.id);
        const blockRows = await db2.select({ id: trainingBlocks.id }).from(trainingBlocks).where(inArray(trainingBlocks.programVersionId, versionIds));
        const blockIds = blockRows.map((r) => r.id);
        const cycleRows = await db2.select({ id: trainingCycles.id }).from(trainingCycles).where(inArray(trainingCycles.trainingBlockId, blockIds));
        const cycleIds = cycleRows.map((r) => r.id);
        const workoutRows = await db2.select({ id: plannedWorkouts.id }).from(plannedWorkouts).where(inArray(plannedWorkouts.trainingCycleId, cycleIds));
        const workoutIds = workoutRows.map((r) => r.id);
        const exerciseRows = await db2.select({ id: plannedExercises.id }).from(plannedExercises).where(inArray(plannedExercises.plannedWorkoutId, workoutIds));
        const exerciseIds = exerciseRows.map((r) => r.id);
        if (exerciseIds.length > 0) await db2.delete(plannedSets).where(inArray(plannedSets.plannedExerciseId, exerciseIds));
        if (workoutIds.length > 0) await db2.delete(plannedExercises).where(inArray(plannedExercises.plannedWorkoutId, workoutIds));
        if (cycleIds.length > 0) await db2.delete(plannedWorkouts).where(inArray(plannedWorkouts.trainingCycleId, cycleIds));
        if (blockIds.length > 0) await db2.delete(trainingCycles).where(inArray(trainingCycles.trainingBlockId, blockIds));
        if (versionIds.length > 0) await db2.delete(trainingBlocks).where(inArray(trainingBlocks.programVersionId, versionIds));
        if (programIds.length > 0) await db2.delete(programVersions).where(inArray(programVersions.programId, programIds));
        await db2.delete(programs).where(inArray(programs.id, programIds));
      }
      await db2.delete(athleteProfiles).where(inArray(athleteProfiles.id, athleteProfileIds));
    }

    await db2.delete(users).where(inArray(users.id, userIds));
    userIds.length = 0;
  });

  it("PROG-APP-D-DUR-A: transient failure BEFORE dispatch insertion -> evaluation job fails, retry reuses the SAME EngineDecision, dispatch eventually enqueues, application eventually exists", async () => {
    const { userId, athleteProfileId } = await createAthlete("GUIDED");
    const plan = await seedProgram(athleteProfileId, "durability-gate-crash-a");
    await setupCapability(athleteProfileId, plan.exerciseRef);
    const workoutSessionId = await insertEvaluableSession(userId, plan);

    // Fail the FIRST (and only, for this single-exercise fixture) send() —
    // simulating a transient failure strictly AFTER the EngineDecision has
    // already committed (evaluateAndPersist runs, and returns PERSISTED,
    // before the enqueue call this wraps is even reached) but BEFORE the
    // dispatch job is successfully inserted.
    const flakyBoss = createFlakySendBoss(boss2, [1]);
    await expect(processProgressionEvaluateSessionJob(db2, flakyBoss, { workoutSessionId, triggerCommandId: "dur-a-1" })).rejects.toThrow(
      "SIMULATED_TRANSIENT_DISPATCH_ENQUEUE_FAILURE_CALL_1",
    );

    // The uncaught throw means pg-boss would NOT ack this job attempt — the
    // EngineDecision it already committed must still be there, exactly once.
    const afterFailure = await db2.select().from(progressionDecisions).where(eq(progressionDecisions.sourceWorkoutSessionId, workoutSessionId));
    expect(afterFailure).toHaveLength(1);
    expect(afterFailure[0]?.decisionType).toBe("INCREASE_LOAD");
    const decisionId = afterFailure[0]!.id;

    // Retry (this codebase's own crash-recovery story: pg-boss re-runs the
    // WHOLE job). The injected failure was single-shot and already
    // consumed, so this attempt reaches the real boss.send().
    const retryResult = await processProgressionEvaluateSessionJob(db2, boss2, { workoutSessionId, triggerCommandId: "dur-a-2" });
    expect(retryResult).toEqual({ workoutSessionId, evaluated: 1, skipped: 0 });

    // Same immutable EngineDecision reused (evidence/fingerprint
    // idempotency) — NOT a second decision row.
    const afterRetry = await db2.select().from(progressionDecisions).where(eq(progressionDecisions.sourceWorkoutSessionId, workoutSessionId));
    expect(afterRetry).toHaveLength(1);
    expect(afterRetry[0]!.id).toBe(decisionId);

    // A durable dispatch job for this exact decision now really exists in
    // pg-boss (real Postgres-backed queue, not an in-memory stub). Fetch
    // is scoped to jobs matching THIS decision only; anything else pulled
    // into the same batch (e.g. from an unrelated concurrently-running
    // process) is left completely untouched.
    const fetched = await boss2.fetch(PROGRESSION_APPLICATION_DISPATCH_QUEUE_V1, { batchSize: 50 });
    const mine = fetched.filter((job) => (job.data as { progressionDecisionId?: string } | null)?.progressionDecisionId === decisionId);
    expect(mine.length).toBeGreaterThanOrEqual(1);
    for (const job of mine) await boss2.complete(PROGRESSION_APPLICATION_DISPATCH_QUEUE_V1, job.id);

    // Eventually processing that dispatch job produces the
    // ProgressionApplication workflow — no lost recommendation.
    const dispatchResult = await processProgressionApplicationDispatchJob(db2, { progressionDecisionId: decisionId, systemCommandId: createEntityId() });
    expect(dispatchResult.status).toBe("SYSTEM_APPLY_ATTEMPTED");

    const applications = await db2.select().from(progressionApplications).where(eq(progressionApplications.progressionDecisionId, decisionId));
    expect(applications).toHaveLength(1);
  });

  it("PROG-APP-D-DUR-B: failure AFTER one decision's dispatch already exists -> retry may enqueue ANOTHER dispatch for it; duplicates converge to one GUIDED APPLIED workflow", async () => {
    const { userId, athleteProfileId } = await createAthlete("GUIDED");
    const planA = await seedProgram(athleteProfileId, "durability-gate-crash-b-a");
    const planB = await seedProgram(athleteProfileId, "durability-gate-crash-b-b");
    await setupCapability(athleteProfileId, planA.exerciseRef);
    await setupCapability(athleteProfileId, planB.exerciseRef);
    const workoutSessionId = await insertEvaluableSession(userId, planA, planB);

    // First send() (exercise A's decision) SUCCEEDS -> A's dispatch job is
    // durably inserted. Second send() (exercise B's decision) FAILS -> the
    // whole job throws AFTER A's dispatch already exists — this is
    // Crash Window B: "after dispatch exists, before evaluation ack."
    const flakyBoss = createFlakySendBoss(boss2, [2]);
    await expect(processProgressionEvaluateSessionJob(db2, flakyBoss, { workoutSessionId, triggerCommandId: "dur-b-1" })).rejects.toThrow(
      "SIMULATED_TRANSIENT_DISPATCH_ENQUEUE_FAILURE_CALL_2",
    );

    const decisionsAfterFailure = await db2.select().from(progressionDecisions).where(eq(progressionDecisions.sourceWorkoutSessionId, workoutSessionId));
    expect(decisionsAfterFailure).toHaveLength(2); // both PERSISTED — evaluateAndPersist itself never rolled back
    const decisionA = decisionsAfterFailure.find((d) => d.exerciseRef === planA.exerciseRef)!;

    // Retry: A's decision is found idempotently and its enqueue call is
    // reached AGAIN (this codebase's own explicit "duplicates are
    // allowed" design, task §7) -> a SECOND dispatch job for A. B's
    // enqueue succeeds for the first time.
    const retryResult = await processProgressionEvaluateSessionJob(db2, boss2, { workoutSessionId, triggerCommandId: "dur-b-2" });
    expect(retryResult).toEqual({ workoutSessionId, evaluated: 2, skipped: 0 });

    const decisionsAfterRetry = await db2.select().from(progressionDecisions).where(eq(progressionDecisions.sourceWorkoutSessionId, workoutSessionId));
    expect(decisionsAfterRetry).toHaveLength(2); // still exactly two immutable decisions, never duplicated

    const fetched = await boss2.fetch(PROGRESSION_APPLICATION_DISPATCH_QUEUE_V1, { batchSize: 50 });
    const forA = fetched.filter((job) => (job.data as { progressionDecisionId?: string } | null)?.progressionDecisionId === decisionA.id);
    expect(forA.length).toBeGreaterThanOrEqual(2); // the duplicate this crash window is expected to produce
    for (const job of fetched) await boss2.complete(PROGRESSION_APPLICATION_DISPATCH_QUEUE_V1, job.id);

    // Running BOTH of A's duplicate dispatch jobs (each with its own
    // independent systemCommandId, per task §15) converges to exactly one
    // workflow with exactly one effective APPLIED outcome — no double
    // progression, no corruption. Each uses its OWN fresh client (matching
    // PROG-APP-D-008's own established pattern) so both attempts are a
    // genuine concurrent DB race, not two calls serialized through one
    // shared client/connection.
    const results = await Promise.all(
      forA.map(() => processProgressionApplicationDispatchJob(createDatabaseClient(DATABASE_URL), { progressionDecisionId: decisionA.id, systemCommandId: createEntityId() })),
    );
    expect(results.every((r) => r.status === "SYSTEM_APPLY_ATTEMPTED")).toBe(true);

    const applicationsForA = await db2.select().from(progressionApplications).where(eq(progressionApplications.progressionDecisionId, decisionA.id));
    expect(applicationsForA).toHaveLength(1);
    expect(applicationsForA[0]?.status).toBe("APPLIED");
  });

  it("PROG-APP-D-DUR-C: a dispatch job's systemCommandId is stable across that SAME job's own pg-boss retry", async () => {
    const { userId, athleteProfileId } = await createAthlete("GUIDED");
    const plan = await seedProgram(athleteProfileId, "durability-gate-crash-c");
    await setupCapability(athleteProfileId, plan.exerciseRef);
    const workoutSessionId = await insertEvaluableSession(userId, plan);

    const evalResult = await processProgressionEvaluateSessionJob(db2, boss2, { workoutSessionId, triggerCommandId: "dur-c-1" });
    expect(evalResult).toEqual({ workoutSessionId, evaluated: 1, skipped: 0 });
    const [decision] = await db2.select().from(progressionDecisions).where(eq(progressionDecisions.sourceWorkoutSessionId, workoutSessionId));
    const decisionId = decision!.id;

    const fetchedFirst = await boss2.fetch(PROGRESSION_APPLICATION_DISPATCH_QUEUE_V1, { batchSize: 50 });
    const mineFirst = fetchedFirst.filter((job) => (job.data as { progressionDecisionId?: string } | null)?.progressionDecisionId === decisionId);
    expect(mineFirst).toHaveLength(1);
    const job = mineFirst[0]!;
    const originalSystemCommandId = (job.data as { systemCommandId: string }).systemCommandId;

    // Everything else pulled into the same batch is left completely alone.
    for (const other of fetchedFirst) if (other.id !== job.id) await boss2.complete(PROGRESSION_APPLICATION_DISPATCH_QUEUE_V1, other.id);

    // Force THIS exact job instance to fail -> real pg-boss retry/backoff
    // takes over (task §5/§15's own queue options: retryBackoff: true).
    await boss2.fail(PROGRESSION_APPLICATION_DISPATCH_QUEUE_V1, job.id);

    // Poll for the job to become fetchable again after its backoff delay
    // elapses — real pg-boss retry timing, not a simulated clock.
    let refetchedJob: (typeof mineFirst)[number] | undefined;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && refetchedJob === undefined) {
      const fetchedAgain = await boss2.fetch(PROGRESSION_APPLICATION_DISPATCH_QUEUE_V1, { batchSize: 50 });
      refetchedJob = fetchedAgain.find((j) => j.id === job.id);
      for (const other of fetchedAgain) if (other.id !== job.id) await boss2.complete(PROGRESSION_APPLICATION_DISPATCH_QUEUE_V1, other.id);
      if (refetchedJob === undefined) await new Promise((resolve) => setTimeout(resolve, 250));
    }

    expect(refetchedJob).toBeDefined();
    expect(refetchedJob!.id).toBe(job.id); // the SAME job instance, not a new one
    expect((refetchedJob!.data as { systemCommandId: string }).systemCommandId).toBe(originalSystemCommandId); // payload untouched across pg-boss's own retry
    await boss2.complete(PROGRESSION_APPLICATION_DISPATCH_QUEUE_V1, refetchedJob!.id);
  }, 20_000);
});
