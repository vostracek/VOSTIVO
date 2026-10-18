import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Harmless technical table proving the local migration pipeline works.
 */
export const bootstrapHealthCheck = sqliteTable("bootstrap_health_check", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  checkedAt: text("checked_at").notNull(),
});

/**
 * Local projection for the Workout Data Integrity vertical slice
 * (spec section 13). Does NOT need to be structurally identical to the
 * PostgreSQL schema — dates/JSON are stored as TEXT (SQLite has no native
 * types for either), matching this file's existing convention.
 *
 * `prescription_json` is the immutable snapshot (spec section 6) —
 * serialized once at session start, never rewritten afterward.
 */
export const localWorkoutSessions = sqliteTable("local_workout_sessions", {
  id: text("id").primaryKey(),
  prescriptionJson: text("prescription_json").notNull(),
  // Available-Time Adaptation V1 Slice C — immutable, written once at start;
  // null for an ordinary (unadjusted) session.
  availableTimeApplicationJson: text("available_time_application_json"),
  startedAt: text("started_at").notNull(),
  status: text("status").notNull().default("ACTIVE"),
  // Set exactly once, by finishWorkoutSession() (Active Workout Core
  // Logger V1, section 25/26) — null while status = 'ACTIVE'.
  completedAt: text("completed_at"),
  // Per-session monotonic sequence for set mutations (Active Workout
  // Finish Causal Boundary Fix) — the last value handed out by
  // completeSet()/reopenSet(), allocated atomically in the same
  // transaction as the mutation itself. Never derived from wall-clock
  // time. 0 means no set mutation has ever been issued for this session.
  lastIssuedSessionSeq: integer("last_issued_session_seq").notNull().default(0),
  // The Finish causal boundary/watermark — set exactly once, in the same
  // local transaction as the ACTIVE->COMPLETED transition, to whatever
  // `lastIssuedSessionSeq` was at that moment. Null while status =
  // 'ACTIVE'. See `finishWorkoutSession()` and
  // docs/architecture/ACTIVE-WORKOUT.md.
  finishSeq: integer("finish_seq"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const localPerformedExercises = sqliteTable("local_performed_exercises", {
  id: text("id").primaryKey(),
  workoutSessionId: text("workout_session_id")
    .notNull()
    .references(() => localWorkoutSessions.id),
  prescriptionExerciseId: text("prescription_exercise_id"),
  // Snapshot of PrescribedExerciseV1.exerciseRef at completion time — the
  // ExerciseIdentityV1 boundary "Previous performance" queries against
  // (Active Workout Core Logger V1, section 8/9). Never synced to the
  // server: purely a local read-model convenience, not part of the WDI
  // wire contract.
  exerciseRef: text("exercise_ref"),
  displayName: text("display_name").notNull(),
  orderIndex: integer("order_index").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Load columns mirror the Stage 1 subset exactly (EXTERNAL_WEIGHT /
 * KG|LB / TOTAL|PER_IMPLEMENT) — see `packages/domain`'s Load Model.
 * `revision` is the monotonic per-set counter the sync protocol's
 * out-of-order convergence depends on (spec section 17) — assigned here,
 * client-side, never derived from a timestamp.
 */
export const localPerformedSets = sqliteTable("local_performed_sets", {
  id: text("id").primaryKey(),
  performedExerciseId: text("performed_exercise_id")
    .notNull()
    .references(() => localPerformedExercises.id),
  prescriptionSetId: text("prescription_set_id"),
  orderIndex: integer("order_index").notNull(),
  actualReps: integer("actual_reps").notNull(),
  loadKind: text("load_kind").notNull(),
  loadAmountMilli: integer("load_amount_milli").notNull(),
  loadUnit: text("load_unit").notNull(),
  loadBasis: text("load_basis").notNull(),
  // Progression Prerequisites V1 (docs/domain/PROGRESSION-ENGINE-V1.md
  // §5) — NOT NULL, explicit. The DEFAULT is migration-safety only (see
  // migrations.ts): the application always writes this explicitly on
  // every INSERT/UPDATE (workout-repository.ts), the same discipline as
  // every other reality column here.
  setType: text("set_type").notNull().default("WORKING"),
  completionState: text("completion_state").notNull(),
  completedAt: text("completed_at"),
  revision: integer("revision").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Domain-aware outbox (spec section 18) — `payload_json` is the full
 * wire-shaped `WorkoutCommandV1`, stored verbatim so the SyncEngine never
 * has to reconstruct a command from scattered local rows.
 */
export const syncOutbox = sqliteTable("sync_outbox", {
  commandId: text("command_id").primaryKey(),
  commandType: text("command_type").notNull(),
  schemaVersion: integer("schema_version").notNull(),
  payloadJson: text("payload_json").notNull(),
  status: text("status").notNull().default("PENDING"),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastAttemptAt: text("last_attempt_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Local-only runtime draft state (Active Workout Core Logger V1, section
 * 33/34) — an athlete's in-progress load/reps input before a set is
 * completed. Never canonical `PerformedSet` reality and never synced;
 * keyed by the prescription's own ids (stable before a `PerformedSet` row
 * exists) so a draft survives a force-stop/relaunch. Cleared once the same
 * set is actually completed.
 */
export const localSetDrafts = sqliteTable(
  "local_set_drafts",
  {
    workoutSessionId: text("workout_session_id")
      .notNull()
      .references(() => localWorkoutSessions.id),
    prescriptionExerciseId: text("prescription_exercise_id").notNull(),
    prescriptionSetId: text("prescription_set_id").notNull(),
    draftReps: integer("draft_reps"),
    draftLoadAmountMilli: integer("draft_load_amount_milli"),
    draftLoadUnit: text("draft_load_unit"),
    draftLoadBasis: text("draft_load_basis"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.workoutSessionId, table.prescriptionExerciseId, table.prescriptionSetId] })],
);

/**
 * Local-only rest-timer runtime state (spec section 19/21) — one row per
 * session, overwritten on each new rest start. Durable `startedAt` +
 * `durationSeconds` (never a decrementing counter) is what lets remaining
 * time be correctly re-derived after backgrounding or a force-stop.
 */
export const localRestTimerState = sqliteTable("local_rest_timer_state", {
  workoutSessionId: text("workout_session_id")
    .primaryKey()
    .references(() => localWorkoutSessions.id),
  startedAt: text("started_at").notNull(),
  durationSeconds: integer("duration_seconds").notNull(),
  updatedAt: text("updated_at").notNull(),
});
