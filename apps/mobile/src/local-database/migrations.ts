/**
 * The exact column definition an `ADD COLUMN` migration creates, as SQLite
 * reports it in `pragma_table_info` (`type`, `notnull`, `dflt_value` — the
 * default is the SQL literal text, e.g. `'WORKING'` with its quotes).
 */
export interface LocalColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly defaultValue: string | null;
}

interface LocalMigrationBase {
  readonly id: string;
  /** Exactly ONE SQL statement: the driver prepares only the first statement of a string. */
  readonly statement: string;
}

/**
 * Every migration declares WHAT it creates. The declarations drive the
 * post-run presence check; reconciling an unrecorded object additionally
 * requires textual proof against the historical statement (see
 * `isAlreadyPresent`). Both are guarded against the real schema by
 * `migrations.crash-recovery.test.ts`.
 */
export type LocalMigration =
  | (LocalMigrationBase & { readonly kind: "CREATE_TABLE"; readonly table: string; readonly columns: readonly string[] })
  | (LocalMigrationBase & { readonly kind: "ADD_COLUMN"; readonly table: string; readonly column: LocalColumnInfo });

/**
 * Storage boundary the migration runner needs. Kept tiny and
 * driver-agnostic on purpose so the ordering/idempotency logic below is
 * unit-testable without a real SQLite/Expo native module (spec section 37 —
 * only claim what was actually verified). The production implementation is
 * `migration-store.ts`.
 */
export interface LocalMigrationStore {
  ensureMigrationsTable(): void;
  isApplied(id: string): boolean;
  execute(statement: string): void;
  markApplied(id: string): void;
  /**
   * Runs `work` in ONE SQLite write transaction on the same connection:
   * either everything `work` wrote commits, or none of it does (rollback on
   * a thrown error; a killed process never commits). SQLite DDL is
   * transactional, so a migration's schema change and its ledger row
   * commit atomically. Never called re-entrantly.
   */
  runInTransaction<T>(work: () => T): T;
  /** The table's columns in declaration order, or `null` when the table does not exist. */
  tableColumns(table: string): readonly LocalColumnInfo[] | null;
  /** The table's definition exactly as SQLite stores it (`sqlite_master.sql`), or `null` when the table does not exist. */
  tableSql(table: string): string | null;
}

/**
 * The database's actual schema contradicts what a migration declares, so
 * the runner cannot prove whether that migration completed. Nothing was
 * written by the failing step (its transaction rolled back); the file and
 * every workout row stay exactly as they were. The app surfaces this as
 * LOCAL_DATA_UNAVAILABLE — see docs/architecture/WORKOUT-DATA-INTEGRITY.md
 * ("Local migration integrity") for the recovery path.
 */
export class LocalMigrationReconciliationError extends Error {
  override readonly name = "LocalMigrationReconciliationError";
  readonly migrationId: string;

  constructor(migrationId: string, detail: string) {
    super(`Local migration ${migrationId} cannot be reconciled: ${detail}`);
    this.migrationId = migrationId;
  }
}

export interface LocalMigrationRunResult {
  /** Migrations whose statement ran and was recorded during this run. */
  readonly applied: readonly string[];
  /** Migrations whose schema object already existed unrecorded, textually proven identical; recorded without re-running. */
  readonly reconciled: readonly string[];
}

/**
 * Migrations are additive, in order, and NEVER edited once released (ids
 * and statements are the on-device history). Each is one hand-rolled
 * statement — `CREATE TABLE IF NOT EXISTS` or a non-idempotent
 * `ALTER TABLE ... ADD COLUMN`, which is why the runner applies each one
 * atomically with its ledger row — see docs/architecture/FOUNDATION.md for
 * why this repo doesn't use drizzle-kit's generated Expo migration bundle
 * (unverified Metro/babel step), and
 * docs/architecture/WORKOUT-DATA-INTEGRITY.md for the local schema this
 * migration establishes.
 */
