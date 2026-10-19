import { eq, inArray } from "drizzle-orm";
import { plannedExercises, plannedSets, plannedWorkouts, type Database } from "@vostivo/database";
import { err, ok, type Result, type WorkoutPrescriptionV1 } from "@vostivo/domain";
import type { AvailableTimeExerciseRow } from "./available-time-preview.js";
import { findOwnedPlannedWorkoutSource, loadAvailableTimeExerciseRows, type OwnedPlannedWorkoutSource } from "./available-time-source.js";

/**
 * The ONE server check of the canonical Plan provenance a
 * `START_WORKOUT_SESSION_V1` snapshot claims — run for EVERY start
 * (ordinary and Available-Time adjusted), before anything is written.
 * Identities inside a client snapshot are never trusted just because they
 * arrived there: progression later resolves `prescriptionExerciseId`
 * against `planned_exercises`, so a smuggled foreign id would reach
 * another athlete's plan.
 *
 * - PLANNED: `prescriptionId` is a planned workout. It must be owned by the
 *   authenticated user (ownership, not freshness — an owned, no-longer-
 *   current ProgramVersion is fine), and every exercise/set identity in the
 *   snapshot must be that workout's own planned exercise/set (each set under
 *   its own exercise).
 * - UNPLANNED: `prescriptionId` is not a planned workout (an ad-hoc,
 *   non-Plan-backed prescription — a legitimate state, see
 *   docs/domain/PROGRESSION-APPLICATION-V1.md §5.2). It may then carry NO
 *   planned exercise/set identity at all — an unplanned workout is never
 *   silently turned into a planned one.
 *
 * Any violation is REJECTED with no reason detail on the wire: the answer
 * never says whose plan an id belongs to. Internally, `FOREIGN_PLANNED_WORKOUT`
 * (the claimed planned workout exists but belongs to someone else) is kept
 * apart from every other `INVALID_PLAN_PROVENANCE` so the command processor
 * can reject it statelessly (Auth & Local Athlete Boundary V1 Slice A — a
 * foreign-ownership failure leaves no receipt). Only string identities are
 * inspected — the snapshot stays an opaque document otherwise, exactly as
 * before.
 */
export type StartProvenanceError = "INVALID_PLAN_PROVENANCE" | "FOREIGN_PLANNED_WORKOUT";

export type StartProvenance =
  | { readonly kind: "UNPLANNED" }
  | { readonly kind: "PLANNED"; readonly source: OwnedPlannedWorkoutSource; readonly exercises: readonly AvailableTimeExerciseRow[] };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface SnapshotIdentities {
  readonly exercises: readonly { readonly id: string; readonly setIds: readonly string[] }[];
}

/** Every string exercise/set identity in the (untrusted, opaque) snapshot — never throws on a hostile shape. */
function collectIdentities(snapshot: WorkoutPrescriptionV1): SnapshotIdentities {
  const rawExercises: unknown = snapshot.exercises;
  if (!Array.isArray(rawExercises)) return { exercises: [] };
  return {
    exercises: rawExercises.filter(isRecord).flatMap((exercise) => {
      const rawSets = exercise["sets"];
      const setIds = Array.isArray(rawSets)
        ? rawSets.filter(isRecord).flatMap((set) => (typeof set["prescriptionSetId"] === "string" ? [set["prescriptionSetId"]] : []))
        : [];
      const id = exercise["prescriptionExerciseId"];
      // An exercise without a string id still has its set ids checked.
      return [{ id: typeof id === "string" ? id : "", setIds }];
    }),
  };
}

export async function resolveStartProvenance(
  db: Database,
  userId: string,
  snapshot: WorkoutPrescriptionV1,
): Promise<Result<StartProvenance, StartProvenanceError>> {
  const identities = collectIdentities(snapshot);
  const workoutId = snapshot.prescriptionId;

  if (UUID_PATTERN.test(workoutId)) {
    const owned = await findOwnedPlannedWorkoutSource(db, userId, workoutId);
    if (owned !== undefined) {
      const exercises = await loadAvailableTimeExerciseRows(db, owned.plannedWorkoutId);
      const setIdsByExercise = new Map(exercises.map((exercise) => [exercise.id, new Set(exercise.sets.map((set) => set.id))]));
      for (const exercise of identities.exercises) {
        const ownSetIds = setIdsByExercise.get(exercise.id);
        if (ownSetIds === undefined || !exercise.setIds.every((setId) => ownSetIds.has(setId))) return err("INVALID_PLAN_PROVENANCE");
      }
      return ok({ kind: "PLANNED", source: owned, exercises });
    }
    // Not the user's: a planned workout of someone else is never attachable.
    const [foreignWorkout] = await db.select({ id: plannedWorkouts.id }).from(plannedWorkouts).where(eq(plannedWorkouts.id, workoutId)).limit(1);
    if (foreignWorkout !== undefined) return err("FOREIGN_PLANNED_WORKOUT");
  }

  // UNPLANNED: no planned exercise/set identity may appear at all.
  const exerciseIds = identities.exercises.map((exercise) => exercise.id).filter((id) => UUID_PATTERN.test(id));
  const setIds = identities.exercises.flatMap((exercise) => exercise.setIds).filter((id) => UUID_PATTERN.test(id));
  if (exerciseIds.length > 0) {
    const [planned] = await db.select({ id: plannedExercises.id }).from(plannedExercises).where(inArray(plannedExercises.id, exerciseIds)).limit(1);
    if (planned !== undefined) return err("INVALID_PLAN_PROVENANCE");
  }
  if (setIds.length > 0) {
    const [planned] = await db.select({ id: plannedSets.id }).from(plannedSets).where(inArray(plannedSets.id, setIds)).limit(1);
    if (planned !== undefined) return err("INVALID_PLAN_PROVENANCE");
  }
  return ok({ kind: "UNPLANNED" });
}
