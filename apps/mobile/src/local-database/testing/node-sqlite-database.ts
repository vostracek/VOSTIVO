import { DatabaseSync } from "node:sqlite";
import { sql } from "drizzle-orm";
// The driver subpath, not the package index: the index also re-exports the
// live-query helper, which imports native `expo-sqlite` at runtime.
import { drizzle, type ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite/driver";
import * as schema from "../schema";
import { runLocalMigrations } from "../migrations";
import { isRowPresent } from "../row-presence";

/**
 * TEST-ONLY: a REAL SQLite engine (Node's built-in `node:sqlite`) behind
 * the exact `expo-sqlite` client surface drizzle's expo driver uses
 * (`prepareSync` -> `executeSync`/`executeForRawResultSync` ->
 * `getAllSync`/`getFirstSync`). The repository's own SQL, the real local
 * migrations and drizzle's real `begin`/`commit`/`rollback` all run
 * unchanged — only SQLCipher encryption (a native-device concern) is absent.
 *
 * File-backed, so "process death" is modelled honestly: close the
 * connection, drop every in-memory object, reopen the same file.
 */
export type TestLocalDatabase = ExpoSQLiteDatabase<typeof schema>;

export interface TestDatabaseConnection {
  readonly db: TestLocalDatabase;
  /** Raw escape hatch for test setup (e.g. installing a failure trigger) — never used by app code. */
  readonly exec: (statement: string) => void;
  readonly close: () => void;
}

function toExpoClient(native: DatabaseSync): Parameters<typeof drizzle>[0] {
  const client = {
    prepareSync(source: string) {
      const statement = native.prepare(source);
      const returnsRows = statement.columns().length > 0;
      const execute = (params: unknown[]) => {
        if (returnsRows) {
          const rows = statement.all(...params);
          return { changes: 0, lastInsertRowId: 0, getAllSync: () => rows, getFirstSync: () => rows[0] ?? null };
        }
        const info = statement.run(...params);
        return { changes: Number(info.changes), lastInsertRowId: Number(info.lastInsertRowid), getAllSync: () => [], getFirstSync: () => null };
      };
      return {
        executeSync: (params: unknown[]) => execute(params),
        executeForRawResultSync: (params: unknown[]) => {
          const rows = returnsRows ? statement.all(...params).map((row) => Object.values(row)) : (execute(params), []);
          return { getAllSync: () => rows, getFirstSync: () => rows[0] ?? null };
        },
        finalizeSync: () => {},
      };
    },
  };
  return client as unknown as Parameters<typeof drizzle>[0];
}

/** Opens (creating if needed) a local database file and applies the real local migrations — same steps as `client.ts`, minus SQLCipher. */
export function openTestLocalDatabase(path: string): TestDatabaseConnection {
  const native = new DatabaseSync(path);
  native.exec("PRAGMA foreign_keys = ON;");
  const db = drizzle(toExpoClient(native), { schema });
  runLocalMigrations({
    ensureMigrationsTable: () => native.exec("CREATE TABLE IF NOT EXISTS __local_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));"),
    isApplied: (id) => isRowPresent(db.get<{ id: string }>(sql`SELECT id FROM __local_migrations WHERE id = ${id}`)),
    execute: (statement) => native.exec(statement),
    markApplied: (id) => db.run(sql`INSERT INTO __local_migrations (id) VALUES (${id})`),
  });
  return { db, exec: (statement) => native.exec(statement), close: () => native.close() };
}
