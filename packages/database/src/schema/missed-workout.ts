import { check, date, integer, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { appSchema, athleteProfiles, users } from "./identity.js";
import { plannedWorkouts, programVersions, trainingBlocks } from "./plan.js";

/**
 * Missed Workout / Schedule Adaptation V1 — Slice C (docs/domain/
 * MISSED-WORKOUT-ADAPTATION-V1.md §10): the EFFECTIVE SCHEDULE OVERLAY.
 *
 * AUTHORED SCHEDULE IS IMMUTABLE — a ROLL_FORWARD never edits
 * `planned_workouts.scheduled_date`, cycle/block dates or the
 * ProgramVersion. Each athlete-applied ROLL_FORWARD is one immutable
 * application row + a COMPLETE effective-date snapshot (assignments) for
 * its TrainingBlock. The effective schedule of a block = authored dates,
 * overridden by the assignments of its single ACTIVE application.
 *
 * - At most one ACTIVE application per (athlete profile, block): partial
 *   unique index — concurrency-safe at the DB layer.
 * - A later application SUPERSEDES the previous ACTIVE one in the same
 *   transaction; nothing is deleted, and the only mutation ever applied to
 *   a written row is ACTIVE -> SUPERSEDED (+ `superseded_at`).
 * - Idempotency: UNIQUE (athlete profile, block, preview fingerprint) —
 *   the exact preview the athlete approved can be applied at most once.
 *   The fingerprint is a stale/idempotency guard, NOT authorization.
 * - Not a generic adaptation framework.
 */
export const MISSED_WORKOUT_SCHEDULE_APPLICATION_STATUS_VALUES = ["ACTIVE", "SUPERSEDED"] as const;
export const missedWorkoutScheduleApplicationStatusEnum = appSchema.enum(
  "missed_workout_schedule_application_status",
  MISSED_WORKOUT_SCHEDULE_APPLICATION_STATUS_VALUES,
);

export const missedWorkoutScheduleApplications = appSchema.table(
  "missed_workout_schedule_applications",
  {
    id: uuid("id").primaryKey(),
    athleteProfileId: uuid("athlete_profile_id")
      .notNull()
      .references(() => athleteProfiles.id),
    programVersionId: uuid("program_version_id")
      .notNull()
      .references(() => programVersions.id),
    trainingBlockId: uuid("training_block_id")
      .notNull()
      .references(() => trainingBlocks.id),
    policyVersion: text("policy_version").notNull(),
    previewFingerprint: text("preview_fingerprint").notNull(),
    athleteLocalDate: date("athlete_local_date").notNull(),
    trainingTimeZone: text("training_time_zone").notNull(),
    missedPlannedWorkoutId: uuid("missed_planned_workout_id")
      .notNull()
      .references(() => plannedWorkouts.id),
    /** The (effective) date the missed workout was due on when it was missed. */
    missedScheduledLocalDate: date("missed_scheduled_local_date"),
    originalNextPlannedWorkoutId: uuid("original_next_planned_workout_id").references(() => plannedWorkouts.id),
    reasonCode: text("reason_code").notNull(),
    appliedByUserId: uuid("applied_by_user_id")
      .notNull()
      .references(() => users.id),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull(),
    status: missedWorkoutScheduleApplicationStatusEnum("status").notNull(),
    supersedesApplicationId: uuid("supersedes_application_id").references((): AnyPgColumn => missedWorkoutScheduleApplications.id),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("missed_workout_schedule_applications_one_active_per_block")
      .on(table.athleteProfileId, table.trainingBlockId)
      .where(sql`${table.status} = 'ACTIVE'`),
    uniqueIndex("missed_workout_schedule_applications_fingerprint_unique").on(
      table.athleteProfileId,
      table.trainingBlockId,
      table.previewFingerprint,
    ),
    check(
      "missed_workout_schedule_applications_superseded_at_matches_status",
      sql`(${table.status} = 'SUPERSEDED') = (${table.supersededAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * ROLL_FORWARD = this application's decision sequence consuming the known
 * training slots (a carryover has `effective_scheduled_local_date` NULL —
 * UNKNOWN AVAILABILITY REMAINS UNSCHEDULED); RETAINED = an effective date
 * carried over unchanged from the superseded application, so the ACTIVE
 * application is always a complete, self-contained snapshot (no stacking).
 */
export const MISSED_WORKOUT_SCHEDULE_ASSIGNMENT_KIND_VALUES = ["ROLL_FORWARD", "RETAINED"] as const;
export const missedWorkoutScheduleAssignmentKindEnum = appSchema.enum(
  "missed_workout_schedule_assignment_kind",
  MISSED_WORKOUT_SCHEDULE_ASSIGNMENT_KIND_VALUES,
);

export const missedWorkoutScheduleAssignments = appSchema.table(
  "missed_workout_schedule_assignments",
  {
    id: uuid("id").primaryKey(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => missedWorkoutScheduleApplications.id),
    sequencePosition: integer("sequence_position").notNull(),
    plannedWorkoutId: uuid("planned_workout_id")
      .notNull()
      .references(() => plannedWorkouts.id),
    assignmentKind: missedWorkoutScheduleAssignmentKindEnum("assignment_kind").notNull(),
    authoredScheduledLocalDate: date("authored_scheduled_local_date"),
    effectiveScheduledLocalDate: date("effective_scheduled_local_date"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("missed_workout_schedule_assignments_application_workout_unique").on(table.applicationId, table.plannedWorkoutId),
    uniqueIndex("missed_workout_schedule_assignments_application_position_unique").on(table.applicationId, table.sequencePosition),
    check("missed_workout_schedule_assignments_position_non_negative", sql`${table.sequencePosition} >= 0`),
  ],
);
