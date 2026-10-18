import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import {
  plannedExercises,
  plannedSets,
  plannedWorkouts,
  programVersions,
  programs,
  trainingBlocks,
  trainingCycles,
  type Database,
} from "@vostivo/database";
import {
  asEntityId,
  createWorkoutPrescriptionFromPlannedWorkout,
  deriveSessionDisplayStatus,
  repTargetFromRange,
  resolveEffectiveSchedule,
  type EffectiveScheduleFields,
  type ExternalWeightLoad,
  type PlannedExercise as DomainPlannedExercise,
  type PlannedSet as DomainPlannedSet,
  type PlannedWorkout as DomainPlannedWorkout,
  type RepTargetV1,
  type WorkoutPrescriptionV1,
} from "@vostivo/domain";
import type {
  PlanCurrentBlockV1,
  PlanFocusAreaV1,
  PlanOverviewV1,
  PlanScheduleV1,
  PlanSessionSummaryV1,
  WorkoutPreviewExerciseV1,
  WorkoutPreviewSetV1,
  WorkoutPreviewV1,
} from "@vostivo/contracts";
import { deriveUniformWorkingLoad, resolveEffectiveWorkingLoadForOccurrence } from "@vostivo/progression-application";
import { DATABASE } from "../database/database.module.js";
import { CLOCK, type Clock } from "../common/clock.js";
import { resolveAthleteScheduleContext, resolveAthleteScheduleDate, type AthleteScheduleContext } from "../schedule/athlete-schedule-context.js";
import { resolveEffectiveEquipmentSubstitutions, type EffectiveEquipmentSubstitution } from "./effective-equipment-adaptation.js";
import { loadActiveScheduleOverlay, resolveEffectiveScheduledDate } from "../schedule/effective-schedule-source.js";
import type { AuthenticatedActor } from "../auth/authenticated-actor.js";
import { findMatchingSessions, type MatchingSessionInfo } from "./planned-workout-sessions.js";

const NO_PLAN_SCHEDULE: PlanScheduleV1 = { state: "NO_PLAN", displayedCycle: null };
const EMPTY_PLAN_OVERVIEW: PlanOverviewV1 = { currentBlock: null, sessions: [], weeklyFocus: [], schedule: NO_PLAN_SCHEDULE };

type TrainingBlockRow = typeof trainingBlocks.$inferSelect;
type TrainingCycleRow = typeof trainingCycles.$inferSelect;
type PlannedWorkoutRow = typeof plannedWorkouts.$inferSelect;

/** The overview plus the internal schedule context it was built from (for tests/diagnostics — not on the wire). */
export interface CurrentPlanRead {
  readonly overview: PlanOverviewV1;
  /** `undefined` only when the actor has no athlete profile. */
  readonly scheduleContext: AthleteScheduleContext | undefined;
}

/**
 * Builds the explicit Plan read projections (spec section 19/22) — the
 * mobile client never reconstructs the Program/ProgramVersion/
 * TrainingBlock/TrainingCycle/PlannedWorkout relational graph itself, and
 * these are never serialized ORM rows. See
 * docs/architecture/PLAN-PRESCRIPTION.md for the full read-model design.
 *
 * Schedule Calendar Authority V1: "today", the active program and the
 * current block/cycle come ONLY from `resolveAthleteScheduleContext` — the
 * same answer Missed Workout uses. Ordinary reads stay available for an
 * athlete without a training time zone (LEGACY_UTC_FALLBACK).
 */
