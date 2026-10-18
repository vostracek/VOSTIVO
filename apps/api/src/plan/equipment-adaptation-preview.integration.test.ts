import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { asc, eq, inArray, sql } from "drizzle-orm";
import {
  athleteProfiles,
  availableTimeApplications,
  createDatabaseClient,
  missedWorkoutScheduleApplications,
  missedWorkoutScheduleAssignments,
  plannedExercises,
  plannedSets,
  plannedWorkoutOccurrenceClaims,
  plannedWorkouts,
  programVersions,
  programs,
  progressionApplications,
  progressionDecisions,
  trainingBlocks,
  trainingCycles,
  users,
  workoutCommandReceipts,
  workoutSessions,
  type Database,
} from "@vostivo/database";
import type { EquipmentAdaptationPreviewRequestV1, EquipmentAdaptationPreviewResponseV1 } from "@vostivo/contracts";
import { createEntityId } from "@vostivo/domain";
import { fixedClock } from "../common/clock.js";
import type { AuthenticatedActor } from "../auth/authenticated-actor.js";
import { EquipmentAdaptationPreviewService } from "./equipment-adaptation-preview.service.js";
import { MissedWorkoutApplyService } from "./missed-workout-apply.service.js";
import { MissedWorkoutPreviewService } from "./missed-workout-preview.service.js";

