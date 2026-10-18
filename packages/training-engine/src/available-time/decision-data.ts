/** One working set the policy removed, in removal order — the reduction sequence itself (locked §13's "reduction sequence... where useful"). */
export interface AvailableTimeRemovedWorkingSetV1 {
  readonly exerciseKey: string;
  readonly setKey: string;
}

/** A whole exercise removed entirely because its last WORKING set was removed while `minimumWorkingSets === 0` (locked §6). */
export interface AvailableTimeFullyRemovedExerciseV1 {
  readonly exerciseKey: string;
}

/** One retained exercise and exactly which of its sets (WARM_UP + WORKING) survive, in original order — never a raw count, so a future explanation layer can point at exact sets. */
export interface AvailableTimeRetainedExerciseV1 {
  readonly exerciseKey: string;
  readonly retainedSetKeys: readonly string[];
}

/**
 * Available-Time Adaptation V1 (locked §11/§13/§14/§15) — the *entire*
 * engine output. Identity/audit fields (a persisted decision id, athlete
 * ownership, timestamps, ...) belong to a future persistence layer
 * (Slice B), never here — same discipline as
 * `ProgressionDecisionDataV1`'s own doc comment.
 */
export type AvailableTimeDecisionDataV1 =
  | {
      readonly resultKind: "NO_CHANGE";
      readonly reasonCode: "FITS_WITHOUT_CHANGE";
      readonly availableTimeSeconds: number;
      readonly estimatedDurationSeconds: number;
    }
  | {
      readonly resultKind: "ADJUST_SESSION";
      readonly reasonCode: "REDUCED_TO_FIT_AVAILABLE_TIME";
      readonly availableTimeSeconds: number;
      readonly originalEstimatedDurationSeconds: number;
      readonly adjustedEstimatedDurationSeconds: number;
      readonly retainedExercises: readonly AvailableTimeRetainedExerciseV1[];
      readonly removedWorkingSets: readonly AvailableTimeRemovedWorkingSetV1[];
      readonly fullyRemovedExercises: readonly AvailableTimeFullyRemovedExerciseV1[];
    }
  | {
      readonly resultKind: "CANNOT_FIT_MINIMUM";
      readonly reasonCode: "MINIMUM_SESSION_EXCEEDS_AVAILABLE_TIME";
      readonly availableTimeSeconds: number;
      readonly originalEstimatedDurationSeconds: number;
      readonly minimumEstimatedDurationSeconds: number;
      readonly minimumRetainedExercises: readonly AvailableTimeRetainedExerciseV1[];
    };
