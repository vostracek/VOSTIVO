import { err, ok, type Result } from "@vostivo/domain";
import type { EngineDecision, EnginePolicy } from "../decision.js";
import type { MissedWorkoutDecisionDataV1 } from "./decision-data.js";
import type { MissedWorkoutInputV1, MissedWorkoutPlannedWorkoutV1 } from "./input.js";
import { validateMissedWorkoutInput, type MissedWorkoutInputValidationErrorV1 } from "./validate-input.js";
import type { MissedWorkoutReviewReasonV1 } from "./vocabulary.js";

/**
 * Pure Missed Workout / Schedule Adaptation Policy V1
 * (docs/domain/MISSED-WORKOUT-ADAPTATION-V1.md). Deterministic and
 * side-effect free: no clock, no DB, no network, no randomness, no id
 * generation, no mode/authority branch — the same input always yields the
 * same decision (same discipline as the Progression and Available-Time
 * engines).
 *
 * SEQUENCE BEFORE CALENDAR: one legitimately missed workout stays in the
 * program and becomes the next session (ROLL_FORWARD); everything that
 * would need judgment — several misses, reordered history, a hard
 * deadline, unknown availability, an ambiguous order, a changed plan — is
 * REVIEW_REQUIRED, never a guess. The policy answers WHAT should happen,
 * never how it is persisted.
 */

/** Unresolved = still owed: a PLANNED/AVAILABLE occurrence with no canonical session. SKIPPED/RESCHEDULED/CANCELLED are resolved and never resurrected. */
function isUnresolved(workout: MissedWorkoutPlannedWorkoutV1): boolean {
  return (workout.status === "PLANNED" || workout.status === "AVAILABLE") && workout.canonicalSessionStatus === null;
}

/** Strictly BEFORE the athlete's local today — a workout scheduled today is not missed yet. ISO dates compare lexically. */
function isMissed(workout: MissedWorkoutPlannedWorkoutV1, athleteLocalDate: string): boolean {
  return isUnresolved(workout) && workout.scheduledLocalDate !== null && workout.scheduledLocalDate < athleteLocalDate;
}

function compareAuthored(a: MissedWorkoutPlannedWorkoutV1, b: MissedWorkoutPlannedWorkoutV1): number {
  return a.trainingCycleOrder - b.trainingCycleOrder || a.workoutOrder - b.workoutOrder;
}

/** Deterministic even when the authored order is ambiguous: (date, id). */
function compareForReporting(a: MissedWorkoutPlannedWorkoutV1, b: MissedWorkoutPlannedWorkoutV1): number {
  const byDate = (a.scheduledLocalDate ?? "").localeCompare(b.scheduledLocalDate ?? "");
  return byDate !== 0 ? byDate : a.plannedWorkoutId < b.plannedWorkoutId ? -1 : a.plannedWorkoutId > b.plannedWorkoutId ? 1 : 0;
}

/**
 * The authored sequence is ambiguous when two occurrences share one
 * position, or when scheduled dates run backwards against it (then "missed"
 * itself would contradict the program order).
 */
function isSequenceAmbiguous(sequence: readonly MissedWorkoutPlannedWorkoutV1[]): boolean {
  let previousDate: string | null = null;
  for (const [index, workout] of sequence.entries()) {
    const previous = sequence[index - 1];
    if (previous !== undefined && compareAuthored(previous, workout) === 0) return true;
    if (workout.scheduledLocalDate !== null) {
      if (previousDate !== null && workout.scheduledLocalDate < previousDate) return true;
      previousDate = workout.scheduledLocalDate;
    }
  }
  return false;
}

function review(reasonCode: MissedWorkoutReviewReasonV1, missed: readonly MissedWorkoutPlannedWorkoutV1[], performedLater: readonly MissedWorkoutPlannedWorkoutV1[] = []): MissedWorkoutDecisionDataV1 {
  return {
    resultKind: "REVIEW_REQUIRED",
    reasonCode,
    missedWorkoutIds: [...missed].sort(compareForReporting).map((workout) => workout.plannedWorkoutId),
    performedLaterWorkoutIds: performedLater.map((workout) => workout.plannedWorkoutId),
  };
}

/**
 * Fixed check precedence (documented, so a multi-condition input always
 * gets the same answer):
 *   1. no missed occurrence                       -> NO_CHANGE
 *   2. HARD_DEADLINE timeline                     -> REVIEW HARD_TIMELINE_CONSTRAINT
 *   3. more than one missed occurrence            -> REVIEW MULTIPLE_MISSED_WORKOUTS
 *   4. missed one not in the applicable plan      -> REVIEW SOURCE_CONTEXT_NOT_APPLICABLE
 *   5. ambiguous authored sequence                -> REVIEW AMBIGUOUS_SEQUENCE
 *   6. a LATER occurrence already has a session   -> REVIEW LATER_SESSION_ALREADY_PERFORMED
 *   7. no explicit slot on/after today            -> REVIEW NO_KNOWN_TRAINING_SLOT
 *   8. otherwise                                  -> ROLL_FORWARD
 */
