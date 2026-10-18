import { and, desc, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { progressionApplications, type Database, type ExpectedEffectiveLoadRow } from "@vostivo/database";

/**
 * Task §21/§22/§45 — the pure "uniform `WORKING`-set load" derivation
 * shared by every caller that needs it: `ensureApplicationForDecision`/
 * `computeRevalidation` (`progression-application.ts`, given rows they
 * already queried) and any Plan/Preview/Workout-Start read path (task
 * §45 — never re-implemented per call site). Returns `null` — never
 * guesses, never averages — when there are no `WORKING` sets, any has no
 * load at all (out of Stage-1 scope), or they are not perfectly uniform
 * (task §22's "fail closed," never stamping one load across structurally
 * incompatible working sets).
 */
export interface WorkingSetLoadRow {
  readonly loadKind: string | null;
  readonly loadAmountMilli: number | null;
  readonly loadUnit: string | null;
  readonly loadBasis: string | null;
}

export function deriveUniformWorkingLoad(workingSets: readonly WorkingSetLoadRow[]): ExpectedEffectiveLoadRow | null {
  const [first] = workingSets;
  if (first === undefined) return null;
  if (first.loadKind !== "EXTERNAL_WEIGHT" || first.loadAmountMilli === null || first.loadUnit === null || first.loadBasis === null) {
    return null;
  }

  const uniform = workingSets.every(
    (s) =>
      s.loadKind === first.loadKind &&
      s.loadAmountMilli === first.loadAmountMilli &&
      s.loadUnit === first.loadUnit &&
      s.loadBasis === first.loadBasis,
  );
  if (!uniform) return null;

  return {
    kind: "EXTERNAL_WEIGHT",
    amountMilli: first.loadAmountMilli,
    unit: first.loadUnit as ExpectedEffectiveLoadRow["unit"],
    basis: first.loadBasis as ExpectedEffectiveLoadRow["basis"],
  };
}

/**
 * Progression Application V1 — Slice C (task §5/§7/§20) — the ONE
 * authoritative, framework-neutral effective-target resolver. Every
 * current repository read path that needs "what load is actually
 * effective for this programmed slot, at this point in program order"
 * must call this function — never re-implement the selection logic
 * inline (task §45).
 *
 * **Historical, not "current APPLIED head" (task §5, a final tech-lead
 * decision)**: an older application may later become `SUPERSEDED` as the
 * *current* overlay for its stream, yet it was still the objectively
 * correct effective prescription for every cycle between its own
 * `effectiveFromCycleOrderIndex` and whatever later application
 * eventually superseded it. Looking only at "the row where
 * `status = 'APPLIED'`" would silently erase that history for any
 * `targetCycleOrderIndex` earlier than the newest application's own
 * boundary — this function instead considers every row that was ever
 * `appliedAt IS NOT NULL` (task §6's "was actually applied" marker,
 * §48's "pending-superseded never counts, applied-superseded always
 * does" distinction), regardless of its *current* `status`.
 */
export interface EffectiveLoadResolutionParams {
  readonly userId: string;
  readonly programVersionId: string;
  readonly trainingBlockId: string;
  readonly workoutOrderIndex: number;
  readonly exerciseOrderIndex: number;
  readonly exerciseRef: string;
  readonly targetCycleOrderIndex: number;
  readonly authoredWorkingLoad: ExpectedEffectiveLoadRow | null;
}

export interface EffectiveLoadResolution {
  /** `null` only when `authoredWorkingLoad` was itself `null` and no eligible historical application exists — never fabricated. */
  readonly load: ExpectedEffectiveLoadRow | null;
  readonly source: "AUTHORED" | "APPLIED_HISTORY";
  /** The historical application this value came from, or `null` for `AUTHORED`. */
  readonly sourceApplicationId: string | null;
}

/**
 * Task §7's exact eligibility/selection rule:
 *
 * - same canonical stream identity (`userId` + the 4-column Program Slot
 *   Identity tuple);
 * - `exerciseRef` matches the canonical slot exactly (task §2.3's
 *   precondition, re-applied here — never trusted from position alone);
 * - the row was actually applied at some point (`appliedAt IS NOT NULL`
 *   — task §6; a `PENDING_REVIEW` row later marked `SUPERSEDED` without
 *   ever applying has `appliedAt = NULL` and is correctly excluded by
 *   this alone, no separate status check needed for that case);
 * - `effectiveFromCycleOrderIndex < targetCycleOrderIndex` — **strictly**
 *   less (task §7/§9 — the source occurrence itself is never affected by
 *   its own application, preventing the corrected-evidence
 *   double-progression case);
 * - `status IN ('APPLIED', 'SUPERSEDED')` (task §7 — `REVOKED` is
 *   deliberately excluded: V1 has no revoke boundary semantics yet, task
 *   §13, so a hypothetical future `REVOKED` row is not eligible until
 *   that slice defines its own temporal rules).
 *
 * Deterministic tie-break (task §49): greatest
 * `effectiveFromCycleOrderIndex`, then greatest `appliedAt`, then
 * greatest `id` (UUIDv7 — this codebase's own `createEntityId()` output
 * is lexicographically time-ordered, so this is a genuine, meaningful
 * last resort, not an arbitrary one).
 */
export async function resolveEffectiveWorkingLoadForOccurrence(
  db: Database,
  params: EffectiveLoadResolutionParams,
): Promise<EffectiveLoadResolution> {
  const [winner] = await db
    .select({ id: progressionApplications.id, appliedLoad: progressionApplications.appliedLoad })
    .from(progressionApplications)
    .where(
      and(
        eq(progressionApplications.userId, params.userId),
        eq(progressionApplications.programVersionId, params.programVersionId),
        eq(progressionApplications.trainingBlockId, params.trainingBlockId),
        eq(progressionApplications.workoutOrderIndex, params.workoutOrderIndex),
        eq(progressionApplications.exerciseOrderIndex, params.exerciseOrderIndex),
        eq(progressionApplications.exerciseRef, params.exerciseRef),
        isNotNull(progressionApplications.appliedAt),
        lt(progressionApplications.effectiveFromCycleOrderIndex, params.targetCycleOrderIndex),
        inArray(progressionApplications.status, ["APPLIED", "SUPERSEDED"]),
      ),
    )
    .orderBy(
      desc(progressionApplications.effectiveFromCycleOrderIndex),
      desc(progressionApplications.appliedAt),
      desc(progressionApplications.id),
    )
    .limit(1);

  if (winner !== undefined && winner.appliedLoad !== null) {
    return { load: winner.appliedLoad, source: "APPLIED_HISTORY", sourceApplicationId: winner.id };
  }

  return { load: params.authoredWorkingLoad, source: "AUTHORED", sourceApplicationId: null };
}
