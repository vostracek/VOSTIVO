import { describe, expect, it } from "vitest";
import { assertDisposableTestDatabase, requireDisposableDatabaseUrl, UnsafeTestDatabaseError } from "./assert-disposable-test-database.js";

const RUNTIME = "postgres://vostivo_api:s3cret@127.0.0.1:55433/vostivo_disposable_a";
const MIGRATION = "postgres://vostivo:s3cret@127.0.0.1:55433/vostivo_disposable_a";

describe("assertDisposableTestDatabase", () => {
  it("accepts two loopback URLs naming the same disposable database", () => {
    expect(() => assertDisposableTestDatabase({ DATABASE_URL: RUNTIME, MIGRATION_DATABASE_URL: MIGRATION })).not.toThrow();
  });

  it.each<[string, Record<string, string | undefined>]>([
    ["no DATABASE_URL", { MIGRATION_DATABASE_URL: MIGRATION }],
    ["no MIGRATION_DATABASE_URL", { DATABASE_URL: RUNTIME }],
    ["an empty DATABASE_URL", { DATABASE_URL: "", MIGRATION_DATABASE_URL: MIGRATION }],
    ["a malformed URL", { DATABASE_URL: "s3cret-not-a-url", MIGRATION_DATABASE_URL: MIGRATION }],
    ["a non-Postgres URL", { DATABASE_URL: RUNTIME.replace("postgres:", "mysql:"), MIGRATION_DATABASE_URL: MIGRATION }],
    ["a remote host", { DATABASE_URL: RUNTIME.replace("127.0.0.1", "db.example.com"), MIGRATION_DATABASE_URL: MIGRATION }],
    ["the shared dev database", { DATABASE_URL: RUNTIME.replace("vostivo_disposable_a", "vostivo_dev"), MIGRATION_DATABASE_URL: MIGRATION }],
    ["the manual database", { DATABASE_URL: RUNTIME.replace("vostivo_disposable_a", "vostivo_manual"), MIGRATION_DATABASE_URL: MIGRATION }],
    ["the dogfood database", { DATABASE_URL: RUNTIME.replace("vostivo_disposable_a", "vostivo_dogfood"), MIGRATION_DATABASE_URL: MIGRATION }],
    ["a migration URL on the shared dev database", { DATABASE_URL: RUNTIME, MIGRATION_DATABASE_URL: MIGRATION.replace("vostivo_disposable_a", "vostivo_dev") }],
    ["two different disposable databases", { DATABASE_URL: RUNTIME, MIGRATION_DATABASE_URL: MIGRATION.replace("vostivo_disposable_a", "vostivo_disposable_b") }],
    ["two different ports", { DATABASE_URL: RUNTIME, MIGRATION_DATABASE_URL: MIGRATION.replace("55433", "55434") }],
  ])("refuses %s without echoing credentials", (_name, env) => {
    let error: unknown;
    try {
      assertDisposableTestDatabase(env);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(UnsafeTestDatabaseError);
    expect(String(error)).not.toContain("s3cret");
  });

  it("returns the requested URL only for a safe pair", () => {
    const env = { DATABASE_URL: RUNTIME, MIGRATION_DATABASE_URL: MIGRATION };

    expect(requireDisposableDatabaseUrl("DATABASE_URL", env)).toBe(RUNTIME);
    expect(requireDisposableDatabaseUrl("MIGRATION_DATABASE_URL", env)).toBe(MIGRATION);
    expect(() => requireDisposableDatabaseUrl("DATABASE_URL", { DATABASE_URL: RUNTIME })).toThrow(UnsafeTestDatabaseError);
  });
});
