import { defineConfig } from "vitest/config";

/**
 * Default test run: no live Postgres required. `startWorker()` itself now
 * connects to real Postgres and starts a real pg-boss instance, so its
 * smoke test needs one — it lives in `*.integration.test.ts`, run
 * separately via `pnpm test:integration` (matches apps/api's convention).
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"],
  },
});
