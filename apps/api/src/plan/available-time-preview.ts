import { createHash } from "node:crypto";
import { err, ok, type Result } from "@vostivo/domain";
import type {
  AvailableTimePreviewExerciseV1,
  AvailableTimePreviewResponseV1,
  AvailableTimePriorityTierV1,
} from "@vostivo/contracts";
import { canonicalStringify } from "@vostivo/progression-application";
import {
  PRIORITY_TIERS_V1,
  evaluateAvailableTime,
  type AvailableTimeDecisionDataV1,
  type AvailableTimeExerciseV1,
  type AvailableTimeInputValidationErrorV1,
  type AvailableTimeInputV1,
  type AvailableTimeRetainedExerciseV1,
} from "@vostivo/training-engine";

/**
 * Available-Time Adaptation V1 — Slice B: the pure part of the server
 * preview. Canonical authored rows in, preview contract out. The reduction
 * policy itself lives only in `@vostivo/training-engine`
 * (`evaluateAvailableTime`); this module only normalizes, calls it, and
 * reshapes its decision. No DB, no clock, no randomness.
 */

/** `${engine}/${policy}` of `availableTimePolicyV1.version` — a test locks the two together. */
export const AVAILABLE_TIME_POLICY_VERSION = "available-time/v1" as const;

/** Bumped only if the fingerprint's own input shape changes — independent of the engine policy version. */
const PREVIEW_FINGERPRINT_SCHEMA = "available-time-preview-v1";

export interface AvailableTimeSetRow {
  readonly id: string;
  readonly orderIndex: number;
  readonly setType: "WORKING" | "WARM_UP";
  /** Authored rest AFTER this set; `null` means "not authored", never "no rest". */
  readonly restSeconds: number | null;
}

export interface AvailableTimeExerciseRow {
  readonly id: string;
  readonly exerciseRef: string | null;
  readonly displayName: string;
  readonly orderIndex: number;
  readonly priorityTier: string | null;
  readonly minimumWorkingSets: number | null;
  readonly sets: readonly AvailableTimeSetRow[];
}

export interface AvailableTimePreviewSource {
  readonly plannedWorkoutId: string;
  /** The ProgramVersion the planned workout belongs to — part of the stale-preview fingerprint. */
  readonly programVersionId: string;
  readonly availableMinutes: number;
  readonly exercises: readonly AvailableTimeExerciseRow[];
}

/**
 * Why a planned workout cannot be previewed. Every case fails closed —
 * an unauthored or broken structure is never silently turned into
 * `NO_CHANGE` or repaired.
 */
export type AvailableTimePreviewError =
  | { readonly code: "AVAILABLE_TIME_PRIORITY_TIER_MISSING"; readonly plannedExerciseId: string }
  | { readonly code: "AVAILABLE_TIME_MINIMUM_WORKING_SETS_MISSING"; readonly plannedExerciseId: string }
  | { readonly code: "AVAILABLE_TIME_REST_SECONDS_MISSING"; readonly plannedSetId: string }
  | { readonly code: "AVAILABLE_TIME_STRUCTURE_INVALID"; readonly reason: AvailableTimeInputValidationErrorV1["reason"] };

function isPriorityTier(value: string): value is AvailableTimePriorityTierV1 {
  return (PRIORITY_TIERS_V1 as readonly string[]).includes(value);
}

function byOrder<T extends { readonly orderIndex: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.orderIndex - b.orderIndex);
}

/**
 * Canonical rows -> `AvailableTimeInputV1`. Authoring invariants checked
 * here are the ones the engine cannot see (a NULL column); everything the
 * engine validates itself (minimum vs working-set count, at least one
 * positive minimum, duplicate order, ...) is left to
 * `validateAvailableTimeInput` so the rule has exactly one home.
 *
 * Rest: the engine counts a set's rest only when another retained set of
 * the same exercise follows it. The authored LAST set of an exercise is
 * never followed by anything, so its rest is never read; a NULL there is
 * normalized to 0 (a provably unused value, not a guess). Every other
 * set's rest IS needed by some reduction outcome, so a NULL there fails
 * closed.
 */
