import type { ExternalWeightLoad, RepTargetV1 } from "@vostivo/domain";
import type { PreviousSetPerformance } from "./workout-repository";

/**
 * The single shared formatting boundary for rep/load display (spec
 * section 7's "do not add parallel mapping logic in mobile UI," applied
 * here to presentation formatting too) — Workout Preview and Active
 * Workout must show the exact same target semantics, not two independent
 * implementations that could quietly drift apart.
 */
export function formatRepTarget(target: RepTargetV1 | null): string {
  if (target === null) return "—";
  if (target.kind === "EXACT") return `${target.reps} reps`;
  return `${target.minReps}–${target.maxReps} reps`;
}

export function formatLoad(load: ExternalWeightLoad | null): string {
  if (load === null) return "—";
  const amount = load.amountMilli / 1000;
  const basisLabel = load.basis === "PER_IMPLEMENT" ? " each" : "";
  return `${amount}${load.unit.toLowerCase()}${basisLabel}`;
}

/** Compact "Previous" format, e.g. "40kg × 10" — never a full history panel (spec section 36). */
export function formatPreviousSet(set: PreviousSetPerformance | undefined): string {
  if (set === undefined) return "—";
  return `${formatLoad(set.actualLoad)} × ${set.actualReps}`;
}
