import { err, ok, type Result } from "@vostivo/domain";
import type { EngineDecision, EnginePolicy } from "../decision.js";
import { estimateExerciseDurationSeconds } from "./duration.js";
import type {
  AvailableTimeFullyRemovedExerciseV1,
  AvailableTimeDecisionDataV1,
  AvailableTimeRemovedWorkingSetV1,
  AvailableTimeRetainedExerciseV1,
} from "./decision-data.js";
import type { AvailableTimeExerciseV1, AvailableTimeInputV1, AvailableTimeSetV1 } from "./input.js";
import { TIER_REMOVAL_ORDER_V1 } from "./vocabulary.js";
import { validateAvailableTimeInput, type AvailableTimeInputValidationErrorV1 } from "./validate-input.js";

/**
 * Pure Available-Time Adaptation Engine V1
 * (`docs/domain/AVAILABLE-TIME-ADAPTATION-V1.md`, tech-lead-locked
 * methodology). The whole module is deterministic and side-effect free:
 * no DB, no network, no clock, no randomness, no mode/authority branch —
 * the same input always produces the same `AvailableTimeDecisionDataV1`
 * (proven by `policy.test.ts`'s determinism/invariant tests), exactly the
 * same discipline `../progression/policy.ts` already establishes.
 */

/**
 * Internal per-exercise working state for the reduction loop — a plain
 * local copy built fresh from the input every call, never the input
 * object itself, so the loop's own mutation (`retainedWorkingCount`/
 * `removed`) can never touch `AvailableTimeInputV1` (locked §17 "input
 * object remains unchanged").
 *
 * Suffix reduction (locked §4 — "remove the LAST retained WORKING set
 * first... never remove working set 2 while keeping working set 3") means
 * "which working sets are currently retained" is always exactly the first
 * `retainedWorkingCount` entries of `workingSetsOrdered` — a plain
 * counter is sufficient; no per-set retained/removed flag is needed.
 */
interface ExerciseReductionState {
  readonly exerciseKey: string;
  readonly orderIndex: number;
  readonly priorityTier: AvailableTimeExerciseV1["priorityTier"];
  readonly minimumWorkingSets: number;
  readonly warmUpSetsOrdered: readonly AvailableTimeSetV1[];
  readonly workingSetsOrdered: readonly AvailableTimeSetV1[];
  retainedWorkingCount: number;
  removed: boolean;
}

function buildReductionStates(exercises: readonly AvailableTimeExerciseV1[]): ExerciseReductionState[] {
  return exercises.map((exercise) => {
    const warmUpSetsOrdered = exercise.sets.filter((set) => set.setType === "WARM_UP").sort((a, b) => a.orderIndex - b.orderIndex);
    const workingSetsOrdered = exercise.sets.filter((set) => set.setType === "WORKING").sort((a, b) => a.orderIndex - b.orderIndex);
    return {
      exerciseKey: exercise.exerciseKey,
      orderIndex: exercise.orderIndex,
      priorityTier: exercise.priorityTier,
      minimumWorkingSets: exercise.minimumWorkingSets,
      warmUpSetsOrdered,
      workingSetsOrdered,
      retainedWorkingCount: workingSetsOrdered.length,
      removed: false,
    };
  });
}

/** All currently-retained sets (WARM_UP + retained-prefix WORKING) for one exercise, in original relative order — `[]` for a fully removed exercise (locked §6: warm-ups go with it). */
function retainedSetsFor(state: ExerciseReductionState): readonly AvailableTimeSetV1[] {
  if (state.removed) return [];
  const retainedWorking = state.workingSetsOrdered.slice(0, state.retainedWorkingCount);
  return [...state.warmUpSetsOrdered, ...retainedWorking].sort((a, b) => a.orderIndex - b.orderIndex);
}

function totalSessionDurationSeconds(states: readonly ExerciseReductionState[]): number {
  return states.reduce((sum, state) => sum + estimateExerciseDurationSeconds(retainedSetsFor(state)), 0);
}

/**
 * Locked §4's exact deterministic pick: TIER_3 before TIER_2 before
 * TIER_1; within one tier, the LATER exercise (by `orderIndex`) before an
 * earlier one. `null` means every exercise is already at (or below,
 * structurally impossible) its own `minimumWorkingSets` — the structural
 * minimum (locked §10) has been reached.
 */
function findNextReducibleExercise(states: readonly ExerciseReductionState[]): ExerciseReductionState | null {
  for (const tier of TIER_REMOVAL_ORDER_V1) {
    const candidates = states.filter((state) => !state.removed && state.priorityTier === tier && state.retainedWorkingCount > state.minimumWorkingSets);
    if (candidates.length === 0) continue;
    return candidates.reduce((latest, candidate) => (candidate.orderIndex > latest.orderIndex ? candidate : latest));
  }
  return null;
}

function toRetainedExerciseSummaries(states: readonly ExerciseReductionState[]): readonly AvailableTimeRetainedExerciseV1[] {
  return states
    .filter((state) => !state.removed)
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((state) => ({ exerciseKey: state.exerciseKey, retainedSetKeys: retainedSetsFor(state).map((set) => set.setKey) }));
}

