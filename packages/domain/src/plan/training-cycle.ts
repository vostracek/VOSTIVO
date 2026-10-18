import type { EntityId } from "../entity-id.js";
import type { TrainingBlockId } from "./training-block.js";

export type TrainingCycleId = EntityId<"TrainingCycle">;

/**
 * The structural unit training is organized into within a `TrainingBlock`
 * (spec section 7). `order` is what "Week 4 / 6" in the UI actually reads
 * off — a 1-based position within the block, not a date computation.
 * `startDate`/`endDate` are real dates (ISO `yyyy-mm-dd`) so the "current
 * cycle" can be derived from the athlete-local date (see
 * `classifyScheduleCalendar` in ../schedule/schedule-calendar.ts),
 * but they are deliberately NOT constrained to a Monday-Sunday week or to
 * any fixed length: the domain must not assume ISO calendar weeks are the
 * only valid structure, even though most V1 fixtures will in practice use
 * 7-day cycles.
 */
export interface TrainingCycle {
  readonly id: TrainingCycleId;
  readonly trainingBlockId: TrainingBlockId;
  readonly order: number;
  readonly startDate: string;
  readonly endDate: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