@Injectable()
export class PlanReadService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async getCurrentPlanOverview(actor: AuthenticatedActor): Promise<PlanOverviewV1> {
    return (await this.readCurrentPlan(actor)).overview;
  }

  async readCurrentPlan(actor: AuthenticatedActor): Promise<CurrentPlanRead> {
    const scheduleContext = await resolveAthleteScheduleContext(this.db, actor, this.clock.now());
    if (scheduleContext === undefined) return { overview: EMPTY_PLAN_OVERVIEW, scheduleContext };
    const { program, calendar, date } = scheduleContext;

    // Only genuine configuration defects are errors — never an arbitrary first row.
    if (program.kind === "AMBIGUOUS") throw new ConflictException("ACTIVE_PROGRAM_AMBIGUOUS");
    if (program.kind === "NONE" || calendar === null) return { overview: EMPTY_PLAN_OVERVIEW, scheduleContext };
    if (calendar.kind === "AMBIGUOUS") throw new ConflictException("CURRENT_SCHEDULE_AMBIGUOUS");

    if (calendar.kind === "NO_SCHEDULE") {
      // Unchanged surface: blocks without any cycle show the last block's focus.
      const blocks = await this.db
        .select()
        .from(trainingBlocks)
        .where(eq(trainingBlocks.programVersionId, program.programVersionId))
        .orderBy(asc(trainingBlocks.orderIndex));
      const lastBlock = blocks.at(-1);
      return { overview: { ...EMPTY_PLAN_OVERVIEW, weeklyFocus: lastBlock === undefined ? [] : toPlanFocusAreas(lastBlock) }, scheduleContext };
    }

    // CURRENT MEANS DATE-CONTAINING: outside a current cycle the screens
    // still show a nearby cycle, but labelled PRESENTATION_FALLBACK.
    const displayed = calendar.kind === "IN_CURRENT_BLOCK" ? calendar.currentCycle : calendar.presentationCycle;
    const schedule: PlanScheduleV1 = { state: calendar.kind, displayedCycle: calendar.kind === "IN_CURRENT_BLOCK" ? "CURRENT" : "PRESENTATION_FALLBACK" };
    const [block] = await this.db.select().from(trainingBlocks).where(eq(trainingBlocks.id, displayed.trainingBlockId));
    const [cycle] = await this.db.select().from(trainingCycles).where(eq(trainingCycles.id, displayed.trainingCycleId));
    if (block === undefined || cycle === undefined) throw new Error("Schedule calendar referenced a missing block/cycle");

    // TODAY USES EFFECTIVE SCHEDULE (Missed Workout V1 Slice C): the view
    // shows every workout of the displayed block whose EFFECTIVE date falls
    // in the displayed cycle's range — even one authored in an earlier cycle
    // (a rolled-forward Upper A on Wednesday) — plus the block's CARRYOVER
    // workouts (no known slot) and the cycle's own unscheduled ones. Without
    // an active overlay, effective = authored, so this is the authored view.
    const blockWorkouts = await this.db
      .select({ workout: plannedWorkouts, cycleOrder: trainingCycles.orderIndex })
      .from(plannedWorkouts)
      .innerJoin(trainingCycles, eq(trainingCycles.id, plannedWorkouts.trainingCycleId))
      .where(eq(trainingCycles.trainingBlockId, block.id))
      .orderBy(asc(trainingCycles.orderIndex), asc(plannedWorkouts.orderIndex), asc(plannedWorkouts.id));
    const overlay = await loadActiveScheduleOverlay(this.db, scheduleContext.athleteProfileId, block.id);
    const effective = resolveEffectiveSchedule(
      blockWorkouts.map(({ workout }) => ({ plannedWorkoutId: workout.id, authoredScheduledLocalDate: workout.scheduledDate, workout })),
      overlay?.assignments ?? null,
    );
    const inView = effective.filter((o) =>
      o.effectiveScheduledLocalDate !== null
        ? o.effectiveScheduledLocalDate >= cycle.startDate && o.effectiveScheduledLocalDate <= cycle.endDate
        : o.isCarryover || o.workout.trainingCycleId === cycle.id,
    );
    const workouts = blockWorkouts.filter(({ workout }) => workout.trainingCycleId === cycle.id).map(({ workout }) => workout);

    const matchingSessions = await this.findMatchingSessions(actor.userId, inView.map((o) => o.plannedWorkoutId));
    const workoutSessionsForDate: PlanSessionSummaryV1[] = inView.map((o) =>
      toSessionSummary({ ...toDomainPlannedWorkout(o.workout), scheduledDate: o.effectiveScheduledLocalDate }, o, matchingSessions.get(o.plannedWorkoutId), date.localDate),
    );
    const sessions = interleaveRestDays(workoutSessionsForDate, cycle);

    const currentBlockDto: PlanCurrentBlockV1 = {
      trainingBlockId: block.id,
      name: block.name,
      goal: block.goal,
      currentCycleOrder: cycle.orderIndex,
      cycleCount: block.cycleCount,
      daysPerWeek: workouts.length,
    };

    return { overview: { currentBlock: currentBlockDto, sessions, weeklyFocus: toPlanFocusAreas(block), schedule }, scheduleContext };
  }

  async getWorkoutPreview(
    actor: AuthenticatedActor,
    plannedWorkoutId: string,
  ): Promise<WorkoutPreviewV1 | undefined> {
    if (actor.athleteProfileId === undefined) return undefined;

    // Ownership join: planned_workouts -> training_cycles -> training_blocks
    // -> program_versions -> programs, athleteProfileId = the authenticated
    // actor's — never trusted from the request (spec section 16/46). A
    // workout that exists but belongs to another athlete returns the same
    // `undefined` as one that does not exist at all (no existence leakage).
    // Also carries the Program Slot Identity coordinates (Progression
    // Application V1 Slice C, task §45) this method needs to resolve each
    // exercise's effective (progression-overlaid) working load.
    const [ownedWorkout] = await this.db
      .select({
        workout: plannedWorkouts,
        trainingCycleOrderIndex: trainingCycles.orderIndex,
        trainingBlockId: trainingBlocks.id,
        programVersionId: programVersions.id,
      })
      .from(plannedWorkouts)
      .innerJoin(trainingCycles, eq(trainingCycles.id, plannedWorkouts.trainingCycleId))
      .innerJoin(trainingBlocks, eq(trainingBlocks.id, trainingCycles.trainingBlockId))
      .innerJoin(programVersions, eq(programVersions.id, trainingBlocks.programVersionId))
      .innerJoin(programs, eq(programs.id, programVersions.programId))
      .where(and(eq(plannedWorkouts.id, plannedWorkoutId), eq(programs.athleteProfileId, actor.athleteProfileId)))
      .limit(1);
    if (ownedWorkout === undefined) return undefined;
    const workoutRow = ownedWorkout.workout;

    const exerciseRows = await this.db
      .select()
      .from(plannedExercises)
      .where(eq(plannedExercises.plannedWorkoutId, workoutRow.id))
      .orderBy(asc(plannedExercises.orderIndex));

    const exerciseDetails = await Promise.all(
      exerciseRows.map(async (exerciseRow) => {
        const setRows = await this.db
          .select()
          .from(plannedSets)
          .where(eq(plannedSets.plannedExerciseId, exerciseRow.id))
          .orderBy(asc(plannedSets.orderIndex));

        // Progression Application V1 Slice C (task §45/§21/§22): the ONE
        // shared authoritative resolver — never re-implemented here. Falls
        // back to each set's own authored value (unchanged) when there is
        // no `exerciseRef` (a freeform, non-catalog exercise) or the
        // `WORKING` sets are not uniform (fail closed, never guesses).
        const authoredWorkingLoad = deriveUniformWorkingLoad(
          setRows.filter((s) => s.setType === "WORKING"),
        );
        const effectiveWorkingLoad =
          exerciseRow.exerciseRef !== null && authoredWorkingLoad !== null
            ? (
                await resolveEffectiveWorkingLoadForOccurrence(this.db, {
                  userId: actor.userId,
                  programVersionId: ownedWorkout.programVersionId,
                  trainingBlockId: ownedWorkout.trainingBlockId,
                  workoutOrderIndex: workoutRow.orderIndex,
                  exerciseOrderIndex: exerciseRow.orderIndex,
                  exerciseRef: exerciseRow.exerciseRef,
                  targetCycleOrderIndex: ownedWorkout.trainingCycleOrderIndex,
                  authoredWorkingLoad,
                })
              ).load
            : null;

        return { exerciseRow, setRows, effectiveWorkingLoad };
      }),
    );

    const matchingSessions = await this.findMatchingSessions(actor.userId, [workoutRow.id]);
    const matchingSession = matchingSessions.get(workoutRow.id);
    // Same schedule-date authority as the overview (ordinary read: legacy fallback allowed).
    const scheduleDate = await resolveAthleteScheduleDate(this.db, actor, this.clock.now());
    if (scheduleDate === undefined) return undefined;
    const todayIsoDate = scheduleDate.localDate;
    // TODAY/TODAY-status uses the EFFECTIVE date (an applied roll-forward may have moved it).
    const effectiveScheduledDate = await resolveEffectiveScheduledDate(this.db, actor.athleteProfileId, ownedWorkout.trainingBlockId, workoutRow.id, workoutRow.scheduledDate);
    const domainWorkout = toDomainPlannedWorkout(workoutRow);

    const authoredPrescription: WorkoutPrescriptionV1 = createWorkoutPrescriptionFromPlannedWorkout({
      workout: domainWorkout,
      exercises: exerciseDetails.map(({ exerciseRow, setRows, effectiveWorkingLoad }) => ({
        exercise: toDomainPlannedExercise(exerciseRow),
        sets: setRows.map((setRow) => toDomainPlannedSet(setRow, effectiveWorkingLoad)),
      })),
    });

    // Temporary Equipment / Gym Adaptation V1 Slice C — composition order:
    // effective schedule -> authored prescription (+ progression overlay)
    // -> TODAY_ONLY equipment substitution (identity + the substitute's OWN
    // load; set ids/types/reps/rest preserved) -> Available-Time selects
    // set ids at START. Only a still-valid, pre-start application applies.
    const substitutions: ReadonlyMap<string, EffectiveEquipmentSubstitution> =
      matchingSession === undefined
        ? await resolveEffectiveEquipmentSubstitutions(this.db, actor, workoutRow.id, new Map(exerciseRows.map((row) => [row.id, row.displayName])), this.clock.now())
        : new Map();
    const prescription: WorkoutPrescriptionV1 = {
      ...authoredPrescription,
      exercises: authoredPrescription.exercises.map((exercise) => {
        const substitution = substitutions.get(exercise.prescriptionExerciseId);
        if (substitution === undefined) return exercise;
        return {
          ...exercise,
          exerciseRef: substitution.substituteExerciseRef,
          displayName: substitution.substituteDisplayName,
          sets: exercise.sets.map((set) => ({ ...set, targetLoad: substitutedSetLoad(set.setType, substitution) })),
          substitution: substitution.provenance,
        };
      }),
    };

    const displayStatus = deriveSessionDisplayStatus({ ...domainWorkout, scheduledDate: effectiveScheduledDate }, matchingSession, todayIsoDate);
    const hasActiveSession = matchingSession?.status === "ACTIVE";

    const exercises: WorkoutPreviewExerciseV1[] = exerciseDetails.map(({ exerciseRow, setRows, effectiveWorkingLoad }) => {
      const substitution = substitutions.get(exerciseRow.id);
      return {
        plannedExerciseId: exerciseRow.id,
        displayName: substitution?.substituteDisplayName ?? exerciseRow.displayName,
        order: exerciseRow.orderIndex,
        sets: setRows.map(
          (setRow): WorkoutPreviewSetV1 => ({
            plannedSetId: setRow.id,
            order: setRow.orderIndex,
            targetReps: toDomainRepTarget(setRow),
            targetLoad: substitution === undefined ? toDomainLoad(setRow, effectiveWorkingLoad) : substitutedSetLoad(setRow.setType, substitution),
            restSeconds: setRow.restSeconds,
          }),
        ),
        ...(substitution === undefined ? {} : { substitution: substitution.provenance }),
      };
    });

    return {
      plannedWorkoutId: workoutRow.id,
      name: workoutRow.name,
      focus: workoutRow.focus,
      estimatedDurationMinutes: workoutRow.estimatedDurationMinutes,
      displayStatus,
      hasActiveSession,
      canStart: !hasActiveSession,
      exercises,
      prescription,
    };
  }

  private async findMatchingSessions(
    userId: string,
    plannedWorkoutIds: readonly string[],
  ): Promise<Map<string, MatchingSessionInfo>> {
    return findMatchingSessions(this.db, userId, plannedWorkoutIds);
  }
}

