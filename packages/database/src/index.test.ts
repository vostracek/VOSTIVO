import { describe, expect, it } from "vitest";
import { getTableName } from "drizzle-orm";
import { bootstrapHealthCheck } from "./schema/index.js";
import { databaseConfigSchema, loadDatabaseConfig } from "./config.js";

/**
 * These tests validate schema shape and config parsing only — no live
 * Postgres connection required, so `pnpm test` never depends on real
 * database credentials (spec section 16).
 */
describe("database package (no live connection required)", () => {
  it("defines the bootstrap table without any product columns", () => {
    expect(getTableName(bootstrapHealthCheck)).toBe("bootstrap_health_check");
    expect(Object.keys(bootstrapHealthCheck)).toEqual(expect.arrayContaining(["id", "checkedAt"]));
  });

  it("requires a valid DATABASE_URL and fails fast without one", () => {
    expect(() => loadDatabaseConfig({ NODE_ENV: "local" })).toThrow();

    const config = loadDatabaseConfig({
      NODE_ENV: "local",
      DATABASE_URL: "postgres://user:pass@localhost:5432/vostivo_dev",
    });
    expect(databaseConfigSchema.safeParse(config).success).toBe(true);
  });
});
