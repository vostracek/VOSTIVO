import { afterEach, describe, expect, it } from "vitest";
import { Controller, Get, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { registerRateLimit } from "./rate-limit.js";

@Controller("probe")
class ProbeController {
  @Get()
  ping(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

/**
 * Real Fastify request/response cycle (not a mocked guard) — rate
 * limiting is registered as a Fastify plugin in `main.ts`, entirely
 * outside Nest's own guard/interceptor pipeline, so a Nest testing-module
 * unit test that only mocks controllers would never actually exercise it.
 * A tiny `max`/`timeWindow` keeps this fast — no real wall-clock sleep
 * beyond the single short window-recovery wait below.
 */
async function buildApp(max: number, timeWindowMs: number): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await registerRateLimit(app, { RATE_LIMIT_MAX: max, RATE_LIMIT_WINDOW_SECONDS: timeWindowMs / 1000 });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe("registerRateLimit (real Fastify request cycle)", () => {
  let app: NestFastifyApplication;

  afterEach(async () => {
    await app.close();
  });

  it("RATE-LIMIT-001: allows a normal request under the limit", async () => {
    app = await buildApp(5, 1000);
    const response = await app.getHttpAdapter().getInstance().inject({ method: "GET", url: "/probe" });
    expect(response.statusCode).toBe(200);
  });

  it("RATE-LIMIT-002: returns 429 once the limit is exceeded, without leaking internals", async () => {
    app = await buildApp(2, 5000);
    const instance = app.getHttpAdapter().getInstance();

    await instance.inject({ method: "GET", url: "/probe" });
    await instance.inject({ method: "GET", url: "/probe" });
    const limited = await instance.inject({ method: "GET", url: "/probe" });

    expect(limited.statusCode).toBe(429);
    const body: Record<string, unknown> = limited.json();
    // Standard, safe shape only — no stack trace, no internal path, no
    // implementation detail beyond the limiter's own generic message.
    expect(body).toMatchObject({ statusCode: 429 });
    expect(JSON.stringify(body)).not.toMatch(/at .*\.ts:\d+/); // no stack frame leaked
    expect(limited.headers["retry-after"]).toBeDefined();
  });

  it("RATE-LIMIT-003: recovers once the window elapses", async () => {
    app = await buildApp(1, 120);
    const instance = app.getHttpAdapter().getInstance();

    const first = await instance.inject({ method: "GET", url: "/probe" });
    expect(first.statusCode).toBe(200);

    const immediatelyAfter = await instance.inject({ method: "GET", url: "/probe" });
    expect(immediatelyAfter.statusCode).toBe(429);

    await new Promise((resolve) => setTimeout(resolve, 150));

    const afterWindow = await instance.inject({ method: "GET", url: "/probe" });
    expect(afterWindow.statusCode).toBe(200);
  });

  it("RATE-LIMIT-004: does not interfere with a request that stays under the limit across several calls", async () => {
    // Guards against an over-eager configuration accidentally throttling
    // ordinary sequential use (e.g. Plan -> Preview -> Start in one
    // session) — not a claim about the production default's exact value,
    // which api-config.test.ts covers separately.
    app = await buildApp(10, 1000);
    const instance = app.getHttpAdapter().getInstance();

    for (let i = 0; i < 8; i += 1) {
      const response = await instance.inject({ method: "GET", url: "/probe" });
      expect(response.statusCode).toBe(200);
    }
  });
});
