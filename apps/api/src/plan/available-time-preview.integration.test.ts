import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictException, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { asc, eq, inArray } from "drizzle-orm";
import {
  athleteProfiles,
  createDatabaseClient,
  plannedExercises,
  plannedSets,
  plannedWorkouts,
  programVersions,
  programs,
  progressionApplications,
  progressionDecisions,
  trainingBlocks,
  trainingCycles,
  users,
  workoutSessions,
  plannedWorkoutOccurrenceClaims,
  type Database,
} from "@vostivo/database";
import { createEntityId } from "@vostivo/domain";
import { AvailableTimePreviewService } from "./available-time-preview.service.js";

/**
 * Available-Time Adaptation V1 — Slice B, real Postgres (same precedent as
 * plan.integration.test.ts) — run via `pnpm test:integration`.
 *
 * Fixture = the tech-lead manual fixture (Slice B §14), authored
 * explicitly: Bench Press TIER_1 / min 2 / 3 WORKING sets, Overhead Press
 * TIER_2 / min 0 / 2 WORKING sets, 90s rest everywhere.
 *
 * available-time/v1 durations for it:
 *   Bench 3 sets: 60 + 3*30 + 2*90 = 330s   Bench 2 sets: 60 + 2*30 + 90 = 210s
 *   OHP 2 sets:   60 + 2*30 + 90   = 210s   OHP 1 set:    60 + 30      =  90s
 *   full session = 540s (9 min)
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://vostivo_api:vostivo_api@localhost:5432/vostivo_dev";

interface TestAthlete {
  readonly userId: string;
  readonly athleteProfileId: string;
}

interface SeededWorkout {
  readonly versionId: string;
  readonly workoutId: string;
  readonly benchId: string;
  readonly ohpId: string;
  /** Per exercise, its planned set ids in authored order. */
  readonly setIds: readonly (readonly string[])[];
}

interface ExerciseSeed {
  readonly displayName: string;
  readonly exerciseRef: string;
  readonly priorityTier: "TIER_1" | "TIER_2" | "TIER_3" | null;
  readonly minimumWorkingSets: number | null;
  readonly workingSets: number;
  readonly restSeconds: number | null;
}

const BENCH: ExerciseSeed = { displayName: "Bench Press", exerciseRef: "bench-press", priorityTier: "TIER_1", minimumWorkingSets: 2, workingSets: 3, restSeconds: 90 };
const OHP: ExerciseSeed = { displayName: "Overhead Press", exerciseRef: "overhead-press", priorityTier: "TIER_2", minimumWorkingSets: 0, workingSets: 2, restSeconds: 90 };

async function createTestAthlete(db: Database): Promise<TestAthlete> {
  const userId = createEntityId();
  await db.insert(users).values({ id: userId, status: "ACTIVE" });
  const athleteProfileId = createEntityId();
  await db.insert(athleteProfiles).values({ id: athleteProfileId, userId, experienceMode: "ADAPTIVE", unitSystem: "METRIC" });
  return { userId, athleteProfileId };
}

async function seedWorkout(db: Database, athleteProfileId: string, exercises: readonly ExerciseSeed[] = [BENCH, OHP]): Promise<SeededWorkout> {
  const [program] = await db.insert(programs).values({ id: createEntityId(), athleteProfileId, name: "Test Program", status: "ACTIVE" }).returning();
  const [version] = await db
    .insert(programVersions)
    .values({ id: createEntityId(), programId: program!.id, versionNumber: 1, status: "ACTIVE", activatedAt: new Date() })
    .returning();
  const [block] = await db
    .insert(trainingBlocks)
    .values({ id: createEntityId(), programVersionId: version!.id, name: "Block 1", goal: "Hypertrophy", orderIndex: 1, cycleCount: 1, focusAreas: [] })
    .returning();
  const today = new Date().toISOString().slice(0, 10);
  const [cycle] = await db
    .insert(trainingCycles)
    .values({ id: createEntityId(), trainingBlockId: block!.id, orderIndex: 1, startDate: today, endDate: today })
    .returning();
  const [workout] = await db
    .insert(plannedWorkouts)
    .values({ id: createEntityId(), trainingCycleId: cycle!.id, name: "Upper Body A", focus: "Push emphasis", orderIndex: 1, scheduledDate: today, estimatedDurationMinutes: 60, status: "PLANNED" })
    .returning();

  const exerciseIds: string[] = [];
  const setIds: string[][] = [];
  for (const [index, seed] of exercises.entries()) {
    const [exercise] = await db
      .insert(plannedExercises)
      .values({
        id: createEntityId(),
        plannedWorkoutId: workout!.id,
        exerciseRef: seed.exerciseRef,
        displayName: seed.displayName,
        orderIndex: index + 1,
        priorityTier: seed.priorityTier,
        minimumWorkingSets: seed.minimumWorkingSets,
      })
      .returning();
    exerciseIds.push(exercise!.id);
    const exerciseSetIds: string[] = [];
    setIds.push(exerciseSetIds);
    for (let setIndex = 1; setIndex <= seed.workingSets; setIndex++) {
      const setId = createEntityId();
      exerciseSetIds.push(setId);
      await db.insert(plannedSets).values({
        id: setId,
        plannedExerciseId: exercise!.id,
        orderIndex: setIndex,
        targetRepsMin: 8,
        targetRepsMax: 12,
        restSeconds: seed.restSeconds,
        setType: "WORKING",
        loadKind: "EXTERNAL_WEIGHT",
        loadAmountMilli: 60000,
        loadUnit: "KG",
        loadBasis: "TOTAL",
      });
    }
  }

  return { versionId: version!.id, workoutId: workout!.id, benchId: exerciseIds[0]!, ohpId: exerciseIds[1] ?? "", setIds };
}

