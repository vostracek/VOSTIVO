import { createHash } from "node:crypto";

/**
 * §18's proposed `evidenceExposureRefs` shape (naming preserved). Defined
 * here (rather than in `progression-evaluation.service.ts`, which needs
 * it too) so `computeEvidenceFingerprint`'s canonical-ordering logic and
 * this type stay next to each other, and so the service module can import
 * it from here without a circular import between the two files.
 */
export interface ProgressionEvidenceRefV1 {
  readonly performedSetId: string;
  readonly revisionEvaluated: number;
}

/**
 * Progression EngineDecision Persistence & Evidence Integration V1 —
 * idempotency/audit-identity fingerprint (§25/§26 of the implementation
 * task; payload corrected during the Slice C identity gate, 2026-09-23).
 * SHA-256 in the server application layer, never inside
 * `packages/training-engine` (that package must stay infrastructure-free —
 * `pnpm boundaries:check` would fail on a `node:crypto` import there
 * anyway). This is for idempotency/audit identity, not security
 * authentication.
 *
 * A stable canonical serialization — recursively sorted object keys —
 * rather than trusting incidental JS property insertion order from
 * objects assembled by other code. Arrays are NOT reordered by
 * `sortKeysDeep` itself: `exposures[]` order is semantically meaningful
 * (§4/§11 — most-recent-first) and must contribute to the fingerprint as
 * constructed. `evidenceRefs`, however, IS explicitly sorted by
 * `performedSetId` before hashing (see `computeEvidenceFingerprint`) —
 * its construction order is already deterministic today (anchor first,
 * then most-recent-first history), but sorting removes any dependence on
 * that construction order being preserved by a future refactor.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeysDeep(record[key]);
    }
    return sorted;
  }
  return value;
}

/** A distinct application-level identity-format version, deliberately NOT the engine/policy version (§9 of the identity-gate task) — this can change independently of `progression/v1`'s decision semantics. */
const FINGERPRINT_SCHEMA = "progression-evaluation-v1";

/**
 * The Slice-C identity gate found that `normalizedInputSnapshot`
 * (`ProgressionEvaluationInput`) alone is NOT sufficient evaluation
 * identity: it carries only `prescriptionSetId`/`actualReps` VALUES
 * (`packages/training-engine/src/progression/input.ts`'s
 * `ProgressionExposureWorkingSetV1` — deliberately no `performedSetId`/
 * `revision`, since the pure engine doesn't need them), never
 * `performedSetId`, `revision`, `sourceWorkoutSessionId`, or
 * `sourcePerformedExerciseId`. Two real gaps followed directly from that:
 *
 * 1. A revision-only correction (reopen -> recomplete with the exact same
 *    `actualReps`/`actualLoad`) produced a BYTE-IDENTICAL snapshot, hence
 *    the same fingerprint, hence no new decision — even though a genuine
 *    new historical correction event occurred.
 * 2. Two structurally distinct source exposures (different
 *    `sourceWorkoutSessionId`/`sourcePerformedExerciseId`) that happen to
 *    produce semantically identical normalized values (same reps, same
 *    target) collapsed onto the same fingerprint — two real evaluation
 *    events treated as one.
 *
 * This payload closes both gaps by hashing the full evaluation identity —
 * source identity, every evidence revision, AND the normalized snapshot —
 * without changing `ProgressionEvaluationInput` itself (§4: the pure
 * engine input stays untouched; persistence/audit identity is composed at
 * this application layer only).
 */
export interface EvidenceFingerprintInput {
  readonly engine: string;
  readonly policy: string;
  readonly userId: string;
  readonly sourceWorkoutSessionId: string;
  readonly sourcePerformedExerciseId: string;
  readonly sourcePrescriptionExerciseId: string;
  readonly normalizedInputSnapshot: unknown;
  readonly evidenceRefs: readonly ProgressionEvidenceRefV1[];
}

export function computeEvidenceFingerprint(input: EvidenceFingerprintInput): string {
  const canonicalEvidenceRefs = [...input.evidenceRefs].sort((a, b) => a.performedSetId.localeCompare(b.performedSetId));

  const canonical = canonicalStringify({
    fingerprintSchema: FINGERPRINT_SCHEMA,
    engine: input.engine,
    policy: input.policy,
    userId: input.userId,
    sourceWorkoutSessionId: input.sourceWorkoutSessionId,
    sourcePerformedExerciseId: input.sourcePerformedExerciseId,
    sourcePrescriptionExerciseId: input.sourcePrescriptionExerciseId,
    normalizedInputSnapshot: input.normalizedInputSnapshot,
    evidenceRefs: canonicalEvidenceRefs,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