/**
 * Temporary Equipment / Gym Adaptation V1 — Slice B, real Postgres
 * (`pnpm test:integration`). Explicit fixture dates + a fixed Clock only.
 *
 * Europe/Prague. cycle 0 (10-05..10-11): Mon A, Wed B, Fri C; cycle 1
 * (10-12..10-18): Mon D. Clock: Wednesday 2026-10-07 10:00 local.
 * Every workout: Bench Press + Barbell Row + Lat Pulldown (catalog refs).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://vostivo_api:vostivo_api@localhost:5432/vostivo_dev";
const WED = "2026-10-07T08:00:00Z";
const THU = "2026-10-08T08:00:00Z";
const CATALOG = "exercise-equipment-catalog/v1";
const EVERYTHING = ["adjustable-bench", "barbell", "barbell-rack", "cable-station", "dumbbells", "flat-bench", "hack-squat-machine", "lat-pulldown-station", "leg-curl-machine", "leg-press-machine"];
const NO_BARBELL = ["cable-station", "dumbbells", "flat-bench", "lat-pulldown-station"];

interface Athlete {
  readonly userId: string;
  readonly athleteProfileId: string;
  readonly actor: AuthenticatedActor;
}

const EXERCISES: readonly { ref: string | null; name: string }[] = [
  { ref: "bench-press", name: "Bench Press" },
  { ref: "barbell-row", name: "Barbell Row" },
  { ref: "lat-pulldown", name: "Lat Pulldown" },
];

describe("Equipment adaptation preview — server orchestration (real Postgres)", () => {
  const db: Database = createDatabaseClient(DATABASE_URL);
  const userIds: string[] = [];
  const at = (iso: string) => fixedClock(new Date(iso));
  const equipmentAt = (iso: string = WED) => new EquipmentAdaptationPreviewService(db, at(iso));

  async function athlete(trainingTimeZone: string | null = "Europe/Prague"): Promise<Athlete> {
    const userId = createEntityId();
    await db.insert(users).values({ id: userId, status: "ACTIVE" });
    const athleteProfileId = createEntityId();
    await db.insert(athleteProfiles).values({ id: athleteProfileId, userId, experienceMode: "GUIDED", unitSystem: "METRIC", trainingTimeZone });
    userIds.push(userId);
    return { userId, athleteProfileId, actor: { userId, athleteProfileId } };
  }

  /** The locked week; `exercises` overrides B's exercises (others always get EXERCISES). */
  async function seed(a: Athlete, options: { exercisesOfB?: readonly { ref: string | null; name: string }[]; bStatus?: "PLANNED" | "SKIPPED"; laterBlock?: boolean } = {}) {
    const programId = createEntityId();
    await db.insert(programs).values({ id: programId, athleteProfileId: a.athleteProfileId, name: "Program", status: "ACTIVE" });
    const versionId = createEntityId();
    await db.insert(programVersions).values({ id: versionId, programId, versionNumber: 1, status: "ACTIVE", activatedAt: new Date("2026-09-01T00:00:00Z") });
    const blockId = createEntityId();
    await db.insert(trainingBlocks).values({ id: blockId, programVersionId: versionId, name: "Block 1", goal: "Hypertrophy", orderIndex: 0, cycleCount: 2, focusAreas: [] });
    const cycles = [createEntityId(), createEntityId()];
    await db.insert(trainingCycles).values([
      { id: cycles[0]!, trainingBlockId: blockId, orderIndex: 0, startDate: "2026-10-05", endDate: "2026-10-11" },
      { id: cycles[1]!, trainingBlockId: blockId, orderIndex: 1, startDate: "2026-10-12", endDate: "2026-10-18" },
    ]);
    const workouts: { key: string; cycle: string; order: number; date: string }[] = [
      { key: "A", cycle: cycles[0]!, order: 0, date: "2026-10-05" },
      { key: "B", cycle: cycles[0]!, order: 1, date: "2026-10-07" },
      { key: "C", cycle: cycles[0]!, order: 2, date: "2026-10-09" },
      { key: "D", cycle: cycles[1]!, order: 0, date: "2026-10-12" },
    ];
    if (options.laterBlock === true) {
      const laterBlockId = createEntityId();
      await db.insert(trainingBlocks).values({ id: laterBlockId, programVersionId: versionId, name: "Block 2", goal: "Strength", orderIndex: 1, cycleCount: 1, focusAreas: [] });
      const laterCycle = createEntityId();
      await db.insert(trainingCycles).values({ id: laterCycle, trainingBlockId: laterBlockId, orderIndex: 0, startDate: "2026-10-26", endDate: "2026-11-01" });
      // Mis-authored on purpose: a later-block workout dated today must still not be today's workout.
      workouts.push({ key: "L", cycle: laterCycle, order: 0, date: "2026-10-07" });
    }
    const ids: Record<string, string> = {};
    const setIds: Record<string, string[]> = {};
    for (const w of workouts) {
      const id = createEntityId();
      ids[w.key] = id;
      await db.insert(plannedWorkouts).values({ id, trainingCycleId: w.cycle, name: `Workout ${w.key}`, orderIndex: w.order, scheduledDate: w.date, status: w.key === "B" ? (options.bStatus ?? "PLANNED") : "PLANNED" });
      const exercises = w.key === "B" && options.exercisesOfB !== undefined ? options.exercisesOfB : EXERCISES;
      for (const [index, spec] of exercises.entries()) {
        const exerciseId = createEntityId();
        await db.insert(plannedExercises).values({ id: exerciseId, plannedWorkoutId: id, exerciseRef: spec.ref, displayName: spec.name, orderIndex: index + 1, priorityTier: "TIER_1", minimumWorkingSets: 1 });
        for (let order = 1; order <= 2; order++) {
          const setId = createEntityId();
          (setIds[`${w.key}${index}`] ??= []).push(setId);
          await db.insert(plannedSets).values({ id: setId, plannedExerciseId: exerciseId, orderIndex: order, targetRepsMin: 8, targetRepsMax: 12, restSeconds: 90, setType: "WORKING", loadKind: "EXTERNAL_WEIGHT", loadAmountMilli: 60000, loadUnit: "KG", loadBasis: "TOTAL" });
        }
      }
    }
    return { ids, setIds, versionId, blockId };
  }

  async function startCanonical(a: Athlete, plannedWorkoutId: string, status: "ACTIVE" | "COMPLETED"): Promise<void> {
    const sessionId = createEntityId();
    await db.insert(workoutSessions).values({ id: sessionId, userId: a.userId, prescriptionSnapshot: { schemaVersion: 1, prescriptionId: plannedWorkoutId, name: "Session", exercises: [] }, startedAt: new Date(), status, completedAt: status === "COMPLETED" ? new Date() : null });
    await db.insert(plannedWorkoutOccurrenceClaims).values({ id: createEntityId(), userId: a.userId, plannedWorkoutId, canonicalWorkoutSessionId: sessionId });
  }

  const request = (plannedWorkoutId: string, availableEquipmentIds: string[] = NO_BARBELL, catalogVersion = CATALOG): EquipmentAdaptationPreviewRequestV1 => ({ plannedWorkoutId, catalogVersion, availableEquipmentIds });

  async function rejection(promise: Promise<unknown>): Promise<Error & { getResponse(): unknown }> {
    const error = await promise.then(() => undefined, (e: unknown) => e);
    if (error === undefined) throw new Error("expected a rejection");
    return error as Error & { getResponse(): unknown };
  }

  /** Every row a preview could conceivably touch. */
  async function snapshot(a: Athlete) {
    const programRows = await db.select().from(programs).where(eq(programs.athleteProfileId, a.athleteProfileId)).orderBy(asc(programs.id));
    const versionRows = await db.select().from(programVersions).where(inArray(programVersions.programId, programRows.map((p) => p.id))).orderBy(asc(programVersions.id));
    const blockRows = await db.select().from(trainingBlocks).where(inArray(trainingBlocks.programVersionId, versionRows.map((v) => v.id))).orderBy(asc(trainingBlocks.id));
    const cycleRows = await db.select().from(trainingCycles).where(inArray(trainingCycles.trainingBlockId, blockRows.map((b) => b.id))).orderBy(asc(trainingCycles.id));
    const workoutRows = await db.select().from(plannedWorkouts).where(inArray(plannedWorkouts.trainingCycleId, cycleRows.map((c) => c.id))).orderBy(asc(plannedWorkouts.id));
    const exerciseRows = await db.select().from(plannedExercises).where(inArray(plannedExercises.plannedWorkoutId, workoutRows.map((w) => w.id))).orderBy(asc(plannedExercises.id));
    const jobs = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM pgboss.job WHERE data::text LIKE ${`%${a.userId}%`}`);
    return {
      programRows, versionRows, blockRows, cycleRows, workoutRows, exerciseRows,
      sets: await db.select().from(plannedSets).where(inArray(plannedSets.plannedExerciseId, exerciseRows.map((e) => e.id))).orderBy(asc(plannedSets.id)),
      sessions: await db.select().from(workoutSessions).where(eq(workoutSessions.userId, a.userId)).orderBy(asc(workoutSessions.id)),
      claims: await db.select().from(plannedWorkoutOccurrenceClaims).where(eq(plannedWorkoutOccurrenceClaims.userId, a.userId)).orderBy(asc(plannedWorkoutOccurrenceClaims.id)),
      receipts: await db.select().from(workoutCommandReceipts).where(eq(workoutCommandReceipts.userId, a.userId)),
      missedApplications: await db.select().from(missedWorkoutScheduleApplications).where(eq(missedWorkoutScheduleApplications.athleteProfileId, a.athleteProfileId)),
      availableTime: await db.select().from(availableTimeApplications).where(eq(availableTimeApplications.userId, a.userId)),
      decisions: await db.select().from(progressionDecisions).where(eq(progressionDecisions.userId, a.userId)),
      progressionApps: await db.select().from(progressionApplications).where(eq(progressionApplications.userId, a.userId)),
      jobs: jobs[0]?.n,
    };
  }

  function adjusted(preview: EquipmentAdaptationPreviewResponseV1) {
    if (preview.result !== "ADJUST_SESSION") throw new Error(`expected ADJUST_SESSION, got ${preview.result} ${preview.reasonCode}`);
    return preview;
  }

  afterAll(async () => {
    await cleanup(db, userIds);
  });

  beforeEach(async () => {
    await cleanup(db, userIds);
    userIds.length = 0;
  });

  it("EQP-023: the athlete previews their own Today workout: barbell out -> DB bench + seated cable row; lat pulldown untouched", async () => {
    const a = await athlete();
    const { ids } = await seed(a);
    const preview = adjusted(await equipmentAt().preview(a.actor, request(ids.B!)));
    expect(preview).toMatchObject({ schemaVersion: "equipment-adaptation-preview/v1", policyVersion: "equipment-adaptation/v1", catalogVersion: CATALOG, athleteLocalDate: "2026-10-07", plannedWorkoutId: ids.B, workoutName: "Workout B", availableEquipmentIds: [...NO_BARBELL].sort() });
    expect(preview.replacements.map((r) => [r.order, r.authoredExerciseRef, r.authoredExerciseName, r.substituteExerciseRef, r.substituteExerciseName])).toEqual([
      [1, "bench-press", "Bench Press", "dumbbell-bench-press", "Dumbbell Bench Press"],
      [2, "barbell-row", "Barbell Row", "seated-cable-row", "Seated Cable Row"],
    ]);
    expect(JSON.stringify(preview)).not.toMatch(/amountMilli|"KG"|targetLoad/);
    expect(await equipmentAt().preview(a.actor, request(ids.B!, EVERYTHING))).toMatchObject({ result: "NO_CHANGE", replacements: [] });
  });

  it("EQP-024/045: a foreign plannedWorkoutId is the same 404 as a missing one and reveals nothing", async () => {
    const owner = await athlete();
    const { ids } = await seed(owner);
    const intruder = await athlete();
    await seed(intruder);
    for (const target of [ids.B!, createEntityId()]) {
      const error = await rejection(equipmentAt().preview(intruder.actor, request(target)));
      expect(error).toBeInstanceOf(NotFoundException);
      expect(JSON.stringify(error.getResponse())).not.toMatch(/Workout B|Bench|bench-press|dumbbell/);
    }
    await expect(equipmentAt().preview({ userId: intruder.userId, athleteProfileId: owner.athleteProfileId }, request(ids.B!))).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([
    ["EQP-025 a future workout", "C"],
    ["EQP-026 a past unresolved workout that was not moved", "A"],
  ])("%s -> 409 EQUIPMENT_ADAPTATION_NOT_APPLICABLE NOT_TODAYS_WORKOUT", async (_label, key) => {
    const a = await athlete();
    const { ids } = await seed(a);
    expect((await rejection(equipmentAt().preview(a.actor, request(ids[key]!)))).getResponse()).toEqual({ statusCode: 409, message: "EQUIPMENT_ADAPTATION_NOT_APPLICABLE", reasonCode: "NOT_TODAYS_WORKOUT" });
  });

  it("EQP-027/028/029/043: after a missed-workout Apply, the rolled-forward A (authored Monday) IS today's, same id; B and the carryover D are not", async () => {
    const a = await athlete();
    const { ids } = await seed(a);
    const beforeB = await equipmentAt().preview(a.actor, request(ids.B!));
    const missed = await new MissedWorkoutPreviewService(db, at(WED)).preview(a.actor);
    if (missed.result !== "ROLL_FORWARD") throw new Error("expected ROLL_FORWARD");
    await new MissedWorkoutApplyService(db, at(WED)).apply(a.actor, missed.previewFingerprint);

    const movedA = adjusted(await equipmentAt().preview(a.actor, request(ids.A!)));
    expect(movedA.plannedWorkoutId).toBe(ids.A);
    expect(movedA.replacements).toHaveLength(2);
    // The effective-Today assignment changed: B's earlier preview can never be applied now.
    expect(beforeB.previewFingerprint).not.toBe(movedA.previewFingerprint);
    for (const key of ["B", "D"]) {
      expect((await rejection(equipmentAt().preview(a.actor, request(ids[key]!)))).getResponse(), key).toMatchObject({ message: "EQUIPMENT_ADAPTATION_NOT_APPLICABLE", reasonCode: "NOT_TODAYS_WORKOUT" });
    }
    // The overlay itself is untouched by the preview.
    expect((await db.select().from(missedWorkoutScheduleApplications).where(eq(missedWorkoutScheduleApplications.athleteProfileId, a.athleteProfileId))).map((r) => r.status)).toEqual(["ACTIVE"]);
  });

  it("EQP-030/031: no training time zone -> 409 TRAINING_TIME_ZONE_REQUIRED (never the legacy UTC date)", async () => {
    const a = await athlete(null);
    const { ids } = await seed(a);
    const error = await rejection(equipmentAt().preview(a.actor, request(ids.B!)));
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.message).toBe("TRAINING_TIME_ZONE_REQUIRED");
  });

  it.each([["ACTIVE"], ["COMPLETED"]] as const)("EQP-032/033: an already %s canonical occurrence -> NOT_APPLICABLE WORKOUT_ALREADY_STARTED", async (status) => {
    const a = await athlete();
    const { ids } = await seed(a);
    await startCanonical(a, ids.B!, status);
    expect((await rejection(equipmentAt().preview(a.actor, request(ids.B!)))).getResponse()).toMatchObject({ reasonCode: "WORKOUT_ALREADY_STARTED" });
  });

  it("a resolved (SKIPPED) workout and a workout outside the current block are not applicable", async () => {
    const skipped = await athlete();
    const s = await seed(skipped, { bStatus: "SKIPPED" });
    expect((await rejection(equipmentAt().preview(skipped.actor, request(s.ids.B!)))).getResponse()).toMatchObject({ reasonCode: "WORKOUT_RESOLVED" });
    const later = await athlete();
    const l = await seed(later, { laterBlock: true });
    expect((await rejection(equipmentAt().preview(later.actor, request(l.ids.L!)))).getResponse()).toMatchObject({ reasonCode: "OUTSIDE_CURRENT_BLOCK" });
  });

  it("catalog version mismatch -> 409 EQUIPMENT_CATALOG_VERSION_MISMATCH; an unknown equipment id -> 400 UNKNOWN_EQUIPMENT_ID", async () => {
    const a = await athlete();
    const { ids } = await seed(a);
    expect((await rejection(equipmentAt().preview(a.actor, request(ids.B!, NO_BARBELL, "exercise-equipment-catalog/v2")))).message).toBe("EQUIPMENT_CATALOG_VERSION_MISMATCH");
    const unknown = await rejection(equipmentAt().preview(a.actor, request(ids.B!, ["dumbbells", "kettlebell"])));
    expect(unknown).toBeInstanceOf(BadRequestException);
    expect(unknown.getResponse()).toEqual({ statusCode: 400, message: "UNKNOWN_EQUIPMENT_ID", unknownEquipmentIds: ["kettlebell"] });
  });

  it("a null / unknown exerciseRef in the real workout -> REVIEW_REQUIRED UNSUPPORTED_EXERCISE_IDENTITY, no partial adjustment", async () => {
    const a = await athlete();
    const { ids } = await seed(a, { exercisesOfB: [{ ref: "bench-press", name: "Bench Press" }, { ref: null, name: "Freeform Press" }, { ref: "mystery-move", name: "Mystery" }] });
    expect(await equipmentAt().preview(a.actor, request(ids.B!))).toMatchObject({
      result: "REVIEW_REQUIRED",
      reasonCode: "UNSUPPORTED_EXERCISE_IDENTITY",
      unresolved: [
        { order: 2, authoredExerciseRef: null, authoredExerciseName: "Freeform Press", reasonCode: "UNSUPPORTED_EXERCISE_IDENTITY" },
        { order: 3, authoredExerciseRef: "mystery-move", authoredExerciseName: "Mystery", reasonCode: "UNSUPPORTED_EXERCISE_IDENTITY" },
      ],
    });
  });

  it("EQP-034..040: every outcome (ADJUST, NO_CHANGE, REVIEW, not applicable, errors) is read-only; repeated previews are identical", async () => {
    const a = await athlete();
    const { ids } = await seed(a);
    const before = await snapshot(a);
    const first = await equipmentAt().preview(a.actor, request(ids.B!));
    await equipmentAt().preview(a.actor, request(ids.B!, EVERYTHING));
    await equipmentAt().preview(a.actor, request(ids.B!, []));
    await equipmentAt().preview(a.actor, request(ids.C!)).catch(() => undefined);
    await equipmentAt().preview(a.actor, request(ids.B!, ["kettlebell"])).catch(() => undefined);
    const second = await equipmentAt().preview(a.actor, request(ids.B!, [...NO_BARBELL].reverse()));
    expect(second).toEqual(first);
    expect(await snapshot(a)).toEqual(before);
  });

  it("EQP-041/042: the fingerprint changes with the inventory and with the authored prescription", async () => {
    const a = await athlete();
    const { ids, setIds } = await seed(a);
    const base = (await equipmentAt().preview(a.actor, request(ids.B!))).previewFingerprint;
    expect((await equipmentAt().preview(a.actor, request(ids.B!, [...NO_BARBELL, "adjustable-bench"]))).previewFingerprint).not.toBe(base);
    await db.update(plannedSets).set({ restSeconds: 120 }).where(eq(plannedSets.id, setIds.B0![0]!));
    expect((await equipmentAt().preview(a.actor, request(ids.B!))).previewFingerprint).not.toBe(base);
  });

  it("EQP-044: the next athlete-local day the same workout is no longer today's — the earlier preview is stale", async () => {
    const a = await athlete();
    const { ids } = await seed(a);
    await equipmentAt(WED).preview(a.actor, request(ids.B!));
    expect((await rejection(equipmentAt(THU).preview(a.actor, request(ids.B!)))).getResponse()).toMatchObject({ reasonCode: "NOT_TODAYS_WORKOUT" });
  });
});

async function cleanup(db: Database, userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  const ids = [...userIds];
  const profileIds = (await db.select({ id: athleteProfiles.id }).from(athleteProfiles).where(inArray(athleteProfiles.userId, ids))).map((r) => r.id);
  if (profileIds.length > 0) {
    const applicationIds = (await db.select({ id: missedWorkoutScheduleApplications.id }).from(missedWorkoutScheduleApplications).where(inArray(missedWorkoutScheduleApplications.athleteProfileId, profileIds))).map((r) => r.id);
    if (applicationIds.length > 0) {
      await db.delete(missedWorkoutScheduleAssignments).where(inArray(missedWorkoutScheduleAssignments.applicationId, applicationIds));
      await db.update(missedWorkoutScheduleApplications).set({ supersedesApplicationId: null }).where(inArray(missedWorkoutScheduleApplications.id, applicationIds));
      await db.delete(missedWorkoutScheduleApplications).where(inArray(missedWorkoutScheduleApplications.id, applicationIds));
    }
  }
  await db.delete(plannedWorkoutOccurrenceClaims).where(inArray(plannedWorkoutOccurrenceClaims.userId, ids));
  await db.delete(workoutSessions).where(inArray(workoutSessions.userId, ids));
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
  await db.delete(users).where(inArray(users.id, ids));
}
