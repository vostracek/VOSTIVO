import { sql } from "drizzle-orm";
import type { LocalDatabase } from "./athlete-database-handle";
import type { LocalColumnInfo, LocalMigrationStore } from "./migrations";
import { isRowPresent } from "./row-presence";

interface PragmaColumnRow {
  readonly name: string;
  readonly type: string;
  readonly not_null: number;
  readonly dflt_value: string | null;
}

/**
 * The production `LocalMigrationStore`, over drizzle's expo-sqlite driver:
 * used by `client.ts` (SQLCipher on device) AND by the `node:sqlite` test
 * connection, so tests exercise exactly this store, not a look-alike.
 * Native-free on purpose (type-only drizzle import; no runtime
 * `expo-sqlite`). Every call runs on the one connection the database was
 * opened with.
 */
export function createLocalMigrationStore(db: LocalDatabase): LocalMigrationStore {
  return {
    ensureMigrationsTable: () => {
      db.run(sql`CREATE TABLE IF NOT EXISTS __local_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );`);
    },
    isApplied: (id) => {
      const row = db.get<{ id: string }>(sql`SELECT id FROM __local_migrations WHERE id = ${id}`);
      return isRowPresent(row);
    },
    execute: (statement) => {
      db.run(sql.raw(statement));
    },
    markApplied: (id) => {
      db.run(sql`INSERT INTO __local_migrations (id) VALUES (${id})`);
    },
    // drizzle's sync SQLite transaction — the same mechanism the workout
    // repository's writes already use on device: `begin` -> work -> `commit`,
    // `rollback` + rethrow on any error, on the same connection. The work
    // uses `db` directly (not the tx handle) — same connection, same
    // transaction; the runner never nests these.
    runInTransaction: (work) => db.transaction(() => work()),
    tableSql: (table) => {
      const row = db.get<{ sql: string }>(sql`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${table}`);
      return isRowPresent(row) ? row.sql : null;
    },
    tableColumns: (table) => {
      const rows = db.all<PragmaColumnRow>(sql`SELECT name, type, "notnull" AS not_null, dflt_value FROM pragma_table_info(${table})`);
      return rows.length === 0 ? null : rows.map(toColumnInfo);
    },
  };
}

function toColumnInfo(row: PragmaColumnRow): LocalColumnInfo {
  return { name: row.name, type: row.type, notNull: row.not_null === 1, defaultValue: row.dflt_value };
}
