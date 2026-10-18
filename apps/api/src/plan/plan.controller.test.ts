import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BadRequestException, ConflictException, NotFoundException, UnprocessableEntityException, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { AvailableTimePreviewResponseV1, EquipmentAdaptationApplyResponseV1, EquipmentAdaptationOptionsResponseV1, EquipmentAdaptationPreviewResponseV1, MissedWorkoutApplyResponseV1, MissedWorkoutPreviewResponseV1, PlanOverviewV1, WorkoutPreviewV1 } from "@vostivo/contracts";
import { PlanModule } from "./plan.module.js";
import { PlanReadService } from "./plan-read.service.js";
import { AvailableTimePreviewService } from "./available-time-preview.service.js";
import { MissedWorkoutPreviewService } from "./missed-workout-preview.service.js";
import { MissedWorkoutApplyService } from "./missed-workout-apply.service.js";
import { EquipmentAdaptationPreviewService } from "./equipment-adaptation-preview.service.js";
import { EquipmentAdaptationApplyService } from "./equipment-adaptation-apply.service.js";
import { EquipmentAdaptationOptionsService } from "./equipment-adaptation-options.service.js";
import { AUTH_TOKEN_VERIFIER, type AuthTokenVerifier } from "../auth/token-verifier.js";
import { IdentityResolverService } from "../auth/identity-resolver.service.js";
import type { ResolvedIdentity } from "../auth/identity-resolution.js";
import type { AuthenticatedActor } from "../auth/authenticated-actor.js";

/**
 * Auth-boundary wiring only (spec section 16/46: ownership must come from
 * `AuthenticatedActor`, never a request parameter). Real projection
 * correctness and BOLA are covered by plan.integration.test.ts against
 * real Postgres.
 */
const ACTIVE_IDENTITY: ResolvedIdentity = {
  userId: "11111111-1111-7111-8111-111111111111",
  userStatus: "ACTIVE",
  athleteProfileId: "22222222-2222-7222-8222-222222222222",
  experienceMode: "GUIDED",
  unitSystem: "METRIC",
};

const EMPTY_OVERVIEW: PlanOverviewV1 = { currentBlock: null, sessions: [], weeklyFocus: [], schedule: { state: "NO_PLAN", displayedCycle: null } };

class FakeVerifier implements AuthTokenVerifier {
  verify(bearerToken: string) {
    if (bearerToken === "valid-active") {
      return Promise.resolve({ subject: "sub-active", issuer: "test-issuer", audience: "authenticated" });
    }
    return Promise.reject(new Error("invalid token"));
  }
}

class FakeIdentityResolver {
  resolve(): Promise<ResolvedIdentity> {
    return Promise.resolve(ACTIVE_IDENTITY);
  }
}

class FakePlanReadService {
  lastOverviewActor: AuthenticatedActor | undefined;
  lastPreviewActor: AuthenticatedActor | undefined;
  lastPreviewWorkoutId: string | undefined;
  previewResult: WorkoutPreviewV1 | undefined;

  getCurrentPlanOverview(actor: AuthenticatedActor): Promise<PlanOverviewV1> {
    this.lastOverviewActor = actor;
    return Promise.resolve(EMPTY_OVERVIEW);
  }

  getWorkoutPreview(actor: AuthenticatedActor, plannedWorkoutId: string): Promise<WorkoutPreviewV1 | undefined> {
    this.lastPreviewActor = actor;
    this.lastPreviewWorkoutId = plannedWorkoutId;
    return Promise.resolve(this.previewResult);
  }
}

const WORKOUT_ID = "33333333-3333-7333-8333-333333333333";

const PREVIEW_RESPONSE: AvailableTimePreviewResponseV1 = {
  policyVersion: "available-time/v1",
  plannedWorkoutId: WORKOUT_ID,
  sourceProgramVersionId: "44444444-4444-7444-8444-444444444444",
  availableMinutes: 30,
  result: "NO_CHANGE",
  fitsAvailableTime: true,
  originalEstimatedSeconds: 540,
  adjustedEstimatedSeconds: 540,
  minimumEstimatedSeconds: null,
  previewFingerprint: "f".repeat(64),
  exercises: [],
};

class FakeAvailableTimePreviewService {
  calls: { actor: AuthenticatedActor; plannedWorkoutId: string; availableMinutes: number }[] = [];
  failWith: Error | undefined;

