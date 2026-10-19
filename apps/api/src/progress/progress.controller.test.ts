import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BadRequestException, NotFoundException, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { ExerciseHistoryPageV1, ProgressOverviewV1, WorkoutHistoryDetailV1, WorkoutHistoryPageV1 } from "@vostivo/contracts";
import { ProgressModule } from "./progress.module.js";
import { ProgressReadService } from "./progress-read.service.js";
import { PlanReadService } from "../plan/plan-read.service.js";
import { AUTH_TOKEN_VERIFIER, type AuthTokenVerifier } from "../auth/token-verifier.js";
import { IdentityResolverService } from "../auth/identity-resolver.service.js";
import type { ResolvedIdentity } from "../auth/identity-resolution.js";
import type { AuthenticatedActor } from "../auth/authenticated-actor.js";

/**
 * Auth-boundary and request-validation wiring only. Projection
 * correctness, canonical-only and BOLA are covered by
 * progress-read.service.integration.test.ts against real Postgres.
 */
const ACTIVE_IDENTITY: ResolvedIdentity = {
  userId: "11111111-1111-7111-8111-111111111111",
  userStatus: "ACTIVE",
  athleteProfileId: "22222222-2222-7222-8222-222222222222",
  experienceMode: "GUIDED",
  unitSystem: "METRIC",
};
const SESSION_ID = "33333333-3333-7333-8333-333333333333";

class FakeVerifier implements AuthTokenVerifier {
  verify(bearerToken: string) {
    if (bearerToken === "valid-active") return Promise.resolve({ subject: "sub-active", issuer: "test-issuer", audience: "authenticated" });
    return Promise.reject(new Error("invalid token"));
  }
}

class FakeIdentityResolver {
  resolve(): Promise<ResolvedIdentity> {
    return Promise.resolve(ACTIVE_IDENTITY);
  }
}

class FakeProgressReadService {
  calls: { method: string; actor: AuthenticatedActor; args: unknown[] }[] = [];
  failWith: Error | undefined;

  private record<T>(method: string, actor: AuthenticatedActor, args: unknown[], value: T): Promise<T> {
    this.calls.push({ method, actor, args });
    return this.failWith === undefined ? Promise.resolve(value) : Promise.reject(this.failWith);
  }
  getOverview(actor: AuthenticatedActor) {
    return this.record<ProgressOverviewV1>("getOverview", actor, [], { schemaVersion: 1, athleteLocalDate: null, snapshot: { block: null, thisWeek: null }, improving: [], recentWorkouts: [] });
  }
  getWorkoutHistory(actor: AuthenticatedActor, query: unknown) {
    return this.record<WorkoutHistoryPageV1>("getWorkoutHistory", actor, [query], { items: [], nextCursor: null });
  }
  getWorkoutDetail(actor: AuthenticatedActor, workoutSessionId: string) {
    return this.record("getWorkoutDetail", actor, [workoutSessionId], {} as WorkoutHistoryDetailV1);
  }
  getExerciseHistory(actor: AuthenticatedActor, exerciseRef: string, query: unknown) {
    return this.record<ExerciseHistoryPageV1>("getExerciseHistory", actor, [exerciseRef, query], { exerciseRef, displayName: "Bench Press", exposures: [], nextCursor: null });
  }
}

describe("ProgressController (auth + validation wiring)", () => {
  let app: NestFastifyApplication;
  let fake: FakeProgressReadService;

  beforeAll(async () => {
    fake = new FakeProgressReadService();
    const moduleRef = await Test.createTestingModule({ imports: [ProgressModule] })
      .overrideProvider(AUTH_TOKEN_VERIFIER)
      .useClass(FakeVerifier)
      .overrideProvider(IdentityResolverService)
      .useClass(FakeIdentityResolver)
      .overrideProvider(ProgressReadService)
      .useValue(fake)
      .overrideProvider(PlanReadService)
      .useValue({})
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

  beforeEach(() => {
    fake.calls = [];
    fake.failWith = undefined;
  });

  function get(url: string, authorized = true) {
    return app.getHttpAdapter().getInstance().inject({ method: "GET", url, headers: authorized ? { authorization: "Bearer valid-active" } : {} });
  }

  it.each(["/progress", "/progress/workouts", `/progress/workouts/${SESSION_ID}`, "/progress/exercises/bench-press"])("GET %s without a bearer token is 401 and never reaches the service", async (url) => {
    const response = await get(url, false);
    expect(response.statusCode).toBe(401);
    expect(fake.calls).toEqual([]);
  });

  it("GET /progress: ownership comes only from the authenticated actor", async () => {
    const response = await get("/progress");
    expect(response.statusCode).toBe(200);
    expect(fake.calls).toEqual([{ method: "getOverview", actor: { userId: ACTIVE_IDENTITY.userId, athleteProfileId: ACTIVE_IDENTITY.athleteProfileId }, args: [] }]);
  });

  it("GET /progress/workouts: limit is parsed to a number, before passed through", async () => {
    const response = await get("/progress/workouts?limit=10&before=abc");
    expect(response.statusCode).toBe(200);
    expect(fake.calls[0]!.args).toEqual([{ limit: 10, before: "abc" }]);
  });

  it.each(["limit=0", "limit=51", "limit=two", "athleteId=someone-else"])("GET /progress/workouts?%s is a 400, never reaches the service", async (query) => {
    const response = await get(`/progress/workouts?${query}`);
    expect(response.statusCode).toBe(400);
    expect(fake.calls).toEqual([]);
  });

  it("GET /progress/workouts/:id: a malformed id is a 400, never a DB error", async () => {
    const response = await get("/progress/workouts/not-a-uuid");
    expect(response.statusCode).toBe(400);
    expect(fake.calls).toEqual([]);
  });

  it("GET /progress/workouts/:id: not found / not owned maps to 404", async () => {
    fake.failWith = new NotFoundException("Workout not found");
    const response = await get(`/progress/workouts/${SESSION_ID}`);
    expect(response.statusCode).toBe(404);
    expect(fake.calls[0]!.args).toEqual([SESSION_ID]);
  });

  it("GET /progress/exercises/:ref: the ref comes from the URL; an invalid cursor maps to 400", async () => {
    fake.failWith = new BadRequestException("INVALID_CURSOR");
    const response = await get("/progress/exercises/bench-press?before=xyz");
    expect(response.statusCode).toBe(400);
    expect(fake.calls[0]!.args).toEqual(["bench-press", { before: "xyz" }]);
  });
});
