import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ProgressionModule } from "./progression.module.js";
import { ProgressionReviewService } from "./progression-review.service.js";
import { GuidedLoadingSetupService } from "./guided-loading-setup.service.js";
import { AUTH_TOKEN_VERIFIER, type AuthTokenVerifier } from "../auth/token-verifier.js";
import { IdentityResolverService } from "../auth/identity-resolver.service.js";
import type { ResolvedIdentity } from "../auth/identity-resolution.js";
import type { AuthenticatedActor } from "../auth/authenticated-actor.js";

/**
 * CORE-AUDIT-01 F-05/F-06 — auth boundary and path-id validation wiring for
 * ProgressionController + GuidedLoadingSetupController (previously without
 * any HTTP-level test). Workflow semantics, mode authority and BOLA are
 * covered by the *.service.integration.test.ts suites against real Postgres.
 */
const ACTIVE_IDENTITY: ResolvedIdentity = {
  userId: "11111111-1111-7111-8111-111111111111",
  userStatus: "ACTIVE",
  athleteProfileId: "22222222-2222-7222-8222-222222222222",
  experienceMode: "ADAPTIVE",
  unitSystem: "METRIC",
};
const APPLICATION_ID = "33333333-3333-7333-8333-333333333333";
const COMMAND_ID = "019a0000-0000-7000-8000-000000000001";
const LOAD = { kind: "EXTERNAL_WEIGHT", amountMilli: 60000, unit: "KG", basis: "TOTAL" };
const APPLY_BODY = {
  commandId: COMMAND_ID,
  expectedCurrentEffectiveLoad: LOAD,
  expectedLoadingCapabilityId: COMMAND_ID,
  expectedLoadingCapabilityRevision: 1,
  expectedResolverProposedLoad: LOAD,
};
const KEEP_BODY = { commandId: COMMAND_ID };
const SAVE_BODY = { kind: "FIXED_INCREMENT", incrementAmountMilli: 2500 };

class FakeVerifier implements AuthTokenVerifier {
  verify(bearerToken: string) {
    if (bearerToken === "valid-active")
      return Promise.resolve({
        subject: "sub-active",
        issuer: "test-issuer",
        audience: "authenticated",
      });
    if (bearerToken === "valid-suspended")
      return Promise.resolve({
        subject: "sub-suspended",
        issuer: "test-issuer",
        audience: "authenticated",
      });
    return Promise.reject(new Error("invalid token"));
  }
}

class FakeIdentityResolver {
  resolve(_provider: string, subject: string): Promise<ResolvedIdentity> {
    return Promise.resolve(
      subject === "sub-suspended"
        ? { ...ACTIVE_IDENTITY, userStatus: "SUSPENDED" }
        : ACTIVE_IDENTITY,
    );
  }
}

type Call = { method: string; actor: AuthenticatedActor; args: unknown[] };

class Recorder {
  calls: Call[] = [];
  protected record(method: string, actor: AuthenticatedActor, ...args: unknown[]): Promise<object> {
    this.calls.push({ method, actor, args });
    return Promise.resolve({});
  }
}

class FakeProgressionReviewService extends Recorder {
  getPending(actor: AuthenticatedActor) {
    return this.record("getPending", actor);
  }
  getProposal(actor: AuthenticatedActor, applicationId: string) {
    return this.record("getProposal", actor, applicationId);
  }
  apply(actor: AuthenticatedActor, applicationId: string) {
    return this.record("apply", actor, applicationId);
  }
  keepOriginal(actor: AuthenticatedActor, applicationId: string) {
    return this.record("keepOriginal", actor, applicationId);
  }
}

class FakeGuidedLoadingSetupService extends Recorder {
  getAttention(actor: AuthenticatedActor) {
    return this.record("getAttention", actor);
  }
  getContext(actor: AuthenticatedActor, applicationId: string) {
    return this.record("getContext", actor, applicationId);
  }
  save(actor: AuthenticatedActor, applicationId: string) {
    return this.record("save", actor, applicationId);
  }
}

type Route = {
  method: "GET" | "POST";
  path: (id: string) => string;
  body?: object;
  service: "review" | "setup";
  handler: string;
};

