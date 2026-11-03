import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createEntityId } from "@vostivo/domain";
import { runLocalMigrations, type LocalMigrationStore } from "./migrations";

/**
 * CC-01 Strength Regression Baseline — local migrations on a REAL SQLite
 * engine (node:sqlite; SQLCipher is a device concern and is not covered here).
 *
 * `CC01-KNOWN-DEFECT` tests use `it.fails`: each one asserts the DESIRED
 * behavior, so it stays green only while the defect exists and turns red the
 * moment the repair lands. The repair must then change it to a plain `it`.
 */
const EXPECTED_MIGRATION_IDS = [
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

class SimulatedCrash extends Error {}

interface StoreOptions {
  /** Process dies right before this migration's statement runs. */
  readonly crashBefore?: string;
  /** Process dies after this migration's statement ran, before it was recorded. */
  readonly crashBeforeRecording?: string;
}

function sqliteStore(native: DatabaseSync, options: StoreOptions = {}): LocalMigrationStore {
  let current = 0;
  const pendingId = (): string => {
    while (isRecorded(native, EXPECTED_MIGRATION_IDS[current]!)) current += 1;
    return EXPECTED_MIGRATION_IDS[current]!;
  };
  return {
    ensureMigrationsTable: () =>
      native.exec("CREATE TABLE IF NOT EXISTS __local_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));"),
    isApplied: (id) => isRecorded(native, id),
    execute: (statement) => {
      if (pendingId() === options.crashBefore) throw new SimulatedCrash();
      native.exec(statement);
    },
    markApplied: (id) => {
      if (id === options.crashBeforeRecording) throw new SimulatedCrash();
      native.prepare("INSERT INTO __local_migrations (id) VALUES (?)").run(id);
    },
    // Real SQLite transaction semantics: a SimulatedCrash thrown inside rolls
    // back the statement together with the (not yet written) ledger row.
    runInTransaction: (work) => {
      native.exec("BEGIN;");
      try {
        const result = work();
        native.exec("COMMIT;");
        return result;
      } catch (error) {
        native.exec("ROLLBACK;");
        throw error;
      }
    },
    tableSql: (table) =>
      (native.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").all(table)[0] as { sql: string } | undefined)?.sql ?? null,
    tableColumns: (table) => {
      const rows = native.prepare('SELECT name, type, "notnull" AS not_null, dflt_value FROM pragma_table_info(?)').all(table) as {
        name: string;
        type: string;
        not_null: number;
        dflt_value: string | null;
      }[];
      return rows.length === 0 ? null : rows.map((row) => ({ name: row.name, type: row.type, notNull: row.not_null === 1, defaultValue: row.dflt_value }));
    },
  };
}

function isRecorded(native: DatabaseSync, id: string): boolean {
  return native.prepare("SELECT id FROM __local_migrations WHERE id = ?").all(id).length > 0;
}

function recordedIds(native: DatabaseSync): string[] {
  return native
    .prepare("SELECT id FROM __local_migrations ORDER BY id")
    .all()
    .map((row) => (row as { id: string }).id);
}

function migrateUntilCrash(native: DatabaseSync, options: StoreOptions): void {
  expect(() => runLocalMigrations(sqliteStore(native, options))).toThrow(SimulatedCrash);
}

describe("CC-01 local migrations (real SQLite)", () => {
  let path: string;
  let native: DatabaseSync;

  beforeEach(() => {
    path = `${tmpdir()}/vostivo-cc01-migrations-${createEntityId()}.db`;
    native = new DatabaseSync(path);
    native.exec("PRAGMA foreign_keys = ON;");
  });

  afterEach(() => {
    native.close();
    rmSync(path, { force: true });
  });

  it("CC01-MIG-001: the applied migration history is exactly these ids, in this order, each recorded once", () => {
    const applied: string[] = [];
    const store = sqliteStore(native);
    runLocalMigrations({
      ...store,
      markApplied: (id) => {
        applied.push(id);
        store.markApplied(id);
      },
    });

    expect(applied).toEqual(EXPECTED_MIGRATION_IDS);
  });

  it("CC01-MIG-002: rows written before later migrations survive them, with the defined defaults", () => {
    migrateUntilCrash(native, { crashBefore: "0005_local_workout_sessions_completed_at" });
    native.exec(`
      INSERT INTO local_workout_sessions (id, prescription_json, started_at, created_at, updated_at)
        VALUES ('s1', '{"schemaVersion":1}', '2026-01-01T10:00:00.000Z', '2026-01-01T10:00:00.000Z', '2026-01-01T10:00:00.000Z');
      INSERT INTO local_performed_exercises (id, workout_session_id, display_name, order_index, created_at, updated_at)
        VALUES ('e1', 's1', 'Bench Press', 0, '2026-01-01T10:00:00.000Z', '2026-01-01T10:00:00.000Z');
      INSERT INTO local_performed_sets (id, performed_exercise_id, order_index, actual_reps, load_kind, load_amount_milli, load_unit, load_basis, completion_state, revision, created_at, updated_at)
        VALUES ('p1', 'e1', 0, 10, 'EXTERNAL_WEIGHT', 60000, 'KG', 'TOTAL', 'COMPLETED', 1, '2026-01-01T10:00:00.000Z', '2026-01-01T10:00:00.000Z');
      INSERT INTO sync_outbox (command_id, command_type, schema_version, payload_json, created_at, updated_at)
        VALUES ('c1', 'START_WORKOUT_SESSION_V1', 1, '{"keep":"verbatim"}', '2026-01-01T10:00:00.000Z', '2026-01-01T10:00:00.000Z');
    `);

    runLocalMigrations(sqliteStore(native));

    expect(recordedIds(native)).toEqual(EXPECTED_MIGRATION_IDS);
    expect(native.prepare("SELECT * FROM local_workout_sessions").all()[0]).toMatchObject({
      prescription_json: '{"schemaVersion":1}',
      status: "ACTIVE",
      completed_at: null,
      last_issued_session_seq: 0,
      finish_seq: null,
      available_time_application_json: null,
    });
    expect(native.prepare("SELECT * FROM local_performed_sets").all()[0]).toMatchObject({
      actual_reps: 10,
      load_amount_milli: 60000,
      set_type: "WORKING",
      revision: 1,
    });
    expect(native.prepare("SELECT * FROM sync_outbox").all()[0]).toMatchObject({
      payload_json: '{"keep":"verbatim"}',
      status: "PENDING",
    });
  });

  it("CC01-MIG-003: re-running on a fully migrated database changes neither schema nor history", () => {
    runLocalMigrations(sqliteStore(native));
    const schemaBefore = native.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();
    const historyBefore = native.prepare("SELECT id, applied_at FROM __local_migrations ORDER BY id").all();

    runLocalMigrations(sqliteStore(native));

    expect(native.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all()).toEqual(schemaBefore);
    expect(native.prepare("SELECT id, applied_at FROM __local_migrations ORDER BY id").all()).toEqual(historyBefore);
  });

  it("CC01-MIG-004: a crash BEFORE a statement ran is recoverable on the next open", () => {
    migrateUntilCrash(native, { crashBefore: "0011_local_performed_sets_set_type" });

    runLocalMigrations(sqliteStore(native));

    expect(recordedIds(native)).toEqual(EXPECTED_MIGRATION_IDS);
  });

  it("CC01-MIG-005: a crash after a CREATE TABLE IF NOT EXISTS, before recording, is recoverable", () => {
    migrateUntilCrash(native, { crashBeforeRecording: "0007_local_set_drafts" });

    runLocalMigrations(sqliteStore(native));

    expect(recordedIds(native)).toEqual(EXPECTED_MIGRATION_IDS);
  });

  // D-MIG-1 (repaired in CC-02): the statement and `markApplied` now commit
  // in one transaction, so a crash between them rolls both back. These were
  // `it.fails` (CC01-KNOWN-DEFECT) until the repair; real-SIGKILL coverage is
  // in migrations.crash-recovery.test.ts.
  it.each([
    "0005_local_workout_sessions_completed_at",
    "0006_local_performed_exercises_exercise_ref",
    "0009_local_workout_sessions_last_issued_session_seq",
    "0010_local_workout_sessions_finish_seq",
    "0011_local_performed_sets_set_type",
    "0012_local_workout_sessions_available_time_application",
  ])("CC01-MIG-006 (D-MIG-1 repaired): a crash between ALTER TABLE and recording is recoverable — %s", (id) => {
    migrateUntilCrash(native, { crashBeforeRecording: id });

    runLocalMigrations(sqliteStore(native));

    expect(recordedIds(native)).toEqual(EXPECTED_MIGRATION_IDS);
  });
});
