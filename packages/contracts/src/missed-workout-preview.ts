/**
 * Missed Workout / Schedule Adaptation V1 — Slice B: the READ-ONLY server
 * preview (`POST /api/v1/plan/missed-workout-preview`,
 * docs/domain/MISSED-WORKOUT-ADAPTATION-V1.md §9). A recommendation only:
 * requesting it never changes the Plan, Today, sessions or any schedule.
 * No UI prose — stable codes and structured data only.
 */
export type MissedWorkoutPreviewReviewReasonV1 =
  | "HARD_TIMELINE_CONSTRAINT"
  | "MULTIPLE_MISSED_WORKOUTS"
  | "SOURCE_CONTEXT_NOT_APPLICABLE"
  | "AMBIGUOUS_SEQUENCE"
  | "LATER_SESSION_ALREADY_PERFORMED"
  | "NO_KNOWN_TRAINING_SLOT";

interface MissedWorkoutPreviewCommonV1 {
  readonly policyVersion: "missed-workout/v1";
  /** The athlete's calendar day in `trainingTimeZone`, as the server resolved it. */
  readonly athleteLocalDate: string;
  readonly trainingTimeZone: string;
  /** Deterministic stale-input guard for a later application step — never an auth token. */
  readonly previewFingerprint: string;
}

export interface MissedWorkoutPreviewWorkoutV1 {
  readonly plannedWorkoutId: string;
  readonly displayName: string;
  /** The effective date this workout was due on (authored unless an earlier roll-forward moved it). */
  readonly scheduledLocalDate: string | null;
}

export interface MissedWorkoutPreviewSequenceItemV1 {
  readonly plannedWorkoutId: string;
  readonly displayName: string;
  /** The authored date — never changed by any adaptation. */
  readonly authoredScheduledLocalDate: string | null;
  /** Slice C (additive): the date currently in effect (differs from authored once an earlier roll-forward is active; `null` = carryover). */
  readonly effectiveScheduledLocalDate: string | null;
  /** Slice C (additive): the effective date applying THIS preview would set — the i-th known training slot, or `null` (carryover, never an invented date). */
  readonly proposedScheduledLocalDate: string | null;
}

export type MissedWorkoutPreviewResponseV1 = MissedWorkoutPreviewCommonV1 &
  (
    | { readonly result: "NO_CHANGE"; readonly reasonCode: "NO_MISSED_WORKOUT" }
    | {
        readonly result: "ROLL_FORWARD";
        readonly reasonCode: "SINGLE_MISSED_WORKOUT";
        readonly missedWorkout: MissedWorkoutPreviewWorkoutV1;
        /** Always the missed workout: the missed session becomes the next session. */
        readonly recommendedNextWorkout: { readonly plannedWorkoutId: string; readonly displayName: string };
        /** What would otherwise have been next — displaced, never deleted. */
        readonly originalNextWorkout: MissedWorkoutPreviewWorkoutV1 | null;
        /** The next authored training slot (a planned training date), never an invented one. */
        readonly nextTrainingSlot: string;
        readonly upcomingSequence: readonly MissedWorkoutPreviewSequenceItemV1[];
      }
    | {
        readonly result: "REVIEW_REQUIRED";
        readonly reasonCode: MissedWorkoutPreviewReviewReasonV1;
        readonly missedWorkoutIds: readonly string[];
        readonly performedLaterWorkoutIds: readonly string[];
      }
  );

/**
 * Missed Workout V1 — Slice C: durable application of ONE previewed
 * ROLL_FORWARD (`POST /api/v1/plan/missed-workout-apply`). The client sends
 * only the fingerprint of the exact preview the athlete approved; the
 * server re-derives everything else and applies only if the current preview
 * still has that fingerprint (otherwise 409 MISSED_WORKOUT_PREVIEW_STALE).
 */
export interface MissedWorkoutApplyRequestV1 {
  readonly previewFingerprint: string;
}

export interface MissedWorkoutEffectiveAssignmentV1 {
  readonly plannedWorkoutId: string;
  readonly authoredScheduledLocalDate: string | null;
  /** `null` = carryover: still in sequence, no known training slot (not skipped). */
  readonly effectiveScheduledLocalDate: string | null;
}

export interface MissedWorkoutApplyResponseV1 {
  readonly application: {
    readonly policyVersion: "missed-workout/v1";
    readonly previewFingerprint: string;
    /** SUPERSEDED only on an idempotent retry after a later application replaced it. */
    readonly status: "ACTIVE" | "SUPERSEDED";
    /** ISO-8601 instant. */
    readonly appliedAt: string;
  };
  readonly result: "ROLL_FORWARD";
  readonly missedWorkout: MissedWorkoutPreviewWorkoutV1;
  /** This application's roll-forward sequence, in sequence order. */
  readonly effectiveAssignments: readonly MissedWorkoutEffectiveAssignmentV1[];
  readonly carryoverWorkoutIds: readonly string[];
}

/** 409 body when the current re-derived preview (same fingerprint) is not a ROLL_FORWARD. */
export interface MissedWorkoutNotApplicableErrorV1 {
  readonly statusCode: 409;
  readonly message: "MISSED_WORKOUT_NOT_APPLICABLE";
  readonly reasonCode: "NO_MISSED_WORKOUT" | MissedWorkoutPreviewReviewReasonV1;
}
