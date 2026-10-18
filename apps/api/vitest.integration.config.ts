import { defineConfig } from "vitest/config";

/**
 * Identity-resolution integration tests only — require a real local
 * Postgres (DATABASE_URL), never a real Supabase project. Run explicitly
 * via `pnpm test:integration`, not part of the default `pnpm test` gate.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
  },
});
