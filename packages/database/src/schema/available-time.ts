import { check, integer, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { appSchema, users } from "./identity.js";
import { workoutSessions } from "./workout.js";

/**
 * Available-Time Adaptation V1 — Slice C (docs/domain/
 * AVAILABLE-TIME-ADAPTATION-V1.md §18). The durable, auditable server record
 * of ONE athlete-chosen TODAY_ONLY application: "this session was started
 * as the `available-time/v1` adjustment of planned workout X". Written
 * exactly once, in the same transaction as the session's own
 * `START_WORKOUT_SESSION_V1`, and never updated — at most one row per
 * WorkoutSession (unique `workout_session_id`).
 *
 * Deliberately NOT `progression_applications` (a different concept) and
 * NOT a generic adaptation framework.
 *
 * `planned_workout_id`/`source_program_version_id` are plain historical
 * references, not FKs — same rule as `workout_sessions.prescription_snapshot`:
 * historical workout truth must survive any later Plan edit/wipe. Ownership
 * is enforced when the row is written (the START handler verifies the
 * source belongs to `user_id`), never inferred later.
 *
 * `verification_status` is the server's classification at sync time; it
 * never changes the session's immutable prescription snapshot.
 */
export const AVAILABLE_TIME_APPLICATION_SCOPE_VALUES = ["TODAY_ONLY"] as const;
export const availableTimeApplicationScopeEnum = appSchema.enum("available_time_application_scope", AVAILABLE_TIME_APPLICATION_SCOPE_VALUES);

export const AVAILABLE_TIME_VERIFICATION_STATUS_VALUES = ["VERIFIED", "STALE", "UNVERIFIED"] as const;
export const availableTimeVerificationStatusEnum = appSchema.enum("available_time_verification_status", AVAILABLE_TIME_VERIFICATION_STATUS_VALUES);

export const availableTimeApplications = appSchema.table(
  "available_time_applications",
  {
    id: uuid("id").primaryKey(),
    workoutSessionId: uuid("workout_session_id")
      .notNull()
      .references(() => workoutSessions.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    plannedWorkoutId: uuid("planned_workout_id").notNull(),
    sourceProgramVersionId: uuid("source_program_version_id").notNull(),
    scope: availableTimeApplicationScopeEnum("scope").notNull(),
    policyVersion: text("policy_version").notNull(),
    availableMinutes: integer("available_minutes").notNull(),
    previewFingerprint: text("preview_fingerprint").notNull(),
    originalEstimatedSeconds: integer("original_estimated_seconds").notNull(),
    adjustedEstimatedSeconds: integer("adjusted_estimated_seconds").notNull(),
    // The exact applied diff, as the athlete applied it: per exercise,
    // retained + removed planned set ids (AvailableTimeApplicationV1
    // `exercises`). An immutable document, never queried by field — same
    // reasoning as `workout_sessions.prescription_snapshot`.
    structuralDiff: jsonb("structural_diff").notNull(),
    verificationStatus: availableTimeVerificationStatusEnum("verification_status").notNull(),
    // Why the status is not VERIFIED (e.g. SOURCE_VERSION_NOT_CURRENT,
    // FINGERPRINT_MISMATCH); null when VERIFIED.
    verificationReason: text("verification_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("available_time_applications_workout_session_id_unique").on(table.workoutSessionId),
    check("available_time_applications_policy_version_v1", sql`${table.policyVersion} = 'available-time/v1'`),
    check("available_time_applications_available_minutes_range", sql`${table.availableMinutes} BETWEEN 1 AND 240`),
    check(
      "available_time_applications_estimates_non_negative",
      sql`${table.originalEstimatedSeconds} >= 0 AND ${table.adjustedEstimatedSeconds} >= 0`,
    ),
  ],
);
