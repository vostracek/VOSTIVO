import { err, isSetType, ok, type Result } from "@vostivo/domain";
import type { AvailableTimeExerciseV1, AvailableTimeInputV1, AvailableTimeSetV1 } from "./input.js";
import { PRIORITY_TIERS_V1 } from "./vocabulary.js";

/**
 * Available-Time Adaptation V1 (locked §17) — the exhaustive "invalid,
 * structurally broken input" list, made explicit and checkable, using
 * this repository's own `Result` convention (`@vostivo/domain`) exactly
 * like the Progression Engine's `validateProgressionInput`. Never
 * auto-repaired (§17's own explicit instruction) — a structurally invalid
 * input is a caller/assembler bug, never silently coerced into
 * `CANNOT_FIT_MINIMUM` or any other real decision (§11's own explicit
 * warning).
 */
export type AvailableTimeInputValidationErrorV1 =
  | { readonly reason: "NEGATIVE_AVAILABLE_TIME" }
  | { readonly reason: "NO_EXERCISES" }
  | { readonly reason: "DUPLICATE_EXERCISE_KEY"; readonly exerciseKey: string }
  | { readonly reason: "DUPLICATE_EXERCISE_ORDER_INDEX"; readonly orderIndex: number }
  | { readonly reason: "INVALID_EXERCISE_ORDER_INDEX"; readonly exerciseKey: string }
  | { readonly reason: "UNSUPPORTED_PRIORITY_TIER"; readonly exerciseKey: string }
  | { readonly reason: "NEGATIVE_MINIMUM_WORKING_SETS"; readonly exerciseKey: string }
  | { readonly reason: "MINIMUM_EXCEEDS_WORKING_SET_COUNT"; readonly exerciseKey: string }
  | { readonly reason: "NO_EXERCISE_WITH_POSITIVE_MINIMUM" }
  | { readonly reason: "NO_SETS"; readonly exerciseKey: string }
  | { readonly reason: "DUPLICATE_SET_KEY"; readonly exerciseKey: string; readonly setKey: string }
  | { readonly reason: "DUPLICATE_SET_ORDER_INDEX"; readonly exerciseKey: string; readonly orderIndex: number }
  | { readonly reason: "INVALID_SET_ORDER_INDEX"; readonly exerciseKey: string; readonly setKey: string }
  | { readonly reason: "UNSUPPORTED_SET_TYPE"; readonly exerciseKey: string; readonly setKey: string }
  | { readonly reason: "INVALID_REST_SECONDS"; readonly exerciseKey: string; readonly setKey: string };

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function validateSet(exerciseKey: string, set: AvailableTimeSetV1): AvailableTimeInputValidationErrorV1 | null {
  if (!isNonNegativeInteger(set.orderIndex)) {
    return { reason: "INVALID_SET_ORDER_INDEX", exerciseKey, setKey: set.setKey };
  }
  // Defense-in-depth (matches `validateProgressionInput`'s own convention):
  // never trust a caller-supplied `setType` string at the runtime
  // boundary, even though the TS type already narrows it.
  if (!isSetType(set.setType)) {
    return { reason: "UNSUPPORTED_SET_TYPE", exerciseKey, setKey: set.setKey };
  }
  if (!isNonNegativeInteger(set.restSeconds)) {
    return { reason: "INVALID_REST_SECONDS", exerciseKey, setKey: set.setKey };
  }
  return null;
}

function validateExercise(exercise: AvailableTimeExerciseV1): AvailableTimeInputValidationErrorV1 | null {
  const { exerciseKey } = exercise;

  if (!isNonNegativeInteger(exercise.orderIndex)) {
    return { reason: "INVALID_EXERCISE_ORDER_INDEX", exerciseKey };
  }
  if (!(PRIORITY_TIERS_V1 as readonly string[]).includes(exercise.priorityTier)) {
    return { reason: "UNSUPPORTED_PRIORITY_TIER", exerciseKey };
  }
  if (!Number.isInteger(exercise.minimumWorkingSets) || exercise.minimumWorkingSets < 0) {
    return { reason: "NEGATIVE_MINIMUM_WORKING_SETS", exerciseKey };
  }
  if (exercise.sets.length === 0) {
    return { reason: "NO_SETS", exerciseKey };
  }

  const seenSetKeys = new Set<string>();
  const seenSetOrderIndexes = new Set<number>();
  let workingSetCount = 0;
  for (const set of exercise.sets) {
    const setError = validateSet(exerciseKey, set);
    if (setError !== null) return setError;

    if (seenSetKeys.has(set.setKey)) return { reason: "DUPLICATE_SET_KEY", exerciseKey, setKey: set.setKey };
    seenSetKeys.add(set.setKey);

    if (seenSetOrderIndexes.has(set.orderIndex)) return { reason: "DUPLICATE_SET_ORDER_INDEX", exerciseKey, orderIndex: set.orderIndex };
    seenSetOrderIndexes.add(set.orderIndex);

    if (set.setType === "WORKING") workingSetCount += 1;
  }

  if (exercise.minimumWorkingSets > workingSetCount) {
    return { reason: "MINIMUM_EXCEEDS_WORKING_SET_COUNT", exerciseKey };
  }

  return null;
}

/**
 * Validates an `AvailableTimeInputV1` structurally only — never whether a
 * session ultimately fits the time budget (that is `policy.ts`'s job and
 * a normal decision outcome — `NO_CHANGE`/`ADJUST_SESSION`/
 * `CANNOT_FIT_MINIMUM` — never a validation failure).
 */
export function validateAvailableTimeInput(
  input: AvailableTimeInputV1,
): Result<AvailableTimeInputV1, AvailableTimeInputValidationErrorV1> {
  if (!Number.isInteger(input.availableTimeSeconds) || input.availableTimeSeconds < 0) {
    return err({ reason: "NEGATIVE_AVAILABLE_TIME" });
  }
  if (input.exercises.length === 0) {
    return err({ reason: "NO_EXERCISES" });
  }

  const seenExerciseKeys = new Set<string>();
  const seenExerciseOrderIndexes = new Set<number>();
  let hasExerciseWithPositiveMinimum = false;

  for (const exercise of input.exercises) {
    if (seenExerciseKeys.has(exercise.exerciseKey)) {
      return err({ reason: "DUPLICATE_EXERCISE_KEY", exerciseKey: exercise.exerciseKey });
    }
    seenExerciseKeys.add(exercise.exerciseKey);

    if (seenExerciseOrderIndexes.has(exercise.orderIndex)) {
      return err({ reason: "DUPLICATE_EXERCISE_ORDER_INDEX", orderIndex: exercise.orderIndex });
    }
    seenExerciseOrderIndexes.add(exercise.orderIndex);

    const exerciseError = validateExercise(exercise);
    if (exerciseError !== null) return err(exerciseError);

    if (exercise.minimumWorkingSets > 0) hasExerciseWithPositiveMinimum = true;
  }

  // Locked §3 — prevents an "empty workout" from ever being the minimum
  // meaningful session: at least one exercise must be structurally
  // protected.
  if (!hasExerciseWithPositiveMinimum) {
    return err({ reason: "NO_EXERCISE_WITH_POSITIVE_MINIMUM" });
  }

  return ok(input);
}
