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
 * CC-01 Strength Regression Baseline — the server half of D-SYNC-1. The
 * ValidationPipe (same options as main.ts) refuses a whole batch with 400 when
 * a single command fails DTO validation, so per-command REJECTED is never
 * reached. This is the current wire contract; the client half is in
 * apps/mobile/src/workout/sync-http-400.cc01-baseline.test.ts.
 */
const OWNER = "11111111-1111-7111-8111-111111111111";

const IDENTITY: ResolvedIdentity = {
  userId: OWNER,
  userStatus: "ACTIVE",
  athleteProfileId: "22222222-2222-7222-8222-222222222222",
  experienceMode: "GUIDED",
  unitSystem: "METRIC",
};

class FakeVerifier implements AuthTokenVerifier {
  verify() {
    return Promise.resolve({ subject: "sub-synthetic", issuer: "test-issuer", audience: "authenticated" });
  }
}

class FakeIdentityResolver {
  resolve(): Promise<ResolvedIdentity> {
    return Promise.resolve(IDENTITY);
  }
}

class CountingSyncService {
  calls = 0;

  syncCommands(): Promise<SyncWorkoutCommandsResponse> {
    this.calls += 1;
    return Promise.resolve({ acknowledgements: [] });
  }
}

function validFinish(suffix: string): Record<string, unknown> {
  return {
    commandId: `0190a000-0000-7000-8000-0000000000${suffix}`,
    type: "FINISH_WORKOUT_SESSION_V1",
    schemaVersion: 1,
    createdAt: "2026-01-01T10:00:00.000Z",
    workoutSessionId: "0190a000-0000-7000-8000-000000000100",
    completedAt: "2026-01-01T10:00:00.000Z",
    finishSeq: 0,
  };
}

describe("POST /sync/workout-commands — whole-batch validation", () => {
  let app: NestFastifyApplication;
  let service: CountingSyncService;

  beforeAll(async () => {
    service = new CountingSyncService();
    const moduleRef = await Test.createTestingModule({ imports: [WorkoutModule] })
      .overrideProvider(AUTH_TOKEN_VERIFIER)
      .useClass(FakeVerifier)
      .overrideProvider(IdentityResolverService)
      .useClass(FakeIdentityResolver)
      .overrideProvider(WorkoutSyncService)
      .useValue(service)
      .overrideProvider(WorkoutHistoryService)
      .useValue({})
      .overrideProvider(ProgressionEvaluationService)
      .useValue({})
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function post(commands: readonly Record<string, unknown>[]): Promise<number> {
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: "POST",
        url: "/sync/workout-commands",
        payload: { ownerUserId: OWNER, commands },
        headers: { authorization: "Bearer synthetic" },
      });
    return response.statusCode;
  }

  it.each([
    ["an unknown command type", { ...validFinish("02"), type: "NOT_A_KNOWN_COMMAND" }],
    ["an unsupported schemaVersion", { ...validFinish("02"), schemaVersion: 2 }],
    ["an unknown extra field", { ...validFinish("02"), unexpected: true }],
  ])("CC01-BATCH-001: %s beside a valid command fails the WHOLE batch with 400, before the service runs", async (_name, invalid) => {
    const callsBefore = service.calls;

    expect(await post([validFinish("01"), invalid])).toBe(400);

    expect(service.calls).toBe(callsBefore);
  });

  it("CC01-BATCH-002: a fully valid batch reaches the service", async () => {
    const callsBefore = service.calls;

    expect(await post([validFinish("01")])).toBeLessThan(300);

    expect(service.calls).toBe(callsBefore + 1);
  });
});
