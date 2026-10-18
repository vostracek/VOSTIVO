import postgres from "postgres";
import { createLogger } from "@vostivo/observability";
import { loadMigrationDatabaseConfig } from "./config.js";

const logger = createLogger({ serviceName: "database-bootstrap-roles" });

/**
 * The Postgres role name the API (and the real-Postgres integration test
 * suite) connects as at runtime. Kept as a single named constant rather
 * than a per-environment config value — this identity is part of the
 * locked least-privilege architecture (Security Hardening Follow-Up V1),
 * not something that varies by deployment.
 *
 * `bootstrap-pgboss.ts` deliberately duplicates this exact string rather
 * than importing it from here — see that file's own comment: every script
 * in this directory runs its whole routine as an unguarded module-scope
 * side effect, so importing a name from one executes all of it.
 */
export const API_RUNTIME_ROLE = "vostivo_api";

const APP_SCHEMA = "app";

/**
 * Idempotent local/CI infrastructure bootstrap ("Prefer a clear
 * infrastructure/bootstrap mechanism... must work in LOCAL Docker
 * Postgres, CI Postgres"). Deliberately a standalone script connecting
 * with the migration/admin role, never folded into an ordinary
 * `app`-schema Drizzle migration — creating/granting a *role* is a
 * database-cluster-level operation, not an application-schema change, and
 * the migration role already owns every `app`-schema object, so it is the
 * only role that can grant privileges on them.
 *
 * Every statement here is either identifier/constant-only (never touches
 * external input) or the validated `VOSTIVO_API_DB_PASSWORD` value, which
 * is embedded as literal SQL text via `sql.unsafe()` rather than a bound
 * parameter — PostgreSQL's `CREATE ROLE ... PASSWORD` grammar requires a
 * string literal in that position, not a bind placeholder, the same
 * constraint this repo already documents for SQLite's `PRAGMA key` (see
 * apps/mobile/src/infrastructure/database-key.ts). Safe here specifically
 * because `requireApiRolePassword()` validates the value's character set
 * before it ever reaches SQL (no quote/backslash/semicolon characters are
 * permitted), the same defensive-validation-before-raw-SQL pattern that
 * file already establishes.
 *
 * Safe to run repeatedly: role creation is guarded by an existence check,
 * and every `GRANT`/`ALTER DEFAULT PRIVILEGES` statement is naturally
 * idempotent.
 *
 * Does NOT touch a real hosted Supabase project — this only ever runs
 * against the local docker-compose Postgres or an ephemeral CI Postgres
 * service. See docs/architecture/FOUNDATION.md for the production
 * Supabase role-provisioning model this bootstrap is not a substitute for.
 */
async function main(): Promise<void> {
  const config = loadMigrationDatabaseConfig();
  const password = requireApiRolePassword();
  const migratorRole = new URL(config.MIGRATION_DATABASE_URL).username;

  const sql = postgres(config.MIGRATION_DATABASE_URL, { max: 1 });

  try {
    logger.info("Bootstrapping least-privilege API runtime role", { role: API_RUNTIME_ROLE });

    const [{ exists }] = await sql<[{ exists: boolean }]>`
      SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = ${API_RUNTIME_ROLE}) AS exists
    `;

    if (exists) {
      // Re-applied every run so a rotated VOSTIVO_API_DB_PASSWORD takes
      // effect without needing a separate rotation procedure.
      await sql.unsafe(`ALTER ROLE ${API_RUNTIME_ROLE} WITH LOGIN PASSWORD '${password}'`);
      logger.info("Role already existed; password re-applied", { role: API_RUNTIME_ROLE });
    } else {
      await sql.unsafe(`CREATE ROLE ${API_RUNTIME_ROLE} WITH LOGIN PASSWORD '${password}'`);
      logger.info("Role created", { role: API_RUNTIME_ROLE });
    }

    // Explicitly NOT granted, anywhere in this file: SUPERUSER, CREATEDB,
    // CREATEROLE, BYPASSRLS, schema ownership, or any CREATE TABLE/DROP
    // TABLE/ALTER TABLE/CREATE ROLE privilege — this role must remain
    // structurally incapable of DDL. Proven, not just asserted, by
    // db-privilege.integration.test.ts.
    await sql.unsafe(`GRANT USAGE ON SCHEMA ${APP_SCHEMA} TO ${API_RUNTIME_ROLE}`);
    await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${APP_SCHEMA} TO ${API_RUNTIME_ROLE}`);
    await sql.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${APP_SCHEMA} TO ${API_RUNTIME_ROLE}`);

    // Covers a migration role that later creates a new app-schema table
    // without a developer remembering to grant it separately. Scoped to
    // objects the migration role itself creates ("FOR ROLE <migrator>") —
    // that is exactly the role every migration runs as.
    await sql.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorRole} IN SCHEMA ${APP_SCHEMA} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${API_RUNTIME_ROLE}`,
    );
    await sql.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorRole} IN SCHEMA ${APP_SCHEMA} GRANT USAGE, SELECT ON SEQUENCES TO ${API_RUNTIME_ROLE}`,
    );

    // Defense-in-depth, not a correctness requirement — every Drizzle
    // query already fully qualifies `app.<table>` (see `appSchema.table`
    // in packages/database/src/schema/*.ts), so this role's queries never
    // actually depend on search_path resolution. No CREATE privilege is
    // granted anywhere, on `app` or `public` (see the audit doc's "public
    // schema / search_path" section for the verification evidence).
    await sql.unsafe(`ALTER ROLE ${API_RUNTIME_ROLE} SET search_path = "${APP_SCHEMA}", public`);

    logger.info("Least-privilege API runtime role bootstrap complete", { role: API_RUNTIME_ROLE });
  } finally {
    await sql.end();
  }
}

/**
 * Never a hardcoded default (unlike the well-known local-dev `vostivo`/
 * `vostivo` convention elsewhere in this repo) — a role-creation password
 * is exactly the kind of value that must fail loudly if genuinely unset
 * rather than silently falling back to something guessable. The character
 * class deliberately excludes quotes/backslash/semicolon so the value can
 * never break out of the single-quoted literal it is embedded into above.
 */
function requireApiRolePassword(): string {
  const password = process.env.VOSTIVO_API_DB_PASSWORD;
  if (password === undefined || password.length === 0) {
    throw new Error(
      "VOSTIVO_API_DB_PASSWORD is required to bootstrap the API runtime role — set it (see .env.example) before running db:bootstrap-roles.",
    );
  }
  if (!/^[A-Za-z0-9_!@#$%^&*()+=./-]{8,128}$/.test(password)) {
    throw new Error("VOSTIVO_API_DB_PASSWORD has an unexpected format — refusing to use it in a DDL statement.");
  }
  return password;
}

main().catch((error: unknown) => {
  logger.error("Role bootstrap failed", { error: error instanceof Error ? error.message : error });
  process.exitCode = 1;
});