  preview(actor: AuthenticatedActor, plannedWorkoutId: string, availableMinutes: number): Promise<AvailableTimePreviewResponseV1> {
    this.calls.push({ actor, plannedWorkoutId, availableMinutes });
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    return Promise.resolve(PREVIEW_RESPONSE);
  }
}

const MISSED_RESPONSE: MissedWorkoutPreviewResponseV1 = {
  policyVersion: "missed-workout/v1",
  athleteLocalDate: "2026-10-07",
  trainingTimeZone: "Europe/Prague",
  previewFingerprint: "e".repeat(64),
  result: "NO_CHANGE",
  reasonCode: "NO_MISSED_WORKOUT",
};

class FakeMissedWorkoutPreviewService {
  calls: { actor: AuthenticatedActor; extraArgs: number }[] = [];
  failWith: Error | undefined;

  preview(actor: AuthenticatedActor, ...rest: unknown[]): Promise<MissedWorkoutPreviewResponseV1> {
    this.calls.push({ actor, extraArgs: rest.length });
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    return Promise.resolve(MISSED_RESPONSE);
  }
}

const FINGERPRINT = "a".repeat(64);

const APPLY_RESPONSE: MissedWorkoutApplyResponseV1 = {
  application: { policyVersion: "missed-workout/v1", previewFingerprint: FINGERPRINT, status: "ACTIVE", appliedAt: "2026-10-07T08:00:00.000Z" },
  result: "ROLL_FORWARD",
  missedWorkout: { plannedWorkoutId: WORKOUT_ID, displayName: "Upper A", scheduledLocalDate: "2026-10-05" },
  effectiveAssignments: [{ plannedWorkoutId: WORKOUT_ID, authoredScheduledLocalDate: "2026-10-05", effectiveScheduledLocalDate: "2026-10-07" }],
  carryoverWorkoutIds: [],
};

class FakeMissedWorkoutApplyService {
  calls: { actor: AuthenticatedActor; previewFingerprint: string; extraArgs: number }[] = [];
  failWith: Error | undefined;

  apply(actor: AuthenticatedActor, previewFingerprint: string, ...rest: unknown[]): Promise<MissedWorkoutApplyResponseV1> {
    this.calls.push({ actor, previewFingerprint, extraArgs: rest.length });
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    return Promise.resolve(APPLY_RESPONSE);
  }
}

const EQUIPMENT_RESPONSE: EquipmentAdaptationPreviewResponseV1 = {
  schemaVersion: "equipment-adaptation-preview/v1",
  policyVersion: "equipment-adaptation/v1",
  catalogVersion: "exercise-equipment-catalog/v1",
  athleteLocalDate: "2026-10-08",
  plannedWorkoutId: WORKOUT_ID,
  workoutName: "Upper Body A",
  availableEquipmentIds: ["dumbbells"],
  previewFingerprint: "e".repeat(64),
  result: "NO_CHANGE",
  reasonCode: "ALL_EQUIPMENT_AVAILABLE",
  replacements: [],
};

class FakeEquipmentAdaptationPreviewService {
  calls: { actor: AuthenticatedActor; request: unknown; extraArgs: number }[] = [];
  failWith: Error | undefined;

  preview(actor: AuthenticatedActor, request: unknown, ...rest: unknown[]): Promise<EquipmentAdaptationPreviewResponseV1> {
    this.calls.push({ actor, request, extraArgs: rest.length });
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    return Promise.resolve(EQUIPMENT_RESPONSE);
  }
}

const EQUIPMENT_APPLY_RESPONSE: EquipmentAdaptationApplyResponseV1 = {
  applicationId: "01890a5d-ac96-774b-bcce-b302099a8057",
  scope: "TODAY_ONLY",
  plannedWorkoutId: WORKOUT_ID,
  athleteLocalDate: "2026-10-08",
  previewFingerprint: "e".repeat(64),
  status: "ACTIVE",
  result: "ADJUST_SESSION",
  replacements: [{ plannedExerciseId: "01890a5d-ac96-774b-bcce-b302099a8058", order: 1, authoredExerciseRef: "bench-press", substituteExerciseRef: "dumbbell-bench-press", substituteExerciseName: "Dumbbell Bench Press" }],
  appliedAt: "2026-10-08T08:00:00.000Z",
};

class FakeEquipmentAdaptationApplyService {
  calls: { actor: AuthenticatedActor; request: unknown; extraArgs: number }[] = [];
  failWith: Error | undefined;

  apply(actor: AuthenticatedActor, request: unknown, ...rest: unknown[]): Promise<EquipmentAdaptationApplyResponseV1> {
    this.calls.push({ actor, request, extraArgs: rest.length });
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    return Promise.resolve(EQUIPMENT_APPLY_RESPONSE);
  }
}