export function normalizeAvailableTimeInput(
  exercises: readonly AvailableTimeExerciseRow[],
  availableTimeSeconds: number,
): Result<AvailableTimeInputV1, AvailableTimePreviewError> {
  const normalized: AvailableTimeExerciseV1[] = [];

  for (const exercise of byOrder(exercises)) {
    if (exercise.priorityTier === null || !isPriorityTier(exercise.priorityTier)) {
      return err({ code: "AVAILABLE_TIME_PRIORITY_TIER_MISSING", plannedExerciseId: exercise.id });
    }
    if (exercise.minimumWorkingSets === null) {
      return err({ code: "AVAILABLE_TIME_MINIMUM_WORKING_SETS_MISSING", plannedExerciseId: exercise.id });
    }

    const sets = byOrder(exercise.sets);
    const normalizedSets = [];
    for (const [index, set] of sets.entries()) {
      const isLastAuthoredSet = index === sets.length - 1;
      if (set.restSeconds === null && !isLastAuthoredSet) {
        return err({ code: "AVAILABLE_TIME_REST_SECONDS_MISSING", plannedSetId: set.id });
      }
      normalizedSets.push({
        setKey: set.id,
        orderIndex: set.orderIndex,
        setType: set.setType,
        restSeconds: set.restSeconds ?? 0,
      });
    }

    normalized.push({
      exerciseKey: exercise.id,
      orderIndex: exercise.orderIndex,
      priorityTier: exercise.priorityTier,
      minimumWorkingSets: exercise.minimumWorkingSets,
      sets: normalizedSets,
    });
  }

  return ok({ availableTimeSeconds, exercises: normalized });
}

/**
 * Deterministic stale-input guard (Slice B §9): the same authored
 * structure + budget always gives the same value; any change to the
 * ProgramVersion identity, an exercise/set id, order, set type, authored
 * rest, tier, minimum, or the budget changes it. Uses AUTHORED values
 * (a NULL final-set rest stays NULL here). Not an auth token.
 */
