import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { asc, eq, inArray } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import {
  athleteProfiles,
  availableTimeApplications,
  createDatabaseClient,
  equipmentAdaptationApplications,
  missedWorkoutScheduleApplications,
  missedWorkoutScheduleAssignments,
  performedExercises,
  performedSets,
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
  workoutChangeCursor,
  workoutCommandReceipts,
  workoutSessions,
  type Database,
} from "@vostivo/database";
import { availableTimeApplicationFromPreview, type CompleteSetCommandV1, type EquipmentAdaptationApplyRequestV1, type StartWorkoutSessionCommandV1 } from "@vostivo/contracts";
import { createEntityId, selectAvailableTimePrescription, type AvailableTimeApplicationV1, type WorkoutPrescriptionV1 } from "@vostivo/domain";
import { ensureProgressionEvaluateSessionQueues, ProgressionEvaluationService, WorkoutHistoryService } from "@vostivo/progression-application";
import { fixedClock } from "../common/clock.js";
import type { AuthenticatedActor } from "../auth/authenticated-actor.js";
import { processWorkoutCommand } from "../workout/workout-command-processing.js";
import { AvailableTimePreviewService } from "./available-time-preview.service.js";
import { EquipmentAdaptationApplyService } from "./equipment-adaptation-apply.service.js";
import { EquipmentAdaptationPreviewService } from "./equipment-adaptation-preview.service.js";
import { EquipmentAdaptationOptionsService } from "./equipment-adaptation-options.service.js";
import { MissedWorkoutApplyService } from "./missed-workout-apply.service.js";
import { MissedWorkoutPreviewService } from "./missed-workout-preview.service.js";
import { PlanReadService } from "./plan-read.service.js";

/**
 * Temporary Equipment / Gym Adaptation V1 — Slice C, real Postgres
 * (`pnpm test:integration`): durable TODAY_ONLY apply -> effective Workout
 * Preview -> local-first START (built exactly like mobile: snapshot of the
 * server Workout Preview prescription) -> verification/consumption ->
 * history and progression safety. Fixed clocks only.
 *
 * Europe/Prague. cycle 0 (10-05..10-11): Mon A, Wed B, Fri C; cycle 1: Mon D.
 * Clock: Wednesday 2026-10-07 10:00 local. Every workout: Bench Press +
 * Barbell Row + Lat Pulldown, 2 WORKING sets each, 60 kg, TIER_1/min 1.
 * Without a barbell: bench -> Dumbbell Bench Press, row -> Seated Cable Row.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://vostivo_api:vostivo_api@localhost:5432/vostivo_dev";
const WED = "2026-10-07T08:00:00Z";
const THU = "2026-10-08T08:00:00Z";
const CATALOG = "exercise-equipment-catalog/v1";
const EVERYTHING = ["adjustable-bench", "barbell", "barbell-rack", "cable-station", "dumbbells", "flat-bench", "hack-squat-machine", "lat-pulldown-station", "leg-curl-machine", "leg-press-machine"];
const NO_BARBELL = ["cable-station", "dumbbells", "flat-bench", "lat-pulldown-station"];

/** Workout B (bench, row, pulldown): planned requirements, then curated substitutes' extra equipment — catalog order, canonical labels. */
const EXPECTED_OPTIONS = [
  { equipmentId: "barbell", displayLabel: "Barbell (with plates)", relevance: "PLANNED" },
  { equipmentId: "barbell-rack", displayLabel: "Barbell rack / uprights", relevance: "PLANNED" },
  { equipmentId: "flat-bench", displayLabel: "Flat bench", relevance: "PLANNED" },
  { equipmentId: "lat-pulldown-station", displayLabel: "Lat pulldown station", relevance: "PLANNED" },
  { equipmentId: "adjustable-bench", displayLabel: "Adjustable (incline) bench", relevance: "SUBSTITUTE" },
  { equipmentId: "dumbbells", displayLabel: "Dumbbells", relevance: "SUBSTITUTE" },
  { equipmentId: "cable-station", displayLabel: "Cable station (adjustable pulley)", relevance: "SUBSTITUTE" },
];

interface Athlete {
  readonly userId: string;
  readonly athleteProfileId: string;
  readonly actor: AuthenticatedActor;
}

const EXERCISES = [
  { ref: "bench-press", name: "Bench Press" },
  { ref: "barbell-row", name: "Barbell Row" },
  { ref: "lat-pulldown", name: "Lat Pulldown" },
] as const;

