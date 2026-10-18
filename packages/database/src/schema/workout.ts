import { bigserial, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { appSchema, users } from "./identity.js";

export const WORKOUT_SESSION_STATUS_VALUES = ["ACTIVE", "COMPLETED"] as const;
export const workoutSessionStatusEnum = appSchema.enum(
  "workout_session_status",
  WORKOUT_SESSION_STATUS_VALUES,
);

/**
 * `prescription_snapshot` is deliberately `jsonb`, not columns per field —
 * it is an immutable, versioned (`schemaVersion`), opaque historical
 * snapshot the API never queries by field, only stores/returns whole
 * (spec section 6). This does NOT conflict with the Load Model's "no JSON
 * load blob" rule (docs/domain/load-model-v1.md section 76) — that rule
 * is specifically about load *data*, which lives in structured columns on
 * `performed_sets` below; the prescription snapshot is a frozen document,
 * not queryable relational load data.
 *
 * `user_id` is server-derived ownership (spec section 21/24) — never
 * trusted from a sync payload. No `ON DELETE CASCADE` on historical
 * workout truth (spec section 22).
 */
export const workoutSessions = appSchema.table(
  "workout_sessions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    prescriptionSnapshot: jsonb("prescription_snapshot").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    status: workoutSessionStatusEnum("status").notNull().default("ACTIVE"),
    // Set exactly once, by FINISH_WORKOUT_SESSION_V1 (Active Workout Core
    // Logger V1, section 25/26) — null while status = 'ACTIVE'.
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // The Finish causal boundary (Active Workout Finish Causal Boundary
    // Fix) — the highest `sessionSeq` validly issued before this session's
    // local Finish transition. Set exactly once, by the first
    // FINISH_WORKOUT_SESSION_V1 applied for this session; a later, distinct
    // FINISH command must never move it (see workout-command-processing.ts).
    // Null while status = 'ACTIVE'.
    finishSeq: integer("finish_seq"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Progression Prerequisites V1 (docs/domain/PROGRESSION-ENGINE-V1.md
    // §29) — proven necessary, not speculative: a representative-volume
    // EXPLAIN ANALYZE (300 sessions/one athlete, rolled back, never
    // persisted) showed `WorkoutHistoryService.getRecentWorkingExposures`
    // planning a full Seq Scan on this table to find one user's sessions
    // without this index (cost 310.94 -> 196.60, Seq Scan -> Index Scan,
    // with it) — see the task's final report for the full before/after
    // plan. No other existing query filters `workout_sessions` by
    // `user_id` in SQL (every other WDI handler looks it up by `id`), so
    // this index exists specifically for the new history read, not added
    // reflexively.
    index("workout_sessions_user_id_idx").on(table.userId),
  ],
);

/**
 * Represents reality. `prescription_exercise_id` is nullable text (an
 * opaque id from a prescription snapshot, spec section 10) — not a FK,
 * since the prescription's exercises are not a queryable relational
 * table in this slice.
 */
export const performedExercises = appSchema.table(
  "performed_exercises",
  {
    id: uuid("id").primaryKey(),
    workoutSessionId: uuid("workout_session_id")
      .notNull()
      .references(() => workoutSessions.id),
    prescriptionExerciseId: text("prescription_exercise_id"),
    /**
     * Progression Prerequisites V1 (docs/domain/PROGRESSION-ENGINE-V1.md
     * §25/OD-1) — the stable `ExerciseIdentityV1` catalog pointer, now
     * synchronized canonical server workout reality. Supersedes the prior
     * Active Workout Core Logger V1 decision that kept this mobile-local
     * only (`apps/mobile/src/local-database/schema.ts`'s
     * `local_performed_exercises.exercise_ref`, which this mirrors).
     *
     * `NOT NULL` (Exercise Ref Legacy Reconciliation) — never derived from
     * `display_name`, never backfilled from a guess. The one pre-existing
     * row that could not be deterministically recovered from its own
     * immutable `prescription_snapshot` was conclusively synthetic
     * native-verification fixture data and was removed as an explicit
     * dev-data cleanup (see migration 0008 and the reconciliation report),
     * not backfilled with a fabricated value.
     */
    exerciseRef: text("exercise_ref").notNull(),
    displayName: text("display_name").notNull(),
    orderIndex: integer("order_index").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Proven necessary by the same EXPLAIN ANALYZE evidence as
    // workout_sessions_user_id_idx above — the primary filter
    // `WorkoutHistoryService` applies.
    index("performed_exercises_exercise_ref_idx").on(table.exerciseRef),
  ],
);

export const LOAD_KIND_V1_VALUES = ["EXTERNAL_WEIGHT"] as const;
export const loadKindV1Enum = appSchema.enum("load_kind_v1", LOAD_KIND_V1_VALUES);

export const LOAD_UNIT_VALUES = ["KG", "LB"] as const;
export const loadUnitEnum = appSchema.enum("load_unit", LOAD_UNIT_VALUES);

export const LOAD_BASIS_V1_VALUES = ["TOTAL", "PER_IMPLEMENT"] as const;
export const loadBasisV1Enum = appSchema.enum("load_basis_v1", LOAD_BASIS_V1_VALUES);

export const PERFORMED_SET_COMPLETION_STATE_VALUES = ["COMPLETED", "REOPENED"] as const;
export const performedSetCompletionStateEnum = appSchema.enum(
  "performed_set_completion_state",
  PERFORMED_SET_COMPLETION_STATE_VALUES,
);

/**
 * Progression Prerequisites V1 (docs/domain/PROGRESSION-ENGINE-V1.md §5,
 * tech-lead-resolved OD-3) — `NOT NULL`, no nullable "null means WORKING"
 * steady state. A separate Postgres enum type from
 * `plan.ts`'s `plannedSetTypeEnum`, matching this schema's existing
 * convention of per-table load enums (e.g. `loadKindV1Enum` vs.
 * `plannedSetLoadKindEnum`) rather than one shared cross-table type.
 */
export const PERFORMED_SET_TYPE_VALUES = ["WORKING", "WARM_UP"] as const;
export const performedSetTypeEnum = appSchema.enum("performed_set_type", PERFORMED_SET_TYPE_VALUES);

/**
 * `revision` is the field the revision-gated upsert (see
 * apps/api/src/workout/) compares against — it is what makes
 * out-of-order command delivery converge correctly (spec section 17),
 * never a timestamp-based last-write-wins. Load columns are structured,
 * matching Load Model V1's "no JSON load blob" rule (section 76) — Stage
 * 1 subset only (EXTERNAL_WEIGHT / KG|LB / TOTAL|PER_IMPLEMENT).
 */
export const performedSets = appSchema.table(
  "performed_sets",
  {
    id: uuid("id").primaryKey(),
    performedExerciseId: uuid("performed_exercise_id")
      .notNull()
      .references(() => performedExercises.id),
    prescriptionSetId: text("prescription_set_id"),
    orderIndex: integer("order_index").notNull(),
    actualReps: integer("actual_reps").notNull(),
    loadKind: loadKindV1Enum("load_kind").notNull(),
    loadAmountMilli: integer("load_amount_milli").notNull(),
    loadUnit: loadUnitEnum("load_unit").notNull(),
    loadBasis: loadBasisV1Enum("load_basis").notNull(),
    setType: performedSetTypeEnum("set_type").notNull(),
    completionState: performedSetCompletionStateEnum("completion_state").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    revision: integer("revision").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Proven necessary by the same EXPLAIN ANALYZE evidence — the final
    // join step from a matched `performed_exercises` row down to its
    // sets (this FK had no index at all, same as the two above).
    index("performed_sets_performed_exercise_id_idx").on(table.performedExerciseId),
  ],
);

export const WORKOUT_COMMAND_TYPE_VALUES = [
  "START_WORKOUT_SESSION_V1",
  "COMPLETE_SET_V1",
  "REOPEN_SET_V1",
  "FINISH_WORKOUT_SESSION_V1",
] as const;
export const workoutCommandTypeEnum = appSchema.enum(
  "workout_command_type",
  WORKOUT_COMMAND_TYPE_VALUES,
);

export const WORKOUT_COMMAND_OUTCOME_VALUES = ["APPLIED", "STALE", "REJECTED"] as const;
export const workoutCommandOutcomeEnum = appSchema.enum(
  "workout_command_outcome",
  WORKOUT_COMMAND_OUTCOME_VALUES,
);

/**
 * Durable, DB-enforced idempotency (spec section 20) — `command_id` is the
 * primary key, so a retried command can never be processed twice
 * regardless of application-layer bugs or concurrent requests. `user_id`
 * is recorded so a receipt itself can never be read/replayed across
 * athletes.
 *
 * `workout_session_id`/`session_seq` (Active Workout Finish Causal
 * Boundary Fix) are populated only for `COMPLETE_SET_V1`/`REOPEN_SET_V1`
 * commands whose ownership check has already passed — never for
 * `START`/`FINISH` (no strong reason to consume a set-mutation sequence
 * slot), and never for a BOLA-rejected attempt on someone else's session
 * (recording a foreign claim there would let an attacker pre-occupy a
 * legitimate owner's future sequence slot). The partial unique index
 * below is a real DB-enforced guarantee — not just application
 * discipline — that one (session, seq) pair can never be claimed by two
 * different commands, catching a buggy or malicious client that reuses a
 * sequence number.
 */
export const workoutCommandReceipts = appSchema.table(
  "workout_command_receipts",
  {
    commandId: uuid("command_id").primaryKey(),
    commandType: workoutCommandTypeEnum("command_type").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    outcome: workoutCommandOutcomeEnum("outcome").notNull(),
    workoutSessionId: uuid("workout_session_id"),
    sessionSeq: integer("session_seq"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("workout_command_receipts_session_seq_unique")
      .on(table.workoutSessionId, table.sessionSeq)
      .where(sql`${table.sessionSeq} IS NOT NULL`),
  ],
);

/**
 * Minimum durable cursor/change-feed primitive (spec section 28) — one
 * row per successfully APPLIED command, monotonically ordered by
 * `cursor_seq`. A future pull-sync endpoint would read
 * `WHERE user_id = ? AND cursor_seq > ?`; that read endpoint is
 * deliberately NOT implemented by this slice — see
 * docs/architecture/WORKOUT-DATA-INTEGRITY.md.
 */
export const workoutChangeCursor = appSchema.table("workout_change_cursor", {
  cursorSeq: bigserial("cursor_seq", { mode: "number" }).primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  resourceType: text("resource_type").notNull(),
  resourceId: uuid("resource_id").notNull(),
  commandType: workoutCommandTypeEnum("command_type").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
});