const EQUIPMENT_OPTIONS_RESPONSE: EquipmentAdaptationOptionsResponseV1 = {
  schemaVersion: "equipment-adaptation-options/v1",
  catalogVersion: "exercise-equipment-catalog/v1",
  plannedWorkoutId: WORKOUT_ID,
  athleteLocalDate: "2026-10-08",
  equipmentOptions: [{ equipmentId: "barbell", displayLabel: "Barbell", relevance: "PLANNED" }],
  currentApplication: null,
};

class FakeEquipmentAdaptationOptionsService {
  calls: { actor: AuthenticatedActor; plannedWorkoutId: string; extraArgs: number }[] = [];
  failWith: Error | undefined;

  options(actor: AuthenticatedActor, plannedWorkoutId: string, ...rest: unknown[]): Promise<EquipmentAdaptationOptionsResponseV1> {
    this.calls.push({ actor, plannedWorkoutId, extraArgs: rest.length });
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    return Promise.resolve(EQUIPMENT_OPTIONS_RESPONSE);
  }
}

describe("GET /api/v1/plan/* (auth boundary)", () => {
  let app: NestFastifyApplication;
  let fakeService: FakePlanReadService;
  let fakeAvailableTime: FakeAvailableTimePreviewService;
  let fakeMissed: FakeMissedWorkoutPreviewService;
  let fakeApply: FakeMissedWorkoutApplyService;
  let fakeEquipment: FakeEquipmentAdaptationPreviewService;
  let fakeEquipmentApply: FakeEquipmentAdaptationApplyService;
  let fakeEquipmentOptions: FakeEquipmentAdaptationOptionsService;

  beforeAll(async () => {
    fakeService = new FakePlanReadService();
    fakeAvailableTime = new FakeAvailableTimePreviewService();
    fakeMissed = new FakeMissedWorkoutPreviewService();
    fakeApply = new FakeMissedWorkoutApplyService();
    fakeEquipment = new FakeEquipmentAdaptationPreviewService();
    fakeEquipmentApply = new FakeEquipmentAdaptationApplyService();
    fakeEquipmentOptions = new FakeEquipmentAdaptationOptionsService();

    const moduleRef = await Test.createTestingModule({ imports: [PlanModule] })
      .overrideProvider(AUTH_TOKEN_VERIFIER)
      .useClass(FakeVerifier)
      .overrideProvider(IdentityResolverService)
      .useClass(FakeIdentityResolver)
      .overrideProvider(PlanReadService)
      .useValue(fakeService)
      .overrideProvider(AvailableTimePreviewService)
      .useValue(fakeAvailableTime)
      .overrideProvider(MissedWorkoutPreviewService)
      .useValue(fakeMissed)
      .overrideProvider(MissedWorkoutApplyService)
      .useValue(fakeApply)
      .overrideProvider(EquipmentAdaptationPreviewService)
      .useValue(fakeEquipment)
      .overrideProvider(EquipmentAdaptationApplyService)
      .useValue(fakeEquipmentApply)
      .overrideProvider(EquipmentAdaptationOptionsService)
      .useValue(fakeEquipmentOptions)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // Same global pipe as main.ts, so request validation is exercised for real.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  function inject(url: string, headers: Record<string, string> = {}) {
    return app.getHttpAdapter().getInstance().inject({ method: "GET", url, headers });
  }

  it("GET /plan/current: missing bearer token returns 401, never reaches the service", async () => {
    const response = await inject("/plan/current");
    expect(response.statusCode).toBe(401);
    expect(fakeService.lastOverviewActor).toBeUndefined();
  });

  it("GET /plan/current: ownership comes from the authenticated actor", async () => {
    const response = await inject("/plan/current", { authorization: "Bearer valid-active" });

    expect(response.statusCode).toBe(200);
    expect(fakeService.lastOverviewActor?.athleteProfileId).toBe(ACTIVE_IDENTITY.athleteProfileId);
  });

  it("GET /plan/workouts/:id: the id comes from the URL, but ownership still comes from the actor", async () => {
    fakeService.previewResult = {
      plannedWorkoutId: "workout-1",
      name: "Upper Body A",
      focus: null,
      estimatedDurationMinutes: 60,
      displayStatus: "PLANNED",
      hasActiveSession: false,
      canStart: true,
      exercises: [],
      prescription: { schemaVersion: 1, prescriptionId: "workout-1", name: "Upper Body A", exercises: [] },
    };

    const response = await inject("/plan/workouts/workout-1", { authorization: "Bearer valid-active" });

    expect(response.statusCode).toBe(200);
    expect(fakeService.lastPreviewWorkoutId).toBe("workout-1");
    expect(fakeService.lastPreviewActor?.athleteProfileId).toBe(ACTIVE_IDENTITY.athleteProfileId);
  });

  it("GET /plan/workouts/:id: an undefined result (not found or not owned) maps to 404, no existence leakage", async () => {
    fakeService.previewResult = undefined;

    const response = await inject("/plan/workouts/someone-elses-workout", { authorization: "Bearer valid-active" });

    expect(response.statusCode).toBe(404);
  });

  describe("POST /plan/workouts/:id/available-time-preview", () => {
    const url = `/plan/workouts/${WORKOUT_ID}/available-time-preview`;

    beforeEach(() => {
      fakeAvailableTime.calls = [];
      fakeAvailableTime.failWith = undefined;
    });

    function post(payload: unknown, headers: Record<string, string> = { authorization: "Bearer valid-active" }, path = url) {
      return app.getHttpAdapter().getInstance().inject({ method: "POST", url: path, headers, payload: payload as object });
    }

    it("missing bearer token returns 401, never reaches the service", async () => {
      const response = await post({ availableMinutes: 30 }, {});
      expect(response.statusCode).toBe(401);
      expect(fakeAvailableTime.calls).toHaveLength(0);
    });

    it("200 with the preview; ownership comes from the actor, the id from the URL", async () => {
      const response = await post({ availableMinutes: 30 });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(PREVIEW_RESPONSE);
      expect(fakeAvailableTime.calls).toEqual([{ actor: expect.objectContaining({ athleteProfileId: ACTIVE_IDENTITY.athleteProfileId }) as AuthenticatedActor, plannedWorkoutId: WORKOUT_ID, availableMinutes: 30 }]);
    });

    it.each([
      ["0", { availableMinutes: 0 }],
      ["241", { availableMinutes: 241 }],
      ["a float", { availableMinutes: 30.5 }],
      ["a numeric string", { availableMinutes: "30" }],
      ["missing", {}],
      ["a client-supplied athleteId", { availableMinutes: 30, athleteId: ACTIVE_IDENTITY.athleteProfileId }],
    ])("availableMinutes %s is rejected with 400 before the service runs", async (_label, payload) => {
      const response = await post(payload);
      expect(response.statusCode).toBe(400);
      expect(fakeAvailableTime.calls).toHaveLength(0);
    });

    it.each([1, 240])("boundary availableMinutes %i is accepted", async (availableMinutes) => {
      const response = await post({ availableMinutes });
      expect(response.statusCode).toBe(200);
    });

    it("a malformed plannedWorkoutId is a 400, never a DB error", async () => {
      const response = await post({ availableMinutes: 30 }, undefined, "/plan/workouts/not-a-uuid/available-time-preview");
      expect(response.statusCode).toBe(400);
      expect(fakeAvailableTime.calls).toHaveLength(0);
    });

    it("already started -> 409 WORKOUT_ALREADY_STARTED", async () => {
      fakeAvailableTime.failWith = new ConflictException("WORKOUT_ALREADY_STARTED");
      const response = await post({ availableMinutes: 30 });
      expect(response.statusCode).toBe(409);
      expect(response.json<{ message: string }>().message).toBe("WORKOUT_ALREADY_STARTED");
    });

    it("invalid authored structure -> 422 with only the stable code", async () => {
      fakeAvailableTime.failWith = new UnprocessableEntityException("AVAILABLE_TIME_PRIORITY_TIER_MISSING");
      const response = await post({ availableMinutes: 30 });
      expect(response.statusCode).toBe(422);
      expect(response.json<{ message: string }>().message).toBe("AVAILABLE_TIME_PRIORITY_TIER_MISSING");
    });
  });

  describe("POST /plan/missed-workout-preview", () => {
    const url = "/plan/missed-workout-preview";

    beforeEach(() => {
      fakeMissed.calls = [];
      fakeMissed.failWith = undefined;
    });

    function post(payload: unknown, headers: Record<string, string> = { authorization: "Bearer valid-active" }) {
      return app.getHttpAdapter().getInstance().inject({ method: "POST", url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
    }

    it("missing bearer token returns 401, never reaches the service", async () => {
      const response = await post({}, {});
      expect(response.statusCode).toBe(401);
      expect(fakeMissed.calls).toHaveLength(0);
    });

    it("an empty body -> 200; ownership comes only from the actor and nothing else reaches the service", async () => {
      const response = await post({});
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(MISSED_RESPONSE);
      expect(fakeMissed.calls).toEqual([{ actor: expect.objectContaining({ athleteProfileId: ACTIVE_IDENTITY.athleteProfileId }) as AuthenticatedActor, extraArgs: 0 }]);
    });

    it("no body at all -> 200 as well", async () => {
      const response = await post(undefined);
      expect(response.statusCode).toBe(200);
      expect(fakeMissed.calls).toHaveLength(1);
    });

    it.each([
      ["a client date", { athleteLocalDate: "2026-10-07" }],
      ["client slots", { validTrainingSlots: ["2026-10-07"] }],
      ["a client workout id", { plannedWorkoutId: WORKOUT_ID }],
      ["a client timeline", { timelineConstraint: "HARD_DEADLINE" }],
      ["a client time zone", { trainingTimeZone: "UTC" }],
      ["a client athleteId", { athleteId: ACTIVE_IDENTITY.athleteProfileId }],
    ])("%s is rejected with 400 before the service runs", async (_label, payload) => {
      const response = await post(payload);
      expect(response.statusCode).toBe(400);
      expect(fakeMissed.calls).toHaveLength(0);
    });

    it.each([
      ["TRAINING_TIME_ZONE_REQUIRED"],
      ["CURRENT_TRAINING_BLOCK_UNRESOLVED"],
    ])("409 %s is surfaced with only the stable code", async (code) => {
      fakeMissed.failWith = new ConflictException(code);
      const response = await post({});
      expect(response.statusCode).toBe(409);
      expect(response.json<{ message: string }>().message).toBe(code);
    });
  });

  describe("POST /plan/missed-workout-apply", () => {
    const url = "/plan/missed-workout-apply";

    beforeEach(() => {
      fakeApply.calls = [];
      fakeApply.failWith = undefined;
    });

    function post(payload: unknown, headers: Record<string, string> = { authorization: "Bearer valid-active" }) {
      return app.getHttpAdapter().getInstance().inject({ method: "POST", url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
    }

    it("missing bearer token returns 401, never reaches the service", async () => {
      const response = await post({ previewFingerprint: FINGERPRINT }, {});
      expect(response.statusCode).toBe(401);
      expect(fakeApply.calls).toHaveLength(0);
    });

    it("200 with the application; only the actor + fingerprint reach the service (also the idempotent-retry shape)", async () => {
      const response = await post({ previewFingerprint: FINGERPRINT });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(APPLY_RESPONSE);
      expect(fakeApply.calls).toEqual([{ actor: expect.objectContaining({ userId: ACTIVE_IDENTITY.userId, athleteProfileId: ACTIVE_IDENTITY.athleteProfileId }) as AuthenticatedActor, previewFingerprint: FINGERPRINT, extraArgs: 0 }]);
    });

    it.each([
      ["no body", undefined],
      ["an empty body", {}],
      ["a short fingerprint", { previewFingerprint: "abc" }],
      ["an uppercase fingerprint", { previewFingerprint: "A".repeat(64) }],
      ["a numeric fingerprint", { previewFingerprint: 123 }],
      ["client dates", { previewFingerprint: FINGERPRINT, athleteLocalDate: "2026-10-07" }],
      ["client slots", { previewFingerprint: FINGERPRINT, validTrainingSlots: ["2026-10-07"] }],
      ["a client sequence", { previewFingerprint: FINGERPRINT, sequence: [WORKOUT_ID] }],
      ["client assignments", { previewFingerprint: FINGERPRINT, effectiveAssignments: [] }],
      ["a client workout id", { previewFingerprint: FINGERPRINT, plannedWorkoutId: WORKOUT_ID }],
      ["a client block / version", { previewFingerprint: FINGERPRINT, trainingBlockId: WORKOUT_ID, programVersionId: WORKOUT_ID }],
      ["a client time zone", { previewFingerprint: FINGERPRINT, trainingTimeZone: "UTC" }],
      ["a client reason code", { previewFingerprint: FINGERPRINT, reasonCode: "SINGLE_MISSED_WORKOUT" }],
      ["a client athleteId", { previewFingerprint: FINGERPRINT, athleteId: ACTIVE_IDENTITY.athleteProfileId }],
    ])("%s is rejected with 400 before the service runs", async (_label, payload) => {
      const response = await post(payload);
      expect(response.statusCode).toBe(400);
      expect(fakeApply.calls).toHaveLength(0);
    });

    it.each([["MISSED_WORKOUT_PREVIEW_STALE"], ["TRAINING_TIME_ZONE_REQUIRED"], ["CURRENT_TRAINING_BLOCK_UNRESOLVED"]])("409 %s is surfaced with only the stable code", async (code) => {
      fakeApply.failWith = new ConflictException(code);
      const response = await post({ previewFingerprint: FINGERPRINT });
      expect(response.statusCode).toBe(409);
      expect(response.json<{ message: string }>().message).toBe(code);
    });

    it.each([["NO_MISSED_WORKOUT"], ["LATER_SESSION_ALREADY_PERFORMED"]])("409 MISSED_WORKOUT_NOT_APPLICABLE carries the stable reasonCode %s", async (reasonCode) => {
      fakeApply.failWith = new ConflictException({ statusCode: 409, message: "MISSED_WORKOUT_NOT_APPLICABLE", reasonCode });
      const response = await post({ previewFingerprint: FINGERPRINT });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ statusCode: 409, message: "MISSED_WORKOUT_NOT_APPLICABLE", reasonCode });
    });

    it("no athlete profile -> 404 (BOLA-safe, same as any not-found)", async () => {
      fakeApply.failWith = new NotFoundException("Athlete profile not found");
      const response = await post({ previewFingerprint: FINGERPRINT });
      expect(response.statusCode).toBe(404);
    });
  });

  describe("POST /plan/equipment-adaptation-preview", () => {
    const url = "/plan/equipment-adaptation-preview";
    const VALID = { plannedWorkoutId: WORKOUT_ID, catalogVersion: "exercise-equipment-catalog/v1", availableEquipmentIds: ["dumbbells", "flat-bench"] };

    beforeEach(() => {
      fakeEquipment.calls = [];
      fakeEquipment.failWith = undefined;
    });

    function post(payload: unknown, headers: Record<string, string> = { authorization: "Bearer valid-active" }) {
      return app.getHttpAdapter().getInstance().inject({ method: "POST", url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
    }

    it("missing bearer token returns 401, never reaches the service", async () => {
      expect((await post(VALID, {})).statusCode).toBe(401);
      expect(fakeEquipment.calls).toHaveLength(0);
    });

    it("200; only the actor + exactly the three client fields reach the service", async () => {
      const response = await post(VALID);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(EQUIPMENT_RESPONSE);
      expect(fakeEquipment.calls).toEqual([{ actor: expect.objectContaining({ athleteProfileId: ACTIVE_IDENTITY.athleteProfileId }) as AuthenticatedActor, request: VALID, extraArgs: 0 }]);
    });

    it("an empty inventory is a valid request", async () => {
      expect((await post({ ...VALID, availableEquipmentIds: [] })).statusCode).toBe(200);
    });

    it.each([
      ["no body", undefined],
      ["missing plannedWorkoutId", { catalogVersion: VALID.catalogVersion, availableEquipmentIds: [] }],
      ["missing catalogVersion", { plannedWorkoutId: WORKOUT_ID, availableEquipmentIds: [] }],
      ["missing inventory", { plannedWorkoutId: WORKOUT_ID, catalogVersion: VALID.catalogVersion }],
      ["a malformed plannedWorkoutId", { ...VALID, plannedWorkoutId: "not-a-uuid" }],
      ["a non-array inventory", { ...VALID, availableEquipmentIds: "dumbbells" }],
      ["a non-string equipment id", { ...VALID, availableEquipmentIds: [1] }],
      ["a client substitute", { ...VALID, substituteExerciseId: "dumbbell-bench-press" }],
      ["client replacements", { ...VALID, replacements: [] }],
      ["a client authored exercise", { ...VALID, authoredExerciseId: "bench-press" }],
      ["a client reason code", { ...VALID, reasonCode: "TEMPORARY_EQUIPMENT_UNAVAILABLE" }],
      ["client requirements", { ...VALID, requiredEquipmentIds: [] }],
      ["client tiers/priorities", { ...VALID, compatibilityTier: "ROLE_EQUIVALENT", substitutionPriority: 1 }],
      ["a client lock", { ...VALID, substitutionPolicy: "ALLOW_TEMPORARY" }],
      ["client blocks", { ...VALID, athleteBlockedExerciseIds: [] }],
      ["a client athleteId", { ...VALID, athleteId: ACTIVE_IDENTITY.athleteProfileId }],
      ["a client date", { ...VALID, athleteLocalDate: "2026-10-08" }],
      ["a client time zone", { ...VALID, trainingTimeZone: "UTC" }],
    ])("%s is rejected with 400 before the service runs", async (_label, payload) => {
      expect((await post(payload)).statusCode).toBe(400);
      expect(fakeEquipment.calls).toHaveLength(0);
    });

    it.each([["EQUIPMENT_CATALOG_VERSION_MISMATCH"], ["TRAINING_TIME_ZONE_REQUIRED"]])("409 %s surfaces only the stable code", async (code) => {
      fakeEquipment.failWith = new ConflictException(code);
      const response = await post(VALID);
      expect(response.statusCode).toBe(409);
      expect(response.json<{ message: string }>().message).toBe(code);
    });

    it("409 EQUIPMENT_ADAPTATION_NOT_APPLICABLE carries a stable reasonCode", async () => {
      fakeEquipment.failWith = new ConflictException({ statusCode: 409, message: "EQUIPMENT_ADAPTATION_NOT_APPLICABLE", reasonCode: "NOT_TODAYS_WORKOUT" });
      const response = await post(VALID);
      expect(response.json()).toEqual({ statusCode: 409, message: "EQUIPMENT_ADAPTATION_NOT_APPLICABLE", reasonCode: "NOT_TODAYS_WORKOUT" });
    });

    it("unknown equipment (400) and not found / not owned (404) are surfaced", async () => {
      fakeEquipment.failWith = new BadRequestException({ statusCode: 400, message: "UNKNOWN_EQUIPMENT_ID", unknownEquipmentIds: ["kettlebell"] });
      expect((await post(VALID)).json()).toEqual({ statusCode: 400, message: "UNKNOWN_EQUIPMENT_ID", unknownEquipmentIds: ["kettlebell"] });
      fakeEquipment.failWith = new NotFoundException("Planned workout not found");
      expect((await post(VALID)).statusCode).toBe(404);
    });
  });
  describe("POST /plan/equipment-adaptation-apply", () => {
    const url = "/plan/equipment-adaptation-apply";
    const VALID = { plannedWorkoutId: WORKOUT_ID, previewFingerprint: "e".repeat(64), catalogVersion: "exercise-equipment-catalog/v1", availableEquipmentIds: ["dumbbells", "flat-bench"] };

    beforeEach(() => {
      fakeEquipmentApply.calls = [];
      fakeEquipmentApply.failWith = undefined;
    });

    function post(payload: unknown, headers: Record<string, string> = { authorization: "Bearer valid-active" }) {
      return app.getHttpAdapter().getInstance().inject({ method: "POST", url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
    }

    it("missing bearer token returns 401, never reaches the service", async () => {
      expect((await post(VALID, {})).statusCode).toBe(401);
      expect(fakeEquipmentApply.calls).toHaveLength(0);
    });

    it("200 with the compact response; only the actor + exactly the four client fields reach the service", async () => {
      const response = await post(VALID);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(EQUIPMENT_APPLY_RESPONSE);
      expect(fakeEquipmentApply.calls).toEqual([{ actor: expect.objectContaining({ athleteProfileId: ACTIVE_IDENTITY.athleteProfileId }) as AuthenticatedActor, request: VALID, extraArgs: 0 }]);
    });

    it.each([
      ["no body", undefined],
      ["missing fingerprint", { plannedWorkoutId: WORKOUT_ID, catalogVersion: VALID.catalogVersion, availableEquipmentIds: [] }],
      ["missing inventory", { plannedWorkoutId: WORKOUT_ID, previewFingerprint: VALID.previewFingerprint, catalogVersion: VALID.catalogVersion }],
      ["missing catalogVersion", { plannedWorkoutId: WORKOUT_ID, previewFingerprint: VALID.previewFingerprint, availableEquipmentIds: [] }],
      ["a malformed fingerprint", { ...VALID, previewFingerprint: "XYZ" }],
      ["an uppercase fingerprint", { ...VALID, previewFingerprint: "E".repeat(64) }],
      ["a malformed plannedWorkoutId", { ...VALID, plannedWorkoutId: "nope" }],
      ["client replacements", { ...VALID, replacements: [] }],
      ["a client substitute", { ...VALID, substituteExerciseRef: "dumbbell-bench-press" }],
      ["client candidates", { ...VALID, candidates: [] }],
      ["a client name", { ...VALID, substituteExerciseName: "Dumbbell Bench Press" }],
      ["client sets/loads", { ...VALID, sets: [], targetLoad: { amountMilli: 1 } }],
      ["a client priority/lock", { ...VALID, substitutionPriority: 1, substitutionPolicy: "ALLOW_TEMPORARY" }],
      ["client blocks", { ...VALID, athleteBlockedExerciseIds: [] }],
      ["a client Available-Time decision", { ...VALID, availableMinutes: 30 }],
      ["a client date / time zone", { ...VALID, athleteLocalDate: "2026-10-08", trainingTimeZone: "UTC" }],
      ["a client athleteId", { ...VALID, athleteId: ACTIVE_IDENTITY.athleteProfileId }],
      ["a client scope/status", { ...VALID, scope: "TODAY_ONLY", status: "ACTIVE" }],
    ])("%s is rejected with 400 before the service runs", async (_label, payload) => {
      expect((await post(payload)).statusCode).toBe(400);
      expect(fakeEquipmentApply.calls).toHaveLength(0);
    });

    it.each([
      [{ statusCode: 409, message: "EQUIPMENT_PREVIEW_STALE" }],
      [{ statusCode: 409, message: "EQUIPMENT_ADAPTATION_REVIEW_REQUIRED", reasonCode: "NO_AVAILABLE_SUBSTITUTE" }],
      [{ statusCode: 409, message: "EQUIPMENT_ADAPTATION_NOT_APPLICABLE", reasonCode: "WORKOUT_ALREADY_STARTED" }],
    ])("409 %o surfaces only the stable body", async (body) => {
      fakeEquipmentApply.failWith = new ConflictException(body);
      const response = await post(VALID);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual(body);
    });

    it("not found / not owned -> 404", async () => {
      fakeEquipmentApply.failWith = new NotFoundException("Planned workout not found");
      expect((await post(VALID)).statusCode).toBe(404);
    });
  });
  describe("GET /plan/equipment-adaptation-options", () => {
    const url = (query: string) => `/plan/equipment-adaptation-options${query}`;

    beforeEach(() => {
      fakeEquipmentOptions.calls = [];
      fakeEquipmentOptions.failWith = undefined;
    });

    it("missing bearer token returns 401, never reaches the service", async () => {
      expect((await inject(url(`?plannedWorkoutId=${WORKOUT_ID}`))).statusCode).toBe(401);
      expect(fakeEquipmentOptions.calls).toHaveLength(0);
    });

    it("200 with the server options; only the actor + the workout id reach the service", async () => {
      const response = await inject(url(`?plannedWorkoutId=${WORKOUT_ID}`), { authorization: "Bearer valid-active" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(EQUIPMENT_OPTIONS_RESPONSE);
      expect(fakeEquipmentOptions.calls).toEqual([{ actor: expect.objectContaining({ athleteProfileId: ACTIVE_IDENTITY.athleteProfileId }) as AuthenticatedActor, plannedWorkoutId: WORKOUT_ID, extraArgs: 0 }]);
    });

    it.each([
      ["no query", ""],
      ["a malformed plannedWorkoutId", "?plannedWorkoutId=nope"],
      ["an extra athlete id", `?plannedWorkoutId=${WORKOUT_ID}&athleteId=${ACTIVE_IDENTITY.athleteProfileId}`],
      ["a client date", `?plannedWorkoutId=${WORKOUT_ID}&athleteLocalDate=2026-10-08`],
    ])("%s is rejected with 400 before the service runs", async (_label, query) => {
      expect((await inject(url(query), { authorization: "Bearer valid-active" })).statusCode).toBe(400);
      expect(fakeEquipmentOptions.calls).toHaveLength(0);
    });

    it.each([
      [{ statusCode: 409, message: "TRAINING_TIME_ZONE_REQUIRED" }],
      [{ statusCode: 409, message: "EQUIPMENT_ADAPTATION_NOT_APPLICABLE", reasonCode: "NOT_TODAYS_WORKOUT" }],
    ])("409 %o surfaces only the stable body", async (body) => {
      fakeEquipmentOptions.failWith = new ConflictException(body);
      const response = await inject(url(`?plannedWorkoutId=${WORKOUT_ID}`), { authorization: "Bearer valid-active" });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual(body);
    });

    it("not found / not owned -> 404", async () => {
      fakeEquipmentOptions.failWith = new NotFoundException("Planned workout not found");
      expect((await inject(url(`?plannedWorkoutId=${WORKOUT_ID}`), { authorization: "Bearer valid-active" })).statusCode).toBe(404);
    });
  });
});
