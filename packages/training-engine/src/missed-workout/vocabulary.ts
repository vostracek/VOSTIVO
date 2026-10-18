/**
 * Missed Workout / Schedule Adaptation V1 — closed vocabularies
 * (docs/domain/MISSED-WORKOUT-ADAPTATION-V1.md). Reason codes are stable
 * business identifiers, never prose.
 */
export const MISSED_WORKOUT_POLICY_VERSION_V1 = "missed-workout/v1" as const;

/** Whether calendar dates are authoritative for this program (e.g. a peaking block with a hard event date). */
export const TIMELINE_CONSTRAINTS_V1 = ["FLEXIBLE", "HARD_DEADLINE"] as const;
export type TimelineConstraintV1 = (typeof TIMELINE_CONSTRAINTS_V1)[number];

export const MISSED_WORKOUT_RESULT_KINDS_V1 = ["NO_CHANGE", "ROLL_FORWARD", "REVIEW_REQUIRED"] as const;
export type MissedWorkoutResultKindV1 = (typeof MISSED_WORKOUT_RESULT_KINDS_V1)[number];

export const MISSED_WORKOUT_REVIEW_REASONS_V1 = [
  "MULTIPLE_MISSED_WORKOUTS",
  "LATER_SESSION_ALREADY_PERFORMED",
  "AMBIGUOUS_SEQUENCE",
  "HARD_TIMELINE_CONSTRAINT",
  "NO_KNOWN_TRAINING_SLOT",
  "SOURCE_CONTEXT_NOT_APPLICABLE",
] as const;
export type MissedWorkoutReviewReasonV1 = (typeof MISSED_WORKOUT_REVIEW_REASONS_V1)[number];
