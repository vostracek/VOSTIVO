import { and, asc, eq } from "drizzle-orm";
import {
  missedWorkoutScheduleApplications,
  missedWorkoutScheduleAssignments,
  plannedWorkouts,
  trainingCycles,
  type Database,
} from "@vostivo/database";
import { resolveEffectiveSchedule, type EffectiveScheduleFields, type PlannedWorkoutStatus } from "@vostivo/domain";

/**
 * Missed Workout V1 Slice C — the ONE server loader of a TrainingBlock's
 * EFFECTIVE schedule: authored planned workouts + the block's single
 * ACTIVE missed-workout schedule application (owned by THIS athlete
 * profile only — another athlete's rows can never affect it), resolved by
 * the pure `resolveEffectiveSchedule`. Plan/Today, Workout Preview and
 * Missed Workout preview/apply all read it. Read only.
 */
export interface ActiveScheduleOverlay {
  readonly applicationId: string;
  readonly assignments: readonly { readonly plannedWorkoutId: string; readonly effectiveScheduledLocalDate: string | null }[];
}

export async function loadActiveScheduleOverlay(db: Database, athleteProfileId: string, trainingBlockId: string): Promise<ActiveScheduleOverlay | null> {
  const [application] = await db
    .select({ id: missedWorkoutScheduleApplications.id })
    .from(missedWorkoutScheduleApplications)
    .where(
      and(
        eq(missedWorkoutScheduleApplications.athleteProfileId, athleteProfileId),
        eq(missedWorkoutScheduleApplications.trainingBlockId, trainingBlockId),
        eq(missedWorkoutScheduleApplications.status, "ACTIVE"),
      ),
    );
  if (application === undefined) return null;
  const assignments = await db
    .select({ plannedWorkoutId: missedWorkoutScheduleAssignments.plannedWorkoutId, effectiveScheduledLocalDate: missedWorkoutScheduleAssignments.effectiveScheduledLocalDate })
    .from(missedWorkoutScheduleAssignments)
    .where(eq(missedWorkoutScheduleAssignments.applicationId, application.id));
  return { applicationId: application.id, assignments };
}

export interface BlockOccurrence {
  readonly plannedWorkoutId: string;
  readonly displayName: string;
  readonly trainingCycleId: string;
  readonly cycleOrder: number;
  readonly workoutOrder: number;
  readonly authoredScheduledLocalDate: string | null;
  readonly status: PlannedWorkoutStatus;
}

export interface EffectiveBlockSchedule {
  readonly activeScheduleApplicationId: string | null;
  readonly overlay: ActiveScheduleOverlay | null;
  /** Every planned workout of the block, authored order, with authored AND effective dates. */
  readonly occurrences: readonly (BlockOccurrence & EffectiveScheduleFields)[];
}

export async function loadEffectiveBlockSchedule(db: Database, athleteProfileId: string, trainingBlockId: string): Promise<EffectiveBlockSchedule> {
  const authored = await db
    .select({
      plannedWorkoutId: plannedWorkouts.id,
      displayName: plannedWorkouts.name,
      trainingCycleId: trainingCycles.id,
      cycleOrder: trainingCycles.orderIndex,
      workoutOrder: plannedWorkouts.orderIndex,
      authoredScheduledLocalDate: plannedWorkouts.scheduledDate,
      status: plannedWorkouts.status,
    })
    .from(plannedWorkouts)
    .innerJoin(trainingCycles, eq(trainingCycles.id, plannedWorkouts.trainingCycleId))
    .where(eq(trainingCycles.trainingBlockId, trainingBlockId))
    .orderBy(asc(trainingCycles.orderIndex), asc(plannedWorkouts.orderIndex), asc(plannedWorkouts.id));
  const overlay = await loadActiveScheduleOverlay(db, athleteProfileId, trainingBlockId);
  return {
    activeScheduleApplicationId: overlay?.applicationId ?? null,
    overlay,
    occurrences: resolveEffectiveSchedule(authored, overlay?.assignments ?? null),
  };
}

/** The effective date of ONE planned workout (Workout Preview `displayStatus`). */
export async function resolveEffectiveScheduledDate(
  db: Database,
  athleteProfileId: string,
  trainingBlockId: string,
  plannedWorkoutId: string,
  authoredScheduledLocalDate: string | null,
): Promise<string | null> {
  const overlay = await loadActiveScheduleOverlay(db, athleteProfileId, trainingBlockId);
  const [resolved] = resolveEffectiveSchedule([{ plannedWorkoutId, authoredScheduledLocalDate }], overlay?.assignments ?? null);
  return resolved?.effectiveScheduledLocalDate ?? null;
}