/**
 * Rest days are explicit but visually secondary (spec section 2/29/31) —
 * synthesized here for any date in the cycle's range with no scheduled
 * `PlannedWorkout`, since a rest day has no backing row at all. Only
 * dates within the cycle's own `[startDate, endDate]` are filled; a
 * workout with no `scheduledDate` (unscheduled) is appended at the end,
 * after the date-ordered rows, rather than silently dropped.
 */
function interleaveRestDays(
  workoutSessions: readonly PlanSessionSummaryV1[],
  cycle: TrainingCycleRow,
): PlanSessionSummaryV1[] {
  const byDate = new Map<string, PlanSessionSummaryV1>();
  const unscheduled: PlanSessionSummaryV1[] = [];
  for (const session of workoutSessions) {
    if (session.scheduledDate === null) {
      unscheduled.push(session);
    } else {
      byDate.set(session.scheduledDate, session);
    }
  }

  const result: PlanSessionSummaryV1[] = [];
  let restOrder = 0;
  for (const isoDate of eachDateInRange(cycle.startDate, cycle.endDate)) {
    const existing = byDate.get(isoDate);
    if (existing !== undefined) {
      result.push(existing);
      continue;
    }
    restOrder += 1;
    result.push({
      plannedWorkoutId: null,
      name: "Rest Day",
      focus: null,
      order: workoutSessions.length + restOrder,
      scheduledDate: isoDate,
      authoredScheduledDate: isoDate,
      scheduleSource: "AUTHORED",
      estimatedDurationMinutes: null,
      displayStatus: "REST",
      hasActiveSession: false,
    });
  }

  return [...result, ...unscheduled];
}