const ID_ROUTES: Route[] = [
  {
    method: "GET",
    path: (id) => `/progression/applications/${id}/proposal`,
    service: "review",
    handler: "getProposal",
  },
  {
    method: "POST",
    path: (id) => `/progression/applications/${id}/apply`,
    body: APPLY_BODY,
    service: "review",
    handler: "apply",
  },
  {
    method: "POST",
    path: (id) => `/progression/applications/${id}/keep-original`,
    body: KEEP_BODY,
    service: "review",
    handler: "keepOriginal",
  },
  {
    method: "GET",
    path: (id) => `/progression/guided-loading-setup/${id}`,
    service: "setup",
    handler: "getContext",
  },
  {
    method: "POST",
    path: (id) => `/progression/guided-loading-setup/${id}`,
    body: SAVE_BODY,
    service: "setup",
    handler: "save",
  },
];
const ALL_ROUTES: Route[] = [
  {
    method: "GET",
    path: () => "/progression/applications/pending",
    service: "review",
    handler: "getPending",
  },
  {
    method: "GET",
    path: () => "/progression/guided-loading-setup/attention",
    service: "setup",
    handler: "getAttention",
  },
  ...ID_ROUTES,
];
const label = (route: Route) => `${route.method} ${route.path(":id")}`;

describe("Progression controllers (auth + path-id validation wiring)", () => {
  let app: NestFastifyApplication;
  const review = new FakeProgressionReviewService();
  const setup = new FakeGuidedLoadingSetupService();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ProgressionModule] })
      .overrideProvider(AUTH_TOKEN_VERIFIER)
      .useClass(FakeVerifier)
      .overrideProvider(IdentityResolverService)
      .useClass(FakeIdentityResolver)
      .overrideProvider(ProgressionReviewService)
      .useValue(review)
      .overrideProvider(GuidedLoadingSetupService)
      .useValue(setup)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // Same global pipe as main.ts.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    review.calls = [];
    setup.calls = [];
  });

  function send(route: Route, id: string, token: string | null) {
    return app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: route.method,
        url: route.path(id),
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
        ...(route.body === undefined ? {} : { payload: route.body }),
      });
  }
  const allCalls = () => [...review.calls, ...setup.calls];

  it.each(ALL_ROUTES.map((route) => [label(route), route] as const))(
    "%s: no bearer token -> 401, never reaches a service",
    async (_name, route) => {
      expect((await send(route, APPLICATION_ID, null)).statusCode).toBe(401);
      expect(allCalls()).toEqual([]);
    },
  );

  it.each(ALL_ROUTES.map((route) => [label(route), route] as const))(
    "%s: an unverifiable token -> 401",
    async (_name, route) => {
      expect((await send(route, APPLICATION_ID, "forged")).statusCode).toBe(401);
      expect(allCalls()).toEqual([]);
    },
  );

  it.each(ALL_ROUTES.map((route) => [label(route), route] as const))(
    "%s: a suspended account -> 403",
    async (_name, route) => {
      expect((await send(route, APPLICATION_ID, "valid-suspended")).statusCode).toBe(403);
      expect(allCalls()).toEqual([]);
    },
  );

  it.each(ID_ROUTES.map((route) => [label(route), route] as const))(
    "F-05 %s: a malformed id is a 400, never reaches the service (no DB error / 500)",
    async (_name, route) => {
      for (const id of ["not-a-uuid", "1", "33333333-3333-7333-8333-33333333333"]) {
        const response = await send(route, id, "valid-active");
        expect({ id, status: response.statusCode }).toEqual({ id, status: 400 });
      }
      expect(allCalls()).toEqual([]);
    },
  );

  it.each(ID_ROUTES.map((route) => [label(route), route] as const))(
    "%s: a well-formed id passes through verbatim with the actor from the token only",
    async (_name, route) => {
      const response = await send(route, APPLICATION_ID, "valid-active");
      expect(response.statusCode).toBeLessThan(300);
      const calls = route.service === "review" ? review.calls : setup.calls;
      expect(calls).toEqual([
        expect.objectContaining({
          method: route.handler,
          actor: {
            userId: ACTIVE_IDENTITY.userId,
            athleteProfileId: ACTIVE_IDENTITY.athleteProfileId,
          },
        }),
      ]);
      expect(calls[0]?.args[0]).toBe(APPLICATION_ID);
    },
  );
});
