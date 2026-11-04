import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  createDatabaseClient,
  performedExercises,
  performedSets,
  users,
  workoutChangeCursor,
  workoutCommandReceipts,
  workoutSessions,
  type Database,
} from "@vostivo/database";
import {
  ensureProgressionEvaluateSessionQueues,
  PROGRESSION_EVALUATE_SESSION_QUEUE_V1,
  ProgressionEvaluationService,
  WorkoutHistoryService,
} from "@vostivo/progression-application";
import { createEntityId } from "@vostivo/domain";
import { createLogger } from "@vostivo/observability";
import type {
  CompleteSetCommandV1,
  FinishWorkoutSessionCommandV1,
  ReopenSetCommandV1,
  StartWorkoutSessionCommandV1,
  WorkoutCommandV1,
} from "@vostivo/contracts";
import { WorkoutModule } from "./workout.module.js";
import { WorkoutSyncService } from "./workout-sync.service.js";
import { ErrorEnvelopeFilter } from "../common/filters/error-envelope.filter.js";
import { AUTH_TOKEN_VERIFIER, type AuthTokenVerifier } from "../auth/token-verifier.js";
import { IdentityResolverService } from "../auth/identity-resolver.service.js";
import type { ResolvedIdentity } from "../auth/identity-resolution.js";
import { requireDisposableDatabaseUrl } from "../../../../packages/test-fixtures/src/assert-disposable-test-database.js";

/**
 * CORE-FIX-11 (F-11) — one planned prescription exercise slot of a workout
 * session has ONE canonical server performed exercise, and one planned set
 * slot holds ONE performed set (corrected in place by revision, never
 * duplicated). Pre-fix mobile builds can still deliver commands that carry
 * a second `performedExerciseId` for an occupied slot (a stale render): the
 * server maps them onto the canonical row instead of forking history, and
 * refuses a second set id for an occupied planned set slot. Unplanned
 * exercises (null slot) keep their existing behavior. Real HTTP + real
 * command processing + real Postgres + real pg-boss. Disposable DB only.
 */
const DATABASE_URL = requireDisposableDatabaseUrl("DATABASE_URL");
const LOAD = { kind: "EXTERNAL_WEIGHT", amountMilli: 60000, unit: "KG", basis: "TOTAL" } as const;

const slot = (id: string, exerciseRef: string, order: number) => ({
  prescriptionExerciseId: id,
  exerciseRef,
  displayName: exerciseRef,
  order,
  sets: [1, 2, 3, 4].map((n) => ({
    prescriptionSetId: `${id}-set-${n}`,
    order: n - 1,
    targetReps: { kind: "RANGE", minReps: 8, maxReps: 12 },
    targetLoad: LOAD,
    restSeconds: 90,
    setType: "WORKING",
  })),
});
const PRESCRIPTION = {
  schemaVersion: 1,
  prescriptionId: "f11-server",
  name: "F11 server",
  exercises: [slot("f11-bench-a", "bench-press", 0), slot("f11-bench-b", "bench-press", 1)],
};

function start(workoutSessionId = createEntityId()): StartWorkoutSessionCommandV1 {
  const now = new Date().toISOString();
  return {
    commandId: createEntityId(),
    type: "START_WORKOUT_SESSION_V1",
    schemaVersion: 1,
    createdAt: now,
    workoutSessionId,
    prescription: PRESCRIPTION as unknown as StartWorkoutSessionCommandV1["prescription"],
    startedAt: now,
  };
}

function complete(
  workoutSessionId: string,
  performedExerciseId: string,
  setNumber: number,
  sessionSeq: number,
  overrides: Partial<CompleteSetCommandV1> = {},
): CompleteSetCommandV1 {
  const now = new Date().toISOString();
  return {
    commandId: createEntityId(),
    type: "COMPLETE_SET_V1",
    schemaVersion: 1,
    createdAt: now,
    workoutSessionId,
    performedExerciseId,
    prescriptionExerciseId: "f11-bench-a",
    exerciseRef: "bench-press",
    exerciseDisplayName: "bench-press",
    exerciseOrder: 0,
    performedSetId: createEntityId(),
    prescriptionSetId: `f11-bench-a-set-${setNumber}`,
    setOrder: setNumber - 1,
    actualReps: 12,
    actualLoad: LOAD,
    setType: "WORKING",
    revision: 1,
    completedAt: now,
    sessionSeq,
    ...overrides,
  };
}

