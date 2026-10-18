import { err, ok, type Result } from "../result.js";
import type { PrescribedExerciseV1, PrescribedSetV1, WorkoutPrescriptionV1 } from "./prescription.js";

/**
 * Available-Time Adaptation V1 — Slice C (docs/domain/
 * AVAILABLE-TIME-ADAPTATION-V1.md §18). The immutable, session-scoped
 * record of an athlete EXPLICITLY choosing "Start adjusted workout" from a
 * server `ADJUST_SESSION` preview. Written once, in the same local
 * transaction that starts the session, and carried (optionally) on that
 * session's `START_WORKOUT_SESSION_V1` so the server can audit/verify it.
 *
 * TODAY_ONLY: it describes which already-authored planned sets this one
 * session keeps — never a Program edit, never a progression decision. The
 * `previewFingerprint` is a stale-input guard, never authorization.
 *
 * The structural diff is grouped by exercise (same grouping as the preview
 * contract): per exercise, `retainedPlannedSetIds` + `removedPlannedSetIds`
 * partition ALL of its authored sets (warm-ups included), each in canonical
 * authored order.
 */
export const AVAILABLE_TIME_APPLICATION_SCOPE_V1 = "TODAY_ONLY" as const;
export const AVAILABLE_TIME_APPLICATION_POLICY_VERSION_V1 = "available-time/v1" as const;
export const AVAILABLE_TIME_MIN_AVAILABLE_MINUTES_V1 = 1;
export const AVAILABLE_TIME_MAX_AVAILABLE_MINUTES_V1 = 240;

export interface AvailableTimeApplicationExerciseV1 {
  readonly plannedExerciseId: string;
  readonly retainedPlannedSetIds: readonly string[];
  readonly removedPlannedSetIds: readonly string[];
}

export interface AvailableTimeApplicationV1 {
  readonly schemaVersion: 1;
  readonly scope: typeof AVAILABLE_TIME_APPLICATION_SCOPE_V1;
  readonly policyVersion: typeof AVAILABLE_TIME_APPLICATION_POLICY_VERSION_V1;
  readonly plannedWorkoutId: string;
  readonly sourceProgramVersionId: string;
  readonly availableMinutes: number;
  readonly previewFingerprint: string;
  readonly originalEstimatedSeconds: number;
  readonly adjustedEstimatedSeconds: number;
  readonly exercises: readonly AvailableTimeApplicationExerciseV1[];
}

export type AvailableTimeApplicationValidationReason =
  | "INVALID_SHAPE"
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "UNSUPPORTED_SCOPE"
  | "UNSUPPORTED_POLICY_VERSION"
  | "INVALID_IDENTIFIER"
  | "INVALID_AVAILABLE_MINUTES"
  | "INVALID_FINGERPRINT"
  | "INVALID_DURATION"
  | "DUPLICATE_EXERCISE"
  | "DUPLICATE_SET"
  | "EXERCISE_WITHOUT_SETS"
  | "NO_RETAINED_SET"
  | "NOTHING_REMOVED";

export type AvailableTimeSelectionReason =
  | "PRESCRIPTION_MISMATCH"
  | "EXERCISE_NOT_COVERED"
  | "UNKNOWN_EXERCISE"
  | "DUPLICATE_PRESCRIPTION_IDENTITY"
  | "PARTITION_MISMATCH"
  | "NON_CANONICAL_ORDER";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isIdentifierArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isIdentifier);
}

/**
 * Runtime structural validation of an untrusted value (a sync payload, a
 * stored JSON column, a mobile-built object). It proves the record is
 * well-formed and internally consistent — it does NOT prove the diff is
 * what `available-time/v1` would produce; only the server's re-evaluation
 * can do that. Every `ADJUST_SESSION` removes at least one set, keeps at
 * least one, and fits the budget; anything else is not an application.
 */