describe("Equipment adaptation apply + START — Slice C (real Postgres)", () => {
  const db: Database = createDatabaseClient(DATABASE_URL);
  let boss: PgBoss;
  const userIds: string[] = [];
  const at = (iso: string) => fixedClock(new Date(iso));
  const previewAt = (iso: string = WED) => new EquipmentAdaptationPreviewService(db, at(iso));
  const applyAt = (iso: string = WED) => new EquipmentAdaptationApplyService(db, at(iso));
  const planAt = (iso: string = WED) => new PlanReadService(db, at(iso));

  beforeAll(async () => {
    boss = new PgBoss({ connectionString: DATABASE_URL, migrate: false, supervise: false, schedule: false });
    await boss.start();
    await ensureProgressionEvaluateSessionQueues(boss);
  });

  afterAll(async () => {
    await cleanup(db, userIds);
    await boss.stop();
  });

  beforeEach(async () => {
    await cleanup(db, userIds);
    userIds.length = 0;
  });

  async function athlete(): Promise<Athlete> {
    const userId = createEntityId();
    await db.insert(users).values({ id: userId, status: "ACTIVE" });
    const athleteProfileId = createEntityId();
    await db.insert(athleteProfiles).values({ id: athleteProfileId, userId, experienceMode: "ADAPTIVE", unitSystem: "METRIC", trainingTimeZone: "Europe/Prague" });
    userIds.push(userId);
    return { userId, athleteProfileId, actor: { userId, athleteProfileId } };
  }

  async function seed(a: Athlete) {
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
    const workouts = [
      { key: "A", cycle: cycles[0]!, order: 0, date: "2026-10-05" },
      { key: "B", cycle: cycles[0]!, order: 1, date: "2026-10-07" },
      { key: "C", cycle: cycles[0]!, order: 2, date: "2026-10-09" },
      { key: "D", cycle: cycles[1]!, order: 0, date: "2026-10-12" },
    ];
    const ids: Record<string, string> = {};
    const exerciseIds: Record<string, string[]> = {};
    const setIds: Record<string, string[]> = {};
    for (const w of workouts) {
      const id = createEntityId();
      ids[w.key] = id;
      await db.insert(plannedWorkouts).values({ id, trainingCycleId: w.cycle, name: `Workout ${w.key}`, orderIndex: w.order, scheduledDate: w.date, estimatedDurationMinutes: 45, status: "PLANNED" });
      for (const [index, spec] of EXERCISES.entries()) {
        const exerciseId = createEntityId();
        (exerciseIds[w.key] ??= []).push(exerciseId);
        await db.insert(plannedExercises).values({ id: exerciseId, plannedWorkoutId: id, exerciseRef: spec.ref, displayName: spec.name, orderIndex: index + 1, priorityTier: "TIER_1", minimumWorkingSets: 1 });
        for (let order = 1; order <= 2; order++) {
          const setId = createEntityId();
          (setIds[`${w.key}${index}`] ??= []).push(setId);
          await db.insert(plannedSets).values({ id: setId, plannedExerciseId: exerciseId, orderIndex: order, targetRepsMin: 8, targetRepsMax: 12, restSeconds: 90, setType: "WORKING", loadKind: "EXTERNAL_WEIGHT", loadAmountMilli: 60000, loadUnit: "KG", loadBasis: "TOTAL" });
        }
      }
    }
    return { ids, exerciseIds, setIds, versionId, blockId, programId };
  }

  /** The athlete's real flow: server preview -> explicit apply of exactly that preview. */
  async function previewAndApply(a: Athlete, plannedWorkoutId: string, inventory: readonly string[] = NO_BARBELL, iso: string = WED) {
    const preview = await previewAt(iso).preview(a.actor, { plannedWorkoutId, catalogVersion: CATALOG, availableEquipmentIds: [...inventory] });
    return applyAt(iso).apply(a.actor, applyRequest(plannedWorkoutId, preview.previewFingerprint, inventory));
  }

  const applyRequest = (plannedWorkoutId: string, previewFingerprint: string, inventory: readonly string[] = NO_BARBELL, catalogVersion = CATALOG): EquipmentAdaptationApplyRequestV1 => ({ plannedWorkoutId, previewFingerprint, catalogVersion, availableEquipmentIds: [...inventory] });

  async function rejection(promise: Promise<unknown>): Promise<Error & { getResponse(): unknown }> {
    const error = await promise.then(() => undefined, (e: unknown) => e);
    if (error === undefined) throw new Error("expected a rejection");
    return error as Error & { getResponse(): unknown };
  }

  const applications = (a: Athlete) => db.select().from(equipmentAdaptationApplications).where(eq(equipmentAdaptationApplications.userId, a.userId)).orderBy(asc(equipmentAdaptationApplications.appliedAt), asc(equipmentAdaptationApplications.createdAt));

  /** Exactly mobile's local-first START: snapshot the server Workout Preview prescription. */
  async function effectivePrescription(a: Athlete, plannedWorkoutId: string, iso: string = WED): Promise<WorkoutPrescriptionV1> {
    return (await planAt(iso).getWorkoutPreview(a.actor, plannedWorkoutId))!.prescription;
  }

  /** Every command runs with a FIXED server `now` (default Wednesday) — never the real clock. */
  const run = (userId: string, command: Parameters<typeof processWorkoutCommand>[3], now: string = WED) => processWorkoutCommand(db, boss, userId, command, new Date(now));

  const activeApplications = async (a: Athlete) => (await applications(a)).filter((r) => r.status === "ACTIVE");

  function startCommand(prescription: WorkoutPrescriptionV1, startedAt: string = WED, availableTimeApplication?: AvailableTimeApplicationV1): StartWorkoutSessionCommandV1 {
    return {
      commandId: createEntityId(),
      type: "START_WORKOUT_SESSION_V1",
      schemaVersion: 1,
      createdAt: startedAt,
      workoutSessionId: createEntityId(),
      prescription,
      startedAt,
      ...(availableTimeApplication === undefined ? {} : { availableTimeApplication }),
    };
  }

  async function authoredState(seeded: Awaited<ReturnType<typeof seed>>) {
    const workoutIds = Object.values(seeded.ids);
    const exerciseRows = await db.select().from(plannedExercises).where(inArray(plannedExercises.plannedWorkoutId, workoutIds)).orderBy(asc(plannedExercises.id));
    return {
      versions: await db.select().from(programVersions).where(eq(programVersions.programId, seeded.programId)),
      workouts: await db.select().from(plannedWorkouts).where(inArray(plannedWorkouts.id, workoutIds)).orderBy(asc(plannedWorkouts.id)),
      exercises: exerciseRows,
      sets: await db.select().from(plannedSets).where(inArray(plannedSets.plannedExerciseId, exerciseRows.map((e) => e.id))).orderBy(asc(plannedSets.id)),
    };
  }

  // ---------------------------------------------------------------- apply

  it("EQC-01: apply persists ONLY server-derived data, returns a compact response, and never touches the authored plan", async () => {
    const a = await athlete();
    const seeded = await seed(a);
    const before = await authoredState(seeded);
    const response = await previewAndApply(a, seeded.ids.B!);

    expect(response).toMatchObject({ scope: "TODAY_ONLY", plannedWorkoutId: seeded.ids.B, athleteLocalDate: "2026-10-07", status: "ACTIVE", result: "ADJUST_SESSION" });
    expect(response.replacements).toEqual([
      { plannedExerciseId: seeded.exerciseIds.B![0], order: 1, authoredExerciseRef: "bench-press", substituteExerciseRef: "dumbbell-bench-press", substituteExerciseName: "Dumbbell Bench Press" },
      { plannedExerciseId: seeded.exerciseIds.B![1], order: 2, authoredExerciseRef: "barbell-row", substituteExerciseRef: "seated-cable-row", substituteExerciseName: "Seated Cable Row" },
    ]);
    expect(JSON.stringify(response)).not.toMatch(/amountMilli|targetLoad|candidates/);

    const rows = await applications(a);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: response.applicationId,
      athleteProfileId: a.athleteProfileId,
      programVersionId: seeded.versionId,
      trainingBlockId: seeded.blockId,
      trainingTimeZone: "Europe/Prague",
      policyVersion: "equipment-adaptation/v1",
      catalogVersion: CATALOG,
      availableEquipmentIds: [...NO_BARBELL].sort(),
      status: "ACTIVE",
      supersedesApplicationId: null,
      consumedByWorkoutSessionId: null,
      appliedByUserId: a.userId,
    });
    expect(rows[0]!.appliedAt.toISOString()).toBe(WED.replace("Z", ".000Z"));
    expect(await authoredState(seeded)).toEqual(before);
  });

  it("EQC-02: a retried apply (same preview) returns the SAME application; concurrent identical applies converge on one row", async () => {
    const a = await athlete();
    const { ids } = await seed(a);
    const preview = await previewAt().preview(a.actor, { plannedWorkoutId: ids.B!, catalogVersion: CATALOG, availableEquipmentIds: NO_BARBELL });
    const results = await Promise.all(Array.from({ length: 5 }, () => applyAt().apply(a.actor, applyRequest(ids.B!, preview.previewFingerprint))));
    expect(new Set(results.map((r) => r.applicationId)).size).toBe(1);
    const retry = await applyAt().apply(a.actor, applyRequest(ids.B!, preview.previewFingerprint, [...NO_BARBELL].reverse()));
    expect(retry).toEqual(results[0]);
    expect(await applications(a)).toHaveLength(1);
  });

  it("EQC-03: a new inventory SUPERSEDES the unconsumed application; applying NO_CHANGE clears it (auditable chain, one ACTIVE)", async () => {
    const a = await athlete();
    const { ids } = await seed(a);
    const first = await previewAndApply(a, ids.B!);
    const second = await previewAndApply(a, ids.B!, [...NO_BARBELL, "adjustable-bench"]);
    expect(second).toMatchObject({ result: "ADJUST_SESSION", status: "ACTIVE" });
    expect(second.previewFingerprint).not.toBe(first.previewFingerprint);
    const cleared = await previewAndApply(a, ids.B!, EVERYTHING);
    expect(cleared).toMatchObject({ result: "NO_CHANGE", replacements: [], status: "ACTIVE" });

    const rows = await applications(a);
    expect(rows.map((r) => [r.id, r.status, r.supersedesApplicationId])).toEqual([
      [first.applicationId, "SUPERSEDED", null],
      [second.applicationId, "SUPERSEDED", first.applicationId],
      [cleared.applicationId, "ACTIVE", second.applicationId],
    ]);
    expect(rows.slice(0, 2).every((r) => r.supersededAt !== null)).toBe(true);
    // Cleared -> the Workout Preview is the authored workout again.
    expect((await effectivePrescription(a, ids.B!)).exercises.map((e) => e.exerciseRef)).toEqual(["bench-press", "barbell-row", "lat-pulldown"]);
    // Re-applying the superseded first preview is a NEW application (never resurrects the old row).
    const again = await previewAndApply(a, ids.B!);
    expect(again.applicationId).not.toBe(first.applicationId);
  });

  it("EQC-04: REVIEW_REQUIRED is never applicable -> 409 EQUIPMENT_ADAPTATION_REVIEW_REQUIRED (+reasonCode), nothing persisted", async () => {
    const a = await athlete();
    const { ids } = await seed(a);
    const preview = await previewAt().preview(a.actor, { plannedWorkoutId: ids.B!, catalogVersion: CATALOG, availableEquipmentIds: [] });
    expect(preview.result).toBe("REVIEW_REQUIRED");
    const error = await rejection(applyAt().apply(a.actor, applyRequest(ids.B!, preview.previewFingerprint, [])));
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({ statusCode: 409, message: "EQUIPMENT_ADAPTATION_REVIEW_REQUIRED", reasonCode: preview.result === "REVIEW_REQUIRED" ? preview.reasonCode : "" });
    expect(await applications(a)).toHaveLength(0);
  });

  it("EQC-05: staleness — a changed inventory, a changed authored prescription, a fabricated fingerprint, another day -> nothing applied", async () => {
    const a = await athlete();
    const { ids, setIds } = await seed(a);
    const preview = await previewAt().preview(a.actor, { plannedWorkoutId: ids.B!, catalogVersion: CATALOG, availableEquipmentIds: NO_BARBELL });
    const stale = { statusCode: 409, message: "EQUIPMENT_PREVIEW_STALE" };

    expect((await rejection(applyAt().apply(a.actor, applyRequest(ids.B!, preview.previewFingerprint, [...NO_BARBELL, "adjustable-bench"])))).getResponse()).toEqual(stale);
    expect((await rejection(applyAt().apply(a.actor, applyRequest(ids.B!, "0".repeat(64))))).getResponse()).toEqual(stale);
    expect((await rejection(applyAt().apply(a.actor, applyRequest(ids.B!, preview.previewFingerprint, NO_BARBELL, "exercise-equipment-catalog/v2")))).message).toBe("EQUIPMENT_CATALOG_VERSION_MISMATCH");
    expect((await rejection(applyAt(THU).apply(a.actor, applyRequest(ids.B!, preview.previewFingerprint)))).getResponse()).toMatchObject({ reasonCode: "NOT_TODAYS_WORKOUT" });
    await db.update(plannedSets).set({ targetRepsMax: 10 }).where(eq(plannedSets.id, setIds.B0![1]!));
    expect((await rejection(applyAt().apply(a.actor, applyRequest(ids.B!, preview.previewFingerprint)))).getResponse()).toEqual(stale);
    expect(await applications(a)).toHaveLength(0);
  });

  it("EQC-06: an applied preview that became stale (authored change after apply) silently stops applying to the Workout Preview", async () => {
    const a = await athlete();
    const { ids, setIds } = await seed(a);
    await previewAndApply(a, ids.B!);
    expect((await effectivePrescription(a, ids.B!)).exercises[0]!.exerciseRef).toBe("dumbbell-bench-press");
    await db.update(plannedSets).set({ restSeconds: 120 }).where(eq(plannedSets.id, setIds.B0![0]!));
    expect((await effectivePrescription(a, ids.B!)).exercises[0]!.exerciseRef).toBe("bench-press");
    // TODAY_ONLY: the next athlete-local day never sees it either.
    await db.update(plannedSets).set({ restSeconds: 90 }).where(eq(plannedSets.id, setIds.B0![0]!));
    expect((await effectivePrescription(a, ids.B!)).exercises[0]!.exerciseRef).toBe("dumbbell-bench-press");
    expect((await effectivePrescription(a, ids.B!, THU)).exercises[0]!.exerciseRef).toBe("bench-press");
  });

  it("EQC-07: BOLA — another athlete's workout is a 404 for apply and never leaks into their Workout Preview", async () => {
    const owner = await athlete();
    const { ids } = await seed(owner);
    const intruder = await athlete();
    await seed(intruder);
    const preview = await previewAt().preview(owner.actor, { plannedWorkoutId: ids.B!, catalogVersion: CATALOG, availableEquipmentIds: NO_BARBELL });
    await expect(applyAt().apply(intruder.actor, applyRequest(ids.B!, preview.previewFingerprint))).rejects.toBeInstanceOf(NotFoundException);
    await expect(applyAt().apply({ userId: intruder.userId, athleteProfileId: owner.athleteProfileId }, applyRequest(ids.B!, preview.previewFingerprint))).rejects.toBeInstanceOf(NotFoundException);
    expect(await applications(intruder)).toHaveLength(0);
    expect(await applications(owner)).toHaveLength(0);
  });

  it("EQC-08: Missed Workout interop — the rolled-forward A (same PlannedWorkout id) is today's and can be applied; B no longer can", async () => {
    const a = await athlete();
    const { ids } = await seed(a);
    const missed = await new MissedWorkoutPreviewService(db, at(WED)).preview(a.actor);
    if (missed.result !== "ROLL_FORWARD") throw new Error("expected ROLL_FORWARD");
    await new MissedWorkoutApplyService(db, at(WED)).apply(a.actor, missed.previewFingerprint);
    const applied = await previewAndApply(a, ids.A!);
    expect(applied.plannedWorkoutId).toBe(ids.A);
    expect((await effectivePrescription(a, ids.A!)).exercises.map((e) => e.exerciseRef)).toEqual(["dumbbell-bench-press", "seated-cable-row", "lat-pulldown"]);
    await expect(previewAndApply(a, ids.B!)).rejects.toMatchObject({ response: { reasonCode: "NOT_TODAYS_WORKOUT" } });
    // The moved-to-Today occurrence starts with the substitution (its authored Monday date is irrelevant) and consumes it.
    const command = startCommand(await effectivePrescription(a, ids.A!));
    expect((await run(a.userId, command)).outcome).toBe("APPLIED");
    expect(await applications(a)).toMatchObject([{ id: applied.applicationId, plannedWorkoutId: ids.A, status: "CONSUMED", consumedByWorkoutSessionId: command.workoutSessionId }]);
    const [claim] = await db.select().from(plannedWorkoutOccurrenceClaims).where(eq(plannedWorkoutOccurrenceClaims.userId, a.userId));
    expect(claim).toMatchObject({ plannedWorkoutId: ids.A, canonicalWorkoutSessionId: command.workoutSessionId });
  });

  it.each([["ACTIVE"], ["COMPLETED"]] as const)("EQC-09: an already %s occurrence is never adapted (apply -> NOT_APPLICABLE WORKOUT_ALREADY_STARTED)", async (status) => {
    const a = await athlete();
    const { ids } = await seed(a);
    const preview = await previewAt().preview(a.actor, { plannedWorkoutId: ids.B!, catalogVersion: CATALOG, availableEquipmentIds: NO_BARBELL });
    const ack = await run(a.userId, startCommand(await effectivePrescription(a, ids.B!)));
    expect(ack.outcome).toBe("APPLIED");
    if (status === "COMPLETED") await db.update(workoutSessions).set({ status: "COMPLETED", completedAt: new Date() }).where(eq(workoutSessions.userId, a.userId));
    expect((await rejection(applyAt().apply(a.actor, applyRequest(ids.B!, preview.previewFingerprint)))).getResponse()).toMatchObject({ reasonCode: "WORKOUT_ALREADY_STARTED" });
    expect(await applications(a)).toHaveLength(0);
  });

  it("EQC-10: apply racing an ordinary (authored) START is serialized — START first: apply refused; Apply first: the authored START cannot bypass it", async () => {
    const seen = new Set<string>();
    for (let round = 0; round < 6; round++) {
      const a = await athlete();
      const { ids } = await seed(a);
      const preview = await previewAt().preview(a.actor, { plannedWorkoutId: ids.B!, catalogVersion: CATALOG, availableEquipmentIds: NO_BARBELL });
      const start = startCommand(await effectivePrescription(a, ids.B!));
      const [applied, ack] = await Promise.all([applyAt().apply(a.actor, applyRequest(ids.B!, preview.previewFingerprint)).then((r) => r, (e: unknown) => e), run(a.userId, start)]);
      const rows = await applications(a);
      const claims = await db.select().from(plannedWorkoutOccurrenceClaims).where(eq(plannedWorkoutOccurrenceClaims.userId, a.userId));
      if (applied instanceof Error) {
        // START won the lock: canonical authored session, the apply is refused, no application exists.
        seen.add("START_FIRST");
        expect(ack.outcome).toBe("APPLIED");
        expect((applied as Error & { getResponse(): unknown }).getResponse()).toMatchObject({ reasonCode: "WORKOUT_ALREADY_STARTED" });
        expect(claims.map((c) => c.canonicalWorkoutSessionId)).toEqual([start.workoutSessionId]);
        expect(rows).toHaveLength(0);
      } else {
        // Apply won the lock: the authored snapshot is now an identity change against the ACTIVE application -> REJECTED.
        seen.add("APPLY_FIRST");
        expect(ack.outcome).toBe("REJECTED");
        expect(claims).toHaveLength(0);
        expect(await db.select().from(workoutSessions).where(eq(workoutSessions.userId, a.userId))).toHaveLength(0);
        expect(rows.map((r) => r.status)).toEqual(["ACTIVE"]);
        // The effective (equipment-adjusted) START then succeeds and consumes it — one replacement reality.
        const effective = startCommand(await effectivePrescription(a, ids.B!));
        expect((await run(a.userId, effective)).outcome).toBe("APPLIED");
        expect(await applications(a)).toMatchObject([{ status: "CONSUMED", consumedByWorkoutSessionId: effective.workoutSessionId }]);
      }
      expect(await activeApplications(a)).toHaveLength(0);
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  // ------------------------------------------------------ Workout Preview

  it("EQC-11: the effective Workout Preview carries performed identity + authored provenance; sets keep ids/reps/rest; NO load is transferred", async () => {
    const a = await athlete();
    const { ids, exerciseIds, setIds } = await seed(a);
    const applied = await previewAndApply(a, ids.B!);
    const preview = (await planAt().getWorkoutPreview(a.actor, ids.B!))!;
    const [bench, row, pulldown] = preview.prescription.exercises;

    expect(bench).toMatchObject({ prescriptionExerciseId: exerciseIds.B![0], exerciseRef: "dumbbell-bench-press", displayName: "Dumbbell Bench Press" });
    expect(bench!.substitution).toEqual({ kind: "TEMPORARY_EQUIPMENT", reasonCode: "TEMPORARY_EQUIPMENT_UNAVAILABLE", authoredExerciseRef: "bench-press", authoredDisplayName: "Bench Press", equipmentApplicationId: applied.applicationId, policyVersion: "equipment-adaptation/v1", catalogVersion: CATALOG });
    expect(bench!.sets.map((s) => [s.prescriptionSetId, s.setType, s.targetReps, s.restSeconds, s.targetLoad])).toEqual(setIds.B0!.map((id) => [id, "WORKING", { kind: "RANGE", minReps: 8, maxReps: 12 }, 90, null]));
    expect(row).toMatchObject({ exerciseRef: "seated-cable-row", substitution: { authoredExerciseRef: "barbell-row" } });
    expect(pulldown).toMatchObject({ exerciseRef: "lat-pulldown", displayName: "Lat Pulldown" });
    expect(pulldown!.substitution).toBeUndefined();
    expect(pulldown!.sets.every((s) => s.targetLoad?.amountMilli === 60000)).toBe(true);
    // Display exercises agree with the prescription.
    expect(preview.exercises.map((e) => [e.displayName, e.substitution?.authoredExerciseRef ?? null, e.sets[0]!.targetLoad?.amountMilli ?? null])).toEqual([
      ["Dumbbell Bench Press", "bench-press", null],
      ["Seated Cable Row", "barbell-row", null],
      ["Lat Pulldown", null, 60000],
    ]);
    // Read-only + deterministic.
    const rowsBefore = await applications(a);
    expect(await planAt().getWorkoutPreview(a.actor, ids.B!)).toEqual(preview);
    expect(await applications(a)).toEqual(rowsBefore);
  });

  it("EQC-12: the substitute's load comes from ITS OWN most recent uniform working exposure — never from the authored exercise", async () => {
    const a = await athlete();
    const { ids } = await seed(a);
    // Earlier unplanned session: dumbbell bench 2 x 24 kg per dumbbell; older one at 20 kg must not win.
    for (const [startedAt, amountMilli] of [["2026-09-20T08:00:00Z", 20000], ["2026-09-28T08:00:00Z", 24000]] as const) {
      const sessionId = createEntityId();
      await db.insert(workoutSessions).values({ id: sessionId, userId: a.userId, prescriptionSnapshot: { schemaVersion: 1, prescriptionId: createEntityId(), name: "Free", exercises: [] }, startedAt: new Date(startedAt), status: "COMPLETED", completedAt: new Date(startedAt) });
      const exerciseId = createEntityId();
      await db.insert(performedExercises).values({ id: exerciseId, workoutSessionId: sessionId, prescriptionExerciseId: null, exerciseRef: "dumbbell-bench-press", displayName: "Dumbbell Bench Press", orderIndex: 1 });
      for (let order = 1; order <= 2; order++) {
        await db.insert(performedSets).values({ id: createEntityId(), performedExerciseId: exerciseId, prescriptionSetId: null, orderIndex: order, actualReps: 10, loadKind: "EXTERNAL_WEIGHT", loadAmountMilli: amountMilli, loadUnit: "KG", loadBasis: "PER_IMPLEMENT", setType: "WORKING", completionState: "COMPLETED", completedAt: new Date(startedAt), revision: 1 });
      }
    }
    await previewAndApply(a, ids.B!);
    const [bench, row] = (await effectivePrescription(a, ids.B!)).exercises;
    expect(bench!.sets.map((s) => s.targetLoad)).toEqual([
      { kind: "EXTERNAL_WEIGHT", amountMilli: 24000, unit: "KG", basis: "PER_IMPLEMENT" },
      { kind: "EXTERNAL_WEIGHT", amountMilli: 24000, unit: "KG", basis: "PER_IMPLEMENT" },
    ]);
    // No own history -> no prescribed load (the athlete chooses).
    expect(row!.sets.map((s) => s.targetLoad)).toEqual([null, null]);
  });

  // ---------------------------------------------------------------- START

  it("EQC-13: START from the effective preview -> APPLIED, performed identity in the snapshot, application CONSUMED by the canonical session; replay is idempotent", async () => {
    const a = await athlete();
    const seeded = await seed(a);
    const before = await authoredState(seeded);
    const applied = await previewAndApply(a, seeded.ids.B!);
    const command = startCommand(await effectivePrescription(a, seeded.ids.B!));
    expect((await run(a.userId, command)).outcome).toBe("APPLIED");

    const [session] = await db.select().from(workoutSessions).where(eq(workoutSessions.userId, a.userId));
    const snapshot = session!.prescriptionSnapshot as WorkoutPrescriptionV1;
    expect(snapshot).toEqual(command.prescription);
    expect(snapshot.exercises.map((e) => [e.prescriptionExerciseId, e.exerciseRef, e.substitution?.authoredExerciseRef ?? null])).toEqual([
      [seeded.exerciseIds.B![0], "dumbbell-bench-press", "bench-press"],
      [seeded.exerciseIds.B![1], "seated-cable-row", "barbell-row"],
      [seeded.exerciseIds.B![2], "lat-pulldown", null],
    ]);
    const [row] = await applications(a);
    expect(row).toMatchObject({ id: applied.applicationId, status: "CONSUMED", consumedByWorkoutSessionId: command.workoutSessionId });
    expect(row!.consumedAt).not.toBeNull();
    const [claim] = await db.select().from(plannedWorkoutOccurrenceClaims).where(eq(plannedWorkoutOccurrenceClaims.userId, a.userId));
    expect(claim!.canonicalWorkoutSessionId).toBe(command.workoutSessionId);
    expect(await activeApplications(a)).toHaveLength(0);

    // Replay (lost ACK) and a retried apply of the same preview are both idempotent.
    expect((await run(a.userId, command)).outcome).toBe("DUPLICATE");
    const retried = await applyAt().apply(a.actor, applyRequest(seeded.ids.B!, row!.previewFingerprint));
    expect(retried).toMatchObject({ applicationId: applied.applicationId, status: "CONSUMED" });
    expect(await db.select().from(workoutSessions).where(eq(workoutSessions.userId, a.userId))).toHaveLength(1);
    expect(await applications(a)).toHaveLength(1);
    // A new adaptation after START is impossible; the authored plan never changed.
    await expect(previewAndApply(a, seeded.ids.B!, ["dumbbells"])).rejects.toMatchObject({ response: { reasonCode: "WORKOUT_ALREADY_STARTED" } });
    expect(await authoredState(seeded)).toEqual(before);
  });

  it("EQC-14: START fails CLOSED on any semantic mismatch with the durable application — no session, no claim, application untouched", async () => {
    const a = await athlete();
    const { ids } = await seed(a);
    const applied = await previewAndApply(a, ids.B!);
    const good = await effectivePrescription(a, ids.B!);
    const other = await athlete();
    const otherSeed = await seed(other);
    const foreign = await previewAndApply(other, otherSeed.ids.B!);

    const mutate = (fn: (exercises: WorkoutPrescriptionV1["exercises"][number][]) => WorkoutPrescriptionV1["exercises"][number][]): WorkoutPrescriptionV1 => ({ ...good, exercises: fn([...good.exercises]) });
    const tampered: [string, WorkoutPrescriptionV1][] = [
      ["another substitute", mutate((ex) => [{ ...ex[0]!, exerciseRef: "incline-dumbbell-press" }, ...ex.slice(1)])],
      ["a wrong authored ref", mutate((ex) => [{ ...ex[0]!, substitution: { ...ex[0]!.substitution!, authoredExerciseRef: "overhead-press" } }, ...ex.slice(1)])],
      ["a missing substitution (partial)", mutate((ex) => [ex[0]!, { ...ex[1]!, exerciseRef: "barbell-row", substitution: undefined } as never, ex[2]!])],
      ["an invented extra substitution", mutate((ex) => [ex[0]!, ex[1]!, { ...ex[2]!, exerciseRef: "seated-cable-row", substitution: { ...ex[0]!.substitution!, authoredExerciseRef: "lat-pulldown" } }])],
      ["an unknown application id", mutate((ex) => ex.map((e) => (e.substitution === undefined ? e : { ...e, substitution: { ...e.substitution, equipmentApplicationId: createEntityId() } })))],
      ["another athlete's application", mutate((ex) => ex.map((e) => (e.substitution === undefined ? e : { ...e, substitution: { ...e.substitution, equipmentApplicationId: foreign.applicationId } })))],
      ["two different application ids", mutate((ex) => [ex[0]!, { ...ex[1]!, substitution: { ...ex[1]!.substitution!, equipmentApplicationId: foreign.applicationId } }, ex[2]!])],
      ["a duplicated slot hiding a missing one", mutate((ex) => [ex[0]!, { ...ex[0]!, order: 2 }, ex[2]!])],
      ["a malformed substitution", mutate((ex) => [{ ...ex[0]!, substitution: { kind: "TEMPORARY_EQUIPMENT" } as never }, ...ex.slice(1)])],
    ];
    for (const [label, prescription] of tampered) {
      expect((await run(a.userId, startCommand(prescription))).outcome, label).toBe("REJECTED");
    }
    // An UNPLANNED START may never claim a substitution.
    const unplanned: WorkoutPrescriptionV1 = { schemaVersion: 1, prescriptionId: createEntityId(), name: "Free", exercises: [{ prescriptionExerciseId: createEntityId(), exerciseRef: "dumbbell-bench-press", displayName: "Dumbbell Bench Press", order: 1, sets: [], substitution: good.exercises[0]!.substitution! }] };
    expect((await run(a.userId, startCommand(unplanned))).outcome).toBe("REJECTED");

    expect(await db.select().from(workoutSessions).where(eq(workoutSessions.userId, a.userId))).toHaveLength(0);
    expect(await db.select().from(plannedWorkoutOccurrenceClaims).where(eq(plannedWorkoutOccurrenceClaims.userId, a.userId))).toHaveLength(0);
    expect((await applications(a)).map((r) => [r.id, r.status])).toEqual([[applied.applicationId, "ACTIVE"]]);
    // The untampered snapshot still starts.
    expect((await run(a.userId, startCommand(good))).outcome).toBe("APPLIED");
  });

  it("EQC-15: an exact snapshot of a SUPERSEDED application is no longer legitimate -> REJECTED; the current (NO_CHANGE) effective START consumes the ACTIVE row", async () => {
    const a = await athlete();
    const { ids } = await seed(a);
    const first = await previewAndApply(a, ids.B!);
    const offlineSnapshot = await effectivePrescription(a, ids.B!);
    const second = await previewAndApply(a, ids.B!, EVERYTHING);
    expect(second.result).toBe("NO_CHANGE");
    expect((await run(a.userId, startCommand(offlineSnapshot))).outcome).toBe("REJECTED");
    expect(await db.select().from(workoutSessions).where(eq(workoutSessions.userId, a.userId))).toHaveLength(0);

    const current = await effectivePrescription(a, ids.B!);
    expect(current.exercises.map((e) => e.exerciseRef)).toEqual(["bench-press", "barbell-row", "lat-pulldown"]);
    const command = startCommand(current);
    expect((await run(a.userId, command)).outcome).toBe("APPLIED");
    expect((await applications(a)).map((r) => [r.id, r.status, r.consumedByWorkoutSessionId])).toEqual([
      [first.applicationId, "SUPERSEDED", null],
      [second.applicationId, "CONSUMED", command.workoutSessionId],
    ]);
  });

  it("EQC-16: TODAY_ONLY — on another day the substitution is no longer legitimate (REJECTED); the authored canonical START retires the stale ACTIVE row", async () => {
    const a = await athlete();
    const { ids } = await seed(a);
    const applied = await previewAndApply(a, ids.B!);
    const substituted = await effectivePrescription(a, ids.B!);
    // Thursday, really (server now == startedAt): the application no longer applies.
    expect((await run(a.userId, startCommand(substituted, THU), THU)).outcome).toBe("REJECTED");
    expect(await activeApplications(a)).toHaveLength(1);
    const authored = await effectivePrescription(a, ids.B!, THU);
    expect(authored.exercises.map((e) => [e.exerciseRef, e.substitution])).toEqual([["bench-press", undefined], ["barbell-row", undefined], ["lat-pulldown", undefined]]);
    const command = startCommand(authored, THU);
    expect((await run(a.userId, command, THU)).outcome).toBe("APPLIED");
    // CANONICAL START LEAVES NO ACTIVE EQUIPMENT APPLICATION BEHIND: unused -> SUPERSEDED (never CONSUMED by a session that did not use it).
    const [row] = await applications(a);
    expect(row).toMatchObject({ id: applied.applicationId, status: "SUPERSEDED", consumedByWorkoutSessionId: null });
    expect(row!.supersededAt).not.toBeNull();
  });

  it("EQC-16b: a client cannot escape an applicable application by lying about startedAt (authored snapshot, startedAt Thursday, server now Wednesday) -> REJECTED", async () => {
    const a = await athlete();
    const { ids } = await seed(a);
    const authored = await effectivePrescription(a, ids.B!);
    await previewAndApply(a, ids.B!);
    expect((await run(a.userId, startCommand(authored, THU), WED)).outcome).toBe("REJECTED");
    // ...and an offline START that really happened on Wednesday but syncs on Thursday still consumes it.
    const command = startCommand(await effectivePrescription(a, ids.B!), WED);
    expect((await run(a.userId, command, THU)).outcome).toBe("APPLIED");
    expect(await applications(a)).toMatchObject([{ status: "CONSUMED", consumedByWorkoutSessionId: command.workoutSessionId }]);
  });

  it("EQC-17: a SECONDARY START must perform the canonical replacement reality: the exact snapshot is accepted; authored or tampered snapshots are REJECTED", async () => {
    const a = await athlete();
    const { ids } = await seed(a);
    const authored = await effectivePrescription(a, ids.B!);
    await previewAndApply(a, ids.B!);
    const snapshot = await effectivePrescription(a, ids.B!);
    const first = startCommand(snapshot);
    expect((await run(a.userId, first)).outcome).toBe("APPLIED");
    expect((await run(a.userId, startCommand(authored))).outcome).toBe("REJECTED");
    expect((await run(a.userId, startCommand({ ...snapshot, exercises: [{ ...snapshot.exercises[0]!, exerciseRef: "incline-dumbbell-press" }, ...snapshot.exercises.slice(1)] }))).outcome).toBe("REJECTED");
    expect((await run(a.userId, startCommand({ ...snapshot, exercises: [{ ...snapshot.exercises[0]!, substitution: { ...snapshot.exercises[0]!.substitution!, equipmentApplicationId: createEntityId() } }, ...snapshot.exercises.slice(1)] }))).outcome).toBe("REJECTED");
    const second = startCommand(snapshot);
    expect((await run(a.userId, second)).outcome).toBe("APPLIED");
    expect(await db.select().from(workoutSessions).where(eq(workoutSessions.userId, a.userId))).toHaveLength(2);
    expect(await applications(a)).toMatchObject([{ status: "CONSUMED", consumedByWorkoutSessionId: first.workoutSessionId }]);
  });

  // ------------------------------------------- START exercise identity integrity

  it("EQC-20: no equipment application — ANY exercise identity change at START is REJECTED (arbitrary ref, fake well-formed provenance, extra slot)", async () => {
    const a = await athlete();
    const seeded = await seed(a);
    const { ids, exerciseIds } = seeded;
    const before = await authoredState(seeded);
    const good = await effectivePrescription(a, ids.B!);
    const other = await athlete();
    const otherSeed = await seed(other);
    const foreign = await previewAndApply(other, otherSeed.ids.B!);
    const fake = (equipmentApplicationId: string) => ({ kind: "TEMPORARY_EQUIPMENT" as const, reasonCode: "TEMPORARY_EQUIPMENT_UNAVAILABLE" as const, authoredExerciseRef: "bench-press", authoredDisplayName: "Bench Press", equipmentApplicationId, policyVersion: "equipment-adaptation/v1" as const, catalogVersion: CATALOG });
    const mutate = (fn: (exercises: WorkoutPrescriptionV1["exercises"][number][]) => WorkoutPrescriptionV1["exercises"][number][]): WorkoutPrescriptionV1 => ({ ...good, exercises: fn([...good.exercises]) });
    const tampered: [string, WorkoutPrescriptionV1][] = [
      ["bench-press -> arbitrary exercise", mutate((ex) => [{ ...ex[0]!, exerciseRef: "leg-press" }, ...ex.slice(1)])],
      ["bench-press -> its curated substitute without provenance", mutate((ex) => [{ ...ex[0]!, exerciseRef: "dumbbell-bench-press" }, ...ex.slice(1)])],
      ["a freeform (null) exerciseRef", mutate((ex) => [{ ...ex[0]!, exerciseRef: null }, ...ex.slice(1)])],
      ["fake provenance, random application id", mutate((ex) => [{ ...ex[0]!, exerciseRef: "dumbbell-bench-press", substitution: fake(createEntityId()) }, ...ex.slice(1)])],
      ["fake provenance, another athlete's real application", mutate((ex) => [{ ...ex[0]!, exerciseRef: "dumbbell-bench-press", substitution: fake(foreign.applicationId) }, ...ex.slice(1)])],
      ["provenance on an unchanged authored exercise", mutate((ex) => [{ ...ex[0]!, substitution: fake(createEntityId()) }, ...ex.slice(1)])],
      ["an extra slot of another workout", mutate((ex) => [...ex, { ...ex[0]!, prescriptionExerciseId: exerciseIds.C![0]!, order: 4, sets: [] }])],
      ["an extra slot with an invented id", mutate((ex) => [...ex, { ...ex[0]!, prescriptionExerciseId: createEntityId(), exerciseRef: "leg-press", order: 4, sets: [] }])],
      ["a duplicated authored slot", mutate((ex) => [...ex, { ...ex[2]!, order: 4 }])],
    ];
    for (const [label, prescription] of tampered) {
      expect((await run(a.userId, startCommand(prescription))).outcome, label).toBe("REJECTED");
    }
    expect(await db.select().from(workoutSessions).where(eq(workoutSessions.userId, a.userId))).toHaveLength(0);
    expect(await db.select().from(plannedWorkoutOccurrenceClaims).where(eq(plannedWorkoutOccurrenceClaims.userId, a.userId))).toHaveLength(0);
    expect(await applications(a)).toHaveLength(0);
    expect((await applications(other)).map((r) => r.status)).toEqual(["ACTIVE"]);
    expect(await authoredState(seeded)).toEqual(before);
    // The authored snapshot starts; omitting a non-replaced slot changes no identity (existing behavior).
    expect((await run(a.userId, startCommand(mutate((ex) => ex.slice(0, 2))))).outcome).toBe("APPLIED");
  });

  it("EQC-21: an ACTIVE application cannot be bypassed — authored exercise, omitted/duplicated/changed replacement, inconsistent provenance -> REJECTED", async () => {
    const a = await athlete();
    const seeded = await seed(a);
    const { ids } = seeded;
    const authored = await effectivePrescription(a, ids.B!);
    const applied = await previewAndApply(a, ids.B!);
    const before = await authoredState(seeded);
    const good = await effectivePrescription(a, ids.B!);
    const mutate = (fn: (exercises: WorkoutPrescriptionV1["exercises"][number][]) => WorkoutPrescriptionV1["exercises"][number][]): WorkoutPrescriptionV1 => ({ ...good, exercises: fn([...good.exercises]) });
    const withSubstitution = (patch: Record<string, unknown>) => mutate((ex) => [{ ...ex[0]!, substitution: { ...ex[0]!.substitution!, ...patch } }, ...ex.slice(1)]);
    const tampered: [string, WorkoutPrescriptionV1][] = [
      ["the whole authored workout", authored],
      ["authored bench-press for one replaced slot", mutate((ex) => [authored.exercises[0]!, ...ex.slice(1)])],
      ["the substitute without its substitution object", mutate((ex) => [{ ...ex[0]!, substitution: undefined } as never, ...ex.slice(1)])],
      ["substitution kept but exerciseRef reverted to authored", mutate((ex) => [{ ...ex[0]!, exerciseRef: "bench-press" }, ...ex.slice(1)])],
      ["the replaced slot omitted", mutate((ex) => ex.slice(1))],
      ["the replaced slot duplicated", mutate((ex) => [...ex, { ...ex[0]!, order: 4 }])],
      ["a compatible (non-applied) substitute", mutate((ex) => [{ ...ex[0]!, exerciseRef: "incline-dumbbell-press" }, ...ex.slice(1)])],
      ["a changed application id", withSubstitution({ equipmentApplicationId: createEntityId() })],
      ["a wrong authored display name", withSubstitution({ authoredDisplayName: "Leg Press" })],
      ["a wrong catalog version", withSubstitution({ catalogVersion: "exercise-equipment-catalog/v0" })],
      ["a wrong policy version", withSubstitution({ policyVersion: "equipment-adaptation/v2" })],
      ["an extra provenance field", withSubstitution({ substituteExerciseRef: "dumbbell-bench-press" })],
      ["a null substitution", mutate((ex) => [{ ...ex[0]!, substitution: null } as never, ...ex.slice(1)])],
      ["an unapproved extra replacement", mutate((ex) => [ex[0]!, ex[1]!, { ...ex[2]!, exerciseRef: "seated-cable-row", substitution: { ...ex[0]!.substitution!, authoredExerciseRef: "lat-pulldown", authoredDisplayName: "Lat Pulldown" } }])],
    ];
    for (const [label, prescription] of tampered) {
      expect((await run(a.userId, startCommand(prescription))).outcome, label).toBe("REJECTED");
    }
    expect(await db.select().from(workoutSessions).where(eq(workoutSessions.userId, a.userId))).toHaveLength(0);
    expect((await applications(a)).map((r) => [r.id, r.status])).toEqual([[applied.applicationId, "ACTIVE"]]);
    expect(await authoredState(seeded)).toEqual(before);
    const command = startCommand(good);
    expect((await run(a.userId, command)).outcome).toBe("APPLIED");
    expect(await activeApplications(a)).toHaveLength(0);
  });

  // ---------------------------------------------------- composition order

  it("EQC-18: composition with Available-Time commutes — equipment-then-time and time-then-equipment give the same structure; both verified", async () => {
    const results: { exercises: [string | null, string[]][]; verification: string; equipmentStatus: string }[] = [];
    for (const order of ["EQUIPMENT_FIRST", "TIME_FIRST"] as const) {
      const a = await athlete();
      const { ids } = await seed(a);
      const timePreview = async () => {
        const preview = await new AvailableTimePreviewService(db).preview(a.actor, ids.B!, 9);
        const application = availableTimeApplicationFromPreview(preview);
        if (!application.ok) throw new Error(`expected ADJUST_SESSION: ${JSON.stringify(application.error)}`);
        return application.value;
      };
      let timeApplication: AvailableTimeApplicationV1;
      if (order === "EQUIPMENT_FIRST") {
        await previewAndApply(a, ids.B!);
        timeApplication = await timePreview();
      } else {
        timeApplication = await timePreview();
        await previewAndApply(a, ids.B!);
      }
      // Mobile: the effective (equipment-adapted) Workout Preview prescription -> shared Available-Time selection.
      const selected = selectAvailableTimePrescription(await effectivePrescription(a, ids.B!), timeApplication);
      if (!selected.ok) throw new Error(selected.error);
      const command = startCommand(selected.value, WED, timeApplication);
      expect((await run(a.userId, command)).outcome).toBe("APPLIED");
      const [timeRow] = await db.select().from(availableTimeApplications).where(eq(availableTimeApplications.workoutSessionId, command.workoutSessionId));
      const snapshot = command.prescription;
      results.push({
        exercises: snapshot.exercises.map((e) => [e.exerciseRef, e.sets.map((s) => (s.prescriptionSetId === (selected.value.exercises.find((x) => x.prescriptionExerciseId === e.prescriptionExerciseId)?.sets[0]?.prescriptionSetId) ? "first" : "other"))]),
        verification: timeRow!.verificationStatus,
        equipmentStatus: (await applications(a))[0]!.status,
      });
      // Time removed the lat pulldown's last set; equipment changed identities only.
      expect(snapshot.exercises.map((e) => [e.exerciseRef, e.sets.length])).toEqual([["dumbbell-bench-press", 2], ["seated-cable-row", 2], ["lat-pulldown", 1]]);
    }
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ verification: "VERIFIED", equipmentStatus: "CONSUMED" });
  });

  it("EQC-18b: Available-Time can select sets but never legitimizes an exercise identity change (with and without an equipment application)", async () => {
    for (const withEquipment of [false, true]) {
      const a = await athlete();
      const { ids } = await seed(a);
      if (withEquipment) await previewAndApply(a, ids.B!);
      const preview = await new AvailableTimePreviewService(db).preview(a.actor, ids.B!, 9);
      const timeApplication = availableTimeApplicationFromPreview(preview);
      if (!timeApplication.ok) throw new Error("expected ADJUST_SESSION");
      const selected = selectAvailableTimePrescription(await effectivePrescription(a, ids.B!), timeApplication.value);
      if (!selected.ok) throw new Error(selected.error);
      const changed: WorkoutPrescriptionV1 = { ...selected.value, exercises: selected.value.exercises.map((e) => (e.exerciseRef === "lat-pulldown" ? { ...e, exerciseRef: "seated-cable-row" } : e)) };
      expect((await run(a.userId, startCommand(changed, WED, timeApplication.value))).outcome, `withEquipment=${withEquipment}`).toBe("REJECTED");
      expect(await db.select().from(availableTimeApplications).where(eq(availableTimeApplications.userId, a.userId))).toHaveLength(0);
      expect((await run(a.userId, startCommand(selected.value, WED, timeApplication.value))).outcome).toBe("APPLIED");
      expect(await activeApplications(a)).toHaveLength(0);
    }
  });

  // -------------------------------------------- history / progression safety

  it("EQC-19: performed history belongs to the substitute; the authored exercise's history and progression are untouched", async () => {
    const a = await athlete();
    const { ids, exerciseIds, setIds } = await seed(a);
    await previewAndApply(a, ids.B!);
    const start = startCommand(await effectivePrescription(a, ids.B!));
    expect((await run(a.userId, start)).outcome).toBe("APPLIED");
    const performedExerciseId = createEntityId();
    for (const [index, setId] of setIds.B0!.entries()) {
      const command: CompleteSetCommandV1 = {
        commandId: createEntityId(),
        type: "COMPLETE_SET_V1",
        schemaVersion: 1,
        createdAt: WED,
        workoutSessionId: start.workoutSessionId,
        performedExerciseId,
        prescriptionExerciseId: exerciseIds.B![0]!,
        exerciseRef: "dumbbell-bench-press",
        exerciseDisplayName: "Dumbbell Bench Press",
        exerciseOrder: 1,
        performedSetId: createEntityId(),
        prescriptionSetId: setId,
        setOrder: index + 1,
        actualReps: 12,
        actualLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: 26000, unit: "KG", basis: "PER_IMPLEMENT" },
        setType: "WORKING",
        revision: 1,
        completedAt: WED,
        sessionSeq: index + 1,
      };
      expect((await run(a.userId, command)).outcome).toBe("APPLIED");
    }
    // The non-substituted Lat Pulldown in the same session, all sets at the top of the range.
    const pulldownPerformedId = createEntityId();
    for (const [index, setId] of setIds.B2!.entries()) {
      const command: CompleteSetCommandV1 = {
        commandId: createEntityId(),
        type: "COMPLETE_SET_V1",
        schemaVersion: 1,
        createdAt: WED,
        workoutSessionId: start.workoutSessionId,
        performedExerciseId: pulldownPerformedId,
        prescriptionExerciseId: exerciseIds.B![2]!,
        exerciseRef: "lat-pulldown",
        exerciseDisplayName: "Lat Pulldown",
        exerciseOrder: 3,
        performedSetId: createEntityId(),
        prescriptionSetId: setId,
        setOrder: index + 1,
        actualReps: 12,
        actualLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: 60000, unit: "KG", basis: "TOTAL" },
        setType: "WORKING",
        revision: 1,
        completedAt: WED,
        sessionSeq: index + 3,
      };
      expect((await run(a.userId, command)).outcome).toBe("APPLIED");
    }
    expect((await run(a.userId, { commandId: createEntityId(), type: "FINISH_WORKOUT_SESSION_V1", schemaVersion: 1, createdAt: WED, workoutSessionId: start.workoutSessionId, completedAt: WED, finishSeq: 4 })).outcome).toBe("APPLIED");

    const [performed] = await db.select().from(performedExercises).where(eq(performedExercises.id, performedExerciseId));
    expect(performed).toMatchObject({ exerciseRef: "dumbbell-bench-press", prescriptionExerciseId: exerciseIds.B![0] });

    const history = new WorkoutHistoryService(db);
    expect(await history.getRecentWorkingExposures({ userId: a.userId }, "bench-press")).toHaveLength(0);
    expect(await history.getRecentWorkingExposures({ userId: a.userId }, "dumbbell-bench-press")).toHaveLength(2); // the two performed working sets

    // Every top-of-range set would be INCREASE_LOAD for an ordinary exercise — the substitute is never evaluated for the authored slot.
    const outcome = await new ProgressionEvaluationService(db, history).evaluateAndPersist({ userId: a.userId }, { workoutSessionId: start.workoutSessionId, performedExerciseId });
    expect(outcome).toEqual({ status: "TEMPORARY_SUBSTITUTION_NOT_EVALUATED" });
    expect(await db.select().from(progressionDecisions).where(eq(progressionDecisions.userId, a.userId))).toHaveLength(0);
    expect(await db.select().from(progressionApplications).where(eq(progressionApplications.userId, a.userId))).toHaveLength(0);

    // The other, non-substituted exercise of the SAME session is evaluated normally.
    const pulldown = await new ProgressionEvaluationService(db, history).evaluateAndPersist({ userId: a.userId }, { workoutSessionId: start.workoutSessionId, performedExerciseId: pulldownPerformedId });
    expect(pulldown.status).toBe("PERSISTED");
    const decisions = await db.select().from(progressionDecisions).where(eq(progressionDecisions.userId, a.userId));
    expect(decisions.map((d) => d.exerciseRef)).toEqual(["lat-pulldown"]);

    // The next time the substitute is chosen, its own (just performed) load is the starting point.
    const nextDay = await athleteNextDayPreview(a, ids.C!);
    expect(nextDay).toEqual([26000, 26000]);
  });

  // ------------------------------------------- Slice D: equipment options (read-only)

  const optionsAt = (iso: string = WED) => new EquipmentAdaptationOptionsService(db, at(iso));

  it("EQD-01: options = canonical labels of the planned exercises' + curated substitutes' equipment, deterministic, no duplicates, no ranking", async () => {
    const a = await athlete();
    const seeded = await seed(a);
    const before = await authoredState(seeded);
    const options = await optionsAt().options(a.actor, seeded.ids.B!);
    expect(options).toEqual({
      schemaVersion: "equipment-adaptation-options/v1",
      catalogVersion: CATALOG,
      plannedWorkoutId: seeded.ids.B,
      athleteLocalDate: "2026-10-07",
      equipmentOptions: EXPECTED_OPTIONS,
      currentApplication: null,
    });
    expect(new Set(options.equipmentOptions.map((o) => o.equipmentId)).size).toBe(options.equipmentOptions.length);
    expect(await optionsAt().options(a.actor, seeded.ids.B!)).toEqual(options);
    // Read-only.
    expect(await applications(a)).toHaveLength(0);
    expect(await authoredState(seeded)).toEqual(before);
    // Every option's id/label is canonical catalog data, and the previewable inventory accepts every id.
    const preview = await previewAt().preview(a.actor, { plannedWorkoutId: seeded.ids.B!, catalogVersion: options.catalogVersion, availableEquipmentIds: options.equipmentOptions.map((o) => o.equipmentId) });
    expect(preview.result).toBe("NO_CHANGE");
  });

  it("EQD-02: currentApplication reflects today's still-applicable ACTIVE application only (ADJUST, NO_CHANGE clear, never after START or on another day)", async () => {
    const a = await athlete();
    const { ids } = await seed(a);
    const adjust = await previewAndApply(a, ids.B!);
    expect((await optionsAt().options(a.actor, ids.B!)).currentApplication).toEqual({ applicationId: adjust.applicationId, result: "ADJUST_SESSION", availableEquipmentIds: [...NO_BARBELL].sort() });
    const clear = await previewAndApply(a, ids.B!, EVERYTHING);
    expect((await optionsAt().options(a.actor, ids.B!)).currentApplication).toEqual({ applicationId: clear.applicationId, result: "NO_CHANGE", availableEquipmentIds: [...EVERYTHING].sort() });
    // Thursday: B is not today -> not applicable at all.
    await expect(optionsAt(THU).options(a.actor, ids.B!)).rejects.toMatchObject({ response: { reasonCode: "NOT_TODAYS_WORKOUT" } });
    expect((await run(a.userId, startCommand(await effectivePrescription(a, ids.B!)))).outcome).toBe("APPLIED");
    await expect(optionsAt().options(a.actor, ids.B!)).rejects.toMatchObject({ response: { reasonCode: "WORKOUT_ALREADY_STARTED" } });
  });

  it("EQD-03: applicability = the preview's — BOLA 404, past/future 409 NOT_TODAYS_WORKOUT, missing time zone 409, Missed Workout moved-to-Today succeeds", async () => {
    const owner = await athlete();
    const { ids } = await seed(owner);
    const intruder = await athlete();
    await seed(intruder);
    await expect(optionsAt().options(intruder.actor, ids.B!)).rejects.toBeInstanceOf(NotFoundException);
    await expect(optionsAt().options(owner.actor, createEntityId())).rejects.toBeInstanceOf(NotFoundException);
    await expect(optionsAt().options(owner.actor, ids.C!)).rejects.toMatchObject({ response: { reasonCode: "NOT_TODAYS_WORKOUT" } });
    await expect(optionsAt().options(owner.actor, ids.A!)).rejects.toMatchObject({ response: { reasonCode: "NOT_TODAYS_WORKOUT" } });

    const missed = await new MissedWorkoutPreviewService(db, at(WED)).preview(owner.actor);
    if (missed.result !== "ROLL_FORWARD") throw new Error("expected ROLL_FORWARD");
    await new MissedWorkoutApplyService(db, at(WED)).apply(owner.actor, missed.previewFingerprint);
    expect((await optionsAt().options(owner.actor, ids.A!)).plannedWorkoutId).toBe(ids.A);
    await expect(optionsAt().options(owner.actor, ids.B!)).rejects.toMatchObject({ response: { reasonCode: "NOT_TODAYS_WORKOUT" } });

    await db.update(athleteProfiles).set({ trainingTimeZone: null }).where(eq(athleteProfiles.id, owner.athleteProfileId));
    const error = await rejection(optionsAt().options(owner.actor, ids.A!));
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.message).toBe("TRAINING_TIME_ZONE_REQUIRED");
  });

  it("EQD-04: a null or unknown exercise identity contributes no equipment (conservative); the rest is unchanged", async () => {
    const a = await athlete();
    const { ids, exerciseIds } = await seed(a);
    await db.update(plannedExercises).set({ exerciseRef: null }).where(eq(plannedExercises.id, exerciseIds.B![1]!));
    await db.update(plannedExercises).set({ exerciseRef: "mystery-machine-move" }).where(eq(plannedExercises.id, exerciseIds.B![2]!));
    const options = await optionsAt().options(a.actor, ids.B!);
    // Only Bench Press remains: barbell + rack + flat bench (planned), dumbbells + adjustable bench (its curated substitutes).
    expect(options.equipmentOptions).toEqual([
      { equipmentId: "barbell", displayLabel: "Barbell (with plates)", relevance: "PLANNED" },
      { equipmentId: "barbell-rack", displayLabel: "Barbell rack / uprights", relevance: "PLANNED" },
      { equipmentId: "flat-bench", displayLabel: "Flat bench", relevance: "PLANNED" },
      { equipmentId: "adjustable-bench", displayLabel: "Adjustable (incline) bench", relevance: "SUBSTITUTE" },
      { equipmentId: "dumbbells", displayLabel: "Dumbbells", relevance: "SUBSTITUTE" },
    ]);
  });

  /** Friday: same inventory for workout C -> the substitute's own last exposure (26 kg / dumbbell) is used. */
  async function athleteNextDayPreview(a: Athlete, plannedWorkoutId: string): Promise<(number | null)[]> {
    const FRI = "2026-10-09T08:00:00Z";
    await previewAndApply(a, plannedWorkoutId, NO_BARBELL, FRI);
    return (await effectivePrescription(a, plannedWorkoutId, FRI)).exercises[0]!.sets.map((s) => s.targetLoad?.amountMilli ?? null);
  }
});

