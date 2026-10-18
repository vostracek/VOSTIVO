import type { AthleteLocalDate } from "./training-time-zone.js";

/**
 * Schedule Calendar Authority V1 — the ONE classification of where an
 * athlete's local date falls in their ACTIVE ProgramVersion's calendar.
 * Pure: rows + a local date in, a typed state out.
 *
 * CURRENT MEANS DATE-CONTAINING, NOT NEAREST: the current cycle is exactly
 * the one TrainingCycle whose inclusive [startDate, endDate] contains the
 * local date, and the current block is the block that owns it. When no
 * cycle contains it, the state says so (BEFORE_PLAN / GAP / AFTER_PLAN) and
 * only carries a separately named `presentationCycle` for screens that
 * want to show something nearby — never labelled "current". Overlaps that
 * make "current" ambiguous fail closed. Row order never matters.
 */
export interface ScheduleCycleRef {
  readonly trainingBlockId: string;
  readonly blockOrder: number;
  readonly trainingCycleId: string;
  readonly cycleOrder: number;
  readonly startDate: AthleteLocalDate;
  readonly endDate: AthleteLocalDate;
}

export type ScheduleCalendarState =
  /** The version has no scheduled cycles at all. */
  | { readonly kind: "NO_SCHEDULE" }
  /** Today is before the first cycle — not an error; the plan just hasn't started. */
  | { readonly kind: "BEFORE_PLAN"; readonly presentationCycle: ScheduleCycleRef }
  | { readonly kind: "IN_CURRENT_BLOCK"; readonly currentBlockId: string; readonly currentCycle: ScheduleCycleRef }
  /** Between cycles (within or between blocks): no current block/cycle. */
  | { readonly kind: "GAP"; readonly previousCycle: ScheduleCycleRef; readonly nextCycle: ScheduleCycleRef; readonly presentationCycle: ScheduleCycleRef }
  /** After the final cycle — not an error; the honest basis for a later Block Complete flow. */
  | { readonly kind: "AFTER_PLAN"; readonly presentationCycle: ScheduleCycleRef }
  /** A configuration defect: more than one cycle contains today. */
  | { readonly kind: "AMBIGUOUS"; readonly reason: "OVERLAPPING_BLOCKS" | "OVERLAPPING_CYCLES" };

function compareCalendar(a: ScheduleCycleRef, b: ScheduleCycleRef): number {
  return (
    a.startDate.localeCompare(b.startDate) ||
    a.endDate.localeCompare(b.endDate) ||
    a.blockOrder - b.blockOrder ||
    a.cycleOrder - b.cycleOrder ||
    a.trainingCycleId.localeCompare(b.trainingCycleId)
  );
}

export function classifyScheduleCalendar(cycles: readonly ScheduleCycleRef[], localDate: AthleteLocalDate): ScheduleCalendarState {
  if (cycles.length === 0) return { kind: "NO_SCHEDULE" };
  const sorted = [...cycles].sort(compareCalendar);

  const containing = sorted.filter((cycle) => cycle.startDate <= localDate && localDate <= cycle.endDate);
  if (containing.length === 1) {
    const currentCycle = containing[0]!;
    return { kind: "IN_CURRENT_BLOCK", currentBlockId: currentCycle.trainingBlockId, currentCycle };
  }
  if (containing.length > 1) {
    const blocks = new Set(containing.map((cycle) => cycle.trainingBlockId));
    return { kind: "AMBIGUOUS", reason: blocks.size > 1 ? "OVERLAPPING_BLOCKS" : "OVERLAPPING_CYCLES" };
  }

  const next = sorted.find((cycle) => cycle.startDate > localDate);
  const previous = [...sorted].sort((a, b) => a.endDate.localeCompare(b.endDate) || compareCalendar(a, b)).filter((cycle) => cycle.endDate < localDate).at(-1);
  if (previous === undefined && next !== undefined) return { kind: "BEFORE_PLAN", presentationCycle: next };
  if (previous !== undefined && next === undefined) return { kind: "AFTER_PLAN", presentationCycle: previous };
  if (previous !== undefined && next !== undefined) return { kind: "GAP", previousCycle: previous, nextCycle: next, presentationCycle: next };
  throw new Error("unreachable: a non-empty calendar with no containing, previous or next cycle");
}