export function computeAvailableTimePreviewFingerprint(source: AvailableTimePreviewSource): string {
  const canonical = canonicalStringify({
    fingerprintSchema: PREVIEW_FINGERPRINT_SCHEMA,
    policyVersion: AVAILABLE_TIME_POLICY_VERSION,
    plannedWorkoutId: source.plannedWorkoutId,
    programVersionId: source.programVersionId,
    availableMinutes: source.availableMinutes,
    exercises: byOrder(source.exercises).map((exercise) => ({
      plannedExerciseId: exercise.id,
      orderIndex: exercise.orderIndex,
      priorityTier: exercise.priorityTier,
      minimumWorkingSets: exercise.minimumWorkingSets,
      sets: byOrder(exercise.sets).map((set) => ({
        plannedSetId: set.id,
        orderIndex: set.orderIndex,
        setType: set.setType,
        restSeconds: set.restSeconds,
      })),
    })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function retainedSetIdsByExercise(decision: AvailableTimeDecisionDataV1, exercises: readonly AvailableTimeExerciseRow[]): Map<string, ReadonlySet<string>> {
  if (decision.resultKind === "NO_CHANGE") {
    return new Map(exercises.map((exercise) => [exercise.id, new Set(exercise.sets.map((set) => set.id))]));
  }
  const retained: readonly AvailableTimeRetainedExerciseV1[] =
    decision.resultKind === "ADJUST_SESSION" ? decision.retainedExercises : decision.minimumRetainedExercises;
  return new Map(retained.map((entry) => [entry.exerciseKey, new Set(entry.retainedSetKeys)]));
}

function toPreviewExercise(exercise: AvailableTimeExerciseRow, retainedSetIds: ReadonlySet<string> | undefined): AvailableTimePreviewExerciseV1 {
  const orderedSets = byOrder(exercise.sets);
  const workingSets = orderedSets.filter((set) => set.setType === "WORKING");
  const retained = retainedSetIds ?? new Set<string>();
  // Slice C: the exact diff is derived from the SAME retained set the counts
  // below use, over all authored sets in canonical order — so the ids and
  // counts can never disagree, and together they partition the exercise.
  const retainedPlannedSetIds = orderedSets.filter((set) => retained.has(set.id)).map((set) => set.id);
  const removedPlannedSetIds = orderedSets.filter((set) => !retained.has(set.id)).map((set) => set.id);
  const retainedWorkingSetCount = workingSets.filter((set) => retained.has(set.id)).length;
  return {
    plannedExerciseId: exercise.id,
    exerciseRef: exercise.exerciseRef,
    displayName: exercise.displayName,
    // Already validated by normalizeAvailableTimeInput before this runs.
    priorityTier: exercise.priorityTier as AvailableTimePriorityTierV1,
    originalWorkingSetCount: workingSets.length,
    retainedWorkingSetCount,
    removedWorkingSetCount: workingSets.length - retainedWorkingSetCount,
    originalTotalSetCount: orderedSets.length,
    retainedTotalSetCount: retainedPlannedSetIds.length,
    minimumWorkingSets: exercise.minimumWorkingSets as number,
    removedEntireExercise: retainedPlannedSetIds.length === 0,
    retainedPlannedSetIds,
    removedPlannedSetIds,
  };
}

/**
 * The whole Slice B preview: normalize -> `evaluateAvailableTime` (the only
 * implementation of the policy) -> contract. `availableMinutes` must
 * already be validated (integer 1..240) by the API boundary.
 */
export function computeAvailableTimePreview(
  source: AvailableTimePreviewSource,
): Result<AvailableTimePreviewResponseV1, AvailableTimePreviewError> {
  const availableTimeSeconds = source.availableMinutes * 60;
  const normalized = normalizeAvailableTimeInput(source.exercises, availableTimeSeconds);
  if (!normalized.ok) return normalized;

  const evaluated = evaluateAvailableTime(normalized.value);
  if (!evaluated.ok) return err({ code: "AVAILABLE_TIME_STRUCTURE_INVALID", reason: evaluated.error.reason });
  const decision = evaluated.value.data;

  const retainedByExercise = retainedSetIdsByExercise(decision, source.exercises);
  const exercises = byOrder(source.exercises).map((exercise) => toPreviewExercise(exercise, retainedByExercise.get(exercise.id)));

  const originalEstimatedSeconds = decision.resultKind === "NO_CHANGE" ? decision.estimatedDurationSeconds : decision.originalEstimatedDurationSeconds;
  const adjustedEstimatedSeconds =
    decision.resultKind === "NO_CHANGE"
      ? decision.estimatedDurationSeconds
      : decision.resultKind === "ADJUST_SESSION"
        ? decision.adjustedEstimatedDurationSeconds
        : decision.minimumEstimatedDurationSeconds;

  return ok({
    policyVersion: AVAILABLE_TIME_POLICY_VERSION,
    plannedWorkoutId: source.plannedWorkoutId,
    sourceProgramVersionId: source.programVersionId,
    availableMinutes: source.availableMinutes,
    result: decision.resultKind,
    fitsAvailableTime: decision.resultKind !== "CANNOT_FIT_MINIMUM",
    originalEstimatedSeconds,
    adjustedEstimatedSeconds,
    minimumEstimatedSeconds: decision.resultKind === "CANNOT_FIT_MINIMUM" ? decision.minimumEstimatedDurationSeconds : null,
    previewFingerprint: computeAvailableTimePreviewFingerprint(source),
    exercises,
  });
}