async function insertSession(db: Database, userId: string, plannedWorkoutId: string, status: "ACTIVE" | "COMPLETED"): Promise<void> {
  const sessionId = createEntityId();
  await db.insert(workoutSessions).values({
    id: sessionId,
    userId,
    prescriptionSnapshot: { schemaVersion: 1, prescriptionId: plannedWorkoutId, name: "Upper Body A", exercises: [] },
    startedAt: new Date(),
    status,
    completedAt: status === "COMPLETED" ? new Date() : null,
  });
  // What the real START handler writes with an accepted planned START
  // (Planned Workout Occurrence Authority V1) — the first one claims the occurrence.
  await db.insert(plannedWorkoutOccurrenceClaims).values({ id: createEntityId(), userId, plannedWorkoutId, canonicalWorkoutSessionId: sessionId }).onConflictDoNothing();
}

/** Every row a preview could conceivably touch, for the "zero mutations" proof. */
async function snapshotState(db: Database, athlete: TestAthlete, seeded: SeededWorkout) {
  const exerciseRows = await db.select().from(plannedExercises).where(eq(plannedExercises.plannedWorkoutId, seeded.workoutId)).orderBy(asc(plannedExercises.orderIndex));
  return {
    workout: await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, seeded.workoutId)),
    exercises: exerciseRows,
    sets: await db.select().from(plannedSets).where(inArray(plannedSets.plannedExerciseId, exerciseRows.map((e) => e.id))).orderBy(asc(plannedSets.id)),
    versions: await db.select().from(programVersions).where(eq(programVersions.id, seeded.versionId)),
    versionCount: (await db.select({ id: programVersions.id }).from(programVersions).innerJoin(programs, eq(programs.id, programVersions.programId)).where(eq(programs.athleteProfileId, athlete.athleteProfileId))).length,
    sessions: await db.select().from(workoutSessions).where(eq(workoutSessions.userId, athlete.userId)),
    decisions: await db.select().from(progressionDecisions).where(eq(progressionDecisions.userId, athlete.userId)),
    applications: await db.select().from(progressionApplications).where(eq(progressionApplications.userId, athlete.userId)),
  };
}