/**
 * Locked §5/§10's single-pass algorithm: estimate, and if the full
 * session already fits, stop at `NO_CHANGE` immediately. Otherwise remove
 * exactly one policy-ordered working set at a time, re-estimating after
 * each removal, stopping the instant the budget is met (`ADJUST_SESSION`).
 * If no further reduction is possible before the budget is met, the
 * session is already at its structural minimum (every exercise is
 * removed or at its own `minimumWorkingSets`) and still does not fit —
 * `CANNOT_FIT_MINIMUM` (locked §10), using that same duration as
 * `minimumEstimatedDurationSeconds` (this loop never computes the
 * structural minimum a second time via a separate pass — reaching "no
 * further reduction possible" IS, by construction, that same state).
 */
function decideCore(input: AvailableTimeInputV1): AvailableTimeDecisionDataV1 {
  const states = buildReductionStates(input.exercises);
  const originalEstimatedDurationSeconds = totalSessionDurationSeconds(states);

  if (originalEstimatedDurationSeconds <= input.availableTimeSeconds) {
    return {
      resultKind: "NO_CHANGE",
      reasonCode: "FITS_WITHOUT_CHANGE",
      availableTimeSeconds: input.availableTimeSeconds,
      estimatedDurationSeconds: originalEstimatedDurationSeconds,
    };
  }

  const removedWorkingSets: AvailableTimeRemovedWorkingSetV1[] = [];
  const fullyRemovedExercises: AvailableTimeFullyRemovedExerciseV1[] = [];
  let currentDurationSeconds = originalEstimatedDurationSeconds;

  while (currentDurationSeconds > input.availableTimeSeconds) {
    const target = findNextReducibleExercise(states);
    if (target === null) {
      return {
        resultKind: "CANNOT_FIT_MINIMUM",
        reasonCode: "MINIMUM_SESSION_EXCEEDS_AVAILABLE_TIME",
        availableTimeSeconds: input.availableTimeSeconds,
        originalEstimatedDurationSeconds,
        minimumEstimatedDurationSeconds: currentDurationSeconds,
        minimumRetainedExercises: toRetainedExerciseSummaries(states),
      };
    }

    // Suffix reduction (locked §4): the last retained WORKING set only.
    const removedSet = target.workingSetsOrdered[target.retainedWorkingCount - 1]!;
    target.retainedWorkingCount -= 1;
    removedWorkingSets.push({ exerciseKey: target.exerciseKey, setKey: removedSet.setKey });

    // Whole-exercise removal (locked §6): only ever reachable when
    // `minimumWorkingSets === 0` (otherwise `findNextReducibleExercise`
    // would never have selected an exercise already at its minimum).
    if (target.retainedWorkingCount === 0 && target.minimumWorkingSets === 0) {
      target.removed = true;
      fullyRemovedExercises.push({ exerciseKey: target.exerciseKey });
    }

    currentDurationSeconds = totalSessionDurationSeconds(states);
  }

  return {
    resultKind: "ADJUST_SESSION",
    reasonCode: "REDUCED_TO_FIT_AVAILABLE_TIME",
    availableTimeSeconds: input.availableTimeSeconds,
    originalEstimatedDurationSeconds,
    adjustedEstimatedDurationSeconds: currentDurationSeconds,
    retainedExercises: toRetainedExerciseSummaries(states),
    removedWorkingSets,
    fullyRemovedExercises,
  };
}

const REASON_DESCRIPTIONS_V1: Readonly<Record<AvailableTimeDecisionDataV1["reasonCode"], string>> = {
  FITS_WITHOUT_CHANGE: "The full authored session already fits the available time.",
  REDUCED_TO_FIT_AVAILABLE_TIME: "One or more policy-ordered working sets were removed to fit the available time.",
  MINIMUM_SESSION_EXCEEDS_AVAILABLE_TIME: "Even the structural minimum session exceeds the available time.",
};

/**
 * The reused `EnginePolicy` contract exactly (same shape the Progression
 * Engine already establishes) — not a new abstraction. `decide()` assumes
 * structurally valid input; callers that cannot guarantee that should
 * call `evaluateAvailableTime()` instead, which validates first.
 */
export const availableTimePolicyV1: EnginePolicy<AvailableTimeInputV1, "available-time", AvailableTimeDecisionDataV1> = {
  version: { engine: "available-time", policy: "v1" },
  decide(input) {
    const data = decideCore(input);
    return {
      kind: "available-time",
      version: availableTimePolicyV1.version,
      data,
      reason: REASON_DESCRIPTIONS_V1[data.reasonCode],
    };
  },
};

/**
 * The recommended public entry point — validates the input explicitly
 * (locked §17) and only ever calls into `availableTimePolicyV1.decide()`
 * once that succeeds, so a caller gets a clear, typed distinction between
 * "structurally invalid input" (`err`) and "a real decision" (`ok`) —
 * never silently converted into `CANNOT_FIT_MINIMUM` or any other result
 * (§11's own explicit warning).
 */
export function evaluateAvailableTime(
  input: AvailableTimeInputV1,
): Result<EngineDecision<"available-time", AvailableTimeDecisionDataV1>, AvailableTimeInputValidationErrorV1> {
  const validation = validateAvailableTimeInput(input);
  if (!validation.ok) return err(validation.error);
  return ok(availableTimePolicyV1.decide(validation.value));
}