async function cleanup(db: Database, userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  const ids = [...userIds];
  await db.update(equipmentAdaptationApplications).set({ supersedesApplicationId: null }).where(inArray(equipmentAdaptationApplications.userId, ids));
  await db.delete(equipmentAdaptationApplications).where(inArray(equipmentAdaptationApplications.userId, ids));
  await db.delete(availableTimeApplications).where(inArray(availableTimeApplications.userId, ids));
  await db.delete(progressionApplications).where(inArray(progressionApplications.userId, ids));
  await db.delete(progressionDecisions).where(inArray(progressionDecisions.userId, ids));
  const sessionIds = (await db.select({ id: workoutSessions.id }).from(workoutSessions).where(inArray(workoutSessions.userId, ids))).map((r) => r.id);
  if (sessionIds.length > 0) {
    const exerciseIds = (await db.select({ id: performedExercises.id }).from(performedExercises).where(inArray(performedExercises.workoutSessionId, sessionIds))).map((r) => r.id);
    if (exerciseIds.length > 0) await db.delete(performedSets).where(inArray(performedSets.performedExerciseId, exerciseIds));
    await db.delete(performedExercises).where(inArray(performedExercises.workoutSessionId, sessionIds));
  }
  await db.delete(workoutChangeCursor).where(inArray(workoutChangeCursor.userId, ids));
  await db.delete(workoutCommandReceipts).where(inArray(workoutCommandReceipts.userId, ids));
  await db.delete(plannedWorkoutOccurrenceClaims).where(inArray(plannedWorkoutOccurrenceClaims.userId, ids));
  await db.delete(workoutSessions).where(inArray(workoutSessions.userId, ids));
  const profileIds = (await db.select({ id: athleteProfiles.id }).from(athleteProfiles).where(inArray(athleteProfiles.userId, ids))).map((r) => r.id);
  if (profileIds.length > 0) {
    const missedIds = (await db.select({ id: missedWorkoutScheduleApplications.id }).from(missedWorkoutScheduleApplications).where(inArray(missedWorkoutScheduleApplications.athleteProfileId, profileIds))).map((r) => r.id);
    if (missedIds.length > 0) {
      await db.delete(missedWorkoutScheduleAssignments).where(inArray(missedWorkoutScheduleAssignments.applicationId, missedIds));
      await db.update(missedWorkoutScheduleApplications).set({ supersedesApplicationId: null }).where(inArray(missedWorkoutScheduleApplications.id, missedIds));
      await db.delete(missedWorkoutScheduleApplications).where(inArray(missedWorkoutScheduleApplications.id, missedIds));
    }
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