function reopen(performedSetId: string, revision: number, sessionSeq: number): ReopenSetCommandV1 {
  const now = new Date().toISOString();
  return {
    commandId: createEntityId(),
    type: "REOPEN_SET_V1",
    schemaVersion: 1,
    createdAt: now,
    performedSetId,
    revision,
    sessionSeq,
  };
}

function finish(workoutSessionId: string, finishSeq: number): FinishWorkoutSessionCommandV1 {
  const now = new Date().toISOString();
  return {
    commandId: createEntityId(),
    type: "FINISH_WORKOUT_SESSION_V1",
    schemaVersion: 1,
    createdAt: now,
    workoutSessionId,
    completedAt: now,
    finishSeq,
  };
}

describe("CORE-FIX-11 — one canonical performed exercise per planned slot (real HTTP + Postgres)", () => {
  let db: Database;
  let boss: PgBoss;
  let app: NestFastifyApplication;
  const userIds: string[] = [];
  let actorUserId = "";

  beforeAll(async () => {
    db = createDatabaseClient(DATABASE_URL);
    boss = new PgBoss({
      connectionString: DATABASE_URL,
      migrate: false,
      supervise: false,
      schedule: false,
    });
    await boss.start();
    await ensureProgressionEvaluateSessionQueues(boss);
    const verifier: AuthTokenVerifier = {
      verify: () =>
        Promise.resolve({ subject: "f11-test", issuer: "test-issuer", audience: "authenticated" }),
    };
    const resolver = {
      resolve: (): Promise<ResolvedIdentity> =>
        Promise.resolve({
          userId: actorUserId,
          userStatus: "ACTIVE",
          athleteProfileId: createEntityId(),
          experienceMode: "GUIDED",
          unitSystem: "METRIC",
        }),
    };
    const moduleRef = await Test.createTestingModule({ imports: [WorkoutModule] })
      .overrideProvider(AUTH_TOKEN_VERIFIER)
      .useValue(verifier)
      .overrideProvider(IdentityResolverService)
      .useValue(resolver)
      .overrideProvider(WorkoutSyncService)
      .useValue(new WorkoutSyncService(db, boss))
      .overrideProvider(WorkoutHistoryService)
      .useValue({})
      .overrideProvider(ProgressionEvaluationService)
      .useValue({})
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(
      new ErrorEnvelopeFilter(createLogger({ serviceName: "f11-identity-test" })),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    await cleanup(db, userIds);
    await boss.stop();
  });

  beforeEach(async () => {
    await cleanup(db, userIds);
    userIds.length = 0;
    actorUserId = await createAthlete();
  });

  async function createAthlete(): Promise<string> {
    const id = createEntityId();
    await db.insert(users).values({ id, status: "ACTIVE" });
    userIds.push(id);
    return id;
  }

  async function sync(commands: readonly WorkoutCommandV1[], as = actorUserId) {
    const previous = actorUserId;
    actorUserId = as;
    try {
      const response = await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: "POST",
          url: "/sync/workout-commands",
          payload: { ownerUserId: as, commands },
          headers: { authorization: "Bearer test" },
        });
      const body = response.json<{ acknowledgements?: { outcome: string }[] }>();
      return {
        status: response.statusCode,
        outcomes: body.acknowledgements?.map((ack) => ack.outcome) ?? null,
      };
    } finally {
      actorUserId = previous;
    }
  }

  const exercisesOf = (sessionId: string, prescriptionExerciseId = "f11-bench-a") =>
    db
      .select()
      .from(performedExercises)
      .where(
        and(
          eq(performedExercises.workoutSessionId, sessionId),
          eq(performedExercises.prescriptionExerciseId, prescriptionExerciseId),
        ),
      );
  const setsOfSession = async (sessionId: string) => {
    const exercises = await db
      .select({ id: performedExercises.id })
      .from(performedExercises)
      .where(eq(performedExercises.workoutSessionId, sessionId));
    if (exercises.length === 0) return [];
    return db
      .select()
      .from(performedSets)
      .where(
        inArray(
          performedSets.performedExerciseId,
          exercises.map((e) => e.id),
        ),
      );
  };
  const receiptOf = (userId: string, commandId: string) =>
    db
      .select()
      .from(workoutCommandReceipts)
      .where(
        and(
          eq(workoutCommandReceipts.userId, userId),
          eq(workoutCommandReceipts.commandId, commandId),
        ),
      );

  it("F11-S01 a stale second performedExerciseId for an occupied planned slot is mapped onto the canonical row", async () => {
    const s = start();
    const canonical = createEntityId();
    const fragment = createEntityId();
    const commands = [
      s,
      complete(s.workoutSessionId, canonical, 1, 1),
      complete(s.workoutSessionId, fragment, 2, 2),
      complete(s.workoutSessionId, fragment, 3, 3),
    ];
    expect(await sync(commands)).toEqual({
      status: 201,
      outcomes: ["APPLIED", "APPLIED", "APPLIED", "APPLIED"],
    });
    expect((await exercisesOf(s.workoutSessionId)).map((e) => e.id)).toEqual([canonical]);
    const sets = await setsOfSession(s.workoutSessionId);
    expect(sets).toHaveLength(3);
    expect(new Set(sets.map((x) => x.performedExerciseId))).toEqual(new Set([canonical]));
    // Exact replay of everything: idempotent, nothing changes.
    expect(await sync(commands)).toEqual({
      status: 201,
      outcomes: ["DUPLICATE", "DUPLICATE", "DUPLICATE", "DUPLICATE"],
    });
    expect(await setsOfSession(s.workoutSessionId)).toHaveLength(3);
  });

  it("F11-S02 a double tap (second set id for an occupied planned set slot) is REJECTED with a receipt, original untouched", async () => {
    const s = start();
    const canonical = createEntityId();
    const first = complete(s.workoutSessionId, canonical, 1, 1);
    const sameSlotSameExercise = complete(s.workoutSessionId, canonical, 1, 2, { actualReps: 11 });
    const sameSlotFragment = complete(s.workoutSessionId, createEntityId(), 1, 3, {
      actualReps: 10,
    });
    expect(await sync([s, first, sameSlotSameExercise, sameSlotFragment])).toEqual({
      status: 201,
      outcomes: ["APPLIED", "APPLIED", "REJECTED", "REJECTED"],
    });
    const sets = await setsOfSession(s.workoutSessionId);
    expect(sets).toEqual([
      expect.objectContaining({ id: first.performedSetId, actualReps: 12, revision: 1 }),
    ]);
    expect(await exercisesOf(s.workoutSessionId)).toHaveLength(1);
    expect(await receiptOf(actorUserId, sameSlotFragment.commandId)).toEqual([
      expect.objectContaining({ outcome: "REJECTED" }),
    ]);
    // Deterministic on replay: the stored receipt answers (a stored REJECTED replays as REJECTED).
    expect((await sync([sameSlotSameExercise, sameSlotFragment])).outcomes).toEqual([
      "REJECTED",
      "REJECTED",
    ]);
  });

  it("F11-S03 reopen + recomplete of a mapped set through the fragment id stays a legitimate correction", async () => {
    const s = start();
    const canonical = createEntityId();
    const fragment = createEntityId();
    const mapped = complete(s.workoutSessionId, fragment, 2, 2);
    const recomplete = {
      ...complete(s.workoutSessionId, fragment, 2, 4, { actualReps: 9, revision: 3 }),
      performedSetId: mapped.performedSetId,
    };
    expect(
      await sync([
        s,
        complete(s.workoutSessionId, canonical, 1, 1),
        mapped,
        reopen(mapped.performedSetId, 2, 3),
        recomplete,
      ]),
    ).toEqual({
      status: 201,
      outcomes: ["APPLIED", "APPLIED", "APPLIED", "APPLIED", "APPLIED"],
    });
    const [row] = (await setsOfSession(s.workoutSessionId)).filter(
      (x) => x.id === mapped.performedSetId,
    );
    expect(row).toEqual(
      expect.objectContaining({
        performedExerciseId: canonical,
        actualReps: 9,
        revision: 3,
        completionState: "COMPLETED",
      }),
    );
  });

  it("F11-S04 the same exerciseRef in two planned slots stays two performed exercises", async () => {
    const s = start();
    const a = createEntityId();
    const b = createEntityId();
    const slotB = { prescriptionExerciseId: "f11-bench-b", exerciseOrder: 1 };
    expect(
      (
        await sync([
          s,
          complete(s.workoutSessionId, a, 1, 1),
          complete(s.workoutSessionId, b, 1, 2, {
            ...slotB,
            prescriptionSetId: "f11-bench-b-set-1",
          }),
          complete(s.workoutSessionId, b, 2, 3, {
            ...slotB,
            prescriptionSetId: "f11-bench-b-set-2",
            setOrder: 1,
          }),
        ])
      ).outcomes,
    ).toEqual(["APPLIED", "APPLIED", "APPLIED", "APPLIED"]);
    expect((await exercisesOf(s.workoutSessionId, "f11-bench-a")).map((e) => e.id)).toEqual([a]);
    expect((await exercisesOf(s.workoutSessionId, "f11-bench-b")).map((e) => e.id)).toEqual([b]);
  });

  it("F11-S05 unplanned exercises (null slot) keep their existing identity behavior", async () => {
    const s = start();
    const unplanned = (id: string, seq: number) =>
      complete(s.workoutSessionId, id, 1, seq, {
        prescriptionExerciseId: null,
        prescriptionSetId: null,
        exerciseRef: "cable-fly",
        exerciseDisplayName: "Cable Fly",
        exerciseOrder: 9,
      });
    const x = createEntityId();
    expect(
      (await sync([s, unplanned(x, 1), unplanned(x, 2), unplanned(createEntityId(), 3)])).outcomes,
    ).toEqual(["APPLIED", "APPLIED", "APPLIED", "APPLIED"]);
    const rows = await db
      .select()
      .from(performedExercises)
      .where(eq(performedExercises.workoutSessionId, s.workoutSessionId));
    expect(rows).toHaveLength(2);
    expect(await setsOfSession(s.workoutSessionId)).toHaveLength(3);
  });

  it("F11-S06 cross-athlete: canonical mapping never reaches into another athlete's session or exercise (CORE-FIX-01 intact)", async () => {
    const athleteA = actorUserId;
    const athleteB = await createAthlete();
    const sA = start();
    const exA = createEntityId();
    await sync([sA, complete(sA.workoutSessionId, exA, 1, 1)], athleteA);
    // B targets A's session -> stateless REJECTED, no receipt, no row.
    const intoA = complete(sA.workoutSessionId, createEntityId(), 2, 2);
    expect((await sync([intoA], athleteB)).outcomes).toEqual(["REJECTED"]);
    expect(await receiptOf(athleteB, intoA.commandId)).toEqual([]);
    // B reuses A's performedExerciseId in B's own session -> REJECTED, nothing of A's touched.
    const sB = start();
    const reuse = complete(sB.workoutSessionId, exA, 1, 1);
    expect((await sync([sB, reuse], athleteB)).outcomes).toEqual(["APPLIED", "REJECTED"]);
    expect(await setsOfSession(sA.workoutSessionId)).toHaveLength(1);
    expect(await exercisesOf(sB.workoutSessionId)).toEqual([]);
  });

  it("F11-S07 concurrent deliveries with different fragment ids for one slot converge to one performed exercise (20 rounds)", async () => {
    for (let round = 0; round < 20; round++) {
      const s = start();
      expect((await sync([s])).outcomes).toEqual(["APPLIED"]);
      const results = await Promise.all([
        sync([complete(s.workoutSessionId, createEntityId(), 1, 1)]),
        sync([complete(s.workoutSessionId, createEntityId(), 2, 2)]),
        sync([complete(s.workoutSessionId, createEntityId(), 3, 3)]),
      ]);
      expect(results.map((r) => r.outcomes)).toEqual([["APPLIED"], ["APPLIED"], ["APPLIED"]]);
      expect({ round, exercises: (await exercisesOf(s.workoutSessionId)).length }).toEqual({
        round,
        exercises: 1,
      });
      expect(await setsOfSession(s.workoutSessionId)).toHaveLength(3);
    }
  });

  it("F11-S08 a pre-fix fragmented server session is extended deterministically (earliest row is canonical, no slot duplicated)", async () => {
    const s = start();
    const early = createEntityId();
    expect((await sync([s, complete(s.workoutSessionId, early, 1, 1)])).outcomes).toEqual([
      "APPLIED",
      "APPLIED",
    ]);
    // What the pre-fix server already persisted: a second row for the slot holding set 2.
    const late = createEntityId();
    await db.insert(performedExercises).values({
      id: late,
      workoutSessionId: s.workoutSessionId,
      prescriptionExerciseId: "f11-bench-a",
      exerciseRef: "bench-press",
      displayName: "bench-press",
      orderIndex: 0,
      createdAt: new Date(Date.now() + 1000),
    });
    const legacySetId = createEntityId();
    await db.insert(performedSets).values({
      id: legacySetId,
      performedExerciseId: late,
      prescriptionSetId: "f11-bench-a-set-2",
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
    const newSet = complete(s.workoutSessionId, late, 3, 2);
    const dupOfLegacy = complete(s.workoutSessionId, early, 2, 3);
    const legacyCorrection = {
      ...complete(s.workoutSessionId, late, 2, 4, { actualReps: 11, revision: 2 }),
      performedSetId: legacySetId,
    };
    expect((await sync([newSet, dupOfLegacy, legacyCorrection])).outcomes).toEqual([
      "APPLIED",
      "REJECTED",
      "APPLIED",
    ]);
    const sets = await setsOfSession(s.workoutSessionId);
    expect(sets.find((x) => x.id === newSet.performedSetId)?.performedExerciseId).toBe(early);
    // The historical row is never moved or rewritten by this read path — only corrected in place.
    expect(sets.find((x) => x.id === legacySetId)).toEqual(
      expect.objectContaining({ performedExerciseId: late, actualReps: 11, revision: 2 }),
    );
    expect(sets.filter((x) => x.prescriptionSetId === "f11-bench-a-set-2")).toHaveLength(1);
  });

  it("F11-S09 completed lifecycle: a late causally-valid fragment applies to the canonical row and re-triggers progression; post-Finish stays REJECTED", async () => {
    const s = start();
    const canonical = createEntityId();
    const late = complete(s.workoutSessionId, createEntityId(), 2, 2);
    expect(
      (
        await sync([
          s,
          complete(s.workoutSessionId, canonical, 1, 1),
          finish(s.workoutSessionId, 2),
        ])
      ).outcomes,
    ).toEqual(["APPLIED", "APPLIED", "APPLIED"]);
    expect(
      (await sync([late, complete(s.workoutSessionId, createEntityId(), 3, 3)])).outcomes,
    ).toEqual(["APPLIED", "REJECTED"]);
    expect((await exercisesOf(s.workoutSessionId)).map((e) => e.id)).toEqual([canonical]);
    const jobs = await boss.findJobs(PROGRESSION_EVALUATE_SESSION_QUEUE_V1, {
      data: { workoutSessionId: s.workoutSessionId },
    });
    expect(jobs.length).toBe(2); // FINISH + the late APPLIED correction
    expect(
      (await db.select().from(workoutSessions).where(eq(workoutSessions.id, s.workoutSessionId)))[0]
        ?.status,
    ).toBe("COMPLETED");
  });
});

async function cleanup(db: Database, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  const sessions = await db
    .select({ id: workoutSessions.id })
    .from(workoutSessions)
    .where(inArray(workoutSessions.userId, userIds));
  const sessionIds = sessions.map((s) => s.id);
  if (sessionIds.length > 0) {
    const exercises = await db
      .select({ id: performedExercises.id })
      .from(performedExercises)
      .where(inArray(performedExercises.workoutSessionId, sessionIds));
    const exerciseIds = exercises.map((e) => e.id);
    if (exerciseIds.length > 0)
      await db.delete(performedSets).where(inArray(performedSets.performedExerciseId, exerciseIds));
    await db
      .delete(performedExercises)
      .where(inArray(performedExercises.workoutSessionId, sessionIds));
  }
  await db.delete(workoutChangeCursor).where(inArray(workoutChangeCursor.userId, userIds));
  await db.delete(workoutCommandReceipts).where(inArray(workoutCommandReceipts.userId, userIds));
  await db.delete(workoutSessions).where(inArray(workoutSessions.userId, userIds));
  await db.delete(users).where(inArray(users.id, userIds));
}
