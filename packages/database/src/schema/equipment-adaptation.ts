import { check, date, index, jsonb, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { appSchema, athleteProfiles, users } from "./identity.js";
import { plannedWorkouts, programVersions, trainingBlocks } from "./plan.js";
import { workoutSessions } from "./workout.js";

/**
 * Temporary Equipment / Gym Adaptation V1 — Slice C
 * (docs/domain/TEMPORARY-EQUIPMENT-ADAPTATION-V1.md §12): the durable,
 * auditable TODAY_ONLY equipment application.
 *
 * The authored plan is never mutated. One row = the athlete explicitly
 * applying ONE server-re-derived `equipment-adaptation/v1` preview for ONE
 * planned workout on ONE athlete-local day. Everything stored is
 * SERVER-derived (the re-derived replacements, the canonical inventory the
 * athlete declared, versions, fingerprint) — never client adaptation data.
 *
 * Lifecycle (append/audit — rows are never deleted or rewritten):
 *   ACTIVE      the one effective equipment adaptation for the occurrence
 *   SUPERSEDED  replaced before START by a newer applied preview, or retired
 *               unused when the canonical START claimed the occurrence while
 *               it no longer applied
 *   CONSUMED    used by the START that claimed the occurrence (canonical)
 * - At most ONE ACTIVE per (user, planned workout): partial unique index.
 * - At most one application consumed by a session: unique consumed session.
 * The fingerprint is a stale/idempotency guard, never authorization.
 */
export const EQUIPMENT_ADAPTATION_APPLICATION_STATUS_VALUES = ["ACTIVE", "SUPERSEDED", "CONSUMED"] as const;
export const equipmentAdaptationApplicationStatusEnum = appSchema.enum("equipment_adaptation_application_status", EQUIPMENT_ADAPTATION_APPLICATION_STATUS_VALUES);

export const EQUIPMENT_ADAPTATION_APPLICATION_SCOPE_VALUES = ["TODAY_ONLY"] as const;
export const equipmentAdaptationApplicationScopeEnum = appSchema.enum("equipment_adaptation_application_scope", EQUIPMENT_ADAPTATION_APPLICATION_SCOPE_VALUES);

export const EQUIPMENT_ADAPTATION_APPLICATION_RESULT_VALUES = ["NO_CHANGE", "ADJUST_SESSION"] as const;
export const equipmentAdaptationApplicationResultEnum = appSchema.enum("equipment_adaptation_application_result", EQUIPMENT_ADAPTATION_APPLICATION_RESULT_VALUES);

/** One server-derived replacement, exactly as `equipment-adaptation/v1` decided it (authored order). */
export interface EquipmentAdaptationReplacementRow {
  readonly plannedExerciseId: string;
  readonly order: number;
  readonly authoredExerciseRef: string;
  readonly substituteExerciseRef: string;
}

export const equipmentAdaptationApplications = appSchema.table(
  "equipment_adaptation_applications",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    athleteProfileId: uuid("athlete_profile_id")
      .notNull()
      .references(() => athleteProfiles.id),
    plannedWorkoutId: uuid("planned_workout_id")
      .notNull()
      .references(() => plannedWorkouts.id),
    programVersionId: uuid("program_version_id")
      .notNull()
      .references(() => programVersions.id),
    trainingBlockId: uuid("training_block_id")
      .notNull()
      .references(() => trainingBlocks.id),
    scope: equipmentAdaptationApplicationScopeEnum("scope").notNull(),
    athleteLocalDate: date("athlete_local_date").notNull(),
    trainingTimeZone: text("training_time_zone").notNull(),
    previewSchemaVersion: text("preview_schema_version").notNull(),
    policyVersion: text("policy_version").notNull(),
    catalogVersion: text("catalog_version").notNull(),
    previewFingerprint: text("preview_fingerprint").notNull(),
    /** The canonical (sorted, deduplicated, catalog-validated) session inventory that caused it. */
    availableEquipmentIds: jsonb("available_equipment_ids").notNull().$type<readonly string[]>(),
    result: equipmentAdaptationApplicationResultEnum("result").notNull(),
    /** `[]` for NO_CHANGE (an explicit "no equipment change today", which supersedes an earlier one). */
    replacements: jsonb("replacements").notNull().$type<readonly EquipmentAdaptationReplacementRow[]>(),
    status: equipmentAdaptationApplicationStatusEnum("status").notNull(),
    supersedesApplicationId: uuid("supersedes_application_id").references((): AnyPgColumn => equipmentAdaptationApplications.id),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    consumedByWorkoutSessionId: uuid("consumed_by_workout_session_id").references(() => workoutSessions.id),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    appliedByUserId: uuid("applied_by_user_id")
      .notNull()
      .references(() => users.id),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("equipment_adaptation_applications_one_active_per_workout").on(table.userId, table.plannedWorkoutId).where(sql`${table.status} = 'ACTIVE'`),
    uniqueIndex("equipment_adaptation_applications_consumed_session_unique").on(table.consumedByWorkoutSessionId),
    index("equipment_adaptation_applications_workout_lookup_idx").on(table.userId, table.plannedWorkoutId, table.status),
    check("equipment_adaptation_applications_superseded_consistent", sql`(${table.status} = 'SUPERSEDED') = (${table.supersededAt} IS NOT NULL)`),
    check(
      "equipment_adaptation_applications_consumed_consistent",
      sql`(${table.status} = 'CONSUMED') = (${table.consumedByWorkoutSessionId} IS NOT NULL AND ${table.consumedAt} IS NOT NULL)`,
    ),
    check("equipment_adaptation_applications_result_consistent", sql`(${table.result} = 'NO_CHANGE') = (jsonb_array_length(${table.replacements}) = 0)`),
  ],
);
