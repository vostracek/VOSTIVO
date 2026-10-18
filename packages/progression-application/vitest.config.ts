import { defineConfig } from "vitest/config";

/**
 * Default test run: no live Postgres required. The transactional-enqueue
 * proof needs a real local Postgres + pg-boss schema and lives in
 * `*.integration.test.ts`, run separately via `pnpm test:integration` —
 * see vitest.integration.config.ts (matches apps/api's convention).
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"],
  },
});
