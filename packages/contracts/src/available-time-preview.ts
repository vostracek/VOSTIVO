import {
  AVAILABLE_TIME_APPLICATION_POLICY_VERSION_V1,
  AVAILABLE_TIME_APPLICATION_SCOPE_V1,
  err,
  validateAvailableTimeApplication,
  type AvailableTimeApplicationV1,
  type AvailableTimeApplicationValidationReason,
  type Result,
} from "@vostivo/domain";

/**
 * Available-Time Adaptation V1 — Slice B (read-only server preview,
 * `docs/domain/AVAILABLE-TIME-ADAPTATION-V1.md`). A preview is a
 * recommendation only: requesting one never starts a workout, never
 * persists a decision and never changes the Plan.
 */

/** Same three tiers as `PRIORITY_TIERS_V1` in packages/training-engine (locked §2). */
export type AvailableTimePriorityTierV1 = "TIER_1" | "TIER_2" | "TIER_3";

export type AvailableTimePreviewResultV1 = "NO_CHANGE" | "ADJUST_SESSION" | "CANNOT_FIT_MINIMUM";

/** `availableMinutes` is a whole number of minutes, 1..240 (Slice B §7). */
export interface AvailableTimePreviewRequestV1 {
  readonly availableMinutes: number;
}

export interface AvailableTimePreviewExerciseV1 {
  readonly plannedExerciseId: string;
  readonly exerciseRef: string | null;
  readonly displayName: string;
  readonly priorityTier: AvailableTimePriorityTierV1;
  readonly originalWorkingSetCount: number;
  readonly retainedWorkingSetCount: number;
  readonly removedWorkingSetCount: number;
  readonly originalTotalSetCount: number;
  readonly retainedTotalSetCount: number;
  readonly minimumWorkingSets: number;
  readonly removedEntireExercise: boolean;
  /**
   * Slice C — the exact structural diff (server-generated canonical
   * PlannedSet ids, ALL authored sets incl. warm-ups, canonical authored
   * order). Together they partition this exercise's sets: no duplicates,
   * no id in both. NO_CHANGE -> `removedPlannedSetIds = []`; whole-exercise
   * removal -> `retainedPlannedSetIds = []`; CANNOT_FIT_MINIMUM -> the exact
   * structural minimum. The client starts from these ids — it never
   * re-derives the decision from the counts above.
   */
  readonly retainedPlannedSetIds: readonly string[];
  readonly removedPlannedSetIds: readonly string[];
}

/**
 * - `NO_CHANGE`: `adjustedEstimatedSeconds === originalEstimatedSeconds`,
 *   nothing removed.
 * - `ADJUST_SESSION`: exactly the deterministic `available-time/v1`
 *   reduction; `adjustedEstimatedSeconds <= availableMinutes * 60`.
 * - `CANNOT_FIT_MINIMUM`: the exercises show the structural-minimum
 *   session, `adjustedEstimatedSeconds === minimumEstimatedSeconds`, and
 *   that minimum is still longer than the available time
 *   (`fitsAvailableTime === false`) — the budget is never pretended met.
 *
 * `minimumEstimatedSeconds` is non-null only for `CANNOT_FIT_MINIMUM`
 * (it is the only result for which the engine computes it).
 *
 * `previewFingerprint` is a deterministic stale-input guard for a later
 * "use adjusted workout" step — never an authentication or authorization
 * token.
 */
export interface AvailableTimePreviewResponseV1 {
  readonly policyVersion: "available-time/v1";
  readonly plannedWorkoutId: string;
  /** Slice C — the ProgramVersion the previewed planned workout belongs to (also inside the fingerprint). */
  readonly sourceProgramVersionId: string;
  readonly availableMinutes: number;
  readonly result: AvailableTimePreviewResultV1;
  readonly fitsAvailableTime: boolean;
  readonly originalEstimatedSeconds: number;
  readonly adjustedEstimatedSeconds: number;
  readonly minimumEstimatedSeconds: number | null;
  readonly previewFingerprint: string;
  readonly exercises: readonly AvailableTimePreviewExerciseV1[];
}

export type AvailableTimeApplicationFromPreviewError =
  | { readonly reason: "NOT_ADJUST_SESSION"; readonly result: AvailableTimePreviewResultV1 }
  | { readonly reason: "UNSUPPORTED_POLICY_VERSION" }
  | { readonly reason: "COUNTS_DISAGREE_WITH_IDS"; readonly plannedExerciseId: string }
  | { readonly reason: "INVALID_APPLICATION"; readonly detail: AvailableTimeApplicationValidationReason };

/**
 * Slice C — the ONE mapping from a server preview to the immutable
 * `AvailableTimeApplicationV1` an adjusted START carries. Purely a
 * reshaping of the server's own exact ids (the client never re-derives the
 * decision). Only `ADJUST_SESSION` is applicable: `NO_CHANGE` uses the
 * ordinary START, and `CANNOT_FIT_MINIMUM` must never be applied as if the
 * budget were met. Fails closed if the preview is internally inconsistent
 * (counts vs ids) or the resulting application is malformed.
 */
export function availableTimeApplicationFromPreview(
  preview: AvailableTimePreviewResponseV1,
): Result<AvailableTimeApplicationV1, AvailableTimeApplicationFromPreviewError> {
  if (preview.result !== "ADJUST_SESSION") return err({ reason: "NOT_ADJUST_SESSION", result: preview.result });
  if (preview.policyVersion !== AVAILABLE_TIME_APPLICATION_POLICY_VERSION_V1) return err({ reason: "UNSUPPORTED_POLICY_VERSION" });

  for (const exercise of preview.exercises) {
    const consistent =
      exercise.retainedTotalSetCount === exercise.retainedPlannedSetIds.length &&
      exercise.originalTotalSetCount === exercise.retainedPlannedSetIds.length + exercise.removedPlannedSetIds.length &&
      exercise.removedEntireExercise === (exercise.retainedPlannedSetIds.length === 0);
    if (!consistent) return err({ reason: "COUNTS_DISAGREE_WITH_IDS", plannedExerciseId: exercise.plannedExerciseId });
  }

  const validated = validateAvailableTimeApplication({
    schemaVersion: 1,
    scope: AVAILABLE_TIME_APPLICATION_SCOPE_V1,
    policyVersion: preview.policyVersion,
    plannedWorkoutId: preview.plannedWorkoutId,
    sourceProgramVersionId: preview.sourceProgramVersionId,
    availableMinutes: preview.availableMinutes,
    previewFingerprint: preview.previewFingerprint,
    originalEstimatedSeconds: preview.originalEstimatedSeconds,
    adjustedEstimatedSeconds: preview.adjustedEstimatedSeconds,
    exercises: preview.exercises.map((exercise) => ({
      plannedExerciseId: exercise.plannedExerciseId,
      retainedPlannedSetIds: exercise.retainedPlannedSetIds,
      removedPlannedSetIds: exercise.removedPlannedSetIds,
    })),
  });
  return validated.ok ? validated : err({ reason: "INVALID_APPLICATION", detail: validated.error });
}
