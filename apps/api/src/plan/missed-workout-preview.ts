import { createHash } from "node:crypto";
import type { MissedWorkoutPreviewResponseV1 } from "@vostivo/contracts";
import { assignRollForwardSlots, type EffectiveScheduleAssignment, type PlannedWorkoutStatus, type WorkoutSessionStatus } from "@vostivo/domain";
import { canonicalStringify } from "@vostivo/progression-application";
import {
  MISSED_WORKOUT_POLICY_VERSION_V1,
  evaluateMissedWorkout,
  type MissedWorkoutDecisionDataV1,
  type MissedWorkoutInputV1,
  type TimelineConstraintV1,
} from "@vostivo/training-engine";

/**
 * Missed Workout / Schedule Adaptation V1 — the PURE half of the server
 * preview (Slice B) and of the apply re-derivation (Slice C). Canonical
 * EFFECTIVE schedule rows + the athlete's local date in, the
 * `missed-workout/v1` input / preview contract / proposed assignments out.
 * The decision itself lives only in `@vostivo/training-engine`
 * (`evaluateMissedWorkout`); this module only scopes, normalizes, derives
 * known training slots, and reshapes. No DB, no clock, no randomness.
 */

/**
 * Bumped only if the fingerprint's own input shape changes — independent of
 * the policy version. v2 (Slice C): + active schedule application id and
 * authored dates, since the policy now reads EFFECTIVE dates.
 */
const PREVIEW_FINGERPRINT_SCHEMA = "missed-workout-preview-v2";

export interface ScheduleOccurrenceRow {
  readonly plannedWorkoutId: string;
  readonly displayName: string;
  readonly cycleOrder: number;
  readonly workoutOrder: number;
  /** Never changed by any adaptation. */
  readonly authoredScheduledLocalDate: string | null;
  /** The EFFECTIVE date (= authored unless the block's active application moved it; `null` = unscheduled/carryover). The policy reads this. */
  readonly scheduledLocalDate: string | null;
  readonly status: PlannedWorkoutStatus;
  /** From Planned Workout Occurrence Authority (the canonical claim) only — never a secondary or unclaimed session. */
  readonly canonicalSessionStatus: WorkoutSessionStatus | null;
}

function isUnresolved(row: ScheduleOccurrenceRow): boolean {
  return (row.status === "PLANNED" || row.status === "AVAILABLE") && row.canonicalSessionStatus === null;
}

/**
 * V1 known training opportunities = the current EFFECTIVE calendar: every
 * date on or after today that belongs to an UNRESOLVED planned occurrence
 * of the current block (without an overlay, exactly the authored dates —
 * Slice B). A date stays a slot even if its own workout may be displaced by
 * a roll-forward. Resolved occurrences (SKIPPED/RESCHEDULED/CANCELLED, or
 * already performed) never establish a slot — a cancelled-only date is not
 * a slot. A carryover (no effective date) establishes none. The app being
 * open today is not a slot; neither is a rest day. No recurrence is ever
 * inferred. Deduplicated, ascending.
 */
export function deriveKnownTrainingSlots(rows: readonly ScheduleOccurrenceRow[], athleteLocalDate: string): string[] {
  const dates = rows.filter((row) => isUnresolved(row) && row.scheduledLocalDate !== null && row.scheduledLocalDate >= athleteLocalDate).map((row) => row.scheduledLocalDate!);
  return [...new Set(dates)].sort();
}

export interface MissedWorkoutPreviewSource {
  readonly athleteProfileId: string;
  readonly trainingTimeZone: string;
  readonly athleteLocalDate: string;
  /** `null` when the athlete has no ACTIVE ProgramVersion. */
  readonly programVersionId: string | null;
  /** `null` when there is no plan, or it has not started. */
  readonly trainingBlockId: string | null;
  /** The block's ACTIVE missed-workout schedule application whose snapshot produced the effective dates, if any. */
  readonly activeScheduleApplicationId: string | null;
  readonly occurrences: readonly ScheduleOccurrenceRow[];
  /** V1 production default is FLEXIBLE (no persisted deadline concept exists); HARD_DEADLINE is only reachable through this seam. */
  readonly timelineConstraint: TimelineConstraintV1;
}

function byAuthoredOrder(a: ScheduleOccurrenceRow, b: ScheduleOccurrenceRow): number {
  return a.cycleOrder - b.cycleOrder || a.workoutOrder - b.workoutOrder || (a.plannedWorkoutId < b.plannedWorkoutId ? -1 : a.plannedWorkoutId > b.plannedWorkoutId ? 1 : 0);
}

/** Canonical rows -> `MissedWorkoutInputV1` (rows already scoped to the ACTIVE version's current block; dates are EFFECTIVE). */
export function buildMissedWorkoutInput(source: MissedWorkoutPreviewSource): MissedWorkoutInputV1 {
  const occurrences = [...source.occurrences].sort(byAuthoredOrder);
  return {
    athleteLocalDate: source.athleteLocalDate,
    applicableProgramVersionId: source.programVersionId,
    timelineConstraint: source.timelineConstraint,
    plannedWorkouts: occurrences.map((row) => ({
      plannedWorkoutId: row.plannedWorkoutId,
      programVersionId: source.programVersionId ?? "",
      trainingCycleOrder: row.cycleOrder,
      workoutOrder: row.workoutOrder,
      scheduledLocalDate: row.scheduledLocalDate,
      status: row.status,
      canonicalSessionStatus: row.canonicalSessionStatus,
    })),
    validTrainingSlots: deriveKnownTrainingSlots(occurrences, source.athleteLocalDate),
  };
}