function decideCore(input: MissedWorkoutInputV1): MissedWorkoutDecisionDataV1 {
  const missed = input.plannedWorkouts.filter((workout) => isMissed(workout, input.athleteLocalDate));
  if (missed.length === 0) return { resultKind: "NO_CHANGE", reasonCode: "NO_MISSED_WORKOUT" };

  if (input.timelineConstraint === "HARD_DEADLINE") return review("HARD_TIMELINE_CONSTRAINT", missed);
  if (missed.length > 1) return review("MULTIPLE_MISSED_WORKOUTS", missed);

  const missedWorkout = missed[0]!;
  if (input.applicableProgramVersionId === null || missedWorkout.programVersionId !== input.applicableProgramVersionId) {
    return review("SOURCE_CONTEXT_NOT_APPLICABLE", missed);
  }

  // The authored sequence of the applicable plan only — another
  // ProgramVersion's occurrences never interleave with this one.
  const sequence = input.plannedWorkouts.filter((workout) => workout.programVersionId === input.applicableProgramVersionId).sort(compareAuthored);
  if (isSequenceAmbiguous(sequence)) return review("AMBIGUOUS_SEQUENCE", missed);

  const missedIndex = sequence.indexOf(missedWorkout);
  const later = sequence.slice(missedIndex + 1);

  // HISTORICAL REALITY BEATS SCHEDULE INTENT: a later occurrence that
  // already has its canonical session cannot be put "after" the missed one.
  const performedLater = later.filter((workout) => workout.canonicalSessionStatus !== null);
  if (performedLater.length > 0) return review("LATER_SESSION_ALREADY_PERFORMED", missed, performedLater);

  // DO NOT INVENT TRAINING AVAILABILITY: only an explicit slot counts.
  const futureSlots = input.validTrainingSlots.filter((slot) => slot >= input.athleteLocalDate).sort();
  const nextTrainingSlot = futureSlots[0];
  if (nextTrainingSlot === undefined) return review("NO_KNOWN_TRAINING_SLOT", missed);

  const laterUnresolved = later.filter(isUnresolved);
  return {
    resultKind: "ROLL_FORWARD",
    reasonCode: "SINGLE_MISSED_WORKOUT",
    missedWorkoutId: missedWorkout.plannedWorkoutId,
    recommendedNextWorkoutId: missedWorkout.plannedWorkoutId,
    originalNextWorkoutId: laterUnresolved[0]?.plannedWorkoutId ?? null,
    sequence: [missedWorkout, ...laterUnresolved].map((workout) => workout.plannedWorkoutId),
    nextTrainingSlot,
  };
}

const REASON_DESCRIPTIONS_V1: Readonly<Record<MissedWorkoutDecisionDataV1["reasonCode"], string>> = {
  NO_MISSED_WORKOUT: "No planned workout is past due and unresolved.",
  SINGLE_MISSED_WORKOUT: "One workout was missed; it stays in the program as the next session, preserving the authored order.",
  MULTIPLE_MISSED_WORKOUTS: "More than one workout is past due; how to return belongs to a later absence policy.",
  LATER_SESSION_ALREADY_PERFORMED: "A later workout was already performed; history is never reordered.",
  AMBIGUOUS_SEQUENCE: "The authored workout order is ambiguous.",
  HARD_TIMELINE_CONSTRAINT: "The program's calendar is authoritative (hard deadline).",
  NO_KNOWN_TRAINING_SLOT: "No future training opportunity is known.",
  SOURCE_CONTEXT_NOT_APPLICABLE: "The missed workout no longer belongs to the applicable plan.",
};

/** The reused `EnginePolicy` contract. `decide()` assumes structurally valid input — prefer `evaluateMissedWorkout()`. */
export const missedWorkoutPolicyV1: EnginePolicy<MissedWorkoutInputV1, "missed-workout", MissedWorkoutDecisionDataV1> = {
  version: { engine: "missed-workout", policy: "v1" },
  decide(input) {
    const data = decideCore(input);
    return { kind: "missed-workout", version: missedWorkoutPolicyV1.version, data, reason: REASON_DESCRIPTIONS_V1[data.reasonCode] };
  },
};

/** Recommended entry point: validates first, so malformed input is a typed `err`, never silently a decision. */
export function evaluateMissedWorkout(
  input: MissedWorkoutInputV1,
): Result<EngineDecision<"missed-workout", MissedWorkoutDecisionDataV1>, MissedWorkoutInputValidationErrorV1> {
  const validation = validateMissedWorkoutInput(input);
  if (!validation.ok) return err(validation.error);
  return ok(missedWorkoutPolicyV1.decide(validation.value));
}
