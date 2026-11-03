import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
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
  StartWorkoutSessionCommandV1,
  WorkoutCommandV1,
} from "@vostivo/contracts";
import { WorkoutModule } from "./workout.module.js";
import { WorkoutSyncService } from "./workout-sync.service.js";
import { processWorkoutCommand } from "./workout-command-processing.js";
import { ErrorEnvelopeFilter } from "../common/filters/error-envelope.filter.js";
import { AUTH_TOKEN_VERIFIER, type AuthTokenVerifier } from "../auth/token-verifier.js";
import { IdentityResolverService } from "../auth/identity-resolver.service.js";
import type { ResolvedIdentity } from "../auth/identity-resolution.js";
import { requireDisposableDatabaseUrl } from "../../../../packages/test-fixtures/src/assert-disposable-test-database.js";

/**
 * CORE-FIX-02 (CORE-AUDIT-01 F-02) — a structurally malformed prescription
 * snapshot must never turn the workout sync endpoint into a deterministic
 * HTTP 500 (which the mobile outbox treats as transient and resends
 * forever, oldest-first, starving every later command of the athlete).
 * Real HTTP pipeline (global ValidationPipe + ErrorEnvelopeFilter) + real
 * command processing + real Postgres + real pg-boss. Disposable DB only.
 */
const DATABASE_URL = requireDisposableDatabaseUrl("DATABASE_URL");

const VALID_EXERCISE = {
  prescriptionExerciseId: "snap-ex-1",
  exerciseRef: "bench-press",
  displayName: "Barbell Bench Press",
  order: 0,
  sets: [
    {
      prescriptionSetId: "snap-set-1",
      order: 0,
      targetReps: { kind: "EXACT", reps: 10 },
      targetLoad: null,
      restSeconds: 90,
      setType: "WORKING",
    },
  ],
};

/** The current, complete shape (what Workout Preview produces today). */
const CURRENT_PRESCRIPTION = {
  schemaVersion: 1,
  prescriptionId: "snap-current",
  name: "Current",
  exercises: [VALID_EXERCISE],
};

/**
 * A real historical shape: frozen before `setType`/`restSeconds` existed
 * (see apps/mobile/src/workout/prescription-compat.ts) and with a legacy
 * `exerciseRef: null` slot. An old START still waiting in an outbox may
 * carry exactly this — it must keep working.
 */
const LEGACY_PRESCRIPTION = {
  schemaVersion: 1,
  prescriptionId: "snap-legacy",
  name: "Legacy",
  exercises: [
    {
      prescriptionExerciseId: "snap-ex-1",
      exerciseRef: null,
      displayName: "Bench",
      order: 0,
      sets: [
        {
          prescriptionSetId: "snap-set-1",
          order: 0,
          targetReps: { kind: "EXACT", reps: 10 },
          targetLoad: null,
        },
      ],
    },
  ],
};

/**
 * Shapes the current top-level check (`schemaVersion`, `prescriptionId`,
 * `name`, `Array.isArray(exercises)`) accepts but that break the snapshot's
 * own contract (`PrescribedExerciseV1` / `PrescribedSetV1`).
 */
const MALFORMED: Record<string, unknown[]> = {
  "null exercise": [null],
  "string exercise": ["bench"],
  "exercise without sets": [
    {
      prescriptionExerciseId: "snap-ex-1",
      exerciseRef: "bench-press",
      displayName: "Bench",
      order: 0,
    },
  ],
  "sets not an array": [{ ...VALID_EXERCISE, sets: "3x10" }],
  "null set": [{ ...VALID_EXERCISE, sets: [null] }],
  "set without prescriptionSetId": [
    { ...VALID_EXERCISE, sets: [{ order: 0, targetReps: null, targetLoad: null }] },
  ],
  "numeric prescriptionExerciseId": [{ ...VALID_EXERCISE, prescriptionExerciseId: 7 }],
  "missing displayName": [
    {
      prescriptionExerciseId: "snap-ex-1",
      exerciseRef: "bench-press",
      order: 0,
      sets: VALID_EXERCISE.sets,
    },
  ],
};

function start(prescription: unknown): StartWorkoutSessionCommandV1 {
  const now = new Date().toISOString();
  return {
    commandId: createEntityId(),
    type: "START_WORKOUT_SESSION_V1",
    schemaVersion: 1,
    createdAt: now,
    workoutSessionId: createEntityId(),
    prescription: prescription as StartWorkoutSessionCommandV1["prescription"],
    startedAt: now,
  };
}

