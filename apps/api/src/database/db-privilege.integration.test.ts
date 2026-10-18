import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";

/**
 * Real Postgres integration tests (Security Hardening Follow-Up V1,
 * "Postgres least privilege") proving — with real PostgreSQL permission
 * failures, never merely inspected grants — that the API runtime role
 * (`vostivo_api`, created/granted by `pnpm db:bootstrap-roles`) is
 * genuinely incapable of DDL or role creation, while still being fully
 * capable of every DML operation the API actually needs.
 *
 * Requires `pnpm db:bootstrap-roles` to have already been run against the
 * target Postgres (local docker-compose or CI) — see
 * .github/workflows/ci.yml and packages/database/.env.example.
 */
const RUNTIME_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://vostivo_api:vostivo_api@localhost:5432/vostivo_dev";
const MIGRATION_DATABASE_URL =
  process.env.MIGRATION_DATABASE_URL ?? "postgres://vostivo:vostivo@localhost:5432/vostivo_dev";

const INSUFFICIENT_PRIVILEGE = "42501";

describe("API runtime role — least privilege (real Postgres)", () => {
  let runtime: Sql;
  let migrator: Sql;

  beforeAll(() => {
    runtime = postgres(RUNTIME_DATABASE_URL, { max: 1 });
    migrator = postgres(MIGRATION_DATABASE_URL, { max: 1 });
  });

  afterAll(async () => {
    await runtime.end();
    await migrator.end();
  });

  it("DB-PRIV-001: can SELECT an existing app-schema table", async () => {
    // Sanity check first — every denial test below only means something if
    // this connection is genuinely live and able to do ordinary DML.
    await expect(runtime`SELECT count(*) FROM app.users`).resolves.toBeDefined();
  });

  it("DB-PRIV-002: cannot CREATE TABLE in the app schema", async () => {
    await expect(runtime.unsafe("CREATE TABLE app.db_priv_test_should_never_exist (id int)")).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
  });

  it("DB-PRIV-003: cannot DROP an existing app-schema table", async () => {
    await expect(runtime.unsafe("DROP TABLE app.users")).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
  });

  it("DB-PRIV-004: cannot ALTER an existing app-schema table", async () => {
    await expect(runtime.unsafe("ALTER TABLE app.users ADD COLUMN db_priv_hacked text")).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
  });

  it("DB-PRIV-005: cannot CREATE ROLE", async () => {
    await expect(runtime.unsafe("CREATE ROLE db_priv_sneaky")).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
  });

  it("DB-PRIV-006: default privileges — a table the migration role creates AFTER bootstrap is immediately usable by the runtime role, with no manual grant", async () => {
    await migrator.unsafe("CREATE TABLE app.db_priv_default_grant_test (id int)");
    try {
      await migrator.unsafe("INSERT INTO app.db_priv_default_grant_test VALUES (1)");
      // No GRANT statement runs between the CREATE TABLE above and this
      // SELECT — this only succeeds because of the `ALTER DEFAULT
      // PRIVILEGES ... FOR ROLE <migrator>` statements in
      // packages/database/src/bootstrap-roles.ts.
      const rows = await runtime.unsafe("SELECT * FROM app.db_priv_default_grant_test");
      expect(rows).toHaveLength(1);
      // The runtime role still cannot mutate the table's structure, even
      // one it has full DML on.
      await expect(
        runtime.unsafe("ALTER TABLE app.db_priv_default_grant_test ADD COLUMN nope text"),
      ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    } finally {
      await migrator.unsafe("DROP TABLE app.db_priv_default_grant_test");
    }
  });
});
