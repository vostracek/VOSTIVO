import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  athleteProfiles,
  createDatabaseClient,
  performedExercises,
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
  type Database,
} from "@vostivo/database";
import { createEntityId } from "@vostivo/domain";
import { ensureApplicationForDecision, keepOriginal, revalidatePendingApplication } from "./progression-application.js";

/**
 * Progression Application V1 — Slice B — real Postgres integration tests
 * (`docs/domain/PROGRESSION-APPLICATION-V1.md`, ADR-0009, Accepted;
 * implementation task "Slice B — Application Workflow Persistence"). Run
 * via `pnpm test:integration`, not part of the default `pnpm test` gate.
 * Covers task §34's required test matrix — state/idempotency/staleness/
 * supersession/concurrency proven against a real database, never
 * simulated. `progression_decisions` rows are inserted directly (this
 * suite does not exercise `ProgressionEvaluationService`/the real engine
 * at all — that pipeline is proven separately, this suite only needs an
 * already-persisted decision to build a workflow from).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://vostivo_api:vostivo_api@localhost:5432/vostivo_dev";

describe("Progression Application V1 — Slice B (real Postgres)", () => {
  let db: Database;
  const userIds: string[] = [];

  beforeEach(() => {
    db = createDatabaseClient(DATABASE_URL);
  });

  async function createAthlete(): Promise<{ readonly userId: string; readonly athleteProfileId: string }> {
    const userId = createEntityId();
    const athleteProfileId = createEntityId();
    await db.insert(users).values({ id: userId, status: "ACTIVE" });
    await db.insert(athleteProfiles).values({ id: athleteProfileId, userId, experienceMode: "GUIDED", unitSystem: "METRIC" });
    userIds.push(userId);
    return { userId, athleteProfileId };
  }

  interface SlotFixture {
    readonly blockId: string;
    readonly versionId: string;
    readonly cycleId: string;
    readonly workoutId: string;
    readonly exerciseId: string;
    readonly exerciseRef: string;
  }

  async function seedProgram(
    athleteProfileId: string,
    opts: {
      readonly programVersionStatus?: "ACTIVE" | "DRAFT" | "SUPERSEDED";
      readonly loadAmountMilli?: number;
      readonly exerciseRef?: string;
    } = {},
  ): Promise<SlotFixture> {
    const exerciseRef = opts.exerciseRef ?? "bench-press";
    const [program] = await db
      .insert(programs)
      .values({ id: createEntityId(), athleteProfileId, name: "Test Program", status: "ACTIVE" })
      .returning();
    const [version] = await db
      .insert(programVersions)
      .values({
        id: createEntityId(),
        programId: program!.id,
        versionNumber: 1,
        status: opts.programVersionStatus ?? "ACTIVE",
        activatedAt: new Date(),
      })
      .returning();
    const [block] = await db
      .insert(trainingBlocks)
      .values({
        id: createEntityId(),
        programVersionId: version!.id,
        name: "Block 1",
        goal: "Hypertrophy",
        orderIndex: 1,
        cycleCount: 6,
        focusAreas: [{ name: "Back", emphasis: "PRIORITY" }],
      })
      .returning();
    const { cycleId, workoutId, exerciseId } = await addCycleWorkoutExercise(
      block!.id,
      1,
      1,
      1,
      exerciseRef,
      opts.loadAmountMilli ?? 100000,
    );
    return { blockId: block!.id, versionId: version!.id, cycleId, workoutId, exerciseId, exerciseRef };
  }

  /** Adds another cycle (task §9 — same block, a different `TrainingCycle.orderIndex`) with a workout/exercise at the given positional slot — used to prove the stream identity repeats across cycles. */
  async function addCycleWorkoutExercise(
    blockId: string,
    cycleOrderIndex: number,
    workoutOrderIndex: number,
    exerciseOrderIndex: number,
    exerciseRef: string,
    loadAmountMilli: number,
  ): Promise<{ readonly cycleId: string; readonly workoutId: string; readonly exerciseId: string }> {
    const today = new Date().toISOString().slice(0, 10);
    const [cycle] = await db
      .insert(trainingCycles)
      .values({ id: createEntityId(), trainingBlockId: blockId, orderIndex: cycleOrderIndex, startDate: today, endDate: today })
      .returning();
    const [workout] = await db
      .insert(plannedWorkouts)
      .values({ id: createEntityId(), trainingCycleId: cycle!.id, name: "Upper A", orderIndex: workoutOrderIndex, status: "PLANNED" })
      .returning();
    const [exercise] = await db
      .insert(plannedExercises)
      .values({ id: createEntityId(), plannedWorkoutId: workout!.id, exerciseRef, displayName: "Bench Press", orderIndex: exerciseOrderIndex })
      .returning();
    await db.insert(plannedSets).values({
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
    return { cycleId: cycle!.id, workoutId: workout!.id, exerciseId: exercise!.id };
  }

  async function createPerformedExposure(
    userId: string,
    exerciseRef: string,
  ): Promise<{ readonly workoutSessionId: string; readonly performedExerciseId: string }> {
    const workoutSessionId = createEntityId();
    await db
      .insert(workoutSessions)
      .values({ id: workoutSessionId, userId, prescriptionSnapshot: {}, startedAt: new Date(), status: "COMPLETED", completedAt: new Date() });
    const performedExerciseId = createEntityId();
    await db
      .insert(performedExercises)
      .values({ id: performedExerciseId, workoutSessionId, prescriptionExerciseId: null, exerciseRef, displayName: "Bench Press", orderIndex: 1 });
    return { workoutSessionId, performedExerciseId };
  }

  async function createDecision(input: {
    readonly userId: string;
    readonly exerciseRef: string;
    readonly sourcePrescriptionExerciseId: string;
    readonly decisionType?: "NO_CHANGE" | "MAINTAIN_LOAD_BUILD_REPS" | "INCREASE_LOAD";
  }): Promise<string> {
    const decisionType = input.decisionType ?? "INCREASE_LOAD";
    const { workoutSessionId, performedExerciseId } = await createPerformedExposure(input.userId, input.exerciseRef);
    const id = createEntityId();
    await db.insert(progressionDecisions).values({
      id,
      userId: input.userId,
      exerciseRef: input.exerciseRef,
      sourceWorkoutSessionId: workoutSessionId,
      sourcePerformedExerciseId: performedExerciseId,
      sourcePrescriptionExerciseId: input.sourcePrescriptionExerciseId,
      engine: "progression",
      policy: "v1",
      decisionType,
      reasonCode: decisionType === "INCREASE_LOAD" ? "TOP_OF_RANGE_ACHIEVED" : "PERFORMANCE_STABLE",
      evidenceStrength: "SUPPORTED",
      progressionStalled: false,
      recommendedChange: decisionType === "INCREASE_LOAD" ? { direction: "INCREASE_LOAD" } : null,
      normalizedInputSnapshot: {},
      evidenceRefs: [],
      evidenceFingerprint: createEntityId(),
    });
    return id;
  }

  afterEach(async () => {
    if (userIds.length === 0) return;

    const commandRows = await db
      .select({ commandId: progressionApplicationCommands.commandId })
      .from(progressionApplicationCommands)
      .where(inArray(progressionApplicationCommands.userId, userIds));
    if (commandRows.length > 0) {
      await db.delete(progressionApplicationCommands).where(inArray(progressionApplicationCommands.commandId, commandRows.map((r) => r.commandId)));
    }
    await db.delete(progressionApplications).where(inArray(progressionApplications.userId, userIds));
    await db.delete(progressionDecisions).where(inArray(progressionDecisions.userId, userIds));

    const sessionRows = await db.select({ id: workoutSessions.id }).from(workoutSessions).where(inArray(workoutSessions.userId, userIds));
    const sessionIds = sessionRows.map((r) => r.id);
    if (sessionIds.length > 0) {
      const exerciseRows = await db
        .select({ id: performedExercises.id })
        .from(performedExercises)
        .where(inArray(performedExercises.workoutSessionId, sessionIds));
      const exerciseIds = exerciseRows.map((r) => r.id);
      if (exerciseIds.length > 0) {
        await db.delete(performedExercises).where(inArray(performedExercises.id, exerciseIds));
      }
      await db.delete(workoutSessions).where(inArray(workoutSessions.id, sessionIds));
    }

    const athleteRows = await db.select({ id: athleteProfiles.id }).from(athleteProfiles).where(inArray(athleteProfiles.userId, userIds));
    const athleteProfileIds = athleteRows.map((r) => r.id);
    if (athleteProfileIds.length > 0) {
      const programRows = await db.select({ id: programs.id }).from(programs).where(inArray(programs.athleteProfileId, athleteProfileIds));
      const programIds = programRows.map((r) => r.id);
      if (programIds.length > 0) {
        const versionRows = await db.select({ id: programVersions.id }).from(programVersions).where(inArray(programVersions.programId, programIds));
        const versionIds = versionRows.map((r) => r.id);
        const blockRows = await db.select({ id: trainingBlocks.id }).from(trainingBlocks).where(inArray(trainingBlocks.programVersionId, versionIds));
        const blockIds = blockRows.map((r) => r.id);
        const cycleRows = await db.select({ id: trainingCycles.id }).from(trainingCycles).where(inArray(trainingCycles.trainingBlockId, blockIds));
        const cycleIds = cycleRows.map((r) => r.id);
        const workoutRows = await db.select({ id: plannedWorkouts.id }).from(plannedWorkouts).where(inArray(plannedWorkouts.trainingCycleId, cycleIds));
        const workoutIds = workoutRows.map((r) => r.id);
        const exerciseRows = await db
          .select({ id: plannedExercises.id })
          .from(plannedExercises)
          .where(inArray(plannedExercises.plannedWorkoutId, workoutIds));
        const exerciseIds = exerciseRows.map((r) => r.id);
        if (exerciseIds.length > 0) await db.delete(plannedSets).where(inArray(plannedSets.plannedExerciseId, exerciseIds));
        if (workoutIds.length > 0) await db.delete(plannedExercises).where(inArray(plannedExercises.plannedWorkoutId, workoutIds));
        if (cycleIds.length > 0) await db.delete(plannedWorkouts).where(inArray(plannedWorkouts.trainingCycleId, cycleIds));
        if (blockIds.length > 0) await db.delete(trainingCycles).where(inArray(trainingCycles.trainingBlockId, blockIds));
        if (versionIds.length > 0) await db.delete(trainingBlocks).where(inArray(trainingBlocks.programVersionId, versionIds));
        if (programIds.length > 0) await db.delete(programVersions).where(inArray(programVersions.programId, programIds));
        await db.delete(programs).where(inArray(programs.id, programIds));
      }
      await db.delete(athleteProfiles).where(inArray(athleteProfiles.id, athleteProfileIds));
    }

    await db.delete(users).where(inArray(users.id, userIds));
    userIds.length = 0;
  });

  // 1, 6, 8, 10, 11
  it("PROG-APP-B-001: an INCREASE_LOAD decision creates exactly one PENDING_REVIEW application, with the exact stream identity/ownership/expected load persisted", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId, { loadAmountMilli: 100000 });
    const decisionId = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });

    const outcome = await ensureApplicationForDecision(db, { userId }, decisionId);
    expect(outcome.status).toBe("CREATED");
    if (outcome.status !== "CREATED") throw new Error("expected CREATED");

    expect(outcome.application.userId).toBe(userId); // ownership matches decision owner
    expect(outcome.application.status).toBe("PENDING_REVIEW");
    expect(outcome.application.trainingBlockId).toBe(plan.blockId);
    expect(outcome.application.workoutOrderIndex).toBe(1);
    expect(outcome.application.exerciseOrderIndex).toBe(1);
    expect(outcome.application.effectiveFromCycleOrderIndex).toBe(1);
    expect(outcome.application.exerciseRef).toBe(plan.exerciseRef);
    expect(outcome.application.expectedEffectiveLoad).toEqual({ kind: "EXTERNAL_WEIGHT", amountMilli: 100000, unit: "KG", basis: "TOTAL" });
    // setOrderIndex is intentionally absent from the persisted identity (task §5/§10).
    expect(Object.keys(outcome.application)).not.toContain("setOrderIndex");
  });

  it("EQC-PROG: a decision about a DIFFERENT exercise than the slot's authored one (a temporary equipment substitute performed in that slot) never creates an application for the authored slot", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId, { loadAmountMilli: 100000 });
    const decisionId = await createDecision({ userId, exerciseRef: "dumbbell-bench-press", sourcePrescriptionExerciseId: plan.exerciseId });

    expect(await ensureApplicationForDecision(db, { userId }, decisionId)).toEqual({ status: "NO_PLAN_CONTEXT" });
    expect(await db.select().from(progressionApplications).where(eq(progressionApplications.userId, userId))).toHaveLength(0);
  });

  // 2
  it("PROG-APP-B-002: a NO_CHANGE decision creates no application", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId);
    const decisionId = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId, decisionType: "NO_CHANGE" });

    const outcome = await ensureApplicationForDecision(db, { userId }, decisionId);
    expect(outcome.status).toBe("NOT_INCREASE_LOAD");

    const rows = await db.select().from(progressionApplications).where(eq(progressionApplications.progressionDecisionId, decisionId));
    expect(rows).toHaveLength(0);
  });

  // 3
  it("PROG-APP-B-003: a MAINTAIN_LOAD_BUILD_REPS decision creates no application", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId);
    const decisionId = await createDecision({
      userId,
      exerciseRef: plan.exerciseRef,
      sourcePrescriptionExerciseId: plan.exerciseId,
      decisionType: "MAINTAIN_LOAD_BUILD_REPS",
    });

    const outcome = await ensureApplicationForDecision(db, { userId }, decisionId);
    expect(outcome.status).toBe("NOT_INCREASE_LOAD");
  });

  // 4
  it("PROG-APP-B-004: a duplicate ensure call returns the SAME application, never a second row", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId);
    const decisionId = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });

    const first = await ensureApplicationForDecision(db, { userId }, decisionId);
    const second = await ensureApplicationForDecision(db, { userId }, decisionId);
    expect(first.status).toBe("CREATED");
    expect(second.status).toBe("ALREADY_EXISTS");
    if (first.status !== "CREATED" || second.status !== "ALREADY_EXISTS") throw new Error("unexpected status");
    expect(second.application.id).toBe(first.application.id);

    const rows = await db.select().from(progressionApplications).where(eq(progressionApplications.progressionDecisionId, decisionId));
    expect(rows).toHaveLength(1);
  });

  // 5
  it("PROG-APP-B-005: concurrent ensure calls for the same decision create exactly one row (real Postgres race)", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId);
    const decisionId = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => ensureApplicationForDecision(createDatabaseClient(DATABASE_URL), { userId }, decisionId)),
    );
    const ids = new Set(results.map((r) => (r.status === "CREATED" || r.status === "ALREADY_EXISTS" ? r.application.id : null)));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.status === "CREATED")).toHaveLength(1);

    const rows = await db.select().from(progressionApplications).where(eq(progressionApplications.progressionDecisionId, decisionId));
    expect(rows).toHaveLength(1);
  });

  // 7
  it("PROG-APP-B-007: actor B cannot create a workflow from actor A's decision — BOLA-safe NOT_FOUND", async () => {
    const athleteA = await createAthlete();
    const athleteB = await createAthlete();
    const plan = await seedProgram(athleteA.athleteProfileId);
    const decisionId = await createDecision({ userId: athleteA.userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });

    const outcome = await ensureApplicationForDecision(db, { userId: athleteB.userId }, decisionId);
    expect(outcome.status).toBe("NOT_FOUND");

    const rows = await db.select().from(progressionApplications).where(eq(progressionApplications.progressionDecisionId, decisionId));
    expect(rows).toHaveLength(0);
  });

  // Slice B ownership-integrity gate — the mandatory raw-SQL negative proof.
  it("PROG-APP-B-OWNERSHIP: Postgres itself (not service-level BOLA) rejects a progression_application whose user_id disagrees with its own progression_decision's real owner", async () => {
    const athleteA = await createAthlete();
    const athleteB = await createAthlete();
    const plan = await seedProgram(athleteA.athleteProfileId);
    const decisionId = await createDecision({ userId: athleteA.userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });

    // Bypass ensureApplicationForDecision entirely — a raw insert with
    // every other field valid, but user_id set to a DIFFERENT athlete than
    // the one who actually owns `decisionId`. drizzle-orm's postgres-js
    // driver wraps the raw PostgresError in its own DrizzleQueryError,
    // exposing the original via `.cause` — same unwrap this codebase
    // already uses in `workout-command-processing.ts`'s
    // `isPostgresUniqueViolation`.
    let caught: unknown;
    try {
      await db.insert(progressionApplications).values({
        id: createEntityId(),
        progressionDecisionId: decisionId,
        userId: athleteB.userId, // mismatched owner — decision belongs to athleteA
        exerciseRef: plan.exerciseRef,
        programVersionId: plan.versionId,
        trainingBlockId: plan.blockId,
        workoutOrderIndex: 1,
        exerciseOrderIndex: 1,
        effectiveFromCycleOrderIndex: 1,
        expectedEffectiveLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: 100000, unit: "KG", basis: "TOTAL" },
        status: "PENDING_REVIEW",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    const cause = (caught as { cause?: { code?: string; constraint_name?: string } }).cause;
    expect(cause?.code).toBe("23503"); // Postgres FK-violation SQLSTATE — not a service/mock rejection
    expect(cause?.constraint_name).toBe("progression_applications_decision_owner_fkey");

    const rows = await db.select().from(progressionApplications).where(eq(progressionApplications.progressionDecisionId, decisionId));
    expect(rows).toHaveLength(0); // the mismatched row was never persisted
  });

  // 9
  it("PROG-APP-B-009: the same programmed slot in a DIFFERENT cycle produces the SAME stream identity but a different effectiveFrom boundary — cycle is excluded from identity", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId, { loadAmountMilli: 100000 }); // cycle orderIndex 1
    const week2 = await addCycleWorkoutExercise(plan.blockId, 2, 1, 1, plan.exerciseRef, 100000); // same workout/exercise orderIndex, cycle 2

    const decision1 = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const decision2 = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: week2.exerciseId });

    const outcome1 = await ensureApplicationForDecision(db, { userId }, decision1);
    const outcome2 = await ensureApplicationForDecision(db, { userId }, decision2);
    if (outcome1.status !== "CREATED" || outcome2.status !== "CREATED") throw new Error("expected CREATED");

    // Same stream (task §5/§9):
    expect(outcome2.application.programVersionId).toBe(outcome1.application.programVersionId);
    expect(outcome2.application.trainingBlockId).toBe(outcome1.application.trainingBlockId);
    expect(outcome2.application.workoutOrderIndex).toBe(outcome1.application.workoutOrderIndex);
    expect(outcome2.application.exerciseOrderIndex).toBe(outcome1.application.exerciseOrderIndex);
    // But a distinct effectiveFrom boundary, reflecting each one's own source cycle:
    expect(outcome1.application.effectiveFromCycleOrderIndex).toBe(1);
    expect(outcome2.application.effectiveFromCycleOrderIndex).toBe(2);
  });

  // 12, 23, 24, 25
  it("PROG-APP-B-012: PENDING_REVIEW -> KEPT_ORIGINAL succeeds and mutates nothing else (Plan, decision untouched)", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId, { loadAmountMilli: 100000 });
    const decisionId = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const ensured = await ensureApplicationForDecision(db, { userId }, decisionId);
    if (ensured.status !== "CREATED") throw new Error("expected CREATED");

    const commandId = createEntityId();
    const outcome = await keepOriginal(db, { userId }, { applicationId: ensured.application.id, commandId });
    expect(outcome.status).toBe("KEPT_ORIGINAL");
    if (outcome.status !== "KEPT_ORIGINAL") throw new Error("expected KEPT_ORIGINAL");
    expect(outcome.application.decidedBy).toBe(userId);
    expect(outcome.application.decidedAt).not.toBeNull();

    // No Plan mutation (task §19/§23):
    const [set] = await db.select().from(plannedSets).where(eq(plannedSets.plannedExerciseId, plan.exerciseId));
    expect(set?.loadAmountMilli).toBe(100000);

    // progression_decision itself is never written by this feature (task §25):
    const [decision] = await db.select().from(progressionDecisions).where(eq(progressionDecisions.id, decisionId));
    expect(decision?.appliedAt).toBeNull();
    expect(decision?.supersededByDecisionId).toBeNull();
  });

  // 13
  it("PROG-APP-B-013: repeated KEEP_ORIGINAL with the SAME commandId is idempotent — identical durable result", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId);
    const decisionId = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const ensured = await ensureApplicationForDecision(db, { userId }, decisionId);
    if (ensured.status !== "CREATED") throw new Error("expected CREATED");

    const commandId = createEntityId();
    const first = await keepOriginal(db, { userId }, { applicationId: ensured.application.id, commandId });
    const second = await keepOriginal(db, { userId }, { applicationId: ensured.application.id, commandId });
    expect(first).toEqual(second);

    const receipts = await db.select().from(progressionApplicationCommands).where(eq(progressionApplicationCommands.commandId, commandId));
    expect(receipts).toHaveLength(1);
  });

  // 14
  it("PROG-APP-B-014: two DIFFERENT commandIds both requesting KEEP_ORIGINAL converge safely to the same terminal state", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId);
    const decisionId = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const ensured = await ensureApplicationForDecision(db, { userId }, decisionId);
    if (ensured.status !== "CREATED") throw new Error("expected CREATED");

    const first = await keepOriginal(db, { userId }, { applicationId: ensured.application.id, commandId: createEntityId() });
    const second = await keepOriginal(db, { userId }, { applicationId: ensured.application.id, commandId: createEntityId() });
    expect(first.status).toBe("KEPT_ORIGINAL");
    expect(second.status).toBe("KEPT_ORIGINAL");

    const rows = await db.select().from(progressionApplications).where(eq(progressionApplications.id, ensured.application.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("KEPT_ORIGINAL");

    const receipts = await db.select().from(progressionApplicationCommands).where(eq(progressionApplicationCommands.applicationId, ensured.application.id));
    expect(receipts).toHaveLength(2); // one receipt per distinct commandId — no corruption
  });

  // 15
  it("PROG-APP-B-015: reusing the same commandId against a different applicationId is a deterministic COMMAND_CONFLICT", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId);
    const decisionA = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const week2 = await addCycleWorkoutExercise(plan.blockId, 2, 1, 1, plan.exerciseRef, 100000);
    const decisionB = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: week2.exerciseId });
    const ensuredA = await ensureApplicationForDecision(db, { userId }, decisionA);
    const ensuredB = await ensureApplicationForDecision(db, { userId }, decisionB);
    if (ensuredA.status !== "CREATED" || ensuredB.status !== "CREATED") throw new Error("expected CREATED");

    const commandId = createEntityId();
    const first = await keepOriginal(db, { userId }, { applicationId: ensuredA.application.id, commandId });
    expect(first.status).toBe("KEPT_ORIGINAL");

    const conflicting = await keepOriginal(db, { userId }, { applicationId: ensuredB.application.id, commandId });
    expect(conflicting.status).toBe("COMMAND_CONFLICT");

    // application B was never touched by the conflicting reused commandId:
    const [rowB] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, ensuredB.application.id));
    expect(rowB?.status).toBe("PENDING_REVIEW");
  });

  // 16, 21
  it("PROG-APP-B-016: a terminal KEPT_ORIGINAL row can never be moved back to PENDING_REVIEW or elsewhere by a later action", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId);
    const decisionId = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const ensured = await ensureApplicationForDecision(db, { userId }, decisionId);
    if (ensured.status !== "CREATED") throw new Error("expected CREATED");
    await keepOriginal(db, { userId }, { applicationId: ensured.application.id, commandId: createEntityId() });

    const revalidated = await revalidatePendingApplication(db, { userId }, ensured.application.id);
    expect(revalidated.status).toBe("TERMINAL");
    if (revalidated.status !== "TERMINAL") throw new Error("expected TERMINAL");
    expect(revalidated.application.status).toBe("KEPT_ORIGINAL");
  });

  // 17, 18
  it("PROG-APP-B-017: a PENDING_REVIEW application whose source decision was superseded (Slice C) becomes SUPERSEDED and is no longer actionable", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId);
    const decisionId1 = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const ensured = await ensureApplicationForDecision(db, { userId }, decisionId1);
    if (ensured.status !== "CREATED") throw new Error("expected CREATED");

    // Simulate Slice C's own D1 -> D2 corrected-evidence supersession directly.
    const decisionId2 = createEntityId();
    await db.insert(progressionDecisions).values({
      id: decisionId2,
      userId,
      exerciseRef: plan.exerciseRef,
      sourceWorkoutSessionId: (await db.select().from(progressionDecisions).where(eq(progressionDecisions.id, decisionId1)))[0]!.sourceWorkoutSessionId,
      sourcePerformedExerciseId: (await db.select().from(progressionDecisions).where(eq(progressionDecisions.id, decisionId1)))[0]!.sourcePerformedExerciseId,
      sourcePrescriptionExerciseId: plan.exerciseId,
      engine: "progression",
      policy: "v1",
      decisionType: "INCREASE_LOAD",
      reasonCode: "TOP_OF_RANGE_ACHIEVED",
      evidenceStrength: "SUPPORTED",
      progressionStalled: false,
      recommendedChange: { direction: "INCREASE_LOAD" },
      normalizedInputSnapshot: {},
      evidenceRefs: [],
      evidenceFingerprint: createEntityId(),
    });
    await db.update(progressionDecisions).set({ supersededByDecisionId: decisionId2 }).where(eq(progressionDecisions.id, decisionId1));

    const revalidated = await revalidatePendingApplication(db, { userId }, ensured.application.id);
    expect(revalidated.status).toBe("SUPERSEDED");

    // No longer actionable — a subsequent KEEP_ORIGINAL cannot revive it:
    const keepAttempt = await keepOriginal(db, { userId }, { applicationId: ensured.application.id, commandId: createEntityId() });
    expect(keepAttempt.status).toBe("NOT_KEPT");
    if (keepAttempt.status !== "NOT_KEPT") throw new Error("expected NOT_KEPT");
    expect(keepAttempt.reason).toBe("SUPERSEDED");
  });

  // 19
  it("PROG-APP-B-019: a ProgramVersion no longer ACTIVE makes its PENDING_REVIEW applications STALE", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId);
    const decisionId = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const ensured = await ensureApplicationForDecision(db, { userId }, decisionId);
    if (ensured.status !== "CREATED") throw new Error("expected CREATED");

    await db.update(programVersions).set({ status: "SUPERSEDED" }).where(eq(programVersions.id, plan.versionId));

    const revalidated = await revalidatePendingApplication(db, { userId }, ensured.application.id);
    expect(revalidated.status).toBe("STALE");
  });

  // 20
  it("PROG-APP-B-020: the exercise at the recorded slot changing (exerciseRef mismatch) makes its PENDING_REVIEW application STALE", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId, { exerciseRef: "bench-press" });
    const decisionId = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const ensured = await ensureApplicationForDecision(db, { userId }, decisionId);
    if (ensured.status !== "CREATED") throw new Error("expected CREATED");

    // Simulate a structural exercise swap at the exact same positional slot.
    await db.update(plannedExercises).set({ exerciseRef: "incline-db-press" }).where(eq(plannedExercises.id, plan.exerciseId));

    const revalidated = await revalidatePendingApplication(db, { userId }, ensured.application.id);
    expect(revalidated.status).toBe("STALE");
  });

  // 20b — expected-load-changed variant of the same live-slot re-resolution
  it("PROG-APP-B-020B: the authored load at the recorded slot changing makes its PENDING_REVIEW application STALE (EXPECTED_LOAD_CHANGED)", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId, { loadAmountMilli: 100000 });
    const decisionId = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const ensured = await ensureApplicationForDecision(db, { userId }, decisionId);
    if (ensured.status !== "CREATED") throw new Error("expected CREATED");

    await db.update(plannedSets).set({ loadAmountMilli: 105000 }).where(eq(plannedSets.plannedExerciseId, plan.exerciseId));

    const revalidated = await revalidatePendingApplication(db, { userId }, ensured.application.id);
    expect(revalidated.status).toBe("STALE");
  });

  // 22
  it("PROG-APP-B-022: SUPERSEDED is terminal — a further revalidation call reports TERMINAL, never re-derives it", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId);
    const decisionId = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const ensured = await ensureApplicationForDecision(db, { userId }, decisionId);
    if (ensured.status !== "CREATED") throw new Error("expected CREATED");

    await db.update(programVersions).set({ status: "SUPERSEDED" }).where(eq(programVersions.id, plan.versionId));
    const first = await revalidatePendingApplication(db, { userId }, ensured.application.id);
    expect(first.status).toBe("STALE");

    const second = await revalidatePendingApplication(db, { userId }, ensured.application.id);
    expect(second.status).toBe("TERMINAL");
    if (second.status !== "TERMINAL") throw new Error("expected TERMINAL");
    expect(second.application.status).toBe("STALE");
  });

  // 28
  it("PROG-APP-B-028: no code path in this slice ever writes status = 'APPLIED'", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId);
    const decisionId = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const ensured = await ensureApplicationForDecision(db, { userId }, decisionId);
    if (ensured.status !== "CREATED") throw new Error("expected CREATED");
    await keepOriginal(db, { userId }, { applicationId: ensured.application.id, commandId: createEntityId() });

    const rows = await db.select().from(progressionApplications).where(eq(progressionApplications.userId, userId));
    expect(rows.every((r) => r.status !== "APPLIED" && r.status !== "REVOKED")).toBe(true);
  });

  // 29
  it("PROG-APP-B-029: concurrent KEEP_ORIGINAL — both the same commandId and different commandIds — is safe under real Postgres concurrency", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId);
    const decisionId = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const ensured = await ensureApplicationForDecision(db, { userId }, decisionId);
    if (ensured.status !== "CREATED") throw new Error("expected CREATED");

    const sameCommandId = createEntityId();
    const sameCommandResults = await Promise.all(
      Array.from({ length: 6 }, () =>
        keepOriginal(createDatabaseClient(DATABASE_URL), { userId }, { applicationId: ensured.application.id, commandId: sameCommandId }),
      ),
    );
    expect(sameCommandResults.every((r) => r.status === "KEPT_ORIGINAL")).toBe(true);

    const decisionId2 = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const ensured2 = await ensureApplicationForDecision(db, { userId }, decisionId2);
    if (ensured2.status !== "CREATED") throw new Error("expected CREATED");
    const differentCommandResults = await Promise.all(
      Array.from({ length: 6 }, () =>
        keepOriginal(createDatabaseClient(DATABASE_URL), { userId }, { applicationId: ensured2.application.id, commandId: createEntityId() }),
      ),
    );
    expect(differentCommandResults.every((r) => r.status === "KEPT_ORIGINAL")).toBe(true);

    const rows = await db
      .select()
      .from(progressionApplications)
      .where(inArray(progressionApplications.id, [ensured.application.id, ensured2.application.id]));
    expect(rows.every((r) => r.status === "KEPT_ORIGINAL")).toBe(true);
  });

  // 30
  it("PROG-APP-B-030: a stale-vs-keep race is deterministic — once the live Plan slot is invalidated, no concurrent KEEP_ORIGINAL can still win", async () => {
    const { userId, athleteProfileId } = await createAthlete();
    const plan = await seedProgram(athleteProfileId, { loadAmountMilli: 100000 });
    const decisionId = await createDecision({ userId, exerciseRef: plan.exerciseRef, sourcePrescriptionExerciseId: plan.exerciseId });
    const ensured = await ensureApplicationForDecision(db, { userId }, decisionId);
    if (ensured.status !== "CREATED") throw new Error("expected CREATED");

    // Invalidate the live precondition BEFORE racing concurrent KEEP_ORIGINAL attempts.
    await db.update(programVersions).set({ status: "SUPERSEDED" }).where(eq(programVersions.id, plan.versionId));

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        keepOriginal(createDatabaseClient(DATABASE_URL), { userId }, { applicationId: ensured.application.id, commandId: createEntityId() }),
      ),
    );
    expect(results.every((r) => r.status === "NOT_KEPT")).toBe(true);

    const [row] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, ensured.application.id));
    expect(row?.status).toBe("STALE"); // exactly one deterministic terminal state, never KEPT_ORIGINAL
  });
});