function eachDateInRange(startIsoDate: string, endIsoDate: string): string[] {
  const dates: string[] = [];
  let cursor = new Date(`${startIsoDate}T00:00:00.000Z`);
  const end = new Date(`${endIsoDate}T00:00:00.000Z`);
  while (cursor.getTime() <= end.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return dates;
}

/** `workout.scheduledDate` is the EFFECTIVE date; `schedule` carries the authored one. */
function toSessionSummary(
  workout: DomainPlannedWorkout,
  schedule: EffectiveScheduleFields,
  matchingSession: MatchingSessionInfo | undefined,
  todayIsoDate: string,
): PlanSessionSummaryV1 {
  return {
    plannedWorkoutId: workout.id,
    name: workout.name,
    focus: workout.focus,
    order: workout.order,
    scheduledDate: workout.scheduledDate,
    authoredScheduledDate: schedule.authoredScheduledLocalDate,
    scheduleSource: schedule.scheduleSource,
    estimatedDurationMinutes: workout.estimatedDurationMinutes,
    displayStatus: deriveSessionDisplayStatus(workout, matchingSession, todayIsoDate),
    hasActiveSession: matchingSession?.status === "ACTIVE",
  };
}

function toPlanFocusAreas(block: TrainingBlockRow): readonly PlanFocusAreaV1[] {
  return block.focusAreas.map((area) => ({ name: area.name, emphasis: area.emphasis }));
}

function toDomainPlannedWorkout(row: PlannedWorkoutRow): DomainPlannedWorkout {
  return {
    id: asEntityId(row.id),
    trainingCycleId: asEntityId(row.trainingCycleId),
    name: row.name,
    focus: row.focus,
    order: row.orderIndex,
    scheduledDate: row.scheduledDate,
    estimatedDurationMinutes: row.estimatedDurationMinutes,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toDomainPlannedExercise(row: typeof plannedExercises.$inferSelect): DomainPlannedExercise {
  return {
    id: asEntityId(row.id),
    plannedWorkoutId: asEntityId(row.plannedWorkoutId),
    exerciseRef: row.exerciseRef,
    displayName: row.displayName,
    order: row.orderIndex,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toDomainPlannedSet(row: typeof plannedSets.$inferSelect, effectiveWorkingLoad: ExternalWeightLoad | null = null): DomainPlannedSet {
  return {
    id: asEntityId(row.id),
    plannedExerciseId: asEntityId(row.plannedExerciseId),
    order: row.orderIndex,
    targetReps: toDomainRepTarget(row),
    targetLoad: toDomainLoad(row, effectiveWorkingLoad),
    restSeconds: row.restSeconds,
    setType: row.setType,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Trusted internal data (this repository's own prior writes), so an
 * invalid stored range throwing here is a real bug/corruption signal —
 * matching this file's `toDomainLoad`, which applies the same trust
 * boundary to Load Model columns.
 */
function toDomainRepTarget(row: { targetRepsMin: number | null; targetRepsMax: number | null }): RepTargetV1 | null {
  const result = repTargetFromRange({ minReps: row.targetRepsMin, maxReps: row.targetRepsMax });
  if (!result.ok) {
    throw new Error(`Invalid stored rep target (${result.error.reason}) for planned_sets row`);
  }
  return result.value;
}

/**
 * Progression Application V1 Slice C (task §21): `effectiveWorkingLoad`
 * overrides the authored value for `WORKING` sets only — `WARM_UP` (or
 * any non-`WORKING` set type) always shows its own authored value,
 * unconditionally, never inferred from the working-set progression
 * overlay (task §21's own worked example).
 */
/** A substitute NEVER inherits the authored load (working or warm-up): WORKING = its own resolved load or none; WARM_UP = none. */
function substitutedSetLoad(setType: string, substitution: EffectiveEquipmentSubstitution): ExternalWeightLoad | null {
  return setType === "WORKING" ? substitution.workingLoad : null;
}

function toDomainLoad(
  row: {
    loadKind: string | null;
    loadAmountMilli: number | null;
    loadUnit: string | null;
    loadBasis: string | null;
    setType?: string;
  },
  effectiveWorkingLoad: ExternalWeightLoad | null = null,
): ExternalWeightLoad | null {
  if (row.setType === "WORKING" && effectiveWorkingLoad !== null) {
    return effectiveWorkingLoad;
  }
  if (row.loadKind === null || row.loadAmountMilli === null || row.loadUnit === null || row.loadBasis === null) {
    return null;
  }
  return {
    kind: "EXTERNAL_WEIGHT",
    amountMilli: row.loadAmountMilli,
    unit: row.loadUnit as ExternalWeightLoad["unit"],
    basis: row.loadBasis as ExternalWeightLoad["basis"],
  };
}
