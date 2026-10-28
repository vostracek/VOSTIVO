import postgres from "postgres";
import { PgBoss } from "pg-boss";
import { createLogger } from "@vostivo/observability";
import { loadMigrationDatabaseConfig } from "./config.js";
import { assertDevToolingTarget } from "./data-environment.js";

const logger = createLogger({ serviceName: "database-bootstrap-pgboss" });

/** pg-boss's own fixed default schema name (verified against the installed `pg-boss@12.32.0` source — `dist/plans.js`'s `DEFAULT_SCHEMA`), never configured per-environment in this codebase. */
const PGBOSS_SCHEMA = "pgboss";

/**
 * Deliberately NOT imported from `bootstrap-roles.ts`: every standalone
 * script in this file (`migrate.ts`, `seed-dev-plan.ts`, `bootstrap-roles.ts`
 * itself) calls its own `main().catch(...)` unconditionally at module scope
 * — the established convention here is "run directly via tsx only," never
 * "import me as a library." Importing a NAMED EXPORT from `bootstrap-roles.ts`
 * would execute its ENTIRE role-bootstrap routine as an unannounced import
 * side effect (including requiring `VOSTIVO_API_DB_PASSWORD`, which this
 * script has no reason to need). A one-line string-constant duplication
 * here is far cheaper than that footgun, and this identity is already
 * documented there as part of the locked least-privilege architecture, not
 * something that varies.
 */
const API_RUNTIME_ROLE = "vostivo_api";

/**
 * Progression Evaluation Orchestration V1 — idempotent local/CI
 * infrastructure bootstrap for pg-boss's own schema, mirroring
 * `bootstrap-roles.ts`'s shape exactly (same rationale: creating/granting
 * on a schema is an admin-role operation, never folded into an ordinary
 * `app`-schema Drizzle migration). Run this AFTER `db:bootstrap-roles` —
 * it grants to the `vostivo_api` role, which must already exist.
 *
 * Two steps:
 * 1. Let pg-boss run its OWN real DDL migrations (`new PgBoss({..., migrate:
 *    true}).start()`), connected as the migration/admin role — the only
 *    role with CREATE privilege. This is pg-boss's own first-party
 *    mechanism, not a hand-rolled schema copy; it stays correct across a
 *    future pg-boss version bump without this file changing.
 * 2. Grant the least-privilege `vostivo_api` role DML-only access to that
 *    schema — SELECT/INSERT/UPDATE/DELETE on tables, USAGE/SELECT on
 *    sequences, EXECUTE on pg-boss's helper functions (`create_queue` etc. —
 *    `.createQueue()`/`.send()` call these; Postgres already grants EXECUTE
 *    on a new function to PUBLIC by default, but this is made explicit
 *    rather than relied on implicitly, matching this file's own
 *    never-rely-on-an-implicit-default convention) — explicitly NEVER any
 *    CREATE/DROP/ALTER privilege. `apps/api`'s producer and `apps/worker`'s
 *    consumer both connect as `vostivo_api`, same as every other runtime
 *    connection in this codebase (Security Hardening Follow-Up V1).
 *
 * Safe to run repeatedly: pg-boss's own migration path is itself
 * idempotent (a no-op once the schema is current), and every `GRANT`/
 * `ALTER DEFAULT PRIVILEGES` statement here is naturally idempotent too.
 *
 * Does NOT touch a real hosted Supabase project — same scope note as
 * `bootstrap-roles.ts`.
 */
async function main(): Promise<void> {
  const config = loadMigrationDatabaseConfig();
  await assertDevToolingTarget(config.MIGRATION_DATABASE_URL, "db:bootstrap-pgboss");
  const migratorRole = new URL(config.MIGRATION_DATABASE_URL).username;

  logger.info("Running pg-boss's own schema migrations", { schema: PGBOSS_SCHEMA });
  const migrator = new PgBoss({ connectionString: config.MIGRATION_DATABASE_URL, migrate: true, supervise: false, schedule: false });
  await migrator.start();
  await migrator.stop();
  logger.info("pg-boss schema is up to date");

  const sql = postgres(config.MIGRATION_DATABASE_URL, { max: 1 });
  try {
    logger.info("Granting least-privilege pg-boss access", { role: API_RUNTIME_ROLE, schema: PGBOSS_SCHEMA });

    await sql.unsafe(`GRANT USAGE ON SCHEMA ${PGBOSS_SCHEMA} TO ${API_RUNTIME_ROLE}`);
    await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${PGBOSS_SCHEMA} TO ${API_RUNTIME_ROLE}`);
    await sql.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${PGBOSS_SCHEMA} TO ${API_RUNTIME_ROLE}`);
    await sql.unsafe(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${PGBOSS_SCHEMA} TO ${API_RUNTIME_ROLE}`);

    // Covers a future pg-boss version bump that migrates in a new table
    // (or function) via the same migrator role, without a developer
    // remembering to re-run this script's GRANT step by hand.
    await sql.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorRole} IN SCHEMA ${PGBOSS_SCHEMA} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${API_RUNTIME_ROLE}`,
    );
    await sql.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorRole} IN SCHEMA ${PGBOSS_SCHEMA} GRANT USAGE, SELECT ON SEQUENCES TO ${API_RUNTIME_ROLE}`,
    );
    await sql.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorRole} IN SCHEMA ${PGBOSS_SCHEMA} GRANT EXECUTE ON FUNCTIONS TO ${API_RUNTIME_ROLE}`,
    );

    logger.info("Least-privilege pg-boss access bootstrap complete", { role: API_RUNTIME_ROLE });
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  logger.error("pg-boss bootstrap failed", { error: error instanceof Error ? error.message : error });
  process.exitCode = 1;
});