/**
 * Deterministic stale-input and idempotency guard: the same canonical
 * schedule state always yields the same value; any change to the zone,
 * local date, version/block, the active overlay, any occurrence's order/
 * authored or effective date/status/canonical session, the derived slots or
 * the decision changes it. Not an auth token.
 */
export function computeMissedWorkoutPreviewFingerprint(source: MissedWorkoutPreviewSource, input: MissedWorkoutInputV1, decision: MissedWorkoutDecisionDataV1): string {
  const canonical = canonicalStringify({
    fingerprintSchema: PREVIEW_FINGERPRINT_SCHEMA,
    policyVersion: MISSED_WORKOUT_POLICY_VERSION_V1,
    athleteProfileId: source.athleteProfileId,
    trainingTimeZone: source.trainingTimeZone,
    athleteLocalDate: source.athleteLocalDate,
    programVersionId: source.programVersionId,
    trainingBlockId: source.trainingBlockId,
    activeScheduleApplicationId: source.activeScheduleApplicationId,
    timelineConstraint: input.timelineConstraint,
    occurrences: input.plannedWorkouts,
    authoredScheduledLocalDates: [...source.occurrences].sort(byAuthoredOrder).map((row) => [row.plannedWorkoutId, row.authoredScheduledLocalDate]),
    validTrainingSlots: input.validTrainingSlots,
    decision,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export interface MissedWorkoutEvaluation {
  readonly preview: MissedWorkoutPreviewResponseV1;
  readonly input: MissedWorkoutInputV1;
  readonly decision: MissedWorkoutDecisionDataV1;
  /** ROLL_FORWARD only: the decision sequence consuming the known slots, in sequence order. */
  readonly proposedAssignments: readonly EffectiveScheduleAssignment[] | null;
}

/** The whole preview: normalize -> `evaluateMissedWorkout` (the only implementation of the policy) -> contract + proposed assignments. */
export function evaluateMissedWorkoutPreview(source: MissedWorkoutPreviewSource): MissedWorkoutEvaluation {
  const input = buildMissedWorkoutInput(source);
  const evaluated = evaluateMissedWorkout(input);
  // Server-built input from validated canonical rows: an invalid one is a bug, not a user condition.
  if (!evaluated.ok) throw new Error(`missed-workout/v1 rejected server-built input: ${evaluated.error.reason}`);
  const decision = evaluated.value.data;

  const common = {
    policyVersion: MISSED_WORKOUT_POLICY_VERSION_V1,
    athleteLocalDate: source.athleteLocalDate,
    trainingTimeZone: source.trainingTimeZone,
    previewFingerprint: computeMissedWorkoutPreviewFingerprint(source, input, decision),
  } as const;

  if (decision.resultKind === "NO_CHANGE") {
    return { input, decision, proposedAssignments: null, preview: { ...common, result: "NO_CHANGE", reasonCode: decision.reasonCode } };
  }
  if (decision.resultKind === "REVIEW_REQUIRED") {
    return {
      input,
      decision,
      proposedAssignments: null,
      preview: { ...common, result: "REVIEW_REQUIRED", reasonCode: decision.reasonCode, missedWorkoutIds: decision.missedWorkoutIds, performedLaterWorkoutIds: decision.performedLaterWorkoutIds },
    };
  }

  const byId = new Map(source.occurrences.map((row) => [row.plannedWorkoutId, row]));
  const row = (id: string): ScheduleOccurrenceRow => {
    const found = byId.get(id);
    if (found === undefined) throw new Error(`missed-workout/v1 referenced an unknown occurrence ${id}`);
    return found;
  };
  // The exact slots the policy saw — never an invented or recurring date.
  const proposedAssignments = assignRollForwardSlots(decision.sequence, input.validTrainingSlots);
  const proposed = new Map(proposedAssignments.map((a) => [a.plannedWorkoutId, a.effectiveScheduledLocalDate]));
  const missed = row(decision.missedWorkoutId);
  const originalNext = decision.originalNextWorkoutId === null ? null : row(decision.originalNextWorkoutId);
  return {
    input,
    decision,
    proposedAssignments,
    preview: {
      ...common,
      result: "ROLL_FORWARD",
      reasonCode: decision.reasonCode,
      missedWorkout: { plannedWorkoutId: missed.plannedWorkoutId, displayName: missed.displayName, scheduledLocalDate: missed.scheduledLocalDate },
      recommendedNextWorkout: { plannedWorkoutId: missed.plannedWorkoutId, displayName: missed.displayName },
      originalNextWorkout: originalNext === null ? null : { plannedWorkoutId: originalNext.plannedWorkoutId, displayName: originalNext.displayName, scheduledLocalDate: originalNext.scheduledLocalDate },
      nextTrainingSlot: decision.nextTrainingSlot,
      upcomingSequence: decision.sequence.map((id) => ({
        plannedWorkoutId: id,
        displayName: row(id).displayName,
        authoredScheduledLocalDate: row(id).authoredScheduledLocalDate,
        effectiveScheduledLocalDate: row(id).scheduledLocalDate,
        proposedScheduledLocalDate: proposed.get(id) ?? null,
      })),
    },
  };
}

export function computeMissedWorkoutPreview(source: MissedWorkoutPreviewSource): MissedWorkoutPreviewResponseV1 {
  return evaluateMissedWorkoutPreview(source).preview;
}
