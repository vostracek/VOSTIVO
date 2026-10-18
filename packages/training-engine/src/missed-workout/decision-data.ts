import type { LocalDate } from "./input.js";
import type { MissedWorkoutReviewReasonV1 } from "./vocabulary.js";

export type MissedWorkoutDecisionDataV1 =
  | {
      readonly resultKind: "NO_CHANGE";
      readonly reasonCode: "NO_MISSED_WORKOUT";
    }
  | {
      readonly resultKind: "ROLL_FORWARD";
      readonly reasonCode: "SINGLE_MISSED_WORKOUT";
      readonly missedWorkoutId: string;
      /** Always === `missedWorkoutId`: the missed session becomes the next session. */
      readonly recommendedNextWorkoutId: string;
      /** What would have been next had the miss been ignored — displaced, never deleted. */
      readonly originalNextWorkoutId: string | null;
      /** The missed workout followed by every later unresolved workout, in exact authored order. */
      readonly sequence: readonly string[];
      /** The first explicit caller-supplied slot on/after `athleteLocalDate` — never invented. */
      readonly nextTrainingSlot: LocalDate;
    }
  | {
      readonly resultKind: "REVIEW_REQUIRED";
      readonly reasonCode: MissedWorkoutReviewReasonV1;
      /** Every missed occurrence, ordered by (scheduledLocalDate, plannedWorkoutId) so the order is deterministic even when the authored sequence is ambiguous. */
      readonly missedWorkoutIds: readonly string[];
      /** Only for LATER_SESSION_ALREADY_PERFORMED: later occurrences that already have a canonical session, in authored order. */
      readonly performedLaterWorkoutIds: readonly string[];
    };