export function validateAvailableTimeApplication(
  value: unknown,
): Result<AvailableTimeApplicationV1, AvailableTimeApplicationValidationReason> {
  if (!isRecord(value) || !Array.isArray(value["exercises"])) return err("INVALID_SHAPE");
  if (value["schemaVersion"] !== 1) return err("UNSUPPORTED_SCHEMA_VERSION");
  if (value["scope"] !== AVAILABLE_TIME_APPLICATION_SCOPE_V1) return err("UNSUPPORTED_SCOPE");
  if (value["policyVersion"] !== AVAILABLE_TIME_APPLICATION_POLICY_VERSION_V1) return err("UNSUPPORTED_POLICY_VERSION");
  if (!isIdentifier(value["plannedWorkoutId"]) || !isIdentifier(value["sourceProgramVersionId"])) return err("INVALID_IDENTIFIER");

  const availableMinutes = value["availableMinutes"];
  if (
    !isNonNegativeInteger(availableMinutes) ||
    availableMinutes < AVAILABLE_TIME_MIN_AVAILABLE_MINUTES_V1 ||
    availableMinutes > AVAILABLE_TIME_MAX_AVAILABLE_MINUTES_V1
  ) {
    return err("INVALID_AVAILABLE_MINUTES");
  }

  const previewFingerprint = value["previewFingerprint"];
  if (typeof previewFingerprint !== "string" || !FINGERPRINT_PATTERN.test(previewFingerprint)) return err("INVALID_FINGERPRINT");

  const originalEstimatedSeconds = value["originalEstimatedSeconds"];
  const adjustedEstimatedSeconds = value["adjustedEstimatedSeconds"];
  if (
    !isNonNegativeInteger(originalEstimatedSeconds) ||
    !isNonNegativeInteger(adjustedEstimatedSeconds) ||
    adjustedEstimatedSeconds >= originalEstimatedSeconds ||
    adjustedEstimatedSeconds > availableMinutes * 60
  ) {
    return err("INVALID_DURATION");
  }

  const exercises: AvailableTimeApplicationExerciseV1[] = [];
  const seenExerciseIds = new Set<string>();
  const seenSetIds = new Set<string>();
  let retainedCount = 0;
  let removedCount = 0;

  for (const exercise of value["exercises"]) {
    if (!isRecord(exercise)) return err("INVALID_SHAPE");
    const { plannedExerciseId, retainedPlannedSetIds, removedPlannedSetIds } = exercise;
    if (!isIdentifier(plannedExerciseId) || !isIdentifierArray(retainedPlannedSetIds) || !isIdentifierArray(removedPlannedSetIds)) {
      return err("INVALID_IDENTIFIER");
    }
    if (seenExerciseIds.has(plannedExerciseId)) return err("DUPLICATE_EXERCISE");
    seenExerciseIds.add(plannedExerciseId);
    if (retainedPlannedSetIds.length + removedPlannedSetIds.length === 0) return err("EXERCISE_WITHOUT_SETS");

    // One global set-identity space: a set id may appear exactly once
    // across every exercise's retained AND removed lists.
    for (const setId of [...retainedPlannedSetIds, ...removedPlannedSetIds]) {
      if (seenSetIds.has(setId)) return err("DUPLICATE_SET");
      seenSetIds.add(setId);
    }
    retainedCount += retainedPlannedSetIds.length;
    removedCount += removedPlannedSetIds.length;
    exercises.push({ plannedExerciseId, retainedPlannedSetIds: [...retainedPlannedSetIds], removedPlannedSetIds: [...removedPlannedSetIds] });
  }

  if (retainedCount === 0) return err("NO_RETAINED_SET");
  if (removedCount === 0) return err("NOTHING_REMOVED");

  return ok({
    schemaVersion: 1,
    scope: AVAILABLE_TIME_APPLICATION_SCOPE_V1,
    policyVersion: AVAILABLE_TIME_APPLICATION_POLICY_VERSION_V1,
    plannedWorkoutId: value["plannedWorkoutId"],
    sourceProgramVersionId: value["sourceProgramVersionId"],
    availableMinutes,
    previewFingerprint,
    originalEstimatedSeconds,
    adjustedEstimatedSeconds,
    exercises,
  });
}

function byOrder<T extends { readonly order: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.order - b.order);
}

