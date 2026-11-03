import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { LOCAL_MIGRATIONS } from "./migrations";
import { openTestLocalDatabase } from "./testing/node-sqlite-database";
import { WorkoutRepository } from "../workout/workout-repository";

/**
 * CC-02 — D-MIG-1: local migrations must survive a REAL process death at any
 * point. Disposable file-backed SQLite only.
 *
 * Crashes are real: a child `node` process runs the real `migrations.ts`
 * (type-stripped) over `node:sqlite` and SIGKILLs itself at the chosen
 * point. The child's store models the production store's transaction
 * boundary with real BEGIN / COMMIT; its LEGACY mode runs with no
 * transaction at all, which is exactly what the pre-CC-02 runner did, to
 * build the partially-migrated files that existing devices may already hold.
 * Recovery is always the REAL app path: `openTestLocalDatabase`, which runs
 * the production migration store over drizzle's expo driver.
 */
const MIGRATIONS_TS = new URL("./migrations.ts", import.meta.url).href;

const ALL_IDS = [
  "0000_bootstrap_health_check",
  "0001_local_workout_sessions",
  "0002_local_performed_exercises",
  "0003_local_performed_sets",
  "0004_sync_outbox",
  "0005_local_workout_sessions_completed_at",
  "0006_local_performed_exercises_exercise_ref",
  "0007_local_set_drafts",
  "0008_local_rest_timer_state",
  "0009_local_workout_sessions_last_issued_session_seq",
  "0010_local_workout_sessions_finish_seq",
  "0011_local_performed_sets_set_type",
  "0012_local_workout_sessions_available_time_application",
];

const ADD_COLUMN_MIGRATIONS: readonly [string, string, string][] = [
  ["0005_local_workout_sessions_completed_at", "local_workout_sessions", "completed_at"],
  ["0006_local_performed_exercises_exercise_ref", "local_performed_exercises", "exercise_ref"],
  ["0009_local_workout_sessions_last_issued_session_seq", "local_workout_sessions", "last_issued_session_seq"],
  ["0010_local_workout_sessions_finish_seq", "local_workout_sessions", "finish_seq"],
  ["0011_local_performed_sets_set_type", "local_performed_sets", "set_type"],
  ["0012_local_workout_sessions_available_time_application", "local_workout_sessions", "available_time_application_json"],
];

type CrashPoint = "before-statement" | "after-statement" | "after-ledger";

const CHILD_SCRIPT = `
import { DatabaseSync } from "node:sqlite";
const [dbPath, migrationsPath, crashPoint, target, transactional] = process.argv.slice(2);
const { runLocalMigrations } = await import(migrationsPath);
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON;");
const die = () => process.kill(process.pid, "SIGKILL");
let current;
const store = {
  ensureMigrationsTable: () => db.exec("CREATE TABLE IF NOT EXISTS __local_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));"),
  isApplied: (id) => { current = id; return db.prepare("SELECT id FROM __local_migrations WHERE id = ?").all(id).length > 0; },
  execute: (statement) => {
    if (crashPoint === "before-statement" && current === target) die();
    db.exec(statement);
  },
  markApplied: (id) => {
    if (crashPoint === "after-statement" && id === target) die();
    db.prepare("INSERT INTO __local_migrations (id) VALUES (?)").run(id);
    if (crashPoint === "after-ledger" && id === target) die();
  },
  runInTransaction: (work) => {
    if (transactional !== "transactional") return work();
    db.exec("BEGIN");
    try { const result = work(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; }
  },
  tableSql: (table) => db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").all(table)[0]?.sql ?? null,
  tableColumns: (table) => {
    const rows = db.prepare('SELECT name, type, "notnull" AS not_null, dflt_value FROM pragma_table_info(?)').all(table);
    return rows.length === 0 ? null : rows.map((row) => ({ name: row.name, type: row.type, notNull: row.not_null === 1, defaultValue: row.dflt_value }));
  },
};
runLocalMigrations(store);
db.close();
`;