export const LOCAL_MIGRATIONS: readonly LocalMigration[] = Object.freeze([
  {
    id: "0000_bootstrap_health_check",
    kind: "CREATE_TABLE",
    table: "bootstrap_health_check",
    columns: ["id", "checked_at"],
    statement: `CREATE TABLE IF NOT EXISTS bootstrap_health_check (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      checked_at TEXT NOT NULL
    );`,
  },
  {
    id: "0001_local_workout_sessions",
    kind: "CREATE_TABLE",
    table: "local_workout_sessions",
    columns: ["id", "prescription_json", "started_at", "status", "created_at", "updated_at"],
    statement: `CREATE TABLE IF NOT EXISTS local_workout_sessions (
      id TEXT PRIMARY KEY,
      prescription_json TEXT NOT NULL,
      started_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`,
  },
  {
    id: "0002_local_performed_exercises",
    kind: "CREATE_TABLE",
    table: "local_performed_exercises",
    columns: ["id", "workout_session_id", "prescription_exercise_id", "display_name", "order_index", "created_at", "updated_at"],
    statement: `CREATE TABLE IF NOT EXISTS local_performed_exercises (
      id TEXT PRIMARY KEY,
      workout_session_id TEXT NOT NULL REFERENCES local_workout_sessions(id),
      prescription_exercise_id TEXT,
      display_name TEXT NOT NULL,
      order_index INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`,
  },
  {
    id: "0003_local_performed_sets",
    kind: "CREATE_TABLE",
    table: "local_performed_sets",
    columns: ["id", "performed_exercise_id", "prescription_set_id", "order_index", "actual_reps", "load_kind", "load_amount_milli", "load_unit", "load_basis", "completion_state", "completed_at", "revision", "created_at", "updated_at"],
    statement: `CREATE TABLE IF NOT EXISTS local_performed_sets (
      id TEXT PRIMARY KEY,
      performed_exercise_id TEXT NOT NULL REFERENCES local_performed_exercises(id),
      prescription_set_id TEXT,
      order_index INTEGER NOT NULL,
      actual_reps INTEGER NOT NULL,
      load_kind TEXT NOT NULL,
      load_amount_milli INTEGER NOT NULL,
      load_unit TEXT NOT NULL,
      load_basis TEXT NOT NULL,
      completion_state TEXT NOT NULL,
      completed_at TEXT,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`,
  },
  {
    id: "0004_sync_outbox",
    kind: "CREATE_TABLE",
    table: "sync_outbox",
    columns: ["command_id", "command_type", "schema_version", "payload_json", "status", "attempt_count", "last_attempt_at", "created_at", "updated_at"],
    statement: `CREATE TABLE IF NOT EXISTS sync_outbox (
      command_id TEXT PRIMARY KEY,
      command_type TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`,
  },
  {
    // Active Workout Core Logger V1 (section 25/26): workout completion.
    id: "0005_local_workout_sessions_completed_at",
    kind: "ADD_COLUMN",
    table: "local_workout_sessions",
    column: { name: "completed_at", type: "TEXT", notNull: false, defaultValue: null },
    statement: `ALTER TABLE local_workout_sessions ADD COLUMN completed_at TEXT;`,
  },
  {
    // Active Workout Core Logger V1 (section 8/9): the ExerciseIdentityV1
    // snapshot "Previous performance" queries against.
    id: "0006_local_performed_exercises_exercise_ref",
    kind: "ADD_COLUMN",
    table: "local_performed_exercises",
    column: { name: "exercise_ref", type: "TEXT", notNull: false, defaultValue: null },
    statement: `ALTER TABLE local_performed_exercises ADD COLUMN exercise_ref TEXT;`,
  },
  {
    // Active Workout Core Logger V1 (section 33/34): input durability.
    id: "0007_local_set_drafts",
    kind: "CREATE_TABLE",
    table: "local_set_drafts",
    columns: ["workout_session_id", "prescription_exercise_id", "prescription_set_id", "draft_reps", "draft_load_amount_milli", "draft_load_unit", "draft_load_basis", "updated_at"],
    statement: `CREATE TABLE IF NOT EXISTS local_set_drafts (
      workout_session_id TEXT NOT NULL REFERENCES local_workout_sessions(id),
      prescription_exercise_id TEXT NOT NULL,
      prescription_set_id TEXT NOT NULL,
      draft_reps INTEGER,
      draft_load_amount_milli INTEGER,
      draft_load_unit TEXT,
      draft_load_basis TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workout_session_id, prescription_exercise_id, prescription_set_id)
    );`,
  },
  {
    // Active Workout Core Logger V1 (section 19/21): rest timer persistence.
    id: "0008_local_rest_timer_state",
    kind: "CREATE_TABLE",
    table: "local_rest_timer_state",
    columns: ["workout_session_id", "started_at", "duration_seconds", "updated_at"],
    statement: `CREATE TABLE IF NOT EXISTS local_rest_timer_state (
      workout_session_id TEXT PRIMARY KEY REFERENCES local_workout_sessions(id),
      started_at TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );`,
  },
  {
    // Active Workout Finish Causal Boundary Fix: the per-session
    // monotonic set-mutation sequence.
    id: "0009_local_workout_sessions_last_issued_session_seq",
    kind: "ADD_COLUMN",
    table: "local_workout_sessions",
    column: { name: "last_issued_session_seq", type: "INTEGER", notNull: true, defaultValue: "0" },
    statement: `ALTER TABLE local_workout_sessions ADD COLUMN last_issued_session_seq INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    // Active Workout Finish Causal Boundary Fix: the Finish watermark.
    id: "0010_local_workout_sessions_finish_seq",
    kind: "ADD_COLUMN",
    table: "local_workout_sessions",
    column: { name: "finish_seq", type: "INTEGER", notNull: false, defaultValue: null },
    statement: `ALTER TABLE local_workout_sessions ADD COLUMN finish_seq INTEGER;`,
  },
  {
    // Progression Prerequisites V1 (docs/domain/PROGRESSION-ENGINE-V1.md
    // §5, tech-lead-resolved OD-3): explicit WORKING/WARM_UP set type.
    // SQLite backfills every existing row with the DEFAULT value as part
    // of this single ADD COLUMN statement (existing rows were all logged
    // before warm-up logging existed, so WORKING is the only value
    // defensible from actual historical behavior — same backfill
    // reasoning as the server-side Postgres migration) and enforces
    // NOT NULL from then on — add, backfill, and constrain in one atomic
    // step. The application always writes this column explicitly on
    // every new/updated row regardless (workout-repository.ts); the
    // DEFAULT is migration-safety, not the primary mechanism.
    id: "0011_local_performed_sets_set_type",
    kind: "ADD_COLUMN",
    table: "local_performed_sets",
    column: { name: "set_type", type: "TEXT", notNull: true, defaultValue: "'WORKING'" },
    statement: `ALTER TABLE local_performed_sets ADD COLUMN set_type TEXT NOT NULL DEFAULT 'WORKING';`,
  },
  {
    // Available-Time Adaptation V1 Slice C: the immutable
    // AvailableTimeApplicationV1 of an adjusted session, written once in the
    // same transaction as the session row + START outbox command. NULL for
    // every ordinary session — including every session created before this
    // migration, which therefore stays readable unchanged.
    id: "0012_local_workout_sessions_available_time_application",
    kind: "ADD_COLUMN",
    table: "local_workout_sessions",
    column: { name: "available_time_application_json", type: "TEXT", notNull: false, defaultValue: null },
    statement: `ALTER TABLE local_workout_sessions ADD COLUMN available_time_application_json TEXT;`,
  },
] satisfies LocalMigration[]);

/**
 * Applies every unrecorded migration, in order, exactly once. Each
 * migration's schema check, statement and ledger row run in ONE transaction
 * (CC-02, D-MIG-1): a crash or error at any point leaves the migration
 * either fully applied and recorded, or not applied at all.
 *
 * Databases written by the earlier non-atomic runner can hold a schema
 * object with no ledger row. Such a migration is recorded WITHOUT re-running
 * on textual proof that the stored definition is exactly what this
 * migration's frozen statement creates (`isAlreadyPresent`); any other shape
 * throws `LocalMigrationReconciliationError` (fail closed — nothing is
 * dropped, rewritten or guessed). Afterwards every migration's schema object
 * is checked to be PRESENT as declared (`verifyAppliedSchema` — a presence
 * guard, not an equivalence proof), so a recorded-but-missing object never
 * passes silently.
 */
export function runLocalMigrations(store: LocalMigrationStore): LocalMigrationRunResult {
  store.ensureMigrationsTable();
  const applied: string[] = [];
  const reconciled: string[] = [];

  for (const migration of LOCAL_MIGRATIONS) {
    if (store.isApplied(migration.id)) continue;
    store.runInTransaction(() => {
      // Re-checked inside the transaction: exactly-once even if another writer raced the first check.
      if (store.isApplied(migration.id)) return;
      if (isAlreadyPresent(store, migration)) {
        reconciled.push(migration.id);
      } else {
        store.execute(migration.statement);
        applied.push(migration.id);
      }
      store.markApplied(migration.id);
    });
  }

  verifyAppliedSchema(store);
  return { applied, reconciled };
}

/**
 * `false` — the object is absent, so the statement must run.
 * `true` — it exists and is PROVABLY what this exact historical statement
 * creates. SQLite stores a table's definition verbatim (`sqlite_master.sql`):
 * the CREATE statement minus `IF NOT EXISTS` and the trailing `;`, and each
 * `ADD COLUMN` appends `, <column definition>` to it. The old runner executed
 * these same frozen strings, so a legitimately half-migrated database matches
 * them character for character — and that text carries every column type,
 * PRIMARY KEY, NOT NULL, DEFAULT, REFERENCES, UNIQUE, CHECK and COLLATE.
 * Matching column names alone would prove none of that.
 * Throws — anything else (including a missing table for ADD COLUMN).
 */
function isAlreadyPresent(store: LocalMigrationStore, migration: LocalMigration): boolean {
  const stored = store.tableSql(migration.table);
  if (migration.kind === "CREATE_TABLE") {
    if (stored === null) return false;
    if (stored === storedCreateTableSql(migration)) return true;
    throw new LocalMigrationReconciliationError(
      migration.id,
      `unrecorded table ${migration.table} exists, but its stored definition is not the one this migration creates: ${stored}`,
    );
  }

  if (stored === null) throw new LocalMigrationReconciliationError(migration.id, `table ${migration.table} does not exist`);
  const existing = store.tableColumns(migration.table)?.find((column) => column.name === migration.column.name);
  if (existing === undefined) return false;
  if (sameColumn(existing, migration.column) && containsAddedColumn(stored, addedColumnDefinition(migration))) return true;
  throw new LocalMigrationReconciliationError(
    migration.id,
    `unrecorded column ${migration.table}.${migration.column.name} exists, but not as \`${addedColumnDefinition(migration)}\` (found ${describeColumn(existing)} in: ${stored})`,
  );
}

/** What SQLite stores for a `CREATE TABLE IF NOT EXISTS ...;` statement. */
function storedCreateTableSql(migration: LocalMigration): string {
  const prefix = "CREATE TABLE IF NOT EXISTS ";
  if (!migration.statement.startsWith(prefix) || !migration.statement.endsWith(";")) {
    throw new LocalMigrationReconciliationError(migration.id, "statement is not a single CREATE TABLE IF NOT EXISTS statement");
  }
  return `CREATE TABLE ${migration.statement.slice(prefix.length, -1)}`;
}

/** The `<column definition>` of an `ALTER TABLE <table> ADD COLUMN <column definition>;` statement. */
function addedColumnDefinition(migration: LocalMigration): string {
  const prefix = `ALTER TABLE ${migration.table} ADD COLUMN `;
  if (!migration.statement.startsWith(prefix) || !migration.statement.endsWith(";")) {
    throw new LocalMigrationReconciliationError(migration.id, "statement is not a single ALTER TABLE ... ADD COLUMN statement");
  }
  return migration.statement.slice(prefix.length, -1);
}

/** `, <definition>` appended by ADD COLUMN, followed by the next appended column or the closing parenthesis. */
function containsAddedColumn(stored: string, definition: string): boolean {
  const fragment = `, ${definition}`;
  for (let at = stored.indexOf(fragment); at !== -1; at = stored.indexOf(fragment, at + 1)) {
    const next = stored.charAt(at + fragment.length);
    if (next === "," || next === ")") return true;
  }
  return false;
}

function verifyAppliedSchema(store: LocalMigrationStore): void {
  for (const migration of LOCAL_MIGRATIONS) {
    const columns = store.tableColumns(migration.table);
    if (columns === null) throw new LocalMigrationReconciliationError(migration.id, `recorded, but table ${migration.table} does not exist`);
    if (migration.kind === "CREATE_TABLE") {
      const missing = migration.columns.filter((name) => !columns.some((column) => column.name === name));
      if (missing.length > 0) {
        throw new LocalMigrationReconciliationError(migration.id, `recorded, but table ${migration.table} lacks columns [${missing.join(", ")}]`);
      }
      continue;
    }
    const existing = columns.find((column) => column.name === migration.column.name);
    if (existing === undefined || !sameColumn(existing, migration.column)) {
      throw new LocalMigrationReconciliationError(
        migration.id,
        `recorded, but column ${migration.table}.${migration.column.name} is ${existing === undefined ? "missing" : describeColumn(existing)}`,
      );
    }
  }
}

function sameColumn(actual: LocalColumnInfo, expected: LocalColumnInfo): boolean {
  return actual.type === expected.type && actual.notNull === expected.notNull && actual.defaultValue === expected.defaultValue;
}

function describeColumn(column: LocalColumnInfo): string {
  return `${column.type}${column.notNull ? " NOT NULL" : ""}${column.defaultValue === null ? "" : ` DEFAULT ${column.defaultValue}`}`;
}
