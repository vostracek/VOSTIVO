import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { PgBoss } from "pg-boss";
import { createLogger } from "@vostivo/observability";
import { loadManualDatabaseConfig } from "./config.js";

const logger = createLogger({ serviceName: "database-bootstrap-manual-db" });

/**
 * The ONLY database name this tool will ever create/drop. Not read from an
 * environment variable — a destructive DROP/CREATE DATABASE target must be
 * a fixed constant, never something a misconfigured env var could widen.
 */
export const MANUAL_DATABASE_NAME = "vostivo_manual";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "postgres"]);
const APP_SCHEMA = "app";
const PGBOSS_SCHEMA = "pgboss";

/**
 * Duplicated from `bootstrap-roles.ts`/`bootstrap-pgboss.ts` rather than
 * imported, for the exact reason those two files already document: every
 * standalone script in this directory runs its whole routine as an
 * unguarded module-scope side effect on import, so importing a name from
 * one would execute all of it.
 */
const API_RUNTIME_ROLE = "vostivo_api";

/**
 * Local Manual E2E Runtime Unblock Slice (task section 11/26) — hard,
 * synchronous safety assertions for a genuinely destructive tool (DROP
 * DATABASE). Pure and side-effect-free on purpose, so it can be unit
 * tested directly (see `bootstrap-manual-db.test.ts`) without ever
 * triggering this file's own `main()` — the `VITEST` guard at the bottom
 * mirrors the established pattern in `apps/worker/src/main.ts`.
 *
 * Refuses anything other than: `NODE_ENV=local`, a local-only host, and a
 * connection string whose database name is EXACTLY
 * `vostivo_manual` — never `vostivo_dev`, never a production-shaped
 * hostname, never an arbitrary name a typo could produce.
 */
export function assertSafeManualDbTarget(params: {
  readonly nodeEnv: string;
  readonly manualDatabaseUrl: string;
}): void {
  if (params.nodeEnv !== "local") {
    throw new Error(`Refusing to reset a database: NODE_ENV must be "local", got "${params.nodeEnv}".`);
  }

  const url = new URL(params.manualDatabaseUrl);
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(`Refusing to reset a database on non-local host "${url.hostname}".`);
  }

  const targetDatabaseName = url.pathname.replace(/^\//, "");
  if (targetDatabaseName !== MANUAL_DATABASE_NAME) {
    throw new Error(
      `Refusing to reset database "${targetDatabaseName}" — this tool only ever targets "${MANUAL_DATABASE_NAME}".`,
    );
  }
}

/**
 * Drops and recreates `vostivo_manual` from scratch, then brings it to
 * exactly the same state `vostivo_dev` reaches via
 * `db:migrate` + `db:bootstrap-roles` + `db:bootstrap-pgboss` combined —
 * one single command for the one database this tool is allowed to touch.
 * Never touches `vostivo_dev` or any other database; never runs unless
 * `assertSafeManualDbTarget` passes first.
 */
async function main(): Promise<void> {
  const config = loadManualDatabaseConfig();
  assertSafeManualDbTarget({ nodeEnv: config.NODE_ENV, manualDatabaseUrl: config.MANUAL_DATABASE_URL });

  const targetUrl = new URL(config.MANUAL_DATABASE_URL);
  const adminRole = targetUrl.username;

  const maintenanceUrl = new URL(config.MANUAL_DATABASE_URL);
  maintenanceUrl.pathname = "/postgres";

  logger.info("Dropping and recreating vostivo_manual (LOCAL ONLY)", { database: MANUAL_DATABASE_NAME });
  const maintenanceSql = postgres(maintenanceUrl.toString(), { max: 1 });
  try {
    await maintenanceSql.unsafe(`DROP DATABASE IF EXISTS ${MANUAL_DATABASE_NAME}`);
    await maintenanceSql.unsafe(`CREATE DATABASE ${MANUAL_DATABASE_NAME} OWNER ${adminRole}`);
  } finally {
    await maintenanceSql.end();
  }

  logger.info("Applying migrations to vostivo_manual");
  const migrateSql = postgres(config.MANUAL_DATABASE_URL, { max: 1 });
  await migrate(drizzle(migrateSql), { migrationsFolder: "./drizzle" });
  await migrateSql.end();

  logger.info("Granting least-privilege API runtime role access on vostivo_manual", { role: API_RUNTIME_ROLE });
  const grantSql = postgres(config.MANUAL_DATABASE_URL, { max: 1 });
  try {
    await grantSql.unsafe(`GRANT USAGE ON SCHEMA ${APP_SCHEMA} TO ${API_RUNTIME_ROLE}`);
    await grantSql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${APP_SCHEMA} TO ${API_RUNTIME_ROLE}`);
    await grantSql.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${APP_SCHEMA} TO ${API_RUNTIME_ROLE}`);
    await grantSql.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${adminRole} IN SCHEMA ${APP_SCHEMA} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${API_RUNTIME_ROLE}`,
    );
    await grantSql.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${adminRole} IN SCHEMA ${APP_SCHEMA} GRANT USAGE, SELECT ON SEQUENCES TO ${API_RUNTIME_ROLE}`,
    );
    await grantSql.unsafe(`ALTER ROLE ${API_RUNTIME_ROLE} SET search_path = "${APP_SCHEMA}", public`);
  } finally {
    await grantSql.end();
  }

  logger.info("Running pg-boss's own schema migrations on vostivo_manual");
  const pgBossMigrator = new PgBoss({ connectionString: config.MANUAL_DATABASE_URL, migrate: true, supervise: false, schedule: false });
  await pgBossMigrator.start();
  await pgBossMigrator.stop();

  logger.info("Granting least-privilege pg-boss access on vostivo_manual", { role: API_RUNTIME_ROLE });
  const pgBossGrantSql = postgres(config.MANUAL_DATABASE_URL, { max: 1 });
  try {
    await pgBossGrantSql.unsafe(`GRANT USAGE ON SCHEMA ${PGBOSS_SCHEMA} TO ${API_RUNTIME_ROLE}`);
    await pgBossGrantSql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${PGBOSS_SCHEMA} TO ${API_RUNTIME_ROLE}`);
    await pgBossGrantSql.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${PGBOSS_SCHEMA} TO ${API_RUNTIME_ROLE}`);
    await pgBossGrantSql.unsafe(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${PGBOSS_SCHEMA} TO ${API_RUNTIME_ROLE}`);
    await pgBossGrantSql.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${adminRole} IN SCHEMA ${PGBOSS_SCHEMA} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${API_RUNTIME_ROLE}`,
    );
    await pgBossGrantSql.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${adminRole} IN SCHEMA ${PGBOSS_SCHEMA} GRANT USAGE, SELECT ON SEQUENCES TO ${API_RUNTIME_ROLE}`,
    );
    await pgBossGrantSql.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${adminRole} IN SCHEMA ${PGBOSS_SCHEMA} GRANT EXECUTE ON FUNCTIONS TO ${API_RUNTIME_ROLE}`,
    );
  } finally {
    await pgBossGrantSql.end();
  }

  logger.info("vostivo_manual is ready: fresh schema, migrated, pg-boss bootstrapped, least-privilege role granted", {
    database: MANUAL_DATABASE_NAME,
  });
}

if (process.env.VITEST === undefined) {
  main().catch((error: unknown) => {
    logger.error("vostivo_manual bootstrap failed", { error: error instanceof Error ? error.message : error });
    process.exitCode = 1;
  });
}
