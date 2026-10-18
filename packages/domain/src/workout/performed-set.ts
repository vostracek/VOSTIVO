import type { EntityId } from "../entity-id.js";
import type { ExternalWeightLoad } from "../load/load.js";
import type { PerformedExerciseId } from "./performed-exercise.js";
import type { SetType } from "./set-type.js";

export type PerformedSetId = EntityId<"PerformedSet">;

/**
 * `REOPENED` is the undo primitive (spec section 16) — reopening a set
 * never deletes it or its history, it transitions the same row to a new
 * revision with `completedAt: null`.
 */
export const PERFORMED_SET_COMPLETION_STATES = ["COMPLETED", "REOPENED"] as const;
export type PerformedSetCompletionState = (typeof PERFORMED_SET_COMPLETION_STATES)[number];

/**
 * Represents what actually happened — `actualReps`/`actualLoad` must
 * never be overwritten by prescription targets (spec section 11):
 * target 40kg x 10, actual 37.5kg x 8, both remain independently visible
 * via `prescriptionSetId` (historical context) vs these fields (reality).
 *
 * `revision` is the monotonically increasing per-set counter that makes
 * out-of-order command delivery converge correctly (spec section 17) —
 * see `docs/architecture/WORKOUT-DATA-INTEGRITY.md` for the exact
 * algorithm. It is assigned client-side, once, per locally-issued mutation
 * (COMPLETE_SET_V1 = revision N, a following REOPEN_SET_V1 = revision
 * N+1), and is never derived from a timestamp.
 *
 * RIR (reps in reserve) is deliberately NOT included in this slice: an
 * "actual RIR" field would need a validated numeric range/policy decision
 * (e.g. is 0-5 valid? half-points?) that nothing in this slice's scope
 * resolves, and spec section 12 explicitly permits deferring rather than
 * inventing that policy. Add it in a future slice once that decision is
 * actually made.
 */
export interface PerformedSet {
  readonly id: PerformedSetId;
  readonly performedExerciseId: PerformedExerciseId;
  readonly prescriptionSetId: string | null;
  readonly order: number;
  readonly actualReps: number;
  readonly actualLoad: ExternalWeightLoad;
  /**
   * Required, never absent (Progression Prerequisites V1 / tech-lead
   * resolution, docs/domain/PROGRESSION-ENGINE-V1.md §5.2) — every
   * performed set has a definite type. A recompletion (reopen ->
   * recomplete) may correct it, gated by the same `revision` rule as
   * `actualReps`/`actualLoad`; there is no separate "change set type"
   * mechanism.
   */
  readonly setType: SetType;
  readonly completionState: PerformedSetCompletionState;
  readonly completedAt: Date | null;
  readonly revision: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
