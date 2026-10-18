import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BadRequestException, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AuthenticatedActor } from "../auth/authenticated-actor.js";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { MeResponse } from "@vostivo/contracts";
import { MeModule } from "./me.module.js";
import { MeProjectionService } from "./me-projection.service.js";
import { AUTH_TOKEN_VERIFIER, type AuthTokenVerifier } from "../auth/token-verifier.js";
import { IdentityResolverService } from "../auth/identity-resolver.service.js";
import type { ResolvedIdentity } from "../auth/identity-resolution.js";

/**
 * Tests the auth boundary end to end through the real Fastify request
 * pipeline (guard -> decorator -> controller), with the token verifier and
 * identity resolver replaced by fakes so no live Supabase project or
 * Postgres is required (spec section 25). Real identity-resolution
 * behavior against actual Postgres is covered separately in
 * identity-resolution.integration.test.ts.
 */
const ACTIVE_IDENTITY: ResolvedIdentity = {
  userId: "11111111-1111-7111-8111-111111111111",
  userStatus: "ACTIVE",
  athleteProfileId: "22222222-2222-7222-8222-222222222222",
  experienceMode: "GUIDED",
  unitSystem: "METRIC",
};

const SUSPENDED_IDENTITY: ResolvedIdentity = { ...ACTIVE_IDENTITY, userStatus: "SUSPENDED" };

const ME_RESPONSE: MeResponse = {
  userId: ACTIVE_IDENTITY.userId,
  athleteProfileId: ACTIVE_IDENTITY.athleteProfileId,
  status: "ACTIVE",
  experienceMode: "GUIDED",
  unitSystem: "METRIC",
  trainingTimeZone: null,
};

class FakeVerifier implements AuthTokenVerifier {
  verify(bearerToken: string) {
    if (bearerToken === "valid-active") {
      return Promise.resolve({
        subject: "sub-active",
        issuer: "test-issuer",
        audience: "authenticated",
      });
    }
    if (bearerToken === "valid-suspended") {
      return Promise.resolve({
        subject: "sub-suspended",
        issuer: "test-issuer",
        audience: "authenticated",
      });
    }
    return Promise.reject(new Error("invalid token"));
  }
}

class FakeIdentityResolver {
  resolve(_provider: string, subject: string): Promise<ResolvedIdentity> {
    return Promise.resolve(subject === "sub-suspended" ? SUSPENDED_IDENTITY : ACTIVE_IDENTITY);
  }
}

class FakeMeProjection {
  timeZoneCalls: { actor: AuthenticatedActor; value: string }[] = [];

  getSafeProjection(): Promise<MeResponse> {
    return Promise.resolve(ME_RESPONSE);
  }

  setTrainingTimeZone(actor: AuthenticatedActor, value: string): Promise<MeResponse> {
    this.timeZoneCalls.push({ actor, value });
    // Mirrors the real service: semantic IANA validation lives there.
    if (value !== "Europe/Prague") return Promise.reject(new BadRequestException("INVALID_TRAINING_TIME_ZONE"));
    return Promise.resolve({ ...ME_RESPONSE, trainingTimeZone: value });
  }
}

describe("GET /api/v1/me (auth boundary)", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [MeModule] })
      .overrideProvider(AUTH_TOKEN_VERIFIER)
      .useClass(FakeVerifier)
      .overrideProvider(IdentityResolverService)
      .useClass(FakeIdentityResolver)
      .overrideProvider(MeProjectionService)
      .useClass(FakeMeProjection)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  function inject(headers: Record<string, string> = {}) {
    return app.getHttpAdapter().getInstance().inject({ method: "GET", url: "/me", headers });
  }

  it("AUTH-001: missing bearer token returns 401", async () => {
    const response = await inject();
    expect(response.statusCode).toBe(401);
  });

  it("rejects a malformed Authorization header with 401", async () => {
    const response = await inject({ authorization: "NotBearer sometoken" });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a token the verifier cannot validate with 401, not verifier internals", async () => {
    const response = await inject({ authorization: "Bearer garbage-token" });
    expect(response.statusCode).toBe(401);
    expect(JSON.stringify(response.json())).not.toContain("invalid token");
  });

  it("AUTH-005: a valid token succeeds and returns only the safe DTO", async () => {
    const response = await inject({ authorization: "Bearer valid-active" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(ME_RESPONSE);
    expect(Object.keys(response.json()).sort()).toEqual(
      ["athleteProfileId", "experienceMode", "status", "trainingTimeZone", "unitSystem", "userId"].sort(),
    );
  });

  it("a valid token for a suspended account is safely denied, not treated as usable", async () => {
    const response = await inject({ authorization: "Bearer valid-suspended" });
    expect(response.statusCode).toBe(403);
  });

  it("AUTH-006: client-supplied identity/role headers cannot influence the resolved actor", async () => {
    const response = await inject({
      authorization: "Bearer valid-active",
      "x-user-id": "attacker-controlled-id",
      "x-role": "ADMIN",
      "x-is-pro": "true",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(ME_RESPONSE);
  });
});

describe("PUT /api/v1/me/training-time-zone (auth boundary)", () => {
  let app: NestFastifyApplication;
  let projection: FakeMeProjection;

  beforeAll(async () => {
    projection = new FakeMeProjection();
    const moduleRef = await Test.createTestingModule({ imports: [MeModule] })
      .overrideProvider(AUTH_TOKEN_VERIFIER)
      .useClass(FakeVerifier)
      .overrideProvider(IdentityResolverService)
      .useClass(FakeIdentityResolver)
      .overrideProvider(MeProjectionService)
      .useValue(projection)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    projection.timeZoneCalls = [];
  });

  function put(payload: object, headers: Record<string, string> = { authorization: "Bearer valid-active" }) {
    return app.getHttpAdapter().getInstance().inject({ method: "PUT", url: "/me/training-time-zone", headers, payload });
  }

  it("missing bearer token returns 401, never reaches the service", async () => {
    const response = await put({ trainingTimeZone: "Europe/Prague" }, {});
    expect(response.statusCode).toBe(401);
    expect(projection.timeZoneCalls).toHaveLength(0);
  });

  it("a valid IANA zone -> 200 with the updated projection; the profile comes from the actor", async () => {
    const response = await put({ trainingTimeZone: "Europe/Prague" });
    expect(response.statusCode).toBe(200);
    expect(response.json<MeResponse>().trainingTimeZone).toBe("Europe/Prague");
    expect(projection.timeZoneCalls[0]?.actor.athleteProfileId).toBe(ACTIVE_IDENTITY.athleteProfileId);
  });

  it("an invalid zone -> 400 INVALID_TRAINING_TIME_ZONE", async () => {
    const response = await put({ trainingTimeZone: "+02:00" });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ message: string }>().message).toBe("INVALID_TRAINING_TIME_ZONE");
  });

  it.each([
    ["missing", {}],
    ["a number", { trainingTimeZone: 2 }],
    ["an extra athleteProfileId", { trainingTimeZone: "Europe/Prague", athleteProfileId: "someone-else" }],
  ])("%s is rejected with 400 before the service runs", async (_label, payload) => {
    const response = await put(payload);
    expect(response.statusCode).toBe(400);
    expect(projection.timeZoneCalls).toHaveLength(0);
  });
});
