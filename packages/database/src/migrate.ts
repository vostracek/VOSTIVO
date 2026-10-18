import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createLogger } from "@vostivo/observability";
import { loadMigrationDatabaseConfig } from "./config.js";

const logger = createLogger({ serviceName: "database-migrate" });

/**
 * Uses the migration/admin role (`MIGRATION_DATABASE_URL`), never the API
 * runtime role — applying a schema migration requires DDL privileges the
 * runtime role deliberately does not have (Security Hardening Follow-Up
 * V1, "Postgres least privilege").
 */
async function main(): Promise<void> {
  const config = loadMigrationDatabaseConfig();
  const sql = postgres(config.MIGRATION_DATABASE_URL, { max: 1 });
  const db = drizzle(sql);

  logger.info("Applying pending migrations");
  await migrate(db, { migrationsFolder: "./drizzle" });
  logger.info("Migrations applied successfully");

  await sql.end();
}

main().catch((error: unknown) => {
  logger.error("Migration failed", { error: error instanceof Error ? error.message : error });
  process.exitCode = 1;
});
