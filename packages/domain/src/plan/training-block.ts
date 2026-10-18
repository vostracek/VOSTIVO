import type { EntityId } from "../entity-id.js";
import type { ProgramVersionId } from "./program-version.js";

export type TrainingBlockId = EntityId<"TrainingBlock">;

/**
 * A labeled priority for the Weekly Focus UI (spec section 31) — a plain
 * intent label, never a computed muscle-volume/science value the system
 * does not yet calculate. `name` is free text (e.g. "Chest", "Back") since
 * this slice does not implement Exercise Taxonomy/muscle-group modeling
 * (spec section 10); `emphasis` is the only structured part.
 */
export const TRAINING_FOCUS_EMPHASES = ["PRIORITY", "MAINTAIN"] as const;
export type TrainingFocusEmphasis = (typeof TRAINING_FOCUS_EMPHASES)[number];

export interface TrainingFocusAreaV1 {
  readonly name: string;
  readonly emphasis: TrainingFocusEmphasis;
}

/**
 * The current mesocycle/block (spec section 6). Deliberately no
 * periodization configuration (progression scheme, deload cadence, etc.)
 * — that belongs to the future Progression/Adaptation Engine, not this
 * slice. `goal` is a plain descriptive snapshot ("Hypertrophy — Upper/
 * Lower"), not a structured goal-taxonomy value.
 */
export interface TrainingBlock {
  readonly id: TrainingBlockId;
  readonly programVersionId: ProgramVersionId;
  readonly name: string;
  readonly goal: string;
  readonly order: number;
  readonly cycleCount: number;
  readonly focusAreas: readonly TrainingFocusAreaV1[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
