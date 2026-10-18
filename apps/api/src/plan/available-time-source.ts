import { and, asc, eq, inArray } from "drizzle-orm";
import {
  athleteProfiles,
  plannedExercises,
  plannedSets,
  plannedWorkouts,
  programVersions,
  programs,
  trainingBlocks,
  trainingCycles,
  type Database,
} from "@vostivo/database";
import type { AvailableTimeExerciseRow } from "./available-time-preview.js";

/**
 * Available-Time Adaptation V1 — the ONE way both the Slice B preview and
 * the Slice C adjusted-START verification read their source: the same
 * deny-by-default ownership join as the Workout Preview, and the same
 * canonical `planned_exercises`/`planned_sets` rows. Read-only.
 */
export interface OwnedPlannedWorkoutSource {
  readonly plannedWorkoutId: string;
  readonly programVersionId: string;
  readonly programVersionStatus: "DRAFT" | "ACTIVE" | "SUPERSEDED";
  readonly programStatus: "ACTIVE" | "ARCHIVED";
}

/**
 * `undefined` both when the workout does not exist and when it belongs to
 * someone else — callers must never distinguish the two (no existence
 * leakage). Ownership is `programs.athlete_profile_id` -> the athlete
 * profile of the server-derived `userId`, never a request value.
 */
export async function findOwnedPlannedWorkoutSource(
  db: Database,
  userId: string,
  plannedWorkoutId: string,
): Promise<OwnedPlannedWorkoutSource | undefined> {
  const [owned] = await db
    .select({
      plannedWorkoutId: plannedWorkouts.id,
      programVersionId: programVersions.id,
      programVersionStatus: programVersions.status,
      programStatus: programs.status,
    })
    .from(plannedWorkouts)
    .innerJoin(trainingCycles, eq(trainingCycles.id, plannedWorkouts.trainingCycleId))
    .innerJoin(trainingBlocks, eq(trainingBlocks.id, trainingCycles.trainingBlockId))
    .innerJoin(programVersions, eq(programVersions.id, trainingBlocks.programVersionId))
    .innerJoin(programs, eq(programs.id, programVersions.programId))
    .innerJoin(athleteProfiles, eq(athleteProfiles.id, programs.athleteProfileId))
    .where(and(eq(plannedWorkouts.id, plannedWorkoutId), eq(athleteProfiles.userId, userId)))
    .limit(1);
  return owned;
}

/** Canonical authored exercises + sets of one planned workout, in authored order. */
export async function loadAvailableTimeExerciseRows(db: Database, plannedWorkoutId: string): Promise<AvailableTimeExerciseRow[]> {
  const exerciseRows = await db
    .select({
      id: plannedExercises.id,
      exerciseRef: plannedExercises.exerciseRef,
      displayName: plannedExercises.displayName,
      orderIndex: plannedExercises.orderIndex,
      priorityTier: plannedExercises.priorityTier,
      minimumWorkingSets: plannedExercises.minimumWorkingSets,
    })
    .from(plannedExercises)
    .where(eq(plannedExercises.plannedWorkoutId, plannedWorkoutId))
    .orderBy(asc(plannedExercises.orderIndex));
  if (exerciseRows.length === 0) return [];

  const setRows = await db
    .select({
      id: plannedSets.id,
      plannedExerciseId: plannedSets.plannedExerciseId,
      orderIndex: plannedSets.orderIndex,
      setType: plannedSets.setType,
      restSeconds: plannedSets.restSeconds,
    })
    .from(plannedSets)
    .where(inArray(plannedSets.plannedExerciseId, exerciseRows.map((row) => row.id)))
    .orderBy(asc(plannedSets.orderIndex));

  return exerciseRows.map((exercise) => ({
    ...exercise,
    sets: setRows
      .filter((set) => set.plannedExerciseId === exercise.id)
      .map(({ id, orderIndex, setType, restSeconds }) => ({ id, orderIndex, setType, restSeconds })),
  }));
}
