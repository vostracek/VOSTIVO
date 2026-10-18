import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startWorker } from "./main.js";

/**
 * Real Postgres + real pg-boss smoke test (Progression Evaluation
 * Orchestration V1). `startWorker()` now connects to Postgres and starts a
 * real pg-boss consumer — the prior heartbeat-only stub needed neither, so
 * this test moved from the default `pnpm test` gate to
 * `pnpm test:integration`, matching apps/api's own convention.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://vostivo_api:vostivo_api@localhost:5432/vostivo_dev";

describe("worker process (real Postgres + real pg-boss)", () => {
  // Vitest sets NODE_ENV=test, which is intentionally not one of Vostivo's
  // recognized environments (spec section 27: local/development/staging/
  // production only) — override it for this test rather than widening the
  // enum to accommodate the test runner.
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "local");
    vi.stubEnv("DATABASE_URL", DATABASE_URL);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("starts (connects to real Postgres, registers its pg-boss consumer) and stops cleanly", async () => {
    const worker = await startWorker();
    expect(typeof worker.stop).toBe("function");
    await worker.stop();
  });
});
