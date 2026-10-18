import { err, ok, type Result } from "./result.js";

/**
 * The one representation of a planned rep target, used identically by
 * `PlannedSet` (Plan intent), `PrescribedSetV1` (the immutable
 * `WorkoutPrescriptionV1` snapshot), and `WorkoutPreviewSetV1` (the wire
 * DTO shown to the athlete) — never a lossy single number for a range,
 * and never two parallel authoritative fields for the same concept (Plan
 * Contract Integrity Fix Pass, section 2).
 *
 * `EXACT` and `RANGE` are structurally distinct rather than "a range
 * where min happens to equal max," so a caller can never accidentally
 * read a `RANGE`'s `minReps` alone and treat it as the whole target.
 */
export type RepTargetV1 = { readonly kind: "EXACT"; readonly reps: number } | { readonly kind: "RANGE"; readonly minReps: number; readonly maxReps: number };

export type RepTargetValidationError =
  | { readonly reason: "NON_INTEGER_REPS" }
  | { readonly reason: "NON_POSITIVE_REPS" }
  | { readonly reason: "MIN_GREATER_THAN_MAX" }
  | { readonly reason: "INCOMPLETE_RANGE" };

/**
 * Storage-neutral input: a rep target is physically stored as two
 * nullable bounds (`packages/database/src/schema/plan.ts`'s
 * `target_reps_min`/`target_reps_max` — unchanged by this fix, no
 * migration needed). Both `null` means no target at all; equal bounds
 * collapse to `EXACT`; unequal bounds become a `RANGE`. This is the one
 * place that reinterpretation happens.
 */
export interface RepTargetRangeInput {
  readonly minReps: number | null;
  readonly maxReps: number | null;
}

export function repTargetFromRange(
  input: RepTargetRangeInput,
): Result<RepTargetV1 | null, RepTargetValidationError> {
  if (input.minReps === null && input.maxReps === null) return ok(null);
  if (input.minReps === null || input.maxReps === null) return err({ reason: "INCOMPLETE_RANGE" });

  if (!Number.isInteger(input.minReps) || !Number.isInteger(input.maxReps)) {
    return err({ reason: "NON_INTEGER_REPS" });
  }
  if (input.minReps <= 0 || input.maxReps <= 0) {
    return err({ reason: "NON_POSITIVE_REPS" });
  }
  if (input.minReps > input.maxReps) {
    return err({ reason: "MIN_GREATER_THAN_MAX" });
  }

  if (input.minReps === input.maxReps) {
    return ok({ kind: "EXACT", reps: input.minReps });
  }
  return ok({ kind: "RANGE", minReps: input.minReps, maxReps: input.maxReps });
}

/** The inverse mapping, for writing a `RepTargetV1` back to the two-column storage shape. */
export function repTargetToRange(target: RepTargetV1 | null): RepTargetRangeInput {
  if (target === null) return { minReps: null, maxReps: null };
  if (target.kind === "EXACT") return { minReps: target.reps, maxReps: target.reps };
  return { minReps: target.minReps, maxReps: target.maxReps };
}
