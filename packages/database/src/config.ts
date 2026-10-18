import { z } from "zod";
import { baseConfigSchema, loadConfig } from "@vostivo/config";

/**
 * `DATABASE_URL` is always the least-privilege **API runtime** role's
 * connection string (Security Hardening Follow-Up V1, spec section
 * "Postgres least privilege") — the same role `apps/api`'s `DatabaseModule`
 * connects with, and the same one the real-Postgres integration test
 * suite uses, so those tests genuinely prove the runtime role is
 * sufficient for every current feature rather than merely inspecting
 * grants. It must never be able to CREATE/DROP/ALTER a table or role.
 */
export const databaseConfigSchema = baseConfigSchema.extend({
  DATABASE_URL: z.string().url(),
});

export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;

export function loadDatabaseConfig(
  source: Record<string, string | undefined> = process.env,
): DatabaseConfig {
  return loadConfig(databaseConfigSchema, source);
}

/**
 * `MIGRATION_DATABASE_URL` is the separate migration/admin role's
 * connection string — the only one ever used to apply schema migrations
 * or bootstrap the runtime role itself (`migrate.ts`, `bootstrap-roles.ts`).
 * Application code (the API, the dev seed fixture) never reads this; only
 * infrastructure tooling does. Deliberately a distinct schema/loader
 * rather than a second optional field on `databaseConfigSchema`, so a tool
 * that only needs the runtime URL can never accidentally read admin
 * credentials it wasn't asking for.
 */
export const migrationDatabaseConfigSchema = baseConfigSchema.extend({
  MIGRATION_DATABASE_URL: z.string().url(),
});

export type MigrationDatabaseConfig = z.infer<typeof migrationDatabaseConfigSchema>;

export function loadMigrationDatabaseConfig(
  source: Record<string, string | undefined> = process.env,
): MigrationDatabaseConfig {
  return loadConfig(migrationDatabaseConfigSchema, source);
}

/**
 * `MANUAL_DATABASE_URL` is the migration/admin-role connection string for
 * the LOCAL-only manual-smoke-test database (`vostivo_manual`) — read
 * exclusively by `bootstrap-manual-db.ts`, which validates (via
 * `assertSafeManualDbTarget`) that it genuinely points at that exact
 * database, on a local host, with `NODE_ENV=local`, before it is ever
 * used to DROP/CREATE a database. A distinct schema/loader for the same
 * reason `MIGRATION_DATABASE_URL` is its own: this tool's one job needs
 * its own narrowly-scoped credential, never conflated with the
 * `vostivo_dev` migration URL other tooling reads.
 */
export const manualDatabaseConfigSchema = baseConfigSchema.extend({
  MANUAL_DATABASE_URL: z.string().url(),
});

export type ManualDatabaseConfig = z.infer<typeof manualDatabaseConfigSchema>;

export function loadManualDatabaseConfig(
  source: Record<string, string | undefined> = process.env,
): ManualDatabaseConfig {
  return loadConfig(manualDatabaseConfigSchema, source);
}
