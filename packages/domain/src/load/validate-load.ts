import { err, ok, type Result } from "../result.js";
import { LOAD_BASES_V1, LOAD_UNITS, type ExternalWeightLoad, type LoadBasisV1, type LoadUnit } from "./load.js";

/**
 * LOAD-INV-001: a numeric load without semantics is invalid. This is the
 * one place that enforces it for the Stage 1 subset — callers must never
 * accept a bare `{ amountMilli }` without also validating unit and basis
 * here.
 */
export interface ExternalWeightLoadInput {
  readonly amountMilli: number;
  readonly unit: string;
  readonly basis: string;
}

export type LoadValidationError =
  | { readonly reason: "INVALID_AMOUNT" }
  | { readonly reason: "INVALID_UNIT" }
  | { readonly reason: "INVALID_BASIS" };

export function validateExternalWeightLoad(
  input: ExternalWeightLoadInput,
): Result<ExternalWeightLoad, LoadValidationError> {
  if (
    !Number.isInteger(input.amountMilli) ||
    !Number.isFinite(input.amountMilli) ||
    input.amountMilli < 0
  ) {
    return err({ reason: "INVALID_AMOUNT" });
  }

  if (!isLoadUnit(input.unit)) {
    return err({ reason: "INVALID_UNIT" });
  }

  if (!isLoadBasisV1(input.basis)) {
    return err({ reason: "INVALID_BASIS" });
  }

  return ok({
    kind: "EXTERNAL_WEIGHT",
    amountMilli: input.amountMilli,
    unit: input.unit,
    basis: input.basis,
  });
}

function isLoadUnit(value: string): value is LoadUnit {
  return (LOAD_UNITS as readonly string[]).includes(value);
}

function isLoadBasisV1(value: string): value is LoadBasisV1 {
  return (LOAD_BASES_V1 as readonly string[]).includes(value);
}

/**
 * Loading Capability V1 (`docs/domain/LOADING-CAPABILITY-V1.md` §8) —
 * the canonical validity rules for an `ENUMERATED_LIST` capability's
 * `loadsMilli`, enforced here once so every write path (the future
 * capability write primitive) and `resolveNextLoadFromEnumeratedList()`
 * agree on what "already valid" means. This is the ONE place these rules
 * are checked — Postgres cannot express "strictly ascending, no
 * duplicates" as a plain `CHECK` constraint without a subquery (which
 * Postgres forbids there) or a custom function (not introduced for this
 * one rule, kept consistent with this schema's existing convention of
 * plain, subquery-free constraints) — so this domain-layer validation,
 * not the database, is the actual enforcement boundary for ordering/
 * uniqueness. See `packages/database/src/schema/loading-capability.ts`
 * for exactly which sibling rules (non-empty, positive, kind/payload
 * shape) the database *does* enforce directly.
 */
export type EnumeratedListValidationError =
  | { readonly reason: "EMPTY" }
  | { readonly reason: "NON_INTEGER" }
  | { readonly reason: "NON_POSITIVE" }
  | { readonly reason: "NOT_STRICTLY_ASCENDING" };

export function validateEnumeratedListLoads(
  loadsMilli: readonly number[],
): Result<readonly number[], EnumeratedListValidationError> {
  if (loadsMilli.length === 0) {
    return err({ reason: "EMPTY" });
  }

  for (const amount of loadsMilli) {
    if (!Number.isInteger(amount) || !Number.isFinite(amount)) {
      return err({ reason: "NON_INTEGER" });
    }
    if (amount <= 0) {
      return err({ reason: "NON_POSITIVE" });
    }
  }

  for (let i = 1; i < loadsMilli.length; i++) {
    if (loadsMilli[i]! <= loadsMilli[i - 1]!) {
      // Covers both "not ascending" and "duplicate" in one check — a
      // duplicate is exactly a non-increase between adjacent entries once
      // the list is already claimed to be in ascending order.
      return err({ reason: "NOT_STRICTLY_ASCENDING" });
    }
  }

  return ok(loadsMilli);
}
