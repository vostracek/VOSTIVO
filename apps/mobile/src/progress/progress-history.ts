import type { ExerciseExposureV1, WorkoutHistoryItemV1 } from "@vostivo/contracts";
import type { ProgressApiClient } from "./progress-api-client";
import type { HistoryPage } from "./paged-history-controller";
import { exposureKey } from "./progress-presentation";

/** Adapters from the two Slice A paged reads to `PagedHistoryController` — the cursor goes through untouched. */
export function workoutHistoryPages(api: Pick<ProgressApiClient, "getWorkoutHistory">): (before: string | null) => Promise<HistoryPage<WorkoutHistoryItemV1, null>> {
  return async (before) => {
    const page = await api.getWorkoutHistory(before);
    return { header: null, items: page.items, nextCursor: page.nextCursor };
  };
}

export interface ExerciseHistoryHeader {
  readonly exerciseRef: string;
  readonly displayName: string;
}

export function exerciseHistoryPages(
  api: Pick<ProgressApiClient, "getExerciseHistory">,
  exerciseRef: string,
): (before: string | null) => Promise<HistoryPage<ExerciseExposureV1, ExerciseHistoryHeader>> {
  return async (before) => {
    const page = await api.getExerciseHistory(exerciseRef, before);
    return { header: { exerciseRef: page.exerciseRef, displayName: page.displayName }, items: page.exposures, nextCursor: page.nextCursor };
  };
}

export const workoutHistoryKey = (item: WorkoutHistoryItemV1): string => item.workoutSessionId;
export const exerciseExposureKey = exposureKey;
