import { boolean, index, jsonb, text, timestamp, unique, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { appSchema, users } from "./identity.js";
import { performedExercises, workoutSessions } from "./workout.js";

/**
 * Progression EngineDecision Persistence & Evidence Integration V1
 * (docs/domain/PROGRESSION-ENGINE-V1.md §18/§21) — a domain-specific
 * table, deliberately NOT a generic polymorphic `engine_decisions` table
 * (§21 of the implementation task; matches `CLAUDE.md`'s "no generic ...
 * framework" convention — a future deload decision type gets its own
 * table when that engine is actually built, not a shared one now).
 *
 * These vocabularies duplicate `packages/training-engine/src/progression/
 * vocabulary.ts` as plain local arrays rather than cross-importing —
 * `packages/database` intentionally does not depend on `packages/domain`
 * or `packages/training-engine` (docs/architecture/FOUNDATION.md's
 * dependency direction), the same reasoning already established for
 * `plan.ts`'s `TrainingFocusAreaRow`. Kept in sync by an apps/api-level
 * test (`progression-evaluation.service.test.ts`) that imports BOTH
 * packages and asserts these arrays deep-equal the real engine
 * vocabulary — apps/api is the one layer allowed to depend on both.
 */
export const PROGRESSION_DECISION_TYPE_VALUES = [
  "NO_CHANGE",
  "MAINTAIN_LOAD_BUILD_REPS",
  "INCREASE_LOAD",
] as const;
export const progressionDecisionTypeEnum = appSchema.enum(
  "progression_decision_type",
  PROGRESSION_DECISION_TYPE_VALUES,
);

export const PROGRESSION_EVIDENCE_STRENGTH_VALUES = [
  "INSUFFICIENT",
  "SINGLE_EXPOSURE",
  "SUPPORTED",
  "STRONG",
] as const;
export const progressionEvidenceStrengthEnum = appSchema.enum(
  "progression_evidence_strength",
  PROGRESSION_EVIDENCE_STRENGTH_VALUES,
);

/**
 * Matches the codebase's existing, established convention of a real
 * Postgres enum for every small fixed vocabulary (`workout_command_type`,
 * `performed_set_type`, `program_status`, ...) rather than "validated text
 * + application invariants" — this project has never used the latter
 * pattern for a comparably-sized closed vocabulary, so introducing one
 * here would be the inconsistent choice, not the conservative one.
 */
export const PROGRESSION_REASON_CODE_VALUES = [
  "TOP_OF_RANGE_ACHIEVED",
  "REPS_PROGRESSING",
  "PERFORMANCE_STABLE",
  "INSUFFICIENT_EVIDENCE",
  "SINGLE_EXPOSURE_ONLY",
  "PERFORMANCE_REGRESSED_SINGLE_EXPOSURE",
  "NON_COMPARABLE_CONTEXT",
  "PARTIAL_EXPOSURE",
  "PRESCRIPTION_CHANGED_RESET",
  "NO_SUITABLE_LOAD_INCREMENT",
] as const;
export const progressionReasonCodeEnum = appSchema.enum("progression_reason_code", PROGRESSION_REASON_CODE_VALUES);

/**
 * One persisted, auditable `progressionPolicyV1` output (§18/§19). Columns
 * map directly onto `EngineDecision<"progression", ProgressionDecisionDataV1>`
 * plus the identity/audit fields §18 lists conceptually — adapted to this
 * project's real naming conventions (camelCase TS / snake_case SQL,
 * `NO ACTION` FKs on historical truth, matching `workout_sessions`).
 *
 * `userId`, not `athleteProfileId` (§9 of the implementation task) — every
 * existing WDI ownership check in this codebase keys on `userId`
 * (`workout_sessions`, `workout_command_receipts`,
 * `workout_change_cursor`); `athleteProfileId` owns the separate Plan/
 * Program hierarchy only (`AuthenticatedActor.athleteProfileId` is even
 * optional — not every `User` has one). Duplicating an athlete-profile
 * column here would be a second ownership representation for the same
 * canonical workout-execution-history authority WDI already settled;
 * nothing in this slice needs it.
 *
 * `normalizedInputSnapshot` exists because the real persistence model does
 * NOT retain historical `PerformedSet` revision values — `performed_sets`
 * is upserted in place (`workout-command-processing.ts`'s
 * `onConflictDoUpdate`), so a corrected revision overwrites the row a
 * decision's `evidenceRefs` point at. Without the snapshot,
 * `performedSetId` + `revisionEvaluated` alone could not answer "what
 * exact evidence did progression/v1 see" once evidence is corrected —
 * this is the approved (§19 of the implementation task) fallback, not
 * event sourcing: one small, bounded, domain-specific document per
 * decision, never a generic event log.
 */
export const progressionDecisions = appSchema.table(
  "progression_decisions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    exerciseRef: text("exercise_ref").notNull(),
    sourceWorkoutSessionId: uuid("source_workout_session_id")
      .notNull()
      .references(() => workoutSessions.id),
    sourcePerformedExerciseId: uuid("source_performed_exercise_id")
      .notNull()
      .references(() => performedExercises.id),
    /** The opaque prescription-snapshot exercise id the decision was evaluated against (§7) — not a FK, same reasoning as `performed_exercises.prescription_exercise_id`. */
    sourcePrescriptionExerciseId: text("source_prescription_exercise_id").notNull(),
    engine: text("engine").notNull(),
    policy: text("policy").notNull(),
    decisionType: progressionDecisionTypeEnum("decision_type").notNull(),
    reasonCode: progressionReasonCodeEnum("reason_code").notNull(),
    evidenceStrength: progressionEvidenceStrengthEnum("evidence_strength").notNull(),
    progressionStalled: boolean("progression_stalled").notNull(),
    /** `IncreaseLoadDataV1 | null` — direction-only, never a resolved kg value (§14/§31 of the spec). */
    recommendedChange: jsonb("recommended_change"),
    /** The exact `ProgressionEvaluationInput` passed to `evaluateProgression()` — see the table doc comment above. */
    normalizedInputSnapshot: jsonb("normalized_input_snapshot").notNull(),
    /** `readonly {performedSetId: string; revisionEvaluated: number}[]` (§18's proposed `evidenceExposureRefs` shape, naming preserved). */
    evidenceRefs: jsonb("evidence_refs").notNull(),
    /**
     * A stable SHA-256 over a canonical serialization of
     * (engine, policy, userId, normalizedInputSnapshot) — the idempotency/
     * audit-identity mechanism (§25/§26 of the implementation task).
     * Correctness, not speculative optimization: the unique index below is
     * what makes "repeated identical evaluation creates one row" and
     * "concurrent identical evaluation creates one row" real DB-enforced
     * guarantees, not application-layer discipline that could race.
     */
    evidenceFingerprint: text("evidence_fingerprint").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    /**
     * Always `null` for every row this slice creates (§20.1/§22 —
     * recommendation != applied adaptation). No application mechanism
     * exists yet; this column exists so a future Progression Application
     * V1 slice can record `appliedAt` additively, without a migration.
     */
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    /**
     * Set when a later corrected re-evaluation of the SAME source exposure
     * produces a new decision (§23/§24) — the old row is never rewritten,
     * only marked superseded. Self-referencing, `NO ACTION` (never
     * `CASCADE` — matches this schema's "never cascade-delete historical
     * truth" convention throughout).
     */
    supersededByDecisionId: uuid("superseded_by_decision_id").references(
      (): AnyPgColumn => progressionDecisions.id,
    ),
  },
  (table) => [
    // Idempotency (§25/§27) — a real DB-enforced unique constraint, not
    // "the service checks before INSERT" (which races). Proven by a real
    // concurrent-insert integration test, not just a unit assumption.
    uniqueIndex("progression_decisions_evidence_fingerprint_unique").on(table.evidenceFingerprint),
    // Proven necessary by the same EXPLAIN-ANALYZE-before-adding discipline
    // as Progression Prerequisites V1's indexes — this is the service's
    // own real query (find the currently-unsuperseded decision for a given
    // source exposure, to link supersession), not speculative. See the
    // final report for the before/after evidence.
    index("progression_decisions_source_performed_exercise_id_idx").on(table.sourcePerformedExerciseId),
    // Progression Application Slice B ownership-integrity gate: the target
    // of progression_applications' composite ownership FK below — `id` is
    // already globally unique via the primary key; this adds `userId`
    // alongside it (same pattern as `loading_capabilities_gym_profile_id_
    // id_unique`), so a referencing row can be forced by Postgres itself
    // to agree with this decision's own owner, never merely a service-level
    // BOLA check.
    unique("progression_decisions_id_user_id_unique").on(table.id, table.userId),
  ],
);