async function cleanup(db: Database, userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  await db.delete(plannedWorkoutOccurrenceClaims).where(inArray(plannedWorkoutOccurrenceClaims.userId, [...userIds]));
  await db.delete(workoutSessions).where(inArray(workoutSessions.userId, [...userIds]));
  const profileIds = (await db.select({ id: athleteProfiles.id }).from(athleteProfiles).where(inArray(athleteProfiles.userId, [...userIds]))).map((r) => r.id);
  if (profileIds.length > 0) {
    const programIds = (await db.select({ id: programs.id }).from(programs).where(inArray(programs.athleteProfileId, profileIds))).map((r) => r.id);
    const versionIds = programIds.length === 0 ? [] : (await db.select({ id: programVersions.id }).from(programVersions).where(inArray(programVersions.programId, programIds))).map((r) => r.id);
    const blockIds = versionIds.length === 0 ? [] : (await db.select({ id: trainingBlocks.id }).from(trainingBlocks).where(inArray(trainingBlocks.programVersionId, versionIds))).map((r) => r.id);
    const cycleIds = blockIds.length === 0 ? [] : (await db.select({ id: trainingCycles.id }).from(trainingCycles).where(inArray(trainingCycles.trainingBlockId, blockIds))).map((r) => r.id);
    const workoutIds = cycleIds.length === 0 ? [] : (await db.select({ id: plannedWorkouts.id }).from(plannedWorkouts).where(inArray(plannedWorkouts.trainingCycleId, cycleIds))).map((r) => r.id);
    const exerciseIds = workoutIds.length === 0 ? [] : (await db.select({ id: plannedExercises.id }).from(plannedExercises).where(inArray(plannedExercises.plannedWorkoutId, workoutIds))).map((r) => r.id);
    if (exerciseIds.length > 0) await db.delete(plannedSets).where(inArray(plannedSets.plannedExerciseId, exerciseIds));
    if (workoutIds.length > 0) await db.delete(plannedExercises).where(inArray(plannedExercises.plannedWorkoutId, workoutIds));
    if (cycleIds.length > 0) await db.delete(plannedWorkouts).where(inArray(plannedWorkouts.trainingCycleId, cycleIds));
    if (blockIds.length > 0) await db.delete(trainingCycles).where(inArray(trainingCycles.trainingBlockId, blockIds));
    if (versionIds.length > 0) await db.delete(trainingBlocks).where(inArray(trainingBlocks.programVersionId, versionIds));
    if (programIds.length > 0) await db.delete(programVersions).where(inArray(programVersions.programId, programIds));
    await db.delete(programs).where(inArray(programs.athleteProfileId, profileIds));
    await db.delete(athleteProfiles).where(inArray(athleteProfiles.id, profileIds));
  }
  await db.delete(users).where(inArray(users.id, [...userIds]));
}

