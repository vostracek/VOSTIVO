import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { sql } from "drizzle-orm";
import type { AvailableTimePreviewResponseV1, StartWorkoutSessionCommandV1, WorkoutPreviewV1 } from "@vostivo/contracts";
import { createEntityId, type PrescribedSetV1, type WorkoutPrescriptionV1 } from "@vostivo/domain";
import { openTestLocalDatabase, type TestDatabaseConnection } from "../local-database/testing/node-sqlite-database";
import { AdjustedWorkoutStartService, type WorkoutSyncRequester } from "./adjusted-workout-start";
import { WorkoutRepository } from "./workout-repository";

/**
 * Available-Time Adaptation V1 — Slice C: "Start adjusted workout" through
 * the REAL WorkoutRepository SQL, the REAL local migrations and drizzle's
 * REAL transaction handling, on a real (file-backed) SQLite engine.
 */
function id(n: number): string {
  return `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
}

const WORKOUT = id(1);
const VERSION = id(2);
const BENCH = id(10);
const OHP = id(20);
const BENCH_WARM_UP = id(100);
const [BENCH_S1, BENCH_S2, BENCH_S3] = [id(101), id(102), id(103)];
const [OHP_S1, OHP_S2] = [id(201), id(202)];
const PROGRESSED = { kind: "EXTERNAL_WEIGHT", amountMilli: 62500, unit: "KG", basis: "TOTAL" } as const;

function set(prescriptionSetId: string, order: number, overrides: Partial<PrescribedSetV1> = {}): PrescribedSetV1 {
  return { prescriptionSetId, order, targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 }, targetLoad: PROGRESSED, restSeconds: 90, setType: "WORKING", ...overrides };
}

/** The server's effective Workout Preview prescription (Bench progressed to 62.5kg, with a warm-up). Rows deliberately out of order. */
function workoutPreview(): WorkoutPreviewV1 {
  const prescription: WorkoutPrescriptionV1 = {
    schemaVersion: 1,
    prescriptionId: WORKOUT,
    name: "Upper Body A",
    exercises: [
      { prescriptionExerciseId: OHP, exerciseRef: "overhead-press", displayName: "Overhead Press", order: 2, sets: [set(OHP_S2, 2, { targetLoad: { ...PROGRESSED, amountMilli: 30000 } }), set(OHP_S1, 1, { targetLoad: { ...PROGRESSED, amountMilli: 30000 } })] },
      {
        prescriptionExerciseId: BENCH,
        exerciseRef: "bench-press",
        displayName: "Bench Press",
        order: 1,
        sets: [set(BENCH_S3, 3), set(BENCH_S1, 1), set(BENCH_WARM_UP, 0, { setType: "WARM_UP", targetLoad: { ...PROGRESSED, amountMilli: 40000 }, restSeconds: 60 }), set(BENCH_S2, 2)],
      },
    ],
  };
  return { plannedWorkoutId: WORKOUT, name: "Upper Body A", focus: "Push emphasis", estimatedDurationMinutes: 60, displayStatus: "TODAY", hasActiveSession: false, canStart: true, exercises: [], prescription };
}

/** A server ADJUST_SESSION preview: Bench keeps warm-up + 2 working (S3 removed), OHP removed entirely. */
function availableTimePreview(overrides: Partial<AvailableTimePreviewResponseV1> = {}): AvailableTimePreviewResponseV1 {
  return {
    policyVersion: "available-time/v1",
    plannedWorkoutId: WORKOUT,
    sourceProgramVersionId: VERSION,
    availableMinutes: 5,
    result: "ADJUST_SESSION",
    fitsAvailableTime: true,
    originalEstimatedSeconds: 630,
    adjustedEstimatedSeconds: 300,
    minimumEstimatedSeconds: null,
    previewFingerprint: "e".repeat(64),
    exercises: [
      { plannedExerciseId: BENCH, exerciseRef: "bench-press", displayName: "Bench Press", priorityTier: "TIER_1", originalWorkingSetCount: 3, retainedWorkingSetCount: 2, removedWorkingSetCount: 1, originalTotalSetCount: 4, retainedTotalSetCount: 3, minimumWorkingSets: 2, removedEntireExercise: false, retainedPlannedSetIds: [BENCH_WARM_UP, BENCH_S1, BENCH_S2], removedPlannedSetIds: [BENCH_S3] },
      { plannedExerciseId: OHP, exerciseRef: "overhead-press", displayName: "Overhead Press", priorityTier: "TIER_2", originalWorkingSetCount: 2, retainedWorkingSetCount: 0, removedWorkingSetCount: 2, originalTotalSetCount: 2, retainedTotalSetCount: 0, minimumWorkingSets: 0, removedEntireExercise: true, retainedPlannedSetIds: [], removedPlannedSetIds: [OHP_S1, OHP_S2] },
    ],
    ...overrides,
  };
}

class RecordingSyncRequester implements WorkoutSyncRequester {
  readonly observedAtRequest: { sessions: number; outbox: number }[] = [];
  constructor(private readonly connection: () => TestDatabaseConnection) {}
  requestSync(): void {
    // Records what is ALREADY durable at the moment sync is requested.
    this.observedAtRequest.push(counts(this.connection()));
  }
}

function counts(connection: TestDatabaseConnection): { sessions: number; outbox: number } {
  const sessions = connection.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM local_workout_sessions`)!.n;
  const outbox = connection.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM sync_outbox`)!.n;
  return { sessions, outbox };
}

function outboxStartCommands(connection: TestDatabaseConnection): StartWorkoutSessionCommandV1[] {
  return connection.db
    .all<{ payload_json: string }>(sql`SELECT payload_json FROM sync_outbox WHERE command_type = 'START_WORKOUT_SESSION_V1'`)
    .map((row) => JSON.parse(row.payload_json) as StartWorkoutSessionCommandV1);
}

describe("startAdjustedWorkout — local-first adjusted START (real SQLite)", () => {
  let path: string;
  let connection: TestDatabaseConnection;
  let repository: WorkoutRepository;
  let sync: RecordingSyncRequester;
  let service: AdjustedWorkoutStartService;

  /** A fresh app process: new connection, new repository/service — nothing carried over in memory. */
  function launch(): void {
    connection = openTestLocalDatabase(path);
    const db = connection.db;
    repository = new WorkoutRepository(() => Promise.resolve(db));
    sync = new RecordingSyncRequester(() => connection);
    service = new AdjustedWorkoutStartService(repository, sync);
  }

  beforeEach(() => {
    path = `${tmpdir()}/vostivo-adjusted-start-${createEntityId()}.db`;
    launch();
  });

  afterEach(() => {
    connection.close();
    rmSync(path, { force: true });
  });

  it("1/4/5/7/8/9/10: ADJUST_SESSION starts the exact retained structure — removed sets and the removed exercise are absent, order canonical, warm-up kept", async () => {
    const outcome = await service.startAdjustedWorkout({ workoutPreview: workoutPreview(), availableTimePreview: availableTimePreview() });

    expect(outcome.status).toBe("STARTED");
    if (outcome.status !== "STARTED") return;
    expect(outcome.session.prescription.exercises.map((e) => [e.prescriptionExerciseId, e.sets.map((s) => [s.prescriptionSetId, s.setType])])).toEqual([
      [BENCH, [[BENCH_WARM_UP, "WARM_UP"], [BENCH_S1, "WORKING"], [BENCH_S2, "WORKING"]]],
    ]);
    expect(outcome.session.prescription).toMatchObject({ schemaVersion: 1, prescriptionId: WORKOUT, name: "Upper Body A" });
  });

  it("6: the immutable application carries the server's exact retained/removed ids, partitioning every authored set", async () => {
    const outcome = await service.startAdjustedWorkout({ workoutPreview: workoutPreview(), availableTimePreview: availableTimePreview() });
    if (outcome.status !== "STARTED") throw new Error(outcome.status);
    const application = outcome.session.availableTimeApplication!;
    expect(application).toMatchObject({ scope: "TODAY_ONLY", policyVersion: "available-time/v1", plannedWorkoutId: WORKOUT, sourceProgramVersionId: VERSION, availableMinutes: 5, previewFingerprint: "e".repeat(64), originalEstimatedSeconds: 630, adjustedEstimatedSeconds: 300 });
    expect(application.exercises).toEqual([
      { plannedExerciseId: BENCH, retainedPlannedSetIds: [BENCH_WARM_UP, BENCH_S1, BENCH_S2], removedPlannedSetIds: [BENCH_S3] },
      { plannedExerciseId: OHP, retainedPlannedSetIds: [], removedPlannedSetIds: [OHP_S1, OHP_S2] },
    ]);
    const all = application.exercises.flatMap((e) => [...e.retainedPlannedSetIds, ...e.removedPlannedSetIds]).sort();
    expect(all).toEqual([BENCH_WARM_UP, BENCH_S1, BENCH_S2, BENCH_S3, OHP_S1, OHP_S2].sort());
  });

  it("11: retained sets keep the progressed/effective load, reps, rest and type verbatim", async () => {
    const outcome = await service.startAdjustedWorkout({ workoutPreview: workoutPreview(), availableTimePreview: availableTimePreview() });
    if (outcome.status !== "STARTED") throw new Error(outcome.status);
    const [warmUp, s1, s2] = outcome.session.prescription.exercises[0]!.sets;
    expect(warmUp).toEqual(set(BENCH_WARM_UP, 0, { setType: "WARM_UP", targetLoad: { ...PROGRESSED, amountMilli: 40000 }, restSeconds: 60 }));
    expect([s1, s2]).toEqual([set(BENCH_S1, 1), set(BENCH_S2, 2)]);
  });

  it("12: the source (server) prescription is never mutated", async () => {
    const preview = workoutPreview();
    const before = JSON.stringify(preview);
    await service.startAdjustedWorkout({ workoutPreview: preview, availableTimePreview: availableTimePreview() });
    expect(JSON.stringify(preview)).toBe(before);
  });

  it("13: session + immutable snapshot + application + START outbox command are written together, and agree", async () => {
    const outcome = await service.startAdjustedWorkout({ workoutPreview: workoutPreview(), availableTimePreview: availableTimePreview() });
    if (outcome.status !== "STARTED") throw new Error(outcome.status);

    expect(counts(connection)).toEqual({ sessions: 1, outbox: 1 });
    const row = connection.db.get<{ id: string; prescription_json: string; available_time_application_json: string }>(
      sql`SELECT id, prescription_json, available_time_application_json FROM local_workout_sessions`,
    )!;
    const [start] = outboxStartCommands(connection);
    expect(start!.workoutSessionId).toBe(row.id);
    expect(start!.prescription).toEqual(JSON.parse(row.prescription_json));
    expect(start!.availableTimeApplication).toEqual(JSON.parse(row.available_time_application_json));
    expect(start!.availableTimeApplication).toEqual(outcome.session.availableTimeApplication);
  });

  it("14: a failure inside the local transaction leaves NOTHING behind — no session, no metadata, no command, no sync", async () => {
    connection.exec(`CREATE TRIGGER simulated_outbox_failure BEFORE INSERT ON sync_outbox BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;`);

    await expect(service.startAdjustedWorkout({ workoutPreview: workoutPreview(), availableTimePreview: availableTimePreview() })).rejects.toThrow();

    expect(counts(connection)).toEqual({ sessions: 0, outbox: 0 });
    expect(sync.observedAtRequest).toEqual([]);
  });

  it("15/16: no network is needed — the start returns after the local commit, and sync is requested only once it is durable", async () => {
    const outcome = await service.startAdjustedWorkout({ workoutPreview: workoutPreview(), availableTimePreview: availableTimePreview() });
    expect(outcome.status).toBe("STARTED");
    expect(sync.observedAtRequest).toEqual([{ sessions: 1, outbox: 1 }]);
    expect(connection.db.get<{ status: string }>(sql`SELECT status FROM sync_outbox`)!.status).toBe("PENDING");
  });

  it("17/18: process death before sync — relaunch recovers the SAME adjusted session, provenance and pending START; no second session", async () => {
    const started = await service.startAdjustedWorkout({ workoutPreview: workoutPreview(), availableTimePreview: availableTimePreview() });
    if (started.status !== "STARTED") throw new Error(started.status);

    connection.close(); // the process dies before any sync
    launch();

    const recovered = await repository.getActiveWorkoutSession();
    expect(recovered?.id).toBe(started.session.id);
    expect(recovered?.prescription).toEqual(started.session.prescription);
    expect(recovered?.availableTimeApplication).toEqual(started.session.availableTimeApplication);
    const pending = await repository.getPendingCommands(10);
    expect(pending.map((c) => c.payload.type)).toEqual(["START_WORKOUT_SESSION_V1"]);

    const again = await service.startAdjustedWorkout({ workoutPreview: workoutPreview(), availableTimePreview: availableTimePreview() });
    expect(again).toMatchObject({ status: "ALREADY_ACTIVE", session: { id: started.session.id } });
    expect(counts(connection)).toEqual({ sessions: 1, outbox: 1 });
    expect(sync.observedAtRequest).toEqual([]); // nothing new to sync
  });

  it.each(["NO_CHANGE", "CANNOT_FIT_MINIMUM"] as const)("2/3: %s is NOT applicable through the adjusted path — nothing written, no sync", async (result) => {
    const outcome = await service.startAdjustedWorkout({ workoutPreview: workoutPreview(), availableTimePreview: availableTimePreview({ result }) });
    expect(outcome).toEqual({ status: "NOT_APPLICABLE", result });
    expect(counts(connection)).toEqual({ sessions: 0, outbox: 0 });
    expect(sync.observedAtRequest).toEqual([]);
  });

  it.each([
    ["WORKOUT_MISMATCH", availableTimePreview({ plannedWorkoutId: id(999) })],
    ["COUNTS_DISAGREE_WITH_IDS", availableTimePreview({ exercises: [{ ...availableTimePreview().exercises[0]!, retainedTotalSetCount: 4 }, availableTimePreview().exercises[1]!] })],
    ["PARTITION_MISMATCH", availableTimePreview({ exercises: [{ ...availableTimePreview().exercises[0]!, removedPlannedSetIds: [], originalTotalSetCount: 3 }, availableTimePreview().exercises[1]!] })],
  ])("a preview that does not exactly describe this workout fails closed (%s) — nothing written", async (reason, preview) => {
    const outcome = await service.startAdjustedWorkout({ workoutPreview: workoutPreview(), availableTimePreview: preview });
    expect(outcome).toEqual({ status: "INVALID_PREVIEW", reason });
    expect(counts(connection)).toEqual({ sessions: 0, outbox: 0 });
  });

  it("19: an ordinary START is unchanged — no metadata column value, no availableTimeApplication key in the START payload", async () => {
    const full = workoutPreview().prescription;
    const outcome = await repository.startWorkoutSession(full);
    if (outcome.status !== "STARTED") throw new Error(outcome.status);

    expect(outcome.session.availableTimeApplication).toBeNull();
    expect(outcome.session.prescription).toEqual(full);
    const [start] = outboxStartCommands(connection);
    expect(Object.keys(start!).sort()).toEqual(["commandId", "createdAt", "prescription", "schemaVersion", "startedAt", "type", "workoutSessionId"]);
    expect(connection.db.get<{ v: string | null }>(sql`SELECT available_time_application_json AS v FROM local_workout_sessions`)!.v).toBeNull();
  });

  it("20: SyncEngine's outbox port hands the adjusted START to sync unchanged (coordinator untouched)", async () => {
    const outcome = await service.startAdjustedWorkout({ workoutPreview: workoutPreview(), availableTimePreview: availableTimePreview() });
    if (outcome.status !== "STARTED") throw new Error(outcome.status);
    const [pending] = await repository.getPendingCommands(10);
    expect(pending!.payload).toMatchObject({ type: "START_WORKOUT_SESSION_V1", workoutSessionId: outcome.session.id, availableTimeApplication: outcome.session.availableTimeApplication });
  });
});
