import { timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { appSchema, users } from "./identity.js";
import { workoutSessions } from "./workout.js";

/**
 * Planned Workout Occurrence Authority V1 (docs/architecture/
 * WORKOUT-DATA-INTEGRITY.md "Planned workout occurrence authority").
 *
 * The ONE server-authoritative answer to "which WorkoutSession represents
 * this athlete's planned workout occurrence?": the FIRST valid
 * server-accepted START of that planned workout claims it. Later, distinct
 * valid STARTs of the same occurrence (another device offline) are still
 * accepted as their own sessions — SECONDARY by derivation (their id is not
 * `canonical_workout_session_id`), never by a stored role that could drift.
 *
 * - UNIQUE (user_id, planned_workout_id): exactly one claim per occurrence.
 *   Claim creation is `INSERT ... ON CONFLICT DO NOTHING` inside the START
 *   transaction, so concurrent STARTs serialize on this index: exactly one
 *   wins, the other observes the winner and continues as SECONDARY.
 * - UNIQUE canonical_workout_session_id + FK: a claim always points at one
 *   real session, and a session is canonical for at most one occurrence.
 * - Stable in V1: never updated (no promotion, no re-election, no merge).
 *
 * `user_id` is the same server-derived ownership identity `workout_sessions`
 * uses. `planned_workout_id` is a plain historical reference, not an FK —
 * same rule as `workout_sessions.prescription_snapshot`: workout history
 * must survive any later Plan edit/wipe. Ownership of the planned workout is
 * verified by the START handler before a claim can ever be created.
 */
export const plannedWorkoutOccurrenceClaims = appSchema.table(
  "planned_workout_occurrence_claims",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    plannedWorkoutId: uuid("planned_workout_id").notNull(),
    canonicalWorkoutSessionId: uuid("canonical_workout_session_id")
      .notNull()
      .references(() => workoutSessions.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("planned_workout_occurrence_claims_user_planned_workout_unique").on(table.userId, table.plannedWorkoutId),
    uniqueIndex("planned_workout_occurrence_claims_canonical_session_unique").on(table.canonicalWorkoutSessionId),
  ],
);
