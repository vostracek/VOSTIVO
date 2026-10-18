import { describe, expect, it } from "vitest";
import { assertSafeManualDbTarget, MANUAL_DATABASE_NAME } from "./bootstrap-manual-db.js";

/**
 * Local Manual E2E Runtime Unblock Slice (task section 26) — proves the
 * destructive manual-DB reset tool refuses every unsafe target. Pure/
 * synchronous: no Postgres connection is ever made here, matching
 * `assertSafeManualDbTarget`'s own contract (see its doc comment).
 */
describe("assertSafeManualDbTarget", () => {
  const safe = { nodeEnv: "local", manualDatabaseUrl: `postgres://vostivo:vostivo@localhost:5432/${MANUAL_DATABASE_NAME}` };

  it("MANUAL-DB-001: accepts NODE_ENV=local + localhost + exactly vostivo_manual", () => {
    expect(() => assertSafeManualDbTarget(safe)).not.toThrow();
  });

  it("MANUAL-DB-002: accepts the docker-compose service hostname 'postgres'", () => {
    expect(() =>
      assertSafeManualDbTarget({ ...safe, manualDatabaseUrl: `postgres://vostivo:vostivo@postgres:5432/${MANUAL_DATABASE_NAME}` }),
    ).not.toThrow();
  });

  it("MANUAL-DB-003: refuses the real dev database vostivo_dev", () => {
    expect(() =>
      assertSafeManualDbTarget({ ...safe, manualDatabaseUrl: "postgres://vostivo:vostivo@localhost:5432/vostivo_dev" }),
    ).toThrow(/vostivo_dev/);
  });

  it("MANUAL-DB-004: refuses an arbitrary/typo'd database name", () => {
    expect(() =>
      assertSafeManualDbTarget({ ...safe, manualDatabaseUrl: "postgres://vostivo:vostivo@localhost:5432/vostivo_manual_2" }),
    ).toThrow(/vostivo_manual_2/);
  });

  it("MANUAL-DB-005: refuses NODE_ENV=production even with an otherwise-perfect URL", () => {
    expect(() => assertSafeManualDbTarget({ ...safe, nodeEnv: "production" })).toThrow(/NODE_ENV/);
  });

  it("MANUAL-DB-006: refuses NODE_ENV=staging", () => {
    expect(() => assertSafeManualDbTarget({ ...safe, nodeEnv: "staging" })).toThrow(/NODE_ENV/);
  });

  it("MANUAL-DB-007: refuses a production-shaped remote hostname", () => {
    expect(() =>
      assertSafeManualDbTarget({
        ...safe,
        manualDatabaseUrl: `postgres://vostivo:vostivo@prod-db.example.com:5432/${MANUAL_DATABASE_NAME}`,
      }),
    ).toThrow(/non-local host/);
  });

  it("MANUAL-DB-008: refuses a real-looking managed-Postgres hostname even with the right database name", () => {
    expect(() =>
      assertSafeManualDbTarget({
        ...safe,
        manualDatabaseUrl: `postgres://vostivo:vostivo@db.supabase.co:5432/${MANUAL_DATABASE_NAME}`,
      }),
    ).toThrow(/non-local host/);
  });
});
