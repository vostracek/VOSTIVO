interface LocalMigration {
  readonly id: string;
  readonly statement: string;
}

/**
 * Storage boundary the migration runner needs. Kept tiny and
 * driver-agnostic on purpose so the ordering/idempotency logic below is
 * unit-testable without a real SQLite/Expo native module (spec section 37 —
 * only claim what was actually verified).
 */
export interface LocalMigrationStore {
  ensureMigrationsTable(): void;
  isApplied(id: string): boolean;
  execute(statement: string): void;
  markApplied(id: string): void;
}

/**
 * Migrations are additive, in order. Each is a hand-rolled, idempotent
 * `CREATE TABLE IF NOT EXISTS` — see docs/architecture/FOUNDATION.md for
 * why this repo doesn't use drizzle-kit's generated Expo migration bundle
 * (unverified Metro/babel step), and
 * docs/architecture/WORKOUT-DATA-INTEGRITY.md for the local schema this
 * migration establishes.
 */
const MIGRATIONS: readonly LocalMigration[] = [
  {
    id: "0000_bootstrap_health_check",
    statement: `CREATE TABLE IF NOT EXISTS bootstrap_health_check (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      checked_at TEXT NOT NULL
    );`,
  },
  {
    id: "0001_local_workout_sessions",
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
    statement: `ALTER TABLE local_workout_sessions ADD COLUMN completed_at TEXT;`,
  },
  {
    // Active Workout Core Logger V1 (section 8/9): the ExerciseIdentityV1
    // snapshot "Previous performance" queries against.
    id: "0006_local_performed_exercises_exercise_ref",
    statement: `ALTER TABLE local_performed_exercises ADD COLUMN exercise_ref TEXT;`,
  },
  {
    // Active Workout Core Logger V1 (section 33/34): input durability.
    id: "0007_local_set_drafts",
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
    statement: `ALTER TABLE local_workout_sessions ADD COLUMN last_issued_session_seq INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    // Active Workout Finish Causal Boundary Fix: the Finish watermark.
    id: "0010_local_workout_sessions_finish_seq",
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
    statement: `ALTER TABLE local_performed_sets ADD COLUMN set_type TEXT NOT NULL DEFAULT 'WORKING';`,
  },
  {
    // Available-Time Adaptation V1 Slice C: the immutable
    // AvailableTimeApplicationV1 of an adjusted session, written once in the
    // same transaction as the session row + START outbox command. NULL for
    // every ordinary session — including every session created before this
    // migration, which therefore stays readable unchanged.
    id: "0012_local_workout_sessions_available_time_application",
    statement: `ALTER TABLE local_workout_sessions ADD COLUMN available_time_application_json TEXT;`,
  },
];

export function runLocalMigrations(store: LocalMigrationStore): void {
  store.ensureMigrationsTable();

  for (const migration of MIGRATIONS) {
    if (store.isApplied(migration.id)) continue;
    store.execute(migration.statement);
    store.markApplied(migration.id);
  }
}