describe("Available-Time preview — server orchestration (real Postgres)", () => {
  const db: Database = createDatabaseClient(DATABASE_URL);
  const service = new AvailableTimePreviewService(db);
  const testUserIds: string[] = [];

  async function athleteWithWorkout(exercises?: readonly ExerciseSeed[]): Promise<{ athlete: TestAthlete; seeded: SeededWorkout }> {
    const athlete = await createTestAthlete(db);
    testUserIds.push(athlete.userId);
    return { athlete, seeded: await seedWorkout(db, athlete.athleteProfileId, exercises) };
  }

  afterAll(async () => {
    await cleanup(db, testUserIds);
  });

  beforeEach(async () => {
    await cleanup(db, testUserIds);
    testUserIds.length = 0;
  });

  it("ATP-001: authored priorityTier + minimumWorkingSets round-trip through the real schema", async () => {
    const { seeded } = await athleteWithWorkout();
    const rows = await db
      .select({ id: plannedExercises.id, priorityTier: plannedExercises.priorityTier, minimumWorkingSets: plannedExercises.minimumWorkingSets })
      .from(plannedExercises)
      .where(eq(plannedExercises.plannedWorkoutId, seeded.workoutId))
      .orderBy(asc(plannedExercises.orderIndex));
    expect(rows).toEqual([
      { id: seeded.benchId, priorityTier: "TIER_1", minimumWorkingSets: 2 },
      { id: seeded.ohpId, priorityTier: "TIER_2", minimumWorkingSets: 0 },
    ]);
  });

  it("ATP-002: the DB rejects a negative minimumWorkingSets", async () => {
    const { seeded } = await athleteWithWorkout();
    await expect(db.update(plannedExercises).set({ minimumWorkingSets: -1 }).where(eq(plannedExercises.id, seeded.benchId))).rejects.toThrow();
  });

  it("ATP-011: the owner gets a preview of their own planned workout", async () => {
    const { athlete, seeded } = await athleteWithWorkout();
    const preview = await service.preview(athlete, seeded.workoutId, 60);
    expect(preview).toMatchObject({ policyVersion: "available-time/v1", plannedWorkoutId: seeded.workoutId, availableMinutes: 60 });
    expect(preview.exercises.map((e) => [e.plannedExerciseId, e.exerciseRef, e.displayName, e.priorityTier])).toEqual([
      [seeded.benchId, "bench-press", "Bench Press", "TIER_1"],
      [seeded.ohpId, "overhead-press", "Overhead Press", "TIER_2"],
    ]);
  });

  it("ATP-012: BOLA — another athlete gets the same 404 as a non-existent workout", async () => {
    const { athlete: owner, seeded } = await athleteWithWorkout();
    const other = await createTestAthlete(db);
    testUserIds.push(other.userId);

    await expect(service.preview(other, seeded.workoutId, 60)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.preview(owner, createEntityId(), 60)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.preview({ userId: other.userId }, seeded.workoutId, 60)).rejects.toBeInstanceOf(NotFoundException);
    // Proves the rejection above is ownership-based, not a query bug.
    await expect(service.preview(owner, seeded.workoutId, 60)).resolves.toMatchObject({ plannedWorkoutId: seeded.workoutId });
  });

  it.each(["ACTIVE", "COMPLETED"] as const)("ATP-014: a %s session for this occurrence -> 409 WORKOUT_ALREADY_STARTED (Resume wins)", async (status) => {
    const { athlete, seeded } = await athleteWithWorkout();
    await insertSession(db, athlete.userId, seeded.workoutId, status);
    const failure = service.preview(athlete, seeded.workoutId, 60);
    await expect(failure).rejects.toBeInstanceOf(ConflictException);
    await expect(failure).rejects.toThrow("WORKOUT_ALREADY_STARTED");
  });

  it("ATP-014b: another workout's session does not block this one", async () => {
    const { athlete, seeded } = await athleteWithWorkout();
    await insertSession(db, athlete.userId, createEntityId(), "ACTIVE");
    await expect(service.preview(athlete, seeded.workoutId, 60)).resolves.toMatchObject({ result: "NO_CHANGE" });
  });

  it("ATP-015: large-enough budget -> NO_CHANGE, nothing removed, adjusted == original (exactly 9 min fits)", async () => {
    const { athlete, seeded } = await athleteWithWorkout();
    const preview = await service.preview(athlete, seeded.workoutId, 9);
    expect(preview).toMatchObject({ result: "NO_CHANGE", fitsAvailableTime: true, originalEstimatedSeconds: 540, adjustedEstimatedSeconds: 540, minimumEstimatedSeconds: null });
    for (const exercise of preview.exercises) {
      expect(exercise.removedWorkingSetCount).toBe(0);
      expect(exercise.removedEntireExercise).toBe(false);
      expect(exercise.retainedTotalSetCount).toBe(exercise.originalTotalSetCount);
    }
  });

  it("ATP-016/018: smaller budget -> ADJUST_SESSION; TIER_2 (OHP) loses its last set before TIER_1 is touched", async () => {
    const { athlete, seeded } = await athleteWithWorkout();
    const preview = await service.preview(athlete, seeded.workoutId, 8);
    expect(preview).toMatchObject({ result: "ADJUST_SESSION", fitsAvailableTime: true, originalEstimatedSeconds: 540, adjustedEstimatedSeconds: 330 + 90 });
    const [benchSets, ohpSets] = seeded.setIds;
    expect(preview.exercises).toEqual([
      { plannedExerciseId: seeded.benchId, exerciseRef: "bench-press", displayName: "Bench Press", priorityTier: "TIER_1", originalWorkingSetCount: 3, retainedWorkingSetCount: 3, removedWorkingSetCount: 0, originalTotalSetCount: 3, retainedTotalSetCount: 3, minimumWorkingSets: 2, removedEntireExercise: false, retainedPlannedSetIds: benchSets, removedPlannedSetIds: [] },
      { plannedExerciseId: seeded.ohpId, exerciseRef: "overhead-press", displayName: "Overhead Press", priorityTier: "TIER_2", originalWorkingSetCount: 2, retainedWorkingSetCount: 1, removedWorkingSetCount: 1, originalTotalSetCount: 2, retainedTotalSetCount: 1, minimumWorkingSets: 0, removedEntireExercise: false, retainedPlannedSetIds: [ohpSets![0]], removedPlannedSetIds: [ohpSets![1]] },
    ]);
    expect(preview.sourceProgramVersionId).toBe(seeded.versionId);
  });

  it("ATP-019: minimumWorkingSets = 0 lets the whole exercise go (6 min)", async () => {
    const { athlete, seeded } = await athleteWithWorkout();
    const preview = await service.preview(athlete, seeded.workoutId, 6);
    expect(preview).toMatchObject({ result: "ADJUST_SESSION", adjustedEstimatedSeconds: 330 });
    expect(preview.exercises[0]).toMatchObject({ retainedWorkingSetCount: 3, removedEntireExercise: false });
    expect(preview.exercises[1]).toMatchObject({ retainedWorkingSetCount: 0, retainedTotalSetCount: 0, removedWorkingSetCount: 2, removedEntireExercise: true });
  });

  it("ATP-020: TIER_1 reduces only down to its minimum of 2 (5 min)", async () => {
    const { athlete, seeded } = await athleteWithWorkout();
    const preview = await service.preview(athlete, seeded.workoutId, 5);
    expect(preview).toMatchObject({ result: "ADJUST_SESSION", adjustedEstimatedSeconds: 210 });
    expect(preview.exercises[0]).toMatchObject({ retainedWorkingSetCount: 2, removedWorkingSetCount: 1, removedEntireExercise: false });
    expect(preview.exercises[1]).toMatchObject({ removedEntireExercise: true });
  });

  it("ATP-017/020: too-small budget -> CANNOT_FIT_MINIMUM; never pretends to fit, never goes below Bench's minimum (3 min)", async () => {
    const { athlete, seeded } = await athleteWithWorkout();
    const preview = await service.preview(athlete, seeded.workoutId, 3);
    expect(preview).toMatchObject({
      result: "CANNOT_FIT_MINIMUM",
      fitsAvailableTime: false,
      originalEstimatedSeconds: 540,
      adjustedEstimatedSeconds: 210,
      minimumEstimatedSeconds: 210,
    });
    expect(preview.adjustedEstimatedSeconds).toBeGreaterThan(3 * 60);
    expect(preview.exercises[0]).toMatchObject({ retainedWorkingSetCount: 2, minimumWorkingSets: 2, removedEntireExercise: false });
    expect(preview.exercises[1]).toMatchObject({ removedEntireExercise: true });
  });

  it("ATP-021: durations match available-time/v1 exactly at every budget from 1 to 10 minutes", async () => {
    const { athlete, seeded } = await athleteWithWorkout();
    const expected: Record<number, [string, number]> = {
      1: ["CANNOT_FIT_MINIMUM", 210],
      3: ["CANNOT_FIT_MINIMUM", 210],
      4: ["ADJUST_SESSION", 210],
      5: ["ADJUST_SESSION", 210],
      6: ["ADJUST_SESSION", 330],
      7: ["ADJUST_SESSION", 420],
      8: ["ADJUST_SESSION", 420],
      9: ["NO_CHANGE", 540],
      10: ["NO_CHANGE", 540],
    };
    for (const [minutes, [result, adjusted]] of Object.entries(expected)) {
      const preview = await service.preview(athlete, seeded.workoutId, Number(minutes));
      expect([minutes, preview.result, preview.adjustedEstimatedSeconds]).toEqual([minutes, result, adjusted]);
    }
  });

  it("ATP-022: a preview performs ZERO plan/workout/progression mutations", async () => {
    const { athlete, seeded } = await athleteWithWorkout();
    const before = await snapshotState(db, athlete, seeded);
    for (const minutes of [3, 6, 8, 60]) await service.preview(athlete, seeded.workoutId, minutes);
    expect(await snapshotState(db, athlete, seeded)).toEqual(before);
    expect(before.sessions).toEqual([]);
  });

  it("ATP-023/024: identical request -> identical result + fingerprint; a different budget -> a different fingerprint", async () => {
    const { athlete, seeded } = await athleteWithWorkout();
    const first = await service.preview(athlete, seeded.workoutId, 6);
    const second = await service.preview(athlete, seeded.workoutId, 6);
    expect(second).toEqual(first);
    expect(first.previewFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect((await service.preview(athlete, seeded.workoutId, 7)).previewFingerprint).not.toBe(first.previewFingerprint);
  });

  it("ATP-025: changing canonical structural input (rest, tier, minimum) changes the fingerprint", async () => {
    const { athlete, seeded } = await athleteWithWorkout();
    const original = (await service.preview(athlete, seeded.workoutId, 60)).previewFingerprint;

    await db.update(plannedSets).set({ restSeconds: 120 }).where(eq(plannedSets.plannedExerciseId, seeded.benchId));
    const afterRest = (await service.preview(athlete, seeded.workoutId, 60)).previewFingerprint;
    expect(afterRest).not.toBe(original);

    await db.update(plannedExercises).set({ priorityTier: "TIER_3" }).where(eq(plannedExercises.id, seeded.ohpId));
    const afterTier = (await service.preview(athlete, seeded.workoutId, 60)).previewFingerprint;
    expect(afterTier).not.toBe(afterRest);

    await db.update(plannedExercises).set({ minimumWorkingSets: 1 }).where(eq(plannedExercises.id, seeded.benchId));
    expect((await service.preview(athlete, seeded.workoutId, 60)).previewFingerprint).not.toBe(afterTier);
  });

  it("ATP-007: an exercise with no authored priorityTier (pre-migration row) fails closed with 422, never NO_CHANGE", async () => {
    const { athlete, seeded } = await athleteWithWorkout([BENCH, { ...OHP, priorityTier: null, minimumWorkingSets: null }]);
    const failure = service.preview(athlete, seeded.workoutId, 60);
    await expect(failure).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(failure).rejects.toThrow("AVAILABLE_TIME_PRIORITY_TIER_MISSING");
  });

  it("ATP-008: minimumWorkingSets above the authored WORKING set count fails closed with 422", async () => {
    const { athlete, seeded } = await athleteWithWorkout([{ ...BENCH, minimumWorkingSets: 4 }, OHP]);
    await expect(service.preview(athlete, seeded.workoutId, 60)).rejects.toThrow("AVAILABLE_TIME_STRUCTURE_INVALID");
  });

  it("ATP-009: a missing rest between sets fails closed with 422", async () => {
    const { athlete, seeded } = await athleteWithWorkout([{ ...BENCH, restSeconds: null }, OHP]);
    await expect(service.preview(athlete, seeded.workoutId, 60)).rejects.toThrow("AVAILABLE_TIME_REST_SECONDS_MISSING");
  });

  it("ATP-010: no exercise with minimumWorkingSets > 0 fails closed with 422", async () => {
    const { athlete, seeded } = await athleteWithWorkout([{ ...BENCH, minimumWorkingSets: 0 }, OHP]);
    await expect(service.preview(athlete, seeded.workoutId, 60)).rejects.toThrow("AVAILABLE_TIME_STRUCTURE_INVALID");
  });

  it("ATP-C01: exact retained/removed PlannedSet ids at every budget — canonical order, a partition, never disagreeing with the counts", async () => {
    const { athlete, seeded } = await athleteWithWorkout();
    const [benchSets, ohpSets] = seeded.setIds;
    const expected: Record<number, [readonly string[], readonly string[]]> = {
      9: [benchSets!, ohpSets!],
      8: [benchSets!, [ohpSets![0]!]],
      6: [benchSets!, []],
      5: [benchSets!.slice(0, 2), []],
      3: [benchSets!.slice(0, 2), []],
    };
    for (const [minutes, [benchRetained, ohpRetained]] of Object.entries(expected)) {
      const preview = await service.preview(athlete, seeded.workoutId, Number(minutes));
      const [bench, ohp] = preview.exercises;
      expect([minutes, bench!.retainedPlannedSetIds, ohp!.retainedPlannedSetIds]).toEqual([minutes, benchRetained, ohpRetained]);
      for (const [exercise, authored] of [[bench!, benchSets!], [ohp!, ohpSets!]] as const) {
        expect([...exercise.retainedPlannedSetIds, ...exercise.removedPlannedSetIds].sort()).toEqual([...authored].sort());
        expect(exercise.removedPlannedSetIds).toEqual(authored.filter((setId) => !exercise.retainedPlannedSetIds.includes(setId)));
        expect(exercise.retainedTotalSetCount).toBe(exercise.retainedPlannedSetIds.length);
        expect(exercise.originalTotalSetCount).toBe(authored.length);
        expect(exercise.removedEntireExercise).toBe(exercise.retainedPlannedSetIds.length === 0);
      }
    }
  });

  it("ATP-C02: repeated identical requests return identical id arrays (same order) and fingerprint", async () => {
    const { athlete, seeded } = await athleteWithWorkout();
    const first = await service.preview(athlete, seeded.workoutId, 5);
    const second = await service.preview(athlete, seeded.workoutId, 5);
    expect(second.exercises.map((e) => [e.retainedPlannedSetIds, e.removedPlannedSetIds])).toEqual(first.exercises.map((e) => [e.retainedPlannedSetIds, e.removedPlannedSetIds]));
    expect(second.previewFingerprint).toBe(first.previewFingerprint);
  });
});