function complete(
  workoutSessionId: string,
  overrides: Partial<CompleteSetCommandV1> = {},
): CompleteSetCommandV1 {
  const now = new Date().toISOString();
  return {
    commandId: createEntityId(),
    type: "COMPLETE_SET_V1",
    schemaVersion: 1,
    createdAt: now,
    workoutSessionId,
    performedExerciseId: createEntityId(),
    prescriptionExerciseId: "snap-ex-1",
    exerciseRef: "bench-press",
    exerciseDisplayName: "Barbell Bench Press",
    exerciseOrder: 0,
    performedSetId: createEntityId(),
    prescriptionSetId: "snap-set-1",
    setOrder: 0,
    actualReps: 10,
    actualLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: 60000, unit: "KG", basis: "TOTAL" },
    setType: "WORKING",
    revision: 1,
    completedAt: now,
    sessionSeq: 1,
    ...overrides,
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

describe("CORE-FIX-02 — malformed prescription snapshots never become a deterministic sync 500 (real HTTP + Postgres)", () => {
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
        Promise.resolve({
          subject: "snapshot-test",
          issuer: "test-issuer",
          audience: "authenticated",
        }),
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
      // The REAL service over the disposable database — not a fake.
      .overrideProvider(WorkoutSyncService)
      .useValue(new WorkoutSyncService(db, boss))
      .overrideProvider(WorkoutHistoryService)
      .useValue({})
      .overrideProvider(ProgressionEvaluationService)
      .useValue({})
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // Same global pipe + error envelope as main.ts.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(
      new ErrorEnvelopeFilter(createLogger({ serviceName: "snapshot-validation-test" })),
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

  async function sync(commands: readonly WorkoutCommandV1[]) {
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: "POST",
        url: "/sync/workout-commands",
        payload: { ownerUserId: actorUserId, commands },
        headers: { authorization: "Bearer test" },
      });
    const body = response.json<{ acknowledgements?: { commandId: string; outcome: string }[] }>();
    return {
      status: response.statusCode,
      outcomes: body.acknowledgements?.map((ack) => ack.outcome) ?? null,
    };
  }

  const sessionRow = (id: string) =>
    db.select().from(workoutSessions).where(eq(workoutSessions.id, id));
  const exercisesOf = (sessionId: string) =>
    db.select().from(performedExercises).where(eq(performedExercises.workoutSessionId, sessionId));
  const receiptOf = (commandId: string) =>
    db.select().from(workoutCommandReceipts).where(eq(workoutCommandReceipts.commandId, commandId));
  const jobsFor = (workoutSessionId: string) =>
    boss.findJobs(PROGRESSION_EVALUATE_SESSION_QUEUE_V1, { data: { workoutSessionId } });

  for (const [label, exercises] of Object.entries(MALFORMED)) {
    it(`SNAP-001 [${label}]: a malformed START is REJECTED as a malformed command — 200, no session, no receipt, no cursor`, async () => {
      const bad = start({ schemaVersion: 1, prescriptionId: "snap-bad", name: "Bad", exercises });
      expect(await sync([bad])).toEqual({ status: 201, outcomes: ["REJECTED"] });
      expect(await sessionRow(bad.workoutSessionId)).toEqual([]);
      expect(await receiptOf(bad.commandId)).toEqual([]);
      expect(
        await db
          .select()
          .from(workoutChangeCursor)
          .where(eq(workoutChangeCursor.userId, actorUserId)),
      ).toEqual([]);
    });
  }

  it("SNAP-002 (starvation): a malformed session never blocks an independent session in the same or any later request", async () => {
    const bad = start({
      schemaVersion: 1,
      prescriptionId: "snap-bad",
      name: "Bad",
      exercises: [null],
    });
    const badSet = complete(bad.workoutSessionId);
    const good = start(CURRENT_PRESCRIPTION);
    const goodSet = complete(good.workoutSessionId);
    const goodFinish = finish(good.workoutSessionId, 1);
    const batch = [bad, badSet, good, goodSet, goodFinish];

    // The mobile outbox resends the SAME oldest-first batch after any 5xx; it must converge, not loop.
    const first = await sync(batch);
    expect(first).toEqual({
      status: 201,
      outcomes: ["REJECTED", "REJECTED", "APPLIED", "APPLIED", "APPLIED"],
    });
    const replay = await sync(batch);
    expect(replay).toEqual({
      status: 201,
      outcomes: ["REJECTED", "REJECTED", "DUPLICATE", "DUPLICATE", "DUPLICATE"],
    });

    expect(await sessionRow(bad.workoutSessionId)).toEqual([]);
    expect(await sessionRow(good.workoutSessionId)).toEqual([
      expect.objectContaining({ status: "COMPLETED", userId: actorUserId }),
    ]);
    expect(await jobsFor(bad.workoutSessionId)).toHaveLength(0);
    expect(await jobsFor(good.workoutSessionId)).toHaveLength(1);
  });

  it("SNAP-003 (already-persisted state): a session stored with a malformed snapshot by an earlier server makes its COMPLETE_SET a deterministic same-owner REJECTED — never a 500, no partial write", async () => {
    for (const exercises of [
      [null],
      [
        {
          prescriptionExerciseId: "snap-ex-1",
          exerciseRef: "bench-press",
          displayName: "Bench",
          order: 0,
        },
      ],
      [{ ...VALID_EXERCISE, sets: [null] }],
      [{ ...VALID_EXERCISE, sets: "3x10" }],
    ]) {
      const sessionId = createEntityId();
      // Simulates a row the previous (shallow) START validation accepted.
      await db.insert(workoutSessions).values({
        id: sessionId,
        userId: actorUserId,
        prescriptionSnapshot: {
          schemaVersion: 1,
          prescriptionId: "legacy-bad",
          name: "Legacy bad",
          exercises,
        },
        startedAt: new Date(),
        status: "ACTIVE",
      });
      const set = complete(sessionId);

      expect(await sync([set])).toEqual({ status: 201, outcomes: ["REJECTED"] });
      expect(await exercisesOf(sessionId)).toEqual([]);
      expect(
        await db.select().from(performedSets).where(eq(performedSets.id, set.performedSetId)),
      ).toEqual([]);
      // Same-owner validation failure convention: a persisted REJECTED receipt (idempotent replay).
      expect(await receiptOf(set.commandId)).toEqual([
        expect.objectContaining({ outcome: "REJECTED", workoutSessionId: sessionId }),
      ]);
      expect(await sync([set])).toEqual({ status: 201, outcomes: ["REJECTED"] });
      // A historical row is never rewritten by the fix.
      expect((await sessionRow(sessionId))[0]?.prescriptionSnapshot).toEqual({
        schemaVersion: 1,
        prescriptionId: "legacy-bad",
        name: "Legacy bad",
        exercises,
      });
    }
  });

  it("SNAP-004: a valid current snapshot syncs START -> COMPLETE -> FINISH exactly as before (one progression job)", async () => {
    const s = start(CURRENT_PRESCRIPTION);
    expect(await sync([s, complete(s.workoutSessionId), finish(s.workoutSessionId, 1)])).toEqual({
      status: 201,
      outcomes: ["APPLIED", "APPLIED", "APPLIED"],
    });
    expect(await exercisesOf(s.workoutSessionId)).toHaveLength(1);
    expect(await jobsFor(s.workoutSessionId)).toHaveLength(1);
  });

  it("SNAP-005: a valid LEGACY snapshot (no setType/restSeconds, exerciseRef null) still syncs", async () => {
    const s = start(LEGACY_PRESCRIPTION);
    expect(await sync([s, complete(s.workoutSessionId, { exerciseRef: "bench-press" })])).toEqual({
      status: 201,
      outcomes: ["APPLIED", "APPLIED"],
    });
    expect((await sessionRow(s.workoutSessionId))[0]?.prescriptionSnapshot).toEqual(
      LEGACY_PRESCRIPTION,
    );
  });

  it("SNAP-008 (compatibility): edge shapes keep their pre-fix outcome; only the documented contract is enforced", async () => {
    const withoutRef: Record<string, unknown> = { ...VALID_EXERCISE };
    delete withoutRef["exerciseRef"];
    const cases: [string, unknown[], string][] = [
      // Accepted before and after: empty structures and unknown extra keys are not malformed.
      ["no exercises", [], "APPLIED"],
      ["exercise with no sets", [{ ...VALID_EXERCISE, sets: [] }], "APPLIED"],
      [
        "unknown extra keys",
        [
          {
            ...VALID_EXERCISE,
            futureField: 1,
            sets: [{ ...VALID_EXERCISE.sets[0], futureField: 1 }],
          },
        ],
        "APPLIED",
      ],
      // Rejected before already (an unplanned START may carry no substitution key at all).
      ["substitution null", [{ ...VALID_EXERCISE, substitution: null }], "REJECTED"],
      // `exerciseRef` is a REQUIRED `string | null` key; no producer omits it, and the planned path already rejected its absence.
      ["exerciseRef absent", [withoutRef], "REJECTED"],
    ];
    for (const [label, exercises, outcome] of cases) {
      const s = start({
        schemaVersion: 1,
        prescriptionId: `snap-${label}`,
        name: label,
        exercises,
      });
      expect({ label, ...(await sync([s])) }).toEqual({ label, status: 201, outcomes: [outcome] });
      expect(await sessionRow(s.workoutSessionId)).toHaveLength(outcome === "APPLIED" ? 1 : 0);
    }
  });

  it("SNAP-006: a COMPLETE_SET for a set the valid snapshot does not contain is still REJECTED (invalid data never accepted)", async () => {
    const s = start(CURRENT_PRESCRIPTION);
    expect(
      await sync([
        s,
        complete(s.workoutSessionId, { prescriptionSetId: "not-in-snapshot" }),
        complete(s.workoutSessionId, { prescriptionExerciseId: "not-in-snapshot", sessionSeq: 2 }),
      ]),
    ).toEqual({ status: 201, outcomes: ["APPLIED", "REJECTED", "REJECTED"] });
    expect(await exercisesOf(s.workoutSessionId)).toEqual([]);
  });

  it("SNAP-007: a genuine infrastructure failure is NOT converted into REJECTED — it still surfaces (HTTP 5xx / thrown), so the client retries", async () => {
    const failing = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "transaction")
          return () => Promise.reject(new Error("simulated connection loss"));
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const s = start(CURRENT_PRESCRIPTION);
    await expect(processWorkoutCommand(failing, boss, actorUserId, s)).rejects.toThrow(
      "simulated connection loss",
    );
    expect(await sessionRow(s.workoutSessionId)).toEqual([]);
    expect(await receiptOf(s.commandId)).toEqual([]);
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
