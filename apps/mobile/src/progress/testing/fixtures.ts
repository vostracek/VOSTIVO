import type {
  ExerciseExposureV1,
  ExerciseHistoryPageV1,
  ProgressImprovementV1,
  ProgressOverviewV1,
  ProgressPerformedSetV1,
  WorkoutHistoryDetailV1,
  WorkoutHistoryItemV1,
} from "@vostivo/contracts";

/** Journey A on Wednesday 2026-10-14. Day labels come from the server's `completedLocalDate`, never from `completedAt`. */
export const KG = (kg: number) => ({ kind: "EXTERNAL_WEIGHT" as const, amountMilli: kg * 1000, unit: "KG" as const, basis: "TOTAL" as const });

export const IDS = {
  upperA: "0199a1b2-0000-7000-8000-000000000001",
  lowerA: "0199a1b2-0000-7000-8000-000000000002",
  benchApplication: "0199a1b2-0000-7000-8000-0000000000a1",
  dumbbellApplication: "0199a1b2-0000-7000-8000-0000000000a2",
  nextUpperA: "0199a1b2-0000-7000-8000-0000000000b1",
} as const;

export const set = (order: number, reps: number, kg: number, setType: "WORKING" | "WARM_UP" = "WORKING"): ProgressPerformedSetV1 => ({ order, setType, reps, load: KG(kg) });

export function benchImprovement(overrides: Partial<ProgressImprovementV1> = {}): ProgressImprovementV1 {
  return {
    applicationId: IDS.benchApplication,
    exerciseRef: "bench-press",
    exerciseDisplayName: "Bench Press",
    fromLoad: KG(60),
    toLoad: KG(62.5),
    appliedAt: "2026-10-12T18:00:00.000Z",
    actor: "SYSTEM",
    basedOn: { workoutSessionId: IDS.upperA, sets: [set(2, 12, 60), set(3, 12, 60), set(4, 12, 60)] },
    nextExposure: { plannedWorkoutId: IDS.nextUpperA, scheduledDate: "2026-10-19", workoutName: "Upper A" },
    ...overrides,
  };
}

/** A temporary-equipment substitute that progressed under ITS OWN identity. */
export function dumbbellImprovement(): ProgressImprovementV1 {
  return benchImprovement({ applicationId: IDS.dumbbellApplication, exerciseRef: "dumbbell-bench-press", exerciseDisplayName: "Dumbbell Bench Press", fromLoad: KG(22), toLoad: KG(24), nextExposure: null, basedOn: { workoutSessionId: IDS.lowerA, sets: [set(1, 12, 22)] } });
}

export function workoutItem(overrides: Partial<WorkoutHistoryItemV1> = {}): WorkoutHistoryItemV1 {
  return {
    workoutSessionId: IDS.upperA,
    plannedWorkoutId: "0199a1b2-0000-7000-8000-0000000000c1",
    workoutName: "Upper A",
    startedAt: "2026-10-12T11:00:00.000Z",
    completedAt: "2026-10-12T12:05:00.000Z",
    completedLocalDate: "2026-10-12",
    durationSeconds: 3900,
    plannedWorkingSets: 5,
    completedWorkingSets: 4,
    completion: "PARTIAL",
    adaptations: { availableTime: false, equipment: false },
    ...overrides,
  };
}

export function overview(overrides: Partial<ProgressOverviewV1> = {}): ProgressOverviewV1 {
  return {
    schemaVersion: 1,
    athleteLocalDate: "2026-10-14",
    snapshot: { block: { name: "Strength Base", cycleOrder: 4, cycleCount: 6 }, thisWeek: { completed: 3, due: 4 } },
    improving: [benchImprovement()],
    recentWorkouts: [workoutItem({ workoutSessionId: IDS.lowerA, workoutName: "Lower A", completedAt: "2026-10-14T12:00:00.000Z", completedLocalDate: "2026-10-14", completion: "FULL", plannedWorkingSets: 1, completedWorkingSets: 1, adaptations: { availableTime: true, equipment: true } }), workoutItem()],
    ...overrides,
  };
}

export function workoutDetail(overrides: Partial<WorkoutHistoryDetailV1> = {}): WorkoutHistoryDetailV1 {
  return {
    workout: workoutItem(),
    exercises: [
      { exerciseRef: "bench-press", displayName: "Bench Press", substitution: null, plannedWorkingSets: 3, sets: [set(1, 10, 20, "WARM_UP"), set(2, 12, 60), set(3, 12, 60), set(4, 12, 60)] },
      { exerciseRef: "overhead-press", displayName: "Overhead Press", substitution: null, plannedWorkingSets: 2, sets: [set(1, 10, 30)] },
    ],
    availableTime: null,
    progressionEvents: [{ applicationId: IDS.benchApplication, exerciseRef: "bench-press", fromLoad: KG(60), toLoad: KG(62.5), appliedAt: "2026-10-12T18:00:00.000Z", actor: "SYSTEM" }],
    ...overrides,
  };
}

export function exposure(overrides: Partial<ExerciseExposureV1> = {}): ExerciseExposureV1 {
  return { workoutSessionId: IDS.upperA, completedAt: "2026-10-12T12:05:00.000Z", completedLocalDate: "2026-10-12", workoutName: "Upper A", isSubstitute: false, sets: [set(1, 10, 20, "WARM_UP"), set(2, 12, 60), set(3, 12, 60), set(4, 12, 60)], ...overrides };
}

export function exercisePage(overrides: Partial<ExerciseHistoryPageV1> = {}): ExerciseHistoryPageV1 {
  return { exerciseRef: "bench-press", displayName: "Bench Press", exposures: [exposure()], nextCursor: null, ...overrides };
}
