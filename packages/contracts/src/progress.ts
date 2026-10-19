import type { ExternalWeightLoad, SetType } from "@vostivo/domain";

/**
 * Progress & Feedback V1 — Slice A (docs/domain/PROGRESS-AND-FEEDBACK-V1.md
 * §6): the athlete Progress read model. Explicit read projections only —
 * never serialized ORM rows. Every value is a server fact: completed
 * CANONICAL workout sessions (Planned Workout Occurrence Authority V1 —
 * SECONDARY sessions never count), performed sets, and APPLIED progression
 * applications. No scores, streaks, tonnage or interpretation the server
 * cannot prove.
 */

export const PROGRESS_OVERVIEW_SCHEMA_VERSION = 1 as const;

/** "Week X of N · <block name>" — only while today is inside a current cycle, never for a presentation-fallback cycle. */
export interface ProgressBlockSnapshotV1 {
  readonly name: string;
  readonly cycleOrder: number;
  readonly cycleCount: number;
}

/**
 * "This week: N of M workouts done" for the CURRENT cycle on the effective
 * schedule. `due` = the cycle's workouts whose effective date is on or
 * before the athlete-local today, plus any already completed ones (a
 * workout done early still counts). Carryover workouts without a date are
 * not due until completed.
 */
export interface ProgressWeekSnapshotV1 {
  readonly completed: number;
  readonly due: number;
}

export interface ProgressSnapshotV1 {
  readonly block: ProgressBlockSnapshotV1 | null;
  readonly thisWeek: ProgressWeekSnapshotV1 | null;
}

/** One performed set as the athlete logged it. */
export interface ProgressPerformedSetV1 {
  readonly order: number;
  readonly setType: SetType;
  readonly reps: number;
  readonly load: ExternalWeightLoad;
}

/** The next not-yet-performed occurrence whose effective target comes from this application. */
export interface ProgressNextExposureV1 {
  readonly plannedWorkoutId: string;
  /** Effective (schedule-overlay) date; `null` = carryover, still owed but without a known training day. */
  readonly scheduledDate: string | null;
  readonly workoutName: string;
}

/**
 * One applied load change ("Bench Press · 60 → 62.5 kg · from 60 kg ×
 * 12/12/12"). Only applications that were actually applied (`appliedAt`
 * set) — a pending, kept-original or stale recommendation is never shown
 * as an improvement.
 */
export interface ProgressImprovementV1 {
  readonly applicationId: string;
  readonly exerciseRef: string;
  readonly exerciseDisplayName: string;
  readonly fromLoad: ExternalWeightLoad;
  readonly toLoad: ExternalWeightLoad;
  /** ISO-8601 instant. */
  readonly appliedAt: string;
  /** SYSTEM = GUIDED automatic apply; ATHLETE = the athlete applied it. */
  readonly actor: "SYSTEM" | "ATHLETE";
  /** The completed working sets of the exposure the decision was about. */
  readonly basedOn: {
    readonly workoutSessionId: string;
    readonly sets: readonly ProgressPerformedSetV1[];
  };
  readonly nextExposure: ProgressNextExposureV1 | null;
}

export interface WorkoutHistoryAdaptationsV1 {
  /** Started as an Available-Time adjusted session. */
  readonly availableTime: boolean;
  /** At least one exercise was a temporary equipment substitute. */
  readonly equipment: boolean;
}

/** One completed canonical workout session. */
export interface WorkoutHistoryItemV1 {
  readonly workoutSessionId: string;
  readonly plannedWorkoutId: string;
  readonly workoutName: string;
  /** ISO-8601 instants. */
  readonly startedAt: string;
  readonly completedAt: string;
  /**
   * The athlete-local calendar day (`YYYY-MM-DD`) of `completedAt`, derived
   * by the server in the athlete's training time zone (Schedule Calendar
   * Authority) — the ONLY value a client may show as the workout's day; never
   * re-derive it from `completedAt` in the device zone.
   */
  readonly completedLocalDate: string;
  /** Wall-clock start → finish (includes pauses). */
  readonly durationSeconds: number;
  /** Prescribed WORKING sets in the session snapshot. */
  readonly plannedWorkingSets: number;
  /** COMPLETED WORKING sets actually logged. */
  readonly completedWorkingSets: number;
  readonly completion: "FULL" | "PARTIAL";
  readonly adaptations: WorkoutHistoryAdaptationsV1;
}

export interface ProgressOverviewV1 {
  readonly schemaVersion: typeof PROGRESS_OVERVIEW_SCHEMA_VERSION;
  /** The server-owned athlete-local date the snapshot was computed for; `null` without an athlete profile. */
  readonly athleteLocalDate: string | null;
  readonly snapshot: ProgressSnapshotV1;
  /** Latest applied progressions, newest first (at most 5). */
  readonly improving: readonly ProgressImprovementV1[];
  /** Latest completed workouts, newest first (at most 5). */
  readonly recentWorkouts: readonly WorkoutHistoryItemV1[];
}

/** Keyset page; pass `nextCursor` back as `before` for the next page, `null` = no more. */
export interface WorkoutHistoryPageV1 {
  readonly items: readonly WorkoutHistoryItemV1[];
  readonly nextCursor: string | null;
}

export interface WorkoutHistoryExerciseV1 {
  /** The PERFORMED identity (a substitute's own ref); `null` only for an unperformed freeform exercise. */
  readonly exerciseRef: string | null;
  readonly displayName: string;
  /** Present only for a temporary equipment substitute. */
  readonly substitution: { readonly authoredDisplayName: string } | null;
  readonly plannedWorkingSets: number;
  /** COMPLETED sets only (warm-up and working), in logged order; empty = not performed. */
  readonly sets: readonly ProgressPerformedSetV1[];
}

/** An applied load change decided from this session's evidence. */
export interface WorkoutHistoryProgressionEventV1 {
  readonly applicationId: string;
  readonly exerciseRef: string;
  readonly fromLoad: ExternalWeightLoad;
  readonly toLoad: ExternalWeightLoad;
  readonly appliedAt: string;
  readonly actor: "SYSTEM" | "ATHLETE";
}

export interface WorkoutHistoryDetailV1 {
  readonly workout: WorkoutHistoryItemV1;
  readonly exercises: readonly WorkoutHistoryExerciseV1[];
  readonly availableTime: { readonly availableMinutes: number } | null;
  readonly progressionEvents: readonly WorkoutHistoryProgressionEventV1[];
}

/** One performance of an exercise identity (substitutes are their own identity, never merged with the authored one). */
export interface ExerciseExposureV1 {
  readonly workoutSessionId: string;
  readonly completedAt: string;
  /** The parent workout's `completedLocalDate` — the same calendar day in every Progress view. */
  readonly completedLocalDate: string;
  readonly workoutName: string;
  /** Performed as a temporary equipment substitute for another exercise. */
  readonly isSubstitute: boolean;
  /** COMPLETED sets only (warm-up and working), in logged order. */
  readonly sets: readonly ProgressPerformedSetV1[];
}

export interface ExerciseHistoryPageV1 {
  readonly exerciseRef: string;
  readonly displayName: string;
  readonly exposures: readonly ExerciseExposureV1[];
  readonly nextCursor: string | null;
}