describe("CC-02 local migration crash recovery (real SIGKILL, real SQLite files)", () => {
  let dir: string;
  let path: string;
  let childScript: string;

  beforeEach(() => {
    dir = mkdtempSync(`${tmpdir()}/vostivo-cc02-`);
    path = `${dir}/athlete.db`;
    childScript = `${dir}/migrate-and-die.mjs`;
    writeFileSync(childScript, CHILD_SCRIPT);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Runs the real runner in a child process that SIGKILLs itself at `crashPoint` of migration `target`. */
  function killDuring(crashPoint: CrashPoint, target: string, mode: "transactional" | "legacy" = "transactional"): void {
    const child = spawnSync(process.execPath, ["--no-warnings", childScript, path, MIGRATIONS_TS, crashPoint, target, mode], { encoding: "utf8" });
    expect({ signal: child.signal, stderr: child.stderr }).toEqual({ signal: "SIGKILL", stderr: "" });
  }

  function raw<T>(work: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(path);
    try {
      return work(db);
    } finally {
      db.close();
    }
  }

  const recorded = (): string[] => raw((db) => db.prepare("SELECT id FROM __local_migrations ORDER BY id").all().map((row) => (row as { id: string }).id));
  const columns = (table: string): string[] => raw((db) => db.prepare("SELECT name FROM pragma_table_info(?)").all(table).map((row) => (row as { name: string }).name));
  const schema = (): unknown[] => raw((db) => db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all());

  /** The error's message plus every `cause` below it (drizzle wraps driver errors). */
  const messageChain = (error: unknown): string =>
    error instanceof Error ? `${error.message} <- ${messageChain(error.cause)}` : String(error);

  /** The real app open path. Returns the error instead of throwing. */
  function reopen(): Error | undefined {
    try {
      openTestLocalDatabase(path).close();
      return undefined;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  it("CC02-MIG-001: a fresh database migrates completely, each migration recorded once", () => {
    expect(reopen()).toBeUndefined();
    expect(recorded()).toEqual(ALL_IDS);
  });

  it("CC02-MIG-002: reopening a fully migrated database repeatedly changes neither schema nor history", () => {
    expect(reopen()).toBeUndefined();
    const schemaBefore = schema();
    const historyBefore = raw((db) => db.prepare("SELECT id, applied_at FROM __local_migrations ORDER BY id").all());

    for (let open = 0; open < 3; open += 1) expect(reopen()).toBeUndefined();

    expect(schema()).toEqual(schemaBefore);
    expect(raw((db) => db.prepare("SELECT id, applied_at FROM __local_migrations ORDER BY id").all())).toEqual(historyBefore);
  });

  it.each(ADD_COLUMN_MIGRATIONS)("CC02-MIG-003: SIGKILL after ALTER TABLE, before recording (%s) leaves nothing half-applied on disk", (id, table, column) => {
    killDuring("after-statement", id);

    // Inspected BEFORE any recovery: the killed transaction rolled back.
    expect(columns(table)).not.toContain(column);
    expect(recorded()).not.toContain(id);
  });

  it.each(ADD_COLUMN_MIGRATIONS)("CC02-MIG-004: after a SIGKILL between ALTER TABLE and recording (%s) the next open recovers — no duplicate column", (id, table, column) => {
    killDuring("after-statement", id);

    expect(reopen()).toBeUndefined();
    expect(reopen()).toBeUndefined();
    expect(recorded()).toEqual(ALL_IDS);
    expect(columns(table).filter((name) => name === column)).toEqual([column]);
  });

  it.each(["0007_local_set_drafts", "0011_local_performed_sets_set_type"])("CC02-MIG-005: SIGKILL while recording the ledger (after the insert, before commit: %s) rolls back both and recovers", (id) => {
    killDuring("after-ledger", id);

    expect(recorded()).not.toContain(id);
    expect(reopen()).toBeUndefined();
    expect(recorded()).toEqual(ALL_IDS);
  });

  it.each(["0001_local_workout_sessions", "0010_local_workout_sessions_finish_seq"])("CC02-MIG-006: SIGKILL before a schema change (%s) recovers", (id) => {
    killDuring("before-statement", id);

    expect(reopen()).toBeUndefined();
    expect(recorded()).toEqual(ALL_IDS);
  });

  it("CC02-MIG-007: a database left half-migrated by the OLD non-atomic runner is reconciled — workout data, outbox payloads and command ids preserved verbatim", async () => {
    killDuring("after-statement", "0011_local_performed_sets_set_type", "legacy");
    // The legacy runner committed the ALTER without recording it: the exact D-MIG-1 state.
    expect(columns("local_performed_sets")).toContain("set_type");
    expect(recorded()).not.toContain("0011_local_performed_sets_set_type");
    raw((db) =>
      db.exec(`
        INSERT INTO local_workout_sessions (id, prescription_json, started_at, created_at, updated_at, last_issued_session_seq)
          VALUES ('0190a000-0000-7000-8000-000000000001', '{"schemaVersion":1,"prescriptionId":"p","name":"Legacy","exercises":[]}', '2026-01-01T10:00:00.000Z', '2026-01-01T10:00:00.000Z', '2026-01-01T10:00:00.000Z', 1);
        INSERT INTO local_performed_exercises (id, workout_session_id, display_name, order_index, created_at, updated_at, exercise_ref)
          VALUES ('0190a000-0000-7000-8000-000000000002', '0190a000-0000-7000-8000-000000000001', 'Bench Press', 0, '2026-01-01T10:00:00.000Z', '2026-01-01T10:00:00.000Z', 'bench-press');
        INSERT INTO local_performed_sets (id, performed_exercise_id, order_index, actual_reps, load_kind, load_amount_milli, load_unit, load_basis, completion_state, completed_at, revision, created_at, updated_at, set_type)
          VALUES ('0190a000-0000-7000-8000-000000000003', '0190a000-0000-7000-8000-000000000002', 0, 10, 'EXTERNAL_WEIGHT', 62500, 'KG', 'TOTAL', 'COMPLETED', '2026-01-01T10:05:00.000Z', 3, '2026-01-01T10:05:00.000Z', '2026-01-01T10:05:00.000Z', 'WARM_UP');
        INSERT INTO sync_outbox (command_id, command_type, schema_version, payload_json, status, attempt_count, created_at, updated_at)
          VALUES ('0190a000-0000-7000-8000-0000000000c1', 'START_WORKOUT_SESSION_V1', 1, '{"keep":"verbatim"}', 'RETRY', 4, '2026-01-01T10:00:00.000Z', '2026-01-01T10:00:00.000Z');
      `),
    );
    const dataBefore = raw((db) => ({
      sessions: db.prepare("SELECT * FROM local_workout_sessions").all(),
      exercises: db.prepare("SELECT * FROM local_performed_exercises").all(),
      sets: db.prepare("SELECT * FROM local_performed_sets").all(),
      outbox: db.prepare("SELECT * FROM sync_outbox").all(),
    }));

    expect(reopen()).toBeUndefined();

    expect(recorded()).toEqual(ALL_IDS);
    const dataAfter = raw((db) => ({
      sessions: db.prepare("SELECT * FROM local_workout_sessions").all(),
      exercises: db.prepare("SELECT * FROM local_performed_exercises").all(),
      sets: db.prepare("SELECT * FROM local_performed_sets").all(),
      outbox: db.prepare("SELECT * FROM sync_outbox").all(),
    }));
    // Only the one later migration (0012) adds a NULL column to the session row.
    expect(dataAfter.exercises).toEqual(dataBefore.exercises);
    expect(dataAfter.sets).toEqual(dataBefore.sets);
    expect(dataAfter.outbox).toEqual(dataBefore.outbox);
    expect(dataAfter.sessions).toEqual(dataBefore.sessions.map((row) => ({ ...(row as object), available_time_application_json: null })));

    // The app itself can read it back.
    const connection = openTestLocalDatabase(path);
    try {
      const repository = new WorkoutRepository(() => Promise.resolve(connection.db));
      const active = await repository.getActiveWorkoutSession();
      expect(active?.id).toBe("0190a000-0000-7000-8000-000000000001");
      expect((await repository.getPendingCommands(25)).map((record) => record.commandId)).toEqual(["0190a000-0000-7000-8000-0000000000c1"]);
    } finally {
      connection.close();
    }
  });

  it("CC02-MIG-008: a partially migrated column whose definition does NOT match is never guessed — open fails closed with a typed error and the file is untouched", () => {
    killDuring("before-statement", "0011_local_performed_sets_set_type", "legacy");
    raw((db) => db.exec("ALTER TABLE local_performed_sets ADD COLUMN set_type INTEGER;"));
    const schemaBefore = schema();
    const historyBefore = recorded();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const error = reopen();
      expect(error?.name).toBe("LocalMigrationReconciliationError");
      expect(error?.message).toContain("0011_local_performed_sets_set_type");
    }

    expect(schema()).toEqual(schemaBefore);
    expect(recorded()).toEqual(historyBefore);
  });

  it("CC02-MIG-009: an unrecorded CREATE TABLE whose existing table has different columns fails closed instead of being silently recorded", () => {
    killDuring("before-statement", "0007_local_set_drafts", "legacy");
    raw((db) => db.exec("CREATE TABLE local_set_drafts (something_else TEXT);"));
    const historyBefore = recorded();

    const error = reopen();

    expect(error?.name).toBe("LocalMigrationReconciliationError");
    expect(error?.message).toContain("0007_local_set_drafts");
    expect(recorded()).toEqual(historyBefore);
  });

  it("CC02-MIG-010: an unrecorded CREATE TABLE whose table already matches exactly is recorded without re-running it", () => {
    killDuring("after-statement", "0008_local_rest_timer_state", "legacy");

    expect(reopen()).toBeUndefined();
    expect(recorded()).toEqual(ALL_IDS);
  });

  // --- CC-02B: reconciliation requires PROOF of equivalence, not matching names ---

  const statementOf = (id: string): string => {
    const migration = LOCAL_MIGRATIONS.find((candidate) => candidate.id === id);
    if (migration === undefined) throw new Error(`unknown migration ${id}`);
    return migration.statement;
  };
  /** The real historical statement with ONE textual change — same table name, same column names. */
  const impostor = (id: string, from: string, to: string): string => {
    const statement = statementOf(id);
    expect(statement).toContain(from);
    return statement.replace(from, to).replace("IF NOT EXISTS ", "");
  };
  const everything = (): unknown => raw((db) => ({
    schema: db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all(),
    ledger: db.prepare("SELECT id, applied_at FROM __local_migrations ORDER BY id").all(),
    sessions: db.prepare("SELECT * FROM local_workout_sessions").all(),
  }));
  const seedSession = (): void =>
    raw((db) =>
      db.exec(`INSERT INTO local_workout_sessions (id, prescription_json, started_at, created_at, updated_at)
               VALUES ('0190a000-0000-7000-8000-0000000000aa', '{"keep":"verbatim"}', '2026-01-01T10:00:00.000Z', '2026-01-01T10:00:00.000Z', '2026-01-01T10:00:00.000Z');`),
    );

  it.each([
    ["a wrong column type", "0003_local_performed_sets", "actual_reps INTEGER NOT NULL", "actual_reps TEXT NOT NULL"],
    ["a missing PRIMARY KEY", "0003_local_performed_sets", "id TEXT PRIMARY KEY", "id TEXT"],
    ["a missing NOT NULL", "0003_local_performed_sets", "load_amount_milli INTEGER NOT NULL", "load_amount_milli INTEGER"],
    ["a missing FOREIGN KEY", "0003_local_performed_sets", "TEXT NOT NULL REFERENCES local_performed_exercises(id)", "TEXT NOT NULL"],
    ["an extra CHECK constraint", "0003_local_performed_sets", "revision INTEGER NOT NULL", "revision INTEGER NOT NULL CHECK (revision > 0)"],
    ["a missing composite PRIMARY KEY (uniqueness)", "0007_local_set_drafts", "PRIMARY KEY (workout_session_id, prescription_exercise_id, prescription_set_id)", "UNIQUE (workout_session_id)"],
    ["a different DEFAULT", "0004_sync_outbox", "status TEXT NOT NULL DEFAULT 'PENDING'", "status TEXT NOT NULL DEFAULT 'SENT'"],
  ])("CC02-MIG-015: an unrecorded table with the SAME column names but %s is never recorded — fails closed, nothing changes", (_case, id, from, to) => {
    killDuring("before-statement", id, "legacy");
    seedSession();
    raw((db) => db.exec(impostor(id, from, to)));
    const before = everything();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const error = reopen();
      expect(error?.name).toBe("LocalMigrationReconciliationError");
      expect(error?.message).toContain(id);
    }

    expect(everything()).toEqual(before);
    expect(recorded()).not.toContain(id);
  });

  it.each([
    ["an extra CHECK", "0011_local_performed_sets_set_type", "local_performed_sets", "set_type TEXT NOT NULL DEFAULT 'WORKING' CHECK (set_type = 'WORKING')"],
    ["an extra FOREIGN KEY", "0006_local_performed_exercises_exercise_ref", "local_performed_exercises", "exercise_ref TEXT REFERENCES local_workout_sessions(id)"],
    ["a different COLLATE", "0005_local_workout_sessions_completed_at", "local_workout_sessions", "completed_at TEXT COLLATE NOCASE"],
  ])("CC02-MIG-016: an unrecorded column with the right type/NOT NULL/DEFAULT but %s is never recorded — fails closed, nothing changes", (_case, id, table, definition) => {
    killDuring("before-statement", id, "legacy");
    seedSession();
    raw((db) => db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition};`));
    const before = everything();

    const error = reopen();

    expect(error?.name).toBe("LocalMigrationReconciliationError");
    expect(error?.message).toContain(id);
    expect(everything()).toEqual(before);
  });

  it("CC02-MIG-017: a table left unrecorded by the OLD runner (its exact historical statement) is still reconciled — every row unchanged", () => {
    killDuring("after-statement", "0004_sync_outbox", "legacy");
    expect(recorded()).not.toContain("0004_sync_outbox");
    seedSession();
    raw((db) =>
      db.exec(`INSERT INTO sync_outbox (command_id, command_type, schema_version, payload_json, status, attempt_count, created_at, updated_at)
               VALUES ('0190a000-0000-7000-8000-0000000000c2', 'START_WORKOUT_SESSION_V1', 1, '{"keep":"verbatim"}', 'RETRY', 2, '2026-01-01T10:00:00.000Z', '2026-01-01T10:00:00.000Z');`),
    );
    const outboxBefore = raw((db) => db.prepare("SELECT * FROM sync_outbox").all());

    expect(reopen()).toBeUndefined();

    expect(recorded()).toEqual(ALL_IDS);
    expect(raw((db) => db.prepare("SELECT * FROM sync_outbox").all())).toEqual(outboxBefore);
    expect(raw((db) => db.prepare("SELECT id, prescription_json FROM local_workout_sessions").all())).toEqual([
      { id: "0190a000-0000-7000-8000-0000000000aa", prescription_json: '{"keep":"verbatim"}' },
    ]);
  });

  it("CC02-MIG-018: the evidence reconciliation compares against is exactly what SQLite stores for each historical statement", () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const migration of LOCAL_MIGRATIONS) {
        const before = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").all(migration.table)[0] as { sql: string } | undefined)?.sql;
        db.exec(migration.statement);
        const after = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").all(migration.table)[0] as { sql: string }).sql;
        if (migration.kind === "CREATE_TABLE") {
          // SQLite stores the statement verbatim minus `IF NOT EXISTS` and the trailing `;`.
          expect(after).toBe(migration.statement.replace("CREATE TABLE IF NOT EXISTS ", "CREATE TABLE ").replace(/;$/, ""));
        } else {
          // ADD COLUMN appends `, <definition>` before the closing parenthesis — and the
          // declared metadata spells exactly that definition.
          const { name, type, notNull, defaultValue } = migration.column;
          const definition = `${name} ${type}${notNull ? " NOT NULL" : ""}${defaultValue === null ? "" : ` DEFAULT ${defaultValue}`}`;
          expect(migration.statement).toBe(`ALTER TABLE ${migration.table} ADD COLUMN ${definition};`);
          expect(after).toBe(`${before?.slice(0, -1)}, ${definition})`);
        }
      }
    } finally {
      db.close();
    }
  });

  it("CC02-MIG-011: a migration that FAILS (not a crash) leaves nothing applied, and a later retry succeeds", () => {
    killDuring("before-statement", "0011_local_performed_sets_set_type");
    raw((db) =>
      db.exec(`CREATE TRIGGER cc02_block_ledger BEFORE INSERT ON __local_migrations
               WHEN NEW.id = '0011_local_performed_sets_set_type'
               BEGIN SELECT RAISE(ABORT, 'simulated ledger write failure'); END;`),
    );

    expect(messageChain(reopen())).toContain("simulated ledger write failure");
    expect(columns("local_performed_sets")).not.toContain("set_type");
    expect(recorded()).not.toContain("0011_local_performed_sets_set_type");

    raw((db) => db.exec("DROP TRIGGER cc02_block_ledger;"));
    expect(reopen()).toBeUndefined();
    expect(recorded()).toEqual(ALL_IDS);
  });

  it("CC02-MIG-012: a recorded migration whose schema object is missing is a schema mismatch — open fails closed, never silently continues", () => {
    expect(reopen()).toBeUndefined();
    raw((db) => db.exec("ALTER TABLE local_performed_exercises DROP COLUMN exercise_ref;"));

    const error = reopen();

    expect(error?.name).toBe("LocalMigrationReconciliationError");
    expect(error?.message).toContain("0006_local_performed_exercises_exercise_ref");
  });

  it("CC02-MIG-013: every migration is exactly ONE SQL statement (the driver prepares only the first statement of a string)", () => {
    expect(LOCAL_MIGRATIONS.map((migration) => migration.id)).toEqual(ALL_IDS);
    for (const migration of LOCAL_MIGRATIONS) {
      expect(migration.statement.trim().replace(/;$/, "")).not.toContain(";");
    }
  });

  it("CC02-MIG-014: the reconciliation metadata declared for each migration matches the schema a fresh database actually gets", () => {
    expect(reopen()).toBeUndefined();
    expect(LOCAL_MIGRATIONS).toHaveLength(ALL_IDS.length);
    raw((db) => {
      for (const migration of LOCAL_MIGRATIONS) {
        const actual = db.prepare('SELECT name, type, "notnull" AS not_null, dflt_value FROM pragma_table_info(?)').all(migration.table) as {
          name: string;
          type: string;
          not_null: number;
          dflt_value: string | null;
        }[];
        if (migration.kind === "CREATE_TABLE") {
          expect(actual.map((column) => column.name).slice(0, migration.columns.length)).toEqual(migration.columns);
        } else {
          const column = actual.find((candidate) => candidate.name === migration.column.name);
          expect({ type: column?.type, notNull: column?.not_null === 1, defaultValue: column?.dflt_value ?? null }).toEqual({
            type: migration.column.type,
            notNull: migration.column.notNull,
            defaultValue: migration.column.defaultValue,
          });
        }
      }
    });
  });
});
