import { openDatabaseSync, type SQLiteDatabase } from "expo-sqlite";
import { sql } from "drizzle-orm";
import { drizzle, type ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite";
import * as schema from "./schema";
import { getOrCreateDatabaseKey } from "../infrastructure/database-key";
import { runLocalMigrations, type LocalMigrationStore } from "./migrations";
import { isRowPresent } from "./row-presence";

const DATABASE_NAME = "vostivo.db";

let cachedDatabase: Promise<ExpoSQLiteDatabase<typeof schema>> | undefined;

/**
 * Initializes the local SQLCipher-encrypted database and returns a
 * type-safe Drizzle handle, enforcing this order (spec section 5):
 *
 *   obtain/create key -> open database -> apply PRAGMA key immediately ->
 *   verify the key by forcing a real read -> enable other PRAGMAs ->
 *   run migrations -> expose the database.
 *
 * No caller can reach a `Database` before this sequence completes — there
 * is no other exported way to get one, and the result is cached so the
 * sequence runs exactly once per process.
 */
export function initializeLocalDatabase(): Promise<ExpoSQLiteDatabase<typeof schema>> {
  cachedDatabase ??= initialize();
  return cachedDatabase;
}

async function initialize(): Promise<ExpoSQLiteDatabase<typeof schema>> {
  const key = await getOrCreateDatabaseKey();
  const nativeDb = openDatabaseSync(DATABASE_NAME);

  applyEncryptionKey(nativeDb, key);
  verifyEncryptedDatabaseOpens(nativeDb);
  enablePragmas(nativeDb);

  const db = drizzle(nativeDb, { schema });
  runLocalMigrations(createMigrationStore(db));

  return db;
}

/**
 * SQLCipher-specific API constraint: the key must be the very first
 * statement executed on a freshly opened connection, before any other
 * read/write — and SQLite PRAGMAs do not support bound `?` parameters, so
 * the key has to be inlined as SQL text rather than passed as a bind
 * parameter. `getOrCreateDatabaseKey()` guarantees this value is always a
 * 64-character lowercase hex string it generated itself (never user
 * input), and the `x'...'` form tells SQLCipher to use it as a raw 256-bit
 * key rather than a passphrase to run through PBKDF2 — appropriate since
 * it is already high-entropy random material, not a human passphrase.
 */
function applyEncryptionKey(nativeDb: SQLiteDatabase, key: string): void {
  nativeDb.execSync(`PRAGMA key = "x'${key}'";`);
}

/**
 * SQLCipher only actually decrypts the database header/schema on the
 * first real read — an incorrect key does not fail at `PRAGMA key` time,
 * it fails here, with SQLITE_NOTADB ("file is not a database"). Forcing
 * that check immediately means a wrong/corrupted key fails loudly at
 * startup instead of surfacing as a confusing error on some unrelated
 * later query.
 */
function verifyEncryptedDatabaseOpens(nativeDb: SQLiteDatabase): void {
  nativeDb.getFirstSync("SELECT count(*) FROM sqlite_master;");
}

function enablePragmas(nativeDb: SQLiteDatabase): void {
  nativeDb.execSync("PRAGMA foreign_keys = ON;");
}

function createMigrationStore(db: ExpoSQLiteDatabase<typeof schema>): LocalMigrationStore {
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
  };
}
