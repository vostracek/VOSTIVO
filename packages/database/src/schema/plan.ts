import { check, date, integer, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { appSchema, athleteProfiles } from "./identity.js";

/**
 * Program hierarchy for the Plan & Workout Prescription vertical slice:
 * Program -> ProgramVersion -> TrainingBlock -> TrainingCycle ->
 * PlannedWorkout -> PlannedExercise -> PlannedSet. See
 * docs/architecture/PLAN-PRESCRIPTION.md for the full design and
 * deliberate deferrals. All foreign keys are `NO ACTION` (never
 * `CASCADE`) — historical reconstructability of a `ProgramVersion` must
 * never depend on an accidental cascading delete.
 */

export const PROGRAM_STATUS_VALUES = ["ACTIVE", "ARCHIVED"] as const;
export const programStatusEnum = appSchema.enum("program_status", PROGRAM_STATUS_VALUES);

/**
 * The long-lived logical program. Deliberately no `active_program_version_id`
 * column — "the active version" is derived from
 * `program_versions.status = 'ACTIVE'` (enforced unique below), not a
 * denormalized pointer, which also avoids a circular FK between these two
 * tables.
 */
export const programs = appSchema.table("programs", {
  id: uuid("id").primaryKey(),
  athleteProfileId: uuid("athlete_profile_id")
    .notNull()
    .references(() => athleteProfiles.id),
  name: text("name").notNull(),
  status: programStatusEnum("status").notNull().default("ACTIVE"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const PROGRAM_VERSION_STATUS_VALUES = ["DRAFT", "ACTIVE", "SUPERSEDED"] as const;
export const programVersionStatusEnum = appSchema.enum(
  "program_version_status",
  PROGRAM_VERSION_STATUS_VALUES,
);

export const programVersions = appSchema.table(
  "program_versions",
  {
    id: uuid("id").primaryKey(),
    programId: uuid("program_id")
      .notNull()
      .references(() => programs.id),
    versionNumber: integer("version_number").notNull(),
    status: programVersionStatusEnum("status").notNull().default("DRAFT"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("program_versions_program_id_version_number_unique").on(
      table.programId,
      table.versionNumber,
    ),
    // At most one ACTIVE version per program — a real DB-enforced
    // invariant, not just application-layer discipline (spec section 17).
    uniqueIndex("program_versions_one_active_per_program")
      .on(table.programId)
      .where(sql`${table.status} = 'ACTIVE'`),
  ],
);

/**
 * Mirrors `TrainingFocusAreaV1` (packages/domain/src/plan/training-block.ts)
 * structurally — duplicated as a plain local type rather than imported,
 * since packages/database intentionally does not depend on
 * packages/domain (see docs/architecture/FOUNDATION.md's dependency
 * directions). Both sides are tiny and locked to the same Weekly Focus
 * vocabulary; a schema test locks this in sync.
 */
export interface TrainingFocusAreaRow {
  readonly name: string;
  readonly emphasis: "PRIORITY" | "MAINTAIN";
}

export const trainingBlocks = appSchema.table(
  "training_blocks",
  {
    id: uuid("id").primaryKey(),
    programVersionId: uuid("program_version_id")
      .notNull()
      .references(() => programVersions.id),
    name: text("name").notNull(),
    goal: text("goal").notNull(),
    orderIndex: integer("order_index").notNull(),
    cycleCount: integer("cycle_count").notNull(),
    // A small labeled-priority list, not a computed volume model.
    focusAreas: jsonb("focus_areas").notNull().$type<readonly TrainingFocusAreaRow[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("training_blocks_program_version_id_order_index_unique").on(
      table.programVersionId,
      table.orderIndex,
    ),
  ],
);

export const trainingCycles = appSchema.table(
  "training_cycles",
  {
    id: uuid("id").primaryKey(),
    trainingBlockId: uuid("training_block_id")
      .notNull()
      .references(() => trainingBlocks.id),
    orderIndex: integer("order_index").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("training_cycles_training_block_id_order_index_unique").on(
      table.trainingBlockId,
      table.orderIndex,
    ),
    check("training_cycles_end_date_not_before_start_date", sql`${table.endDate} >= ${table.startDate}`),
  ],
);

/**
 * Scheduling status ONLY — never `STARTED`/`COMPLETED` (spec section 8,
 * a previously locked correction). Execution truth lives exclusively in
 * `app.workout_sessions`.
 */
export const PLANNED_WORKOUT_STATUS_VALUES = [
  "PLANNED",
  "AVAILABLE",
  "SKIPPED",
  "RESCHEDULED",
  "CANCELLED",
] as const;
export const plannedWorkoutStatusEnum = appSchema.enum(
  "planned_workout_status",
  PLANNED_WORKOUT_STATUS_VALUES,
);

export const plannedWorkouts = appSchema.table(
  "planned_workouts",
  {
    id: uuid("id").primaryKey(),
    trainingCycleId: uuid("training_cycle_id")
      .notNull()
      .references(() => trainingCycles.id),
    name: text("name").notNull(),
    focus: text("focus"),
    orderIndex: integer("order_index").notNull(),
    scheduledDate: date("scheduled_date"),
    estimatedDurationMinutes: integer("estimated_duration_minutes"),
    status: plannedWorkoutStatusEnum("status").notNull().default("PLANNED"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("planned_workouts_training_cycle_id_order_index_unique").on(
      table.trainingCycleId,
      table.orderIndex,
    ),
  ],
);

/**
 * Available-Time Adaptation V1 (docs/domain/AVAILABLE-TIME-ADAPTATION-V1.md
 * §2) — mirrors `PRIORITY_TIERS_V1` (packages/training-engine) as a plain
 * local list, since packages/database does not depend on the engine; an
 * apps/api test locks the two in sync.
 */
export const PLANNED_EXERCISE_PRIORITY_TIER_VALUES = ["TIER_1", "TIER_2", "TIER_3"] as const;
export const plannedExercisePriorityTierEnum = appSchema.enum(
  "planned_exercise_priority_tier",
  PLANNED_EXERCISE_PRIORITY_TIER_VALUES,
);

export const plannedExercises = appSchema.table(
  "planned_exercises",
  {
    id: uuid("id").primaryKey(),
    plannedWorkoutId: uuid("planned_workout_id")
      .notNull()
      .references(() => plannedWorkouts.id),
    exerciseRef: text("exercise_ref"),
    displayName: text("display_name").notNull(),
    orderIndex: integer("order_index").notNull(),
    /**
     * Authored program structure for Available-Time Adaptation V1 (§2/§3):
     * how protected this exercise is when a session must be shortened, and
     * how many WORKING sets it must keep. Never inferred from name, order,
     * taxonomy or set count.
     *
     * Nullable on purpose — a DATABASE COMPATIBILITY state, not a product
     * default: rows authored before this column existed carry no
     * adaptation intent, and inventing a tier for them would be fake
     * authored semantics. A workout with any NULL here is simply not
     * eligible for available-time adaptation (the preview fails closed);
     * every new authoring path writes both values explicitly.
     */
    priorityTier: plannedExercisePriorityTierEnum("priority_tier"),
    minimumWorkingSets: integer("minimum_working_sets"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("planned_exercises_planned_workout_id_order_index_unique").on(
      table.plannedWorkoutId,
      table.orderIndex,
    ),
    check(
      "planned_exercises_minimum_working_sets_non_negative",
      sql`${table.minimumWorkingSets} IS NULL OR ${table.minimumWorkingSets} >= 0`,
    ),
  ],
);

export const PLANNED_SET_LOAD_KIND_VALUES = ["EXTERNAL_WEIGHT"] as const;
export const plannedSetLoadKindEnum = appSchema.enum(
  "planned_set_load_kind",
  PLANNED_SET_LOAD_KIND_VALUES,
);
export const PLANNED_SET_LOAD_UNIT_VALUES = ["KG", "LB"] as const;
export const plannedSetLoadUnitEnum = appSchema.enum("planned_set_load_unit", PLANNED_SET_LOAD_UNIT_VALUES);
export const PLANNED_SET_LOAD_BASIS_VALUES = ["TOTAL", "PER_IMPLEMENT"] as const;
export const plannedSetLoadBasisEnum = appSchema.enum(
  "planned_set_load_basis",
  PLANNED_SET_LOAD_BASIS_VALUES,
);

/**
 * Progression Prerequisites V1 (docs/domain/PROGRESSION-ENGINE-V1.md
 * §5.2, tech-lead-resolved OD-3). `NOT NULL` with a `WORKING` default —
 * the default is migration/defense-in-depth only (existing rows had no
 * warm-up concept when created, and a future write path that forgets to
 * specify one still gets an explicit, correct value written) — the
 * application/domain layer always writes this explicitly on every new
 * row (`packages/database/src/seed-dev-plan.ts`), never relying on the
 * default as the primary mechanism. There is exactly one representation
 * for "ordinary set" (`WORKING`) — never a nullable column silently
 * reinterpreted at read time.
 */
export const PLANNED_SET_TYPE_VALUES = ["WORKING", "WARM_UP"] as const;
export const plannedSetTypeEnum = appSchema.enum("planned_set_type", PLANNED_SET_TYPE_VALUES);

export const plannedSets = appSchema.table(
  "planned_sets",
  {
    id: uuid("id").primaryKey(),
    plannedExerciseId: uuid("planned_exercise_id")
      .notNull()
      .references(() => plannedExercises.id),
    orderIndex: integer("order_index").notNull(),
    targetRepsMin: integer("target_reps_min"),
    targetRepsMax: integer("target_reps_max"),
    // Optional prescribed rest duration (Active Workout Core Logger V1,
    // section 20) — null means "not specified," not "no rest"; see
    // packages/domain/src/plan/planned-set.ts.
    restSeconds: integer("rest_seconds"),
    setType: plannedSetTypeEnum("set_type").notNull().default("WORKING"),
    loadKind: plannedSetLoadKindEnum("load_kind"),
    loadAmountMilli: integer("load_amount_milli"),
    loadUnit: plannedSetLoadUnitEnum("load_unit"),
    loadBasis: plannedSetLoadBasisEnum("load_basis"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("planned_sets_planned_exercise_id_order_index_unique").on(
      table.plannedExerciseId,
      table.orderIndex,
    ),
    // A valid Load Model representation is all four columns present or
    // all four absent — never a partial/ambiguous load (spec section 17,
    // LOAD-INV-001).
    check(
      "planned_sets_load_all_or_nothing",
      sql`(${table.loadKind} IS NULL AND ${table.loadAmountMilli} IS NULL AND ${table.loadUnit} IS NULL AND ${table.loadBasis} IS NULL)
          OR (${table.loadKind} IS NOT NULL AND ${table.loadAmountMilli} IS NOT NULL AND ${table.loadUnit} IS NOT NULL AND ${table.loadBasis} IS NOT NULL)`,
    ),
  ],
);
