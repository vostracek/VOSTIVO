import { and, eq } from "drizzle-orm";
import { exerciseLoadingCapabilityBindings, loadingCapabilities, type Database } from "@vostivo/database";
import type { LoadingCapabilityV1 } from "@vostivo/domain";

/**
 * Loading Capability V1 (`docs/domain/LOADING-CAPABILITY-V1.md` §5/§15) —
 * the smallest server-side lookup primitive future Progression
 * Application code needs: given a (trusted) `gymProfileId` and an exact
 * `exerciseRef`, return the bound `LoadingCapability` as the exact pure
 * `packages/domain` shape `resolveNextLoadFromCapability()` already
 * consumes — no hidden DB/framework knowledge leaks into that call
 * (`packages/domain` stays entirely unaware this data came from Postgres).
 *
 * **No fallback of any kind** — an exact-`exerciseRef` binding either
 * exists or it doesn't (`docs/domain/LOADING-CAPABILITY-V1.md` §5.1). Unit/
 * basis compatibility with a specific *current load* is intentionally NOT
 * checked here — that is `resolveNextLoadFromCapability()`'s own job
 * (`INVALID_CAPABILITY`), once a caller actually has a current load to
 * resolve against; this primitive only answers "is there a binding at
 * all," which is a DB-lookup question, not a mathematical resolver
 * condition (kept out of `packages/domain` for exactly that reason).
 *
 * **BOLA contract**: `gymProfileId` is trusted as already
 * ownership-verified — this function performs no ownership check of its
 * own. The real BOLA guarantee is structural, not a runtime check here:
 * nothing in this package ever accepts a client-supplied `gymProfileId`
 * directly, and the only way to obtain one is
 * `getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId)`
 * (`gym-profile.ts`), keyed by a canonical, server-resolved
 * `athleteProfileId` — so composing the two functions together, actor A
 * can never reach actor B's capability data, regardless of what
 * `exerciseRef` or `loadingCapabilityId` value actor A's own request
 * might otherwise claim.
 */
export type LoadingCapabilityLookupResult =
  | {
      readonly status: "RESOLVED";
      readonly loadingCapabilityId: string;
      readonly revision: number;
      readonly capability: LoadingCapabilityV1;
    }
  | { readonly status: "LOADING_CAPABILITY_UNAVAILABLE" };

interface BoundCapabilityRow {
  readonly loadingCapabilityId: string;
  readonly revision: number;
  readonly unit: LoadingCapabilityV1["unit"];
  readonly basis: LoadingCapabilityV1["basis"];
  readonly kind: LoadingCapabilityV1["kind"];
  readonly fixedIncrementAmountMilli: number | null;
  readonly enumeratedLoadsMilli: readonly number[] | null;
}

const BOUND_CAPABILITY_COLUMNS = {
  loadingCapabilityId: loadingCapabilities.id,
  revision: loadingCapabilities.revision,
  unit: loadingCapabilities.unit,
  basis: loadingCapabilities.basis,
  kind: loadingCapabilities.kind,
  fixedIncrementAmountMilli: loadingCapabilities.fixedIncrementAmountMilli,
  enumeratedLoadsMilli: loadingCapabilities.enumeratedLoadsMilli,
} as const;

function toLookupResult(row: BoundCapabilityRow | undefined): LoadingCapabilityLookupResult {
  if (row === undefined) {
    return { status: "LOADING_CAPABILITY_UNAVAILABLE" };
  }

  // NOT NULL enforced by loading_capabilities_payload_matches_kind for the
  // matching `kind` — trusted internal data (this repository's own prior
  // writes), same trust boundary PlanReadService's toDomainLoad already
  // applies to Load Model columns.
  const capability: LoadingCapabilityV1 =
    row.kind === "FIXED_INCREMENT"
      ? { kind: "FIXED_INCREMENT", unit: row.unit, basis: row.basis, incrementAmountMilli: row.fixedIncrementAmountMilli! }
      : { kind: "ENUMERATED_LIST", unit: row.unit, basis: row.basis, loadsMilli: row.enumeratedLoadsMilli! };

  return { status: "RESOLVED", loadingCapabilityId: row.loadingCapabilityId, revision: row.revision, capability };
}

export async function resolveBoundCapability(
  db: Database,
  gymProfileId: string,
  exerciseRef: string,
): Promise<LoadingCapabilityLookupResult> {
  const [row] = await db
    .select(BOUND_CAPABILITY_COLUMNS)
    .from(exerciseLoadingCapabilityBindings)
    .innerJoin(
      loadingCapabilities,
      eq(loadingCapabilities.id, exerciseLoadingCapabilityBindings.loadingCapabilityId),
    )
    .where(
      and(
        eq(exerciseLoadingCapabilityBindings.gymProfileId, gymProfileId),
        eq(exerciseLoadingCapabilityBindings.exerciseRef, exerciseRef),
      ),
    )
    .limit(1);

  return toLookupResult(row);
}

/**
 * Progression Application V1 — Slice C (task §27): identical lookup, but
 * takes a row lock (`SELECT ... FOR UPDATE`) on both the binding and its
 * capability row for the duration of the caller's transaction — the
 * numeric Apply transaction's own serialization mechanism against a
 * concurrent capability edit (task §56), never a distributed lock. A
 * separate function, not a boolean flag on `resolveBoundCapability`, so
 * every ordinary (unlocked) call site's intent stays visually obvious and
 * this codebase's proven query shape for the common case is never
 * disturbed by an unused parameter.
 */
export async function resolveBoundCapabilityForUpdate(
  db: Database,
  gymProfileId: string,
  exerciseRef: string,
): Promise<LoadingCapabilityLookupResult> {
  const [row] = await db
    .select(BOUND_CAPABILITY_COLUMNS)
    .from(exerciseLoadingCapabilityBindings)
    .innerJoin(
      loadingCapabilities,
      eq(loadingCapabilities.id, exerciseLoadingCapabilityBindings.loadingCapabilityId),
    )
    .where(
      and(
        eq(exerciseLoadingCapabilityBindings.gymProfileId, gymProfileId),
        eq(exerciseLoadingCapabilityBindings.exerciseRef, exerciseRef),
      ),
    )
    .limit(1)
    .for("update");

  return toLookupResult(row);
}
