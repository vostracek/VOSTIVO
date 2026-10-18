import type { ExternalWeightLoad, LoadBasisV1, LoadUnit } from "./load.js";
import { validateEnumeratedListLoads } from "./validate-load.js";

/**
 * Progression Prerequisites V1 — Load Resolver Stage 1
 * (docs/domain/load-model-v1.md §51-65/§106-108,
 * docs/domain/PROGRESSION-ENGINE-V1.md §14, LOAD-INV-016).
 *
 * Boundary (already locked, not invented here):
 *
 *   Progression Engine  = should difficulty increase?
 *   Load Resolver       = what exact achievable load represents that
 *                          increase?
 *
 * This module answers only the second question, and only for the
 * currently-implemented Load Model Stage 1 subset (`EXTERNAL_WEIGHT`,
 * `KG`/`LB`, `TOTAL`/`PER_IMPLEMENT`) — bodyweight/assistance/machine-
 * level/percentage-of-1RM/bands/plate math are later stages, not
 * represented here (Load Model V1 §106-108's own staged rollout).
 *
 * Placement: `packages/domain`, not `packages/training-engine`. Load
 * Model ownership (kind/unit/basis/amountMilli semantics, `LOAD-INV-*`)
 * already lives entirely in `packages/domain/src/load/` — the Resolver is
 * a Load Model responsibility (deciding what's physically achievable),
 * not a decision-engine responsibility (deciding whether to increase at
 * all). `packages/training-engine` depends on `packages/domain` and would
 * eventually consume this module's exports the same way any other
 * caller does — putting it there would invert that dependency for no
 * reason. Pure and deterministic: no DB queries, no network, no React, no
 * Nest, no Expo — the same "framework-free" contract
 * `packages/training-engine` already enforces (`docs/architecture/
 * FOUNDATION.md`), honored here without needing that package's own
 * dependency-cruiser rule to enforce it (packages/domain has an identical
 * rule).
 */

/**
 * The only capability shape implemented in this slice: a fixed,
 * externally-supplied increment for a given unit+basis — the smallest
 * valid next step for the relevant equipment context (Load Model V1
 * §39's `FIXED_INCREMENT` LoadingProfile type). Deliberately a **pure
 * input value**, never persisted `GymProfile`/`LoadingProfile` data (spec
 * §15) — the application layer supplies it; this task does not build Gym
 * Profiles. `DISCRETE_LIST`/`PLATE_LOADED_BAR`/`PLATE_LOADED_PER_SIDE`/
 * etc. (Load Model V1 §38, later stages) are not implemented here.
 */
export interface FixedIncrementCapability {
  readonly kind: "FIXED_INCREMENT";
  readonly unit: LoadUnit;
  readonly basis: LoadBasisV1;
  /** Fixed-precision integer, scale 1000 — same representation as `ExternalWeightLoad.amountMilli` (LOAD-INV-002). Never a floating-point kg value. */
  readonly incrementAmountMilli: number;
}

export type LoadIncrementCapability = FixedIncrementCapability;

export type LoadResolutionResult =
  | { readonly status: "RESOLVED"; readonly load: ExternalWeightLoad }
  /**
   * A structurally valid request that the Resolver could not satisfy with
   * a sensible next value — a real domain outcome (Load Model V1 §349-351
   * already anticipates this exact code), never a thrown exception. For
   * `FIXED_INCREMENT` this covers a non-positive increment (zero or
   * negative); for `ENUMERATED_LIST` (Loading Capability V1) this covers
   * `current` already being the maximum entry — either way, there is no
   * meaningful "next achievable load" to offer.
   */
  | { readonly status: "NO_SUITABLE_INCREMENT" }
  /**
   * Loading Capability V1 — `ENUMERATED_LIST` only. `current.amountMilli`
   * does not exactly exist in the capability's list (a manual override, a
   * different prior gym, or legacy data). Never rounds or picks a
   * neighboring value — this is a distinct outcome from
   * `NO_SUITABLE_INCREMENT` precisely so a caller can tell "there's
   * nothing higher" apart from "I don't even recognize where you are
   * right now."
   */
  | { readonly status: "CURRENT_LOAD_UNSUPPORTED" }
  /**
   * The capability itself doesn't apply to the given current load
   * (wrong unit, wrong basis) or would produce an unrepresentable result
   * (overflow) — a caller/configuration problem, distinct from "no
   * increment exists for an otherwise-valid request."
   */
  | {
      readonly status: "INVALID_CAPABILITY";
      readonly reason: "UNIT_MISMATCH" | "BASIS_MISMATCH" | "OVERFLOW" | "MALFORMED_CAPABILITY";
    };

/**
 * Resolves the next achievable `EXTERNAL_WEIGHT` load one Stage-1 fixed
 * increment above `current`. Pure and deterministic: identical inputs
 * always produce an identical result (by value; a fresh object, never a
 * mutation of `current`), and `current` itself is never mutated — the
 * caller may safely reuse it after this call.
 *
 * Never converts unit (KG<->LB) and never changes `basis` — the Load
 * Model's per-side/per-implement/total semantics are inputs to this
 * function, not something it resolves or infers (LOAD-INV-005/006/007).
 * A mismatch between `current` and `capability` is reported as
 * `INVALID_CAPABILITY`, never silently coerced.
 */
