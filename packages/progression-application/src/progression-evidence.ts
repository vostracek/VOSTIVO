import type { ExternalWeightLoad, RepTargetV1, WorkoutPrescriptionV1 } from "@vostivo/domain";
import type { ComparabilityTierV1 } from "@vostivo/training-engine";

/**
 * Progression EngineDecision Persistence & Evidence Integration V1 — pure
 * evidence-assembly helpers. No DB access here (that lives in
 * `progression-evaluation.service.ts`); these functions take
 * already-fetched plain data so comparability classification and
 * prescription-context reconstruction are independently unit-testable
 * without a real Postgres connection (matching
 * `packages/domain/src/plan/prescription-builder.ts`'s existing
 * pure/fetch split).
 */

export interface ReconstructedPrescriptionContext {
  readonly targetReps: RepTargetV1;
  readonly targetLoad: ExternalWeightLoad;
  readonly prescribedWorkingSetIds: readonly string[];
}

function repTargetsEqual(a: RepTargetV1, b: RepTargetV1): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "EXACT" && b.kind === "EXACT") return a.reps === b.reps;
  if (a.kind === "RANGE" && b.kind === "RANGE") return a.minReps === b.minReps && a.maxReps === b.maxReps;
  return false;
}

function loadsEqual(a: ExternalWeightLoad, b: ExternalWeightLoad): boolean {
  return a.kind === b.kind && a.unit === b.unit && a.basis === b.basis && a.amountMilli === b.amountMilli;
}

/**
 * Reconstructs the exact immutable prescription context that governed one
 * performed exercise (§7 — never today's live Plan). Returns `null` when a
 * valid, unambiguous context cannot be reconstructed: no matching
 * `prescriptionExerciseId` in the snapshot (an unplanned/extra exercise,
 * §10), no `WORKING` sets prescribed for it, a missing `targetLoad`/
 * `targetReps` (the pure engine's `ProgressionPrescriptionContextV1`
 * requires both, non-null), or — the one genuinely ambiguous real-world
 * case — the prescribed `WORKING` sets do not all share the same
 * `targetReps`/`targetLoad` (heterogeneous per-set targets are technically
 * representable in `PrescribedSetV1` but every real prescription this
 * project authors uses one uniform target per exercise slot; rather than
 * invent a rule for the untested heterogeneous case, this returns `null`
 * — "cannot deterministically reconstruct," never a fabricated average or
 * a silently chosen first value).
 *
 * `null` for the anchor exposure means the whole evaluation cannot
 * proceed (`NO_PRESCRIPTION_CONTEXT`); `null` for a historical candidate
 * simply excludes that one exposure from evidence (`NOT_COMPARABLE`) —
 * both callers are in `progression-evaluation.service.ts`.
 */
export function reconstructPrescriptionContext(
  snapshot: WorkoutPrescriptionV1,
  prescriptionExerciseId: string | null,
): ReconstructedPrescriptionContext | null {
  if (prescriptionExerciseId === null) return null;

  const exercise = snapshot.exercises.find((e) => e.prescriptionExerciseId === prescriptionExerciseId);
  if (exercise === undefined) return null;

  const workingSets = exercise.sets.filter((s) => s.setType === "WORKING");
  if (workingSets.length === 0) return null;

  const [first, ...rest] = workingSets;
  if (first === undefined) return null;
  if (first.targetReps === null || first.targetLoad === null) return null;

  const targetReps = first.targetReps;
  const targetLoad = first.targetLoad;
  const uniform = rest.every(
    (set) => set.targetReps !== null && set.targetLoad !== null && repTargetsEqual(set.targetReps, targetReps) && loadsEqual(set.targetLoad, targetLoad),
  );
  if (!uniform) return null;

  return {
    targetReps,
    targetLoad,
    prescribedWorkingSetIds: workingSets.map((s) => s.prescriptionSetId),
  };
}

export interface HistoricalExposureCandidate {
  readonly exerciseOrder: number;
  readonly context: ReconstructedPrescriptionContext;
  /** `true` if any performed set in this exposure has no match in `context.prescribedWorkingSetIds` (an unplanned/extra set, §10.1). */
  readonly hasUnmatchedWorkingSet: boolean;
}

/**
 * Classifies one historical candidate exposure against the anchor's own
 * context, using exactly §10.1/§10.2's deterministic factors — never a
 * numeric confidence, never a fuzzy match, never an equipment/gym-change
 * signal (none exists in V1; not silently treated as always-matching, it
 * is simply not a factor here, matching §10.2's documented gap). A
 * different `targetReps`/`targetLoad` is `NOT_COMPARABLE` (§12.11 —
 * prescription changed); a changed exercise order, a different prescribed
 * working-set count, or an unmatched/extra set downgrades to
 * `COMPARABLE_WITH_CONTEXT` without excluding the exposure.
 */
export function classifyComparability(
  anchor: { readonly exerciseOrder: number; readonly context: ReconstructedPrescriptionContext },
  candidate: HistoricalExposureCandidate,
): ComparabilityTierV1 | "NOT_COMPARABLE" {
  const sameTarget =
    repTargetsEqual(anchor.context.targetReps, candidate.context.targetReps) &&
    loadsEqual(anchor.context.targetLoad, candidate.context.targetLoad);
  if (!sameTarget) return "NOT_COMPARABLE";

  const sameWorkingSetCount = anchor.context.prescribedWorkingSetIds.length === candidate.context.prescribedWorkingSetIds.length;
  const sameExerciseOrder = anchor.exerciseOrder === candidate.exerciseOrder;

  if (!sameWorkingSetCount || !sameExerciseOrder || candidate.hasUnmatchedWorkingSet) {
    return "COMPARABLE_WITH_CONTEXT";
  }
  return "COMPARABLE";
}
