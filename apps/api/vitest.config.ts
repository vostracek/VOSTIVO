import { defineConfig } from "vitest/config";

/**
 * Default test run: no live Postgres or Supabase required (spec sections
 * 16, 25). Identity-resolution integration tests need a real local
 * Postgres and live in `*.integration.test.ts` files, run separately via
 * `pnpm test:integration` — see vitest.integration.config.ts.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"],
  },
});