function sameSequence(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

/**
 * The ONE structural filter from a full (already effective/progressed)
 * prescription to the adjusted session prescription. It never builds a
 * second prescription representation and never touches load, reps, rest or
 * set type: retained exercises/sets are the SAME objects, in the same
 * canonical order; removed sets disappear; an exercise with no retained set
 * disappears entirely.
 *
 * Fails closed unless the application's per-exercise retained/removed ids
 * exactly partition this prescription's own sets, in canonical order — the
 * client never "fixes up" a preview that does not match what it is about to
 * start.
 */
export function selectAvailableTimePrescription(
  prescription: WorkoutPrescriptionV1,
  application: AvailableTimeApplicationV1,
): Result<WorkoutPrescriptionV1, AvailableTimeSelectionReason> {
  if (prescription.prescriptionId !== application.plannedWorkoutId) return err("PRESCRIPTION_MISMATCH");

  const exerciseIds = prescription.exercises.map((exercise) => exercise.prescriptionExerciseId);
  const setIds = prescription.exercises.flatMap((exercise) => exercise.sets.map((set) => set.prescriptionSetId));
  if (hasDuplicates(exerciseIds) || hasDuplicates(setIds)) return err("DUPLICATE_PRESCRIPTION_IDENTITY");

  const selectionByExercise = new Map(application.exercises.map((exercise) => [exercise.plannedExerciseId, exercise]));
  for (const applicationExercise of application.exercises) {
    if (!exerciseIds.includes(applicationExercise.plannedExerciseId)) return err("UNKNOWN_EXERCISE");
  }

  const adjustedExercises: PrescribedExerciseV1[] = [];
  for (const exercise of byOrder(prescription.exercises)) {
    const selection = selectionByExercise.get(exercise.prescriptionExerciseId);
    if (selection === undefined) return err("EXERCISE_NOT_COVERED");

    const orderedSets = byOrder(exercise.sets);
    const retained = new Set(selection.retainedPlannedSetIds);
    const removed = new Set(selection.removedPlannedSetIds);
    const isPartition =
      orderedSets.length === retained.size + removed.size &&
      orderedSets.every((set) => retained.has(set.prescriptionSetId) !== removed.has(set.prescriptionSetId));
    if (!isPartition) return err("PARTITION_MISMATCH");

    const retainedSets = orderedSets.filter((set) => retained.has(set.prescriptionSetId));
    const removedSets = orderedSets.filter((set) => removed.has(set.prescriptionSetId));
    if (
      !sameSequence(retainedSets.map((set) => set.prescriptionSetId), selection.retainedPlannedSetIds) ||
      !sameSequence(removedSets.map((set) => set.prescriptionSetId), selection.removedPlannedSetIds)
    ) {
      return err("NON_CANONICAL_ORDER");
    }

    if (retainedSets.length > 0) adjustedExercises.push({ ...exercise, sets: retainedSets });
  }

  return ok({ ...prescription, exercises: adjustedExercises });
}

/**
 * Server-side counterpart: the server never sees the client's full source
 * prescription, only the adjusted snapshot it is asked to store. This
 * proves that snapshot is EXACTLY the retained structure the application
 * claims — same planned workout, exactly the exercises that keep at least
 * one set, and per exercise exactly the retained set ids in canonical
 * order. Anything else is an integrity violation (never "stale").
 */
export function verifyAvailableTimeSnapshot(
  snapshot: WorkoutPrescriptionV1,
  application: AvailableTimeApplicationV1,
): Result<true, AvailableTimeSelectionReason> {
  if (snapshot.prescriptionId !== application.plannedWorkoutId) return err("PRESCRIPTION_MISMATCH");

  // The snapshot arrives from an untrusted payload: every level is checked
  // at runtime before it is read, so a hostile shape is a clean rejection,
  // never a thrown error.
  const rawExercises: unknown = snapshot.exercises;
  if (!Array.isArray(rawExercises) || !rawExercises.every(isSnapshotExercise)) return err("PARTITION_MISMATCH");
  const snapshotExercises = byOrder(rawExercises);
  if (hasDuplicates(snapshotExercises.map((exercise) => exercise.prescriptionExerciseId))) return err("DUPLICATE_PRESCRIPTION_IDENTITY");

  const expected = application.exercises.filter((exercise) => exercise.retainedPlannedSetIds.length > 0);
  if (snapshotExercises.length !== expected.length) return err("PARTITION_MISMATCH");

  for (const exercise of snapshotExercises) {
    const selection = expected.find((candidate) => candidate.plannedExerciseId === exercise.prescriptionExerciseId);
    if (selection === undefined) return err("UNKNOWN_EXERCISE");
    const snapshotSetIds = byOrder(exercise.sets).map((set) => set.prescriptionSetId);
    if (!sameSequence(snapshotSetIds, selection.retainedPlannedSetIds)) return err("PARTITION_MISMATCH");
  }

  return ok(true);
}

function isSnapshotSet(value: unknown): value is PrescribedSetV1 {
  return isRecord(value) && typeof value["prescriptionSetId"] === "string" && typeof value["order"] === "number";
}

function isSnapshotExercise(value: unknown): value is PrescribedExerciseV1 {
  return (
    isRecord(value) &&
    typeof value["prescriptionExerciseId"] === "string" &&
    typeof value["order"] === "number" &&
    Array.isArray(value["sets"]) &&
    value["sets"].every(isSnapshotSet)
  );
}
