import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { SyncWorkoutCommandsResponse } from "@vostivo/contracts";
import { ProgressionEvaluationService, WorkoutHistoryService } from "@vostivo/progression-application";
import { WorkoutModule } from "./workout.module.js";
import { WorkoutSyncService } from "./workout-sync.service.js";
import { AUTH_TOKEN_VERIFIER, type AuthTokenVerifier } from "../auth/token-verifier.js";
import { IdentityResolverService } from "../auth/identity-resolver.service.js";
import type { ResolvedIdentity } from "../auth/identity-resolution.js";

/**
 * Auth-boundary wiring only (spec section 24: ownership must come from
 * `AuthenticatedActor`, never the request body). Real command-processing
 * correctness (idempotency, revision-gating, BOLA) is covered by
 * workout-sync.integration.test.ts against real Postgres.
 */
const ACTIVE_IDENTITY: ResolvedIdentity = {
  userId: "11111111-1111-7111-8111-111111111111",
  userStatus: "ACTIVE",
  athleteProfileId: "22222222-2222-7222-8222-222222222222",
  experienceMode: "GUIDED",
  unitSystem: "METRIC",
};

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

class FakeWorkoutSyncService {
  lastCalledUserId: string | undefined;

  syncCommands(userId: string): Promise<SyncWorkoutCommandsResponse> {
    this.lastCalledUserId = userId;
    return Promise.resolve({ acknowledgements: [] });
  }
}

describe("POST /api/v1/sync/workout-commands (auth boundary)", () => {
  let app: NestFastifyApplication;
  let fakeService: FakeWorkoutSyncService;

  beforeAll(async () => {
    fakeService = new FakeWorkoutSyncService();

    const moduleRef = await Test.createTestingModule({ imports: [WorkoutModule] })
      .overrideProvider(AUTH_TOKEN_VERIFIER)
      .useClass(FakeVerifier)
      .overrideProvider(IdentityResolverService)
      .useClass(FakeIdentityResolver)
      .overrideProvider(WorkoutSyncService)
      .useValue(fakeService)
      // WorkoutModule's WorkoutHistoryService/ProgressionEvaluationService
      // providers are useFactory-based and inject DATABASE (DatabaseModule
      // is @Global() in the real app, but not auto-imported into this
      // isolated TestingModule) — overriding both providers directly below
      // means their factories (and DATABASE) never run at all, so no
      // separate DATABASE stub is needed here. This test is
      // auth-boundary-only and never exercises history/progression reads.
      .overrideProvider(WorkoutHistoryService)
      .useValue({})
      // Progression EngineDecision Persistence & Evidence Integration V1's
      // ProgressionEvaluationService also needs a real DATABASE connection
      // and WorkoutHistoryService — same reasoning as the override above:
      // this test is auth-boundary-only and never exercises progression
      // evaluation.
      .overrideProvider(ProgressionEvaluationService)
      .useValue({})
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // Same global pipe as main.ts, so the DTO's required ownerUserId is enforced here too.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  function inject(body: Record<string, unknown>, headers: Record<string, string> = {}) {
    return app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: "POST", url: "/sync/workout-commands", payload: body, headers });
  }

  it("missing bearer token returns 401, never reaches the service", async () => {
    const response = await inject({ commands: [] });
    expect(response.statusCode).toBe(401);
    expect(fakeService.lastCalledUserId).toBeUndefined();
  });

  it("valid token: ownership comes from the authenticated actor, not the body", async () => {
    const response = await inject(
      { ownerUserId: ACTIVE_IDENTITY.userId, commands: [] },
      { authorization: "Bearer valid-active" },
    );

    expect(response.statusCode).toBe(201);
    // Even though nothing in the body claims a userId, the service was
    // called with the actor's real userId — proving the controller never
    // reads identity out of the request payload.
    expect(fakeService.lastCalledUserId).toBe(ACTIVE_IDENTITY.userId);
  });

  it("Slice B: a batch without ownerUserId (or with a non-UUID one) is a 400 and never reaches the service", async () => {
    fakeService.lastCalledUserId = undefined;
    expect((await inject({ commands: [] }, { authorization: "Bearer valid-active" })).statusCode).toBe(400);
    expect((await inject({ ownerUserId: "not-a-uuid", commands: [] }, { authorization: "Bearer valid-active" })).statusCode).toBe(400);
    expect(fakeService.lastCalledUserId).toBeUndefined();
  });
});