export function resolveNextLoad(
  current: ExternalWeightLoad,
  capability: LoadIncrementCapability,
): LoadResolutionResult {
  if (capability.unit !== current.unit) {
    return { status: "INVALID_CAPABILITY", reason: "UNIT_MISMATCH" };
  }
  if (capability.basis !== current.basis) {
    return { status: "INVALID_CAPABILITY", reason: "BASIS_MISMATCH" };
  }

  if (
    !Number.isInteger(capability.incrementAmountMilli) ||
    !Number.isFinite(capability.incrementAmountMilli) ||
    capability.incrementAmountMilli <= 0
  ) {
    return { status: "NO_SUITABLE_INCREMENT" };
  }

  const nextAmountMilli = current.amountMilli + capability.incrementAmountMilli;
  if (!Number.isSafeInteger(nextAmountMilli)) {
    return { status: "INVALID_CAPABILITY", reason: "OVERFLOW" };
  }

  return {
    status: "RESOLVED",
    load: { kind: "EXTERNAL_WEIGHT", amountMilli: nextAmountMilli, unit: current.unit, basis: current.basis },
  };
}

/**
 * Loading Capability V1's second Stage-1 capability kind
 * (`docs/domain/LOADING-CAPABILITY-V1.md` §8) — needed because real
 * dumbbell racks and machine stacks are frequently *not* evenly spaced
 * (e.g. `20, 22, 24, 26, 28, 30, 35, 40`), so pretending they have one
 * constant increment would misrepresent the equipment (Load Model V1
 * §40-41's own `DISCRETE_LIST` precedent). `loadsMilli` must already be a
 * valid canonical list — strictly ascending, unique, positive integers
 * (`validateEnumeratedListLoads`, `packages/domain/src/load/
 * validate-load.ts`) — this resolver trusts that precondition and does
 * not re-sort or de-duplicate at read time.
 */
export interface EnumeratedListCapability {
  readonly kind: "ENUMERATED_LIST";
  readonly unit: LoadUnit;
  readonly basis: LoadBasisV1;
  readonly loadsMilli: readonly number[];
}

/**
 * The union of every Stage-1 Loading Capability kind
 * (`docs/domain/LOADING-CAPABILITY-V1.md` §8). Deliberately a NEW export,
 * not a widening of the pre-existing `LoadIncrementCapability` (kept
 * exactly as it was — `resolveNextLoad()`'s own signature and every
 * existing caller/test is unaffected by this addition).
 */
export type LoadingCapabilityV1 = FixedIncrementCapability | EnumeratedListCapability;

/**
 * Resolves the next achievable `EXTERNAL_WEIGHT` load from an
 * `ENUMERATED_LIST` capability. `current.amountMilli` must exactly exist
 * in `capability.loadsMilli` — a value not present in the list (a manual
 * override, a different prior gym, legacy data) is `CURRENT_LOAD_UNSUPPORTED`,
 * never rounded to a neighboring entry. If `current` is already the
 * maximum entry, `NO_SUITABLE_INCREMENT`. Pure and deterministic, same
 * never-mutates-`current` guarantee as `resolveNextLoad()`.
 *
 * **Fail-closed defense-in-depth** (Loading Capability Foundation V1's
 * evidence gate): `capability.loadsMilli` is expected to already be
 * canonical — strictly ascending, unique — because the write boundary
 * (`validateEnumeratedListLoads`) is supposed to guarantee it before
 * persistence. But Postgres itself cannot enforce that ordering as a
 * `CHECK` constraint (`packages/database/src/schema/loading-capability.ts`'s
 * own doc comment explains why), so malformed data CAN reach this
 * function if something ever bypasses that write boundary. Indexing
 * blindly into a malformed list would silently return an incorrect
 * "next" value — verified empirically: `[20000, 24000, 22000]` with
 * `current = 24000` previously returned `RESOLVED` with `22000`, a value
 * *lower* than `current`. This function therefore re-validates ordering
 * itself, every call, and fails closed (`MALFORMED_CAPABILITY`) rather
 * than ever resolving from data it cannot trust — no sorting, no repair,
 * no guessing which entries are "right."
 */
export function resolveNextLoadFromEnumeratedList(
  current: ExternalWeightLoad,
  capability: EnumeratedListCapability,
): LoadResolutionResult {
  if (capability.unit !== current.unit) {
    return { status: "INVALID_CAPABILITY", reason: "UNIT_MISMATCH" };
  }
  if (capability.basis !== current.basis) {
    return { status: "INVALID_CAPABILITY", reason: "BASIS_MISMATCH" };
  }
  if (!validateEnumeratedListLoads(capability.loadsMilli).ok) {
    return { status: "INVALID_CAPABILITY", reason: "MALFORMED_CAPABILITY" };
  }

  const currentIndex = capability.loadsMilli.indexOf(current.amountMilli);
  if (currentIndex === -1) {
    return { status: "CURRENT_LOAD_UNSUPPORTED" };
  }
  if (currentIndex === capability.loadsMilli.length - 1) {
    return { status: "NO_SUITABLE_INCREMENT" };
  }

  const nextAmountMilli = capability.loadsMilli[currentIndex + 1]!;
  return {
    status: "RESOLVED",
    load: { kind: "EXTERNAL_WEIGHT", amountMilli: nextAmountMilli, unit: current.unit, basis: current.basis },
  };
}

/**
 * The single entry point a caller (the future Loading Capability lookup
 * primitive, `@vostivo/progression-application`) should use once it has
 * resolved *which* capability kind applies — dispatches to
 * `resolveNextLoad()` or `resolveNextLoadFromEnumeratedList()` by
 * `capability.kind`, never duplicating either's logic.
 */
export function resolveNextLoadFromCapability(
  current: ExternalWeightLoad,
  capability: LoadingCapabilityV1,
): LoadResolutionResult {
  switch (capability.kind) {
    case "FIXED_INCREMENT":
      return resolveNextLoad(current, capability);
    case "ENUMERATED_LIST":
      return resolveNextLoadFromEnumeratedList(current, capability);
  }
}
