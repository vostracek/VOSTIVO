import type { MissedWorkoutApplyResponseV1, MissedWorkoutPreviewResponseV1 } from "@vostivo/contracts";
import type { RollForwardPreview } from "../missed-workout-flow";

/** The locked example on Wednesday 2026-10-07: Upper A (Mon) missed; Wed/Fri/Mon slots; Lower B carryover. */
export const IDS = { upperA: "w-upper-a", lowerA: "w-lower-a", upperB: "w-upper-b", lowerB: "w-lower-b" } as const;

export function rollForwardPreview(fingerprint = "a".repeat(64)): RollForwardPreview {
  return {
    policyVersion: "missed-workout/v1",
    athleteLocalDate: "2026-10-07",
    trainingTimeZone: "Europe/Prague",
    previewFingerprint: fingerprint,
    result: "ROLL_FORWARD",
    reasonCode: "SINGLE_MISSED_WORKOUT",
    missedWorkout: { plannedWorkoutId: IDS.upperA, displayName: "Upper A", scheduledLocalDate: "2026-10-05" },
    recommendedNextWorkout: { plannedWorkoutId: IDS.upperA, displayName: "Upper A" },
    originalNextWorkout: { plannedWorkoutId: IDS.lowerA, displayName: "Lower A", scheduledLocalDate: "2026-10-07" },
    nextTrainingSlot: "2026-10-07",
    upcomingSequence: [
      { plannedWorkoutId: IDS.upperA, displayName: "Upper A", authoredScheduledLocalDate: "2026-10-05", effectiveScheduledLocalDate: "2026-10-05", proposedScheduledLocalDate: "2026-10-07" },
      { plannedWorkoutId: IDS.lowerA, displayName: "Lower A", authoredScheduledLocalDate: "2026-10-07", effectiveScheduledLocalDate: "2026-10-07", proposedScheduledLocalDate: "2026-10-09" },
      { plannedWorkoutId: IDS.upperB, displayName: "Upper B", authoredScheduledLocalDate: "2026-10-09", effectiveScheduledLocalDate: "2026-10-09", proposedScheduledLocalDate: "2026-10-12" },
      { plannedWorkoutId: IDS.lowerB, displayName: "Lower B", authoredScheduledLocalDate: "2026-10-12", effectiveScheduledLocalDate: "2026-10-12", proposedScheduledLocalDate: null },
    ],
  };
}

export const NO_CHANGE: MissedWorkoutPreviewResponseV1 = {
  policyVersion: "missed-workout/v1",
  athleteLocalDate: "2026-10-07",
  trainingTimeZone: "Europe/Prague",
  previewFingerprint: "c".repeat(64),
  result: "NO_CHANGE",
  reasonCode: "NO_MISSED_WORKOUT",
};

export function reviewRequired(reasonCode: Extract<MissedWorkoutPreviewResponseV1, { result: "REVIEW_REQUIRED" }>["reasonCode"]): MissedWorkoutPreviewResponseV1 {
  return { ...NO_CHANGE, previewFingerprint: "d".repeat(64), result: "REVIEW_REQUIRED", reasonCode, missedWorkoutIds: [IDS.upperA, IDS.lowerA], performedLaterWorkoutIds: [] };
}

export function applied(fingerprint = "a".repeat(64)): MissedWorkoutApplyResponseV1 {
  return {
    application: { policyVersion: "missed-workout/v1", previewFingerprint: fingerprint, status: "ACTIVE", appliedAt: "2026-10-07T08:00:00.000Z" },
    result: "ROLL_FORWARD",
    missedWorkout: { plannedWorkoutId: IDS.upperA, displayName: "Upper A", scheduledLocalDate: "2026-10-05" },
    effectiveAssignments: [],
    carryoverWorkoutIds: [IDS.lowerB],
  };
}
