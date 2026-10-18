import type { WorkoutPrescriptionV1 } from "@vostivo/domain";

/**
 * Backward-compatibility patch for a real bug found during Progression
 * Prerequisites V1 native verification: `local_workout_sessions
 * .prescription_json` is an immutable snapshot, so any `WorkoutSession`
 * already `ACTIVE` on a device from before `PrescribedSetV1.setType`
 * existed has stored JSON with no `setType` on any of its sets — a plain
 * `JSON.parse(...) as WorkoutPrescriptionV1` cast doesn't runtime-check
 * this, so `set.setType` read `undefined` and broke `completeSet()`'s
 * outbox INSERT for that already-open session (confirmed via `adb
 * logcat`: `DrizzleError: ... VALUES (..., , 'COMPLETED', ...)` — a bare
 * empty SQL parameter where `set_type` should have been).
 *
 * `WORKING` is the only value defensible from actual history here — no
 * warm-up concept existed when these documents were frozen — the exact
 * same reasoning as the server-side Postgres backfill migration for
 * *rows* (`packages/database/drizzle/0006_*.sql`), applied here to an
 * already-serialized *document* instead. This does NOT reintroduce a
 * nullable "null means WORKING" representation for new data: every new
 * write still carries an explicit `setType`; this only patches reads of
 * pre-existing opaque documents frozen before the field existed.
 * `schemaVersion` correctly stays `1` — this is an additive,
 * backward-compatible read-time default, not a breaking contract change.
 */
export function normalizeStoredPrescription(value: unknown): WorkoutPrescriptionV1 {
  const prescription = value as WorkoutPrescriptionV1;
  return {
    ...prescription,
    exercises: prescription.exercises.map((exercise) => ({
      ...exercise,
      sets: exercise.sets.map((set) => ({
        ...set,
        setType: set.setType ?? "WORKING",
      })),
    })),
  };
}
