import { availableTimeApplications, type Database } from "@vostivo/database";
import { createEntityId, verifyAvailableTimeSnapshot, type AvailableTimeApplicationV1, type WorkoutPrescriptionV1 } from "@vostivo/domain";
import { computeAvailableTimePreview } from "../plan/available-time-preview.js";
import type { StartProvenance } from "../plan/planned-provenance.js";

/**
 * Available-Time Adaptation V1 — Slice C: server decision for the OPTIONAL
 * `availableTimeApplication` on `START_WORKOUT_SESSION_V1`
 * (docs/domain/AVAILABLE-TIME-ADAPTATION-V1.md §18). Pure: it runs over the
 * provenance `resolveStartProvenance` already established (owned planned
 * workout + its canonical rows), BEFORE anything is written.
 *
 * The locked distinction:
 *
 * - The server CAN evaluate the owned source and PROVES the client payload
 *   contradicts it (foreign/missing identity, snapshot != retained sets,
 *   fingerprint, result kind, durations or exact diff) -> REJECTED. The
 *   adjusted START never becomes server reality: no session, no row.
 * - Exact re-derivation matches:
 *     current source            -> VERIFIED
 *     source no longer current  -> STALE (accepted — local reality wins)
 * - The owned, intact source genuinely cannot be re-evaluated (and so no
 *   contradiction is provable) -> UNVERIFIED (accepted).
 *
 * UNVERIFIED IS NOT A FALLBACK FOR TAMPERED OR MISMATCHING CLIENT DATA.
 */
export type AvailableTimeRejection =
  | "SOURCE_NOT_PLANNED"
  | "SOURCE_VERSION_MISMATCH"
  | "FOREIGN_EXERCISE"
  | "FOREIGN_SET"
  | "SNAPSHOT_MISMATCH"
  | "FINGERPRINT_MISMATCH"
  | "RESULT_MISMATCH"
  | "DURATION_MISMATCH"
  | "DIFF_MISMATCH";

export type AvailableTimeVerification =
  | { readonly status: "VERIFIED"; readonly reason: null }
  | { readonly status: "STALE"; readonly reason: "SOURCE_NOT_CURRENT" }
  | { readonly status: "UNVERIFIED"; readonly reason: "SOURCE_NOT_EVALUABLE" };

export type AvailableTimeStartDecision =
  | { readonly accepted: true; readonly verification: AvailableTimeVerification }
  | { readonly accepted: false; readonly reason: AvailableTimeRejection };

function reject(reason: AvailableTimeRejection): AvailableTimeStartDecision {
  return { accepted: false, reason };
}

function sameSequence(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function decideAvailableTimeStart(
  application: AvailableTimeApplicationV1,
  provenance: StartProvenance,
  snapshot: WorkoutPrescriptionV1,
): AvailableTimeStartDecision {
  // ---- integrity: identities must be the athlete's own planned source ----
  if (provenance.kind !== "PLANNED" || provenance.source.plannedWorkoutId !== application.plannedWorkoutId) return reject("SOURCE_NOT_PLANNED");
  const { source, exercises } = provenance;
  if (source.programVersionId !== application.sourceProgramVersionId) return reject("SOURCE_VERSION_MISMATCH");

  const setIdsByExercise = new Map(exercises.map((exercise) => [exercise.id, new Set(exercise.sets.map((set) => set.id))]));
  for (const applied of application.exercises) {
    const ownSetIds = setIdsByExercise.get(applied.plannedExerciseId);
    if (ownSetIds === undefined) return reject("FOREIGN_EXERCISE");
    if (![...applied.retainedPlannedSetIds, ...applied.removedPlannedSetIds].every((setId) => ownSetIds.has(setId))) return reject("FOREIGN_SET");
  }
  if (!verifyAvailableTimeSnapshot(snapshot, application).ok) return reject("SNAPSHOT_MISMATCH");

  // ---- re-derivation: the client's recommendation is transported, never trusted ----
  const recomputed = computeAvailableTimePreview({
    plannedWorkoutId: source.plannedWorkoutId,
    programVersionId: source.programVersionId,
    availableMinutes: application.availableMinutes,
    exercises,
  });
  // Genuinely not evaluable (no contradiction can be proven): preserve the owned, intact history.
  if (!recomputed.ok) return { accepted: true, verification: { status: "UNVERIFIED", reason: "SOURCE_NOT_EVALUABLE" } };

  const expected = recomputed.value;
  if (expected.previewFingerprint !== application.previewFingerprint) return reject("FINGERPRINT_MISMATCH");
  if (expected.result !== "ADJUST_SESSION") return reject("RESULT_MISMATCH");
  if (expected.originalEstimatedSeconds !== application.originalEstimatedSeconds || expected.adjustedEstimatedSeconds !== application.adjustedEstimatedSeconds) {
    return reject("DURATION_MISMATCH");
  }
  const expectedByExercise = new Map(expected.exercises.map((exercise) => [exercise.plannedExerciseId, exercise]));
  const diffMatches =
    application.exercises.length === expected.exercises.length &&
    application.exercises.every((applied) => {
      const canonical = expectedByExercise.get(applied.plannedExerciseId);
      return (
        canonical !== undefined &&
        sameSequence(canonical.retainedPlannedSetIds, applied.retainedPlannedSetIds) &&
        sameSequence(canonical.removedPlannedSetIds, applied.removedPlannedSetIds)
      );
    });
  if (!diffMatches) return reject("DIFF_MISMATCH");

  // ---- exact match: only freshness remains (authorization is ownership, not freshness) ----
  if (source.programVersionStatus !== "ACTIVE" || source.programStatus !== "ACTIVE") {
    return { accepted: true, verification: { status: "STALE", reason: "SOURCE_NOT_CURRENT" } };
  }
  return { accepted: true, verification: { status: "VERIFIED", reason: null } };
}

/** Written once, in the START transaction, after the session row; at most one row per session (unique index). */
export async function insertAvailableTimeApplication(
  tx: Database,
  userId: string,
  workoutSessionId: string,
  application: AvailableTimeApplicationV1,
  verification: AvailableTimeVerification,
): Promise<void> {
  await tx
    .insert(availableTimeApplications)
    .values({
      id: createEntityId(),
      workoutSessionId,
      userId,
      plannedWorkoutId: application.plannedWorkoutId,
      sourceProgramVersionId: application.sourceProgramVersionId,
      scope: application.scope,
      policyVersion: application.policyVersion,
      availableMinutes: application.availableMinutes,
      previewFingerprint: application.previewFingerprint,
      originalEstimatedSeconds: application.originalEstimatedSeconds,
      adjustedEstimatedSeconds: application.adjustedEstimatedSeconds,
      structuralDiff: application.exercises,
      verificationStatus: verification.status,
      verificationReason: verification.reason,
    })
    .onConflictDoNothing({ target: availableTimeApplications.workoutSessionId });
}
