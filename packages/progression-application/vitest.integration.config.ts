import { defineConfig } from "vitest/config";

/**
 * Real-Postgres/real-pg-boss transactional enqueue proof. Run via
 * `pnpm test:integration`, not part of the default `pnpm test` gate.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    setupFiles: ["./vitest.integration.setup.ts"],
  },
});
