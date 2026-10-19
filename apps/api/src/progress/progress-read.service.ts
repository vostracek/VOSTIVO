import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import {
  athleteProfiles,
  availableTimeApplications,
  performedExercises,
  performedSets,
  plannedExercises,
  plannedSets,
  plannedWorkoutOccurrenceClaims,
  programVersions,
  programs,
  progressionApplications,
  progressionDecisions,
  workoutSessions,
  type Database,
} from "@vostivo/database";
import { exerciseEquipmentCatalogV1, resolveScheduleDateContext, type PrescribedSetV1, type WorkoutPrescriptionV1 } from "@vostivo/domain";
import type {
  ExerciseHistoryPageV1,
  ProgressImprovementV1,
  ProgressNextExposureV1,
  ProgressOverviewV1,
  ProgressPerformedSetV1,
  ProgressSnapshotV1,
  WorkoutHistoryDetailV1,
  WorkoutHistoryExerciseV1,
  WorkoutHistoryItemV1,
  WorkoutHistoryPageV1,
  WorkoutHistoryProgressionEventV1,
} from "@vostivo/contracts";
import { PROGRESS_OVERVIEW_SCHEMA_VERSION } from "@vostivo/contracts";
import {
  deriveUniformWorkingLoad,
  findCanonicalOccurrenceSessions,
  resolveEffectiveWorkingLoadForOccurrence,
  resolveExerciseDisplayName,
} from "@vostivo/progression-application";
import { DATABASE } from "../database/database.module.js";
import { CLOCK, type Clock } from "../common/clock.js";
import type { AuthenticatedActor } from "../auth/authenticated-actor.js";
import { PlanReadService } from "../plan/plan-read.service.js";
import { resolveAthleteScheduleDate } from "../schedule/athlete-schedule-context.js";
import { loadEffectiveBlockSchedule } from "../schedule/effective-schedule-source.js";
import { decodeProgressCursor, encodeProgressCursor, type ProgressCursor } from "./progress-cursor.js";
import { DEFAULT_PROGRESS_PAGE_LIMIT } from "./dto/progress-page-query.dto.js";

const OVERVIEW_ITEM_LIMIT = 5;
const MAX_EXERCISE_REF_LENGTH = 200;
const NO_SNAPSHOT: ProgressSnapshotV1 = { block: null, thisWeek: null };
/** Planned workouts that are still owed; SKIPPED / RESCHEDULED / CANCELLED are not "due" and never a next exposure. */
const OWED_WORKOUT_STATUSES: ReadonlySet<string> = new Set(["PLANNED", "AVAILABLE"]);

/**
 * "Was actually applied": the same eligibility the effective load resolver
 * uses (`appliedAt` set; APPLIED, or SUPERSEDED after having applied).
 * PENDING_REVIEW / KEPT_ORIGINAL / STALE / REVOKED are never improvements.
 */
const WAS_APPLIED: SQL = and(
  isNotNull(progressionApplications.appliedAt),
  isNotNull(progressionApplications.appliedLoad),
  isNotNull(progressionApplications.decidedByActorType),
  inArray(progressionApplications.status, ["APPLIED", "SUPERSEDED"]),
)!;

interface CanonicalSessionRow {
  readonly id: string;
  readonly plannedWorkoutId: string;
  readonly snapshot: WorkoutPrescriptionV1;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly cursorCompletedAt: string;
}

/** Instant -> athlete-local calendar day (`YYYY-MM-DD`). */
type LocalDateOf = (instant: Date) => string;

interface PageQuery {
  readonly before?: string;
  readonly limit?: number;
}

/**
 * Progress & Feedback V1 — Slice A (docs/domain/PROGRESS-AND-FEEDBACK-V1.md
 * §6): the athlete Progress read model. Read only — never writes.
 *
 * - OWNER-ONLY: workout history is owned by `userId` (the WDI ownership
 *   column), the Plan by `athleteProfileId`; both come only from the
 *   authenticated actor. Unknown and foreign ids are the same 404.
 * - CANONICAL-ONLY: a session counts only through its Planned Workout
 *   Occurrence Authority claim — SECONDARY sessions (another device of the
 *   same occurrence) and unclaimed sessions never appear.
 * - SUBSTITUTES NEVER MERGED: exercise history is keyed by the PERFORMED
 *   `exerciseRef`; a temporary substitute is its own identity.
 * - Improvements are APPLIED `progression_applications`, never pending
 *   recommendations or performed-history comparisons.
 */
@Injectable()
export class ProgressReadService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly planRead: PlanReadService,
  ) {}

  async getOverview(actor: AuthenticatedActor): Promise<ProgressOverviewV1> {
    const { snapshot, athleteLocalDate } = await this.readSnapshot(actor);
    const recentWorkouts = await this.toHistoryItems(await this.selectCanonicalCompletedSessions(actor.userId, undefined, OVERVIEW_ITEM_LIMIT), await this.localDateResolver(actor));
    const improving = await this.readImproving(actor, athleteLocalDate);
    return { schemaVersion: PROGRESS_OVERVIEW_SCHEMA_VERSION, athleteLocalDate, snapshot, improving, recentWorkouts };
  }

  async getWorkoutHistory(actor: AuthenticatedActor, query: PageQuery): Promise<WorkoutHistoryPageV1> {
    const cursor = parseCursor(query.before);
    const limit = query.limit ?? DEFAULT_PROGRESS_PAGE_LIMIT;
    const keyset = cursor === undefined ? undefined : sql`(${workoutSessions.completedAt}, ${workoutSessions.id}) < (${cursor.completedAt}::timestamptz, ${cursor.id}::uuid)`;
    const rows = await this.selectCanonicalCompletedSessions(actor.userId, keyset, limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: await this.toHistoryItems(page, await this.localDateResolver(actor)),
      nextCursor: rows.length > limit && last !== undefined ? encodeProgressCursor({ completedAt: last.cursorCompletedAt, id: last.id }) : null,
    };
  }

  async getWorkoutDetail(actor: AuthenticatedActor, workoutSessionId: string): Promise<WorkoutHistoryDetailV1> {
    const [row] = await this.selectCanonicalCompletedSessions(actor.userId, eq(workoutSessions.id, workoutSessionId), 1);
    if (row === undefined) throw new NotFoundException("Workout not found");
    const [workout] = await this.toHistoryItems([row], await this.localDateResolver(actor));

    const performed = await this.db
      .select({
        id: performedExercises.id,
        prescriptionExerciseId: performedExercises.prescriptionExerciseId,
        exerciseRef: performedExercises.exerciseRef,
        displayName: performedExercises.displayName,
      })
      .from(performedExercises)
      .where(eq(performedExercises.workoutSessionId, row.id))
      .orderBy(asc(performedExercises.orderIndex), asc(performedExercises.id));
    const setsByExercise = await this.completedSetsByPerformedExercise(performed.map((p) => p.id), false);

    // Snapshot order first (what was prescribed, performed or not), then
    // anything performed outside the prescription.
    const matched = new Set<string>();
    const exercises: WorkoutHistoryExerciseV1[] = [...row.snapshot.exercises]
      .sort((a, b) => a.order - b.order)
      .map((prescribed) => {
        const performedExercise = performed.find((p) => p.prescriptionExerciseId === prescribed.prescriptionExerciseId);
        if (performedExercise !== undefined) matched.add(performedExercise.id);
        return {
          exerciseRef: performedExercise?.exerciseRef ?? prescribed.exerciseRef,
          displayName: performedExercise?.displayName ?? prescribed.displayName,
          substitution: prescribed.substitution === undefined ? null : { authoredDisplayName: prescribed.substitution.authoredDisplayName },
          plannedWorkingSets: countWorkingSets(prescribed.sets),
          sets: performedExercise === undefined ? [] : (setsByExercise.get(performedExercise.id) ?? []),
        };
      });
    for (const extra of performed.filter((p) => !matched.has(p.id))) {
      exercises.push({ exerciseRef: extra.exerciseRef, displayName: extra.displayName, substitution: null, plannedWorkingSets: 0, sets: setsByExercise.get(extra.id) ?? [] });
    }

    const [availableTime] = await this.db
      .select({ availableMinutes: availableTimeApplications.availableMinutes })
      .from(availableTimeApplications)
      .where(and(eq(availableTimeApplications.workoutSessionId, row.id), eq(availableTimeApplications.userId, actor.userId)))
      .limit(1);

    const eventRows = await this.db
      .select({
        applicationId: progressionApplications.id,
        exerciseRef: progressionApplications.exerciseRef,
        fromLoad: progressionApplications.expectedEffectiveLoad,
        toLoad: progressionApplications.appliedLoad,
        appliedAt: progressionApplications.appliedAt,
        actor: progressionApplications.decidedByActorType,
      })
      .from(progressionApplications)
      .innerJoin(progressionDecisions, and(eq(progressionDecisions.id, progressionApplications.progressionDecisionId), eq(progressionDecisions.userId, progressionApplications.userId)))
      .where(and(eq(progressionApplications.userId, actor.userId), eq(progressionDecisions.sourceWorkoutSessionId, row.id), WAS_APPLIED))
      .orderBy(asc(progressionApplications.appliedAt), asc(progressionApplications.id));
    const progressionEvents: WorkoutHistoryProgressionEventV1[] = eventRows.map((event) => ({
      applicationId: event.applicationId,
      exerciseRef: event.exerciseRef,
      fromLoad: event.fromLoad,
      toLoad: requireApplied(event.toLoad),
      appliedAt: requireApplied(event.appliedAt).toISOString(),
      actor: requireApplied(event.actor),
    }));

    return { workout: workout!, exercises, availableTime: availableTime ?? null, progressionEvents };
  }

  async getExerciseHistory(actor: AuthenticatedActor, exerciseRef: string, query: PageQuery): Promise<ExerciseHistoryPageV1> {
    const cursor = parseCursor(query.before);
    if (exerciseRef.length === 0 || exerciseRef.length > MAX_EXERCISE_REF_LENGTH) throw new NotFoundException("Exercise history not found");
    const limit = query.limit ?? DEFAULT_PROGRESS_PAGE_LIMIT;
    const keyset = cursor === undefined ? undefined : sql`(${workoutSessions.completedAt}, ${performedExercises.id}) < (${cursor.completedAt}::timestamptz, ${cursor.id}::uuid)`;

    const rows = await this.db
      .select({
        performedExerciseId: performedExercises.id,
        prescriptionExerciseId: performedExercises.prescriptionExerciseId,
        displayName: performedExercises.displayName,
        workoutSessionId: workoutSessions.id,
        prescriptionSnapshot: workoutSessions.prescriptionSnapshot,
        completedAt: workoutSessions.completedAt,
        cursorCompletedAt: sql<string>`${workoutSessions.completedAt}::text`,
      })
      .from(performedExercises)
      .innerJoin(workoutSessions, eq(workoutSessions.id, performedExercises.workoutSessionId))
      .innerJoin(plannedWorkoutOccurrenceClaims, canonicalClaimJoin())
      .where(and(canonicalCompletedSessionFilter(actor.userId), eq(performedExercises.exerciseRef, exerciseRef), keyset))
      .orderBy(desc(workoutSessions.completedAt), desc(performedExercises.id))
      .limit(limit + 1);
    if (cursor === undefined && rows.length === 0) throw new NotFoundException("Exercise history not found");

    // Catalog name, else the newest name the athlete logged — never the raw ref as copy.
    const displayName = exerciseEquipmentCatalogV1.getExerciseDefinition(exerciseRef)?.displayName ?? (await this.latestPerformedDisplayName(actor.userId, exerciseRef));
    if (displayName === undefined) throw new NotFoundException("Exercise history not found");

    const page = rows.slice(0, limit);
    const setsByExercise = await this.completedSetsByPerformedExercise(page.map((r) => r.performedExerciseId), false);
    const localDateOf = await this.localDateResolver(actor);
    const last = page.at(-1);
    return {
      exerciseRef,
      displayName,
      exposures: page.map((r) => {
        const snapshot = r.prescriptionSnapshot as WorkoutPrescriptionV1;
        const prescribed = snapshot.exercises.find((e) => e.prescriptionExerciseId === r.prescriptionExerciseId);
        const completedAt = requireApplied(r.completedAt);
        return {
          workoutSessionId: r.workoutSessionId,
          completedAt: completedAt.toISOString(),
          // The parent session's day — same derivation as the workout history item.
          completedLocalDate: localDateOf(completedAt),
          workoutName: snapshot.name,
          isSubstitute: prescribed?.substitution !== undefined,
          sets: setsByExercise.get(r.performedExerciseId) ?? [],
        };
      }),
      nextCursor: rows.length > limit && last !== undefined ? encodeProgressCursor({ completedAt: last.cursorCompletedAt, id: last.performedExerciseId }) : null,
    };
  }

  /**
   * Snapshot of the CURRENT cycle only (never a presentation-fallback one),
   * from the same Plan projection Today/Plan use — one schedule authority.
   * A schedule configuration defect (ambiguous program/cycle — Plan answers
   * 409) only hides the snapshot; history stays readable.
   */
  private async readSnapshot(actor: AuthenticatedActor): Promise<{ readonly snapshot: ProgressSnapshotV1; readonly athleteLocalDate: string | null }> {
    let plan;
    try {
      plan = await this.planRead.readCurrentPlan(actor);
    } catch (error) {
      if (!(error instanceof ConflictException)) throw error;
      const date = await resolveAthleteScheduleDate(this.db, actor, this.clock.now());
      return { snapshot: NO_SNAPSHOT, athleteLocalDate: date?.localDate ?? null };
    }
    const { overview } = plan;
    const today = overview.athleteLocalDate;
    if (today === null || overview.currentBlock === null || overview.schedule.displayedCycle !== "CURRENT") {
      return { snapshot: NO_SNAPSHOT, athleteLocalDate: today };
    }
    const workouts = overview.sessions.filter((s) => s.plannedWorkoutId !== null);
    const completed = workouts.filter((s) => s.displayStatus === "COMPLETED").length;
    const due = workouts.filter(
      (s) => s.displayStatus === "COMPLETED" || ((s.displayStatus === "TODAY" || s.displayStatus === "PLANNED" || s.displayStatus === "IN_PROGRESS") && s.scheduledDate !== null && s.scheduledDate <= today),
    ).length;
    return {
      snapshot: {
        block: { name: overview.currentBlock.name, cycleOrder: overview.currentBlock.currentCycleOrder, cycleCount: overview.currentBlock.cycleCount },
        thisWeek: { completed, due },
      },
      athleteLocalDate: today,
    };
  }

  private async readImproving(actor: AuthenticatedActor, today: string | null): Promise<ProgressImprovementV1[]> {
    const rows = await this.db
      .select({
        applicationId: progressionApplications.id,
        exerciseRef: progressionApplications.exerciseRef,
        programVersionId: progressionApplications.programVersionId,
        trainingBlockId: progressionApplications.trainingBlockId,
        workoutOrderIndex: progressionApplications.workoutOrderIndex,
        exerciseOrderIndex: progressionApplications.exerciseOrderIndex,
        effectiveFromCycleOrderIndex: progressionApplications.effectiveFromCycleOrderIndex,
        fromLoad: progressionApplications.expectedEffectiveLoad,
        toLoad: progressionApplications.appliedLoad,
        appliedAt: progressionApplications.appliedAt,
        actor: progressionApplications.decidedByActorType,
        sourceWorkoutSessionId: progressionDecisions.sourceWorkoutSessionId,
        sourcePerformedExerciseId: progressionDecisions.sourcePerformedExerciseId,
        performedDisplayName: performedExercises.displayName,
      })
      .from(progressionApplications)
      .innerJoin(progressionDecisions, and(eq(progressionDecisions.id, progressionApplications.progressionDecisionId), eq(progressionDecisions.userId, progressionApplications.userId)))
      .innerJoin(performedExercises, eq(performedExercises.id, progressionDecisions.sourcePerformedExerciseId))
      .where(and(eq(progressionApplications.userId, actor.userId), WAS_APPLIED))
      .orderBy(desc(progressionApplications.appliedAt), desc(progressionApplications.id))
      .limit(OVERVIEW_ITEM_LIMIT);

    const basedOnSets = await this.completedSetsByPerformedExercise(rows.map((r) => r.sourcePerformedExerciseId), true);
    const improving: ProgressImprovementV1[] = [];
    for (const row of rows) {
      // The live canonical slot name (presentation-integrity rule); when the
      // Plan moved on, the name the athlete actually logged — never the raw ref.
      const exerciseDisplayName = (await resolveExerciseDisplayName(this.db, row)) ?? row.performedDisplayName;
      improving.push({
        applicationId: row.applicationId,
        exerciseRef: row.exerciseRef,
        exerciseDisplayName,
        fromLoad: row.fromLoad,
        toLoad: requireApplied(row.toLoad),
        appliedAt: requireApplied(row.appliedAt).toISOString(),
        actor: requireApplied(row.actor),
        basedOn: { workoutSessionId: row.sourceWorkoutSessionId, sets: basedOnSets.get(row.sourcePerformedExerciseId) ?? [] },
        nextExposure: await this.resolveNextExposure(actor, row, today),
      });
    }
    return improving;
  }

  /**
   * The next still-owed occurrence of the application's Program Slot whose
   * effective WORKING target is governed by THIS application — exactly what
   * Workout Preview (= START) will show. Sequence before calendar: the
   * earliest later cycle without a canonical session, on or after today (or
   * a carryover). `null` when a newer application governs it, the program
   * version is no longer the athlete's active one, or nothing is left.
   */
  private async resolveNextExposure(
    actor: AuthenticatedActor,
    application: {
      readonly applicationId: string;
      readonly exerciseRef: string;
      readonly programVersionId: string;
      readonly trainingBlockId: string;
      readonly workoutOrderIndex: number;
      readonly exerciseOrderIndex: number;
      readonly effectiveFromCycleOrderIndex: number;
    },
    today: string | null,
  ): Promise<ProgressNextExposureV1 | null> {
    if (actor.athleteProfileId === undefined || today === null) return null;
    const [activeVersion] = await this.db
      .select({ id: programVersions.id })
      .from(programVersions)
      .innerJoin(programs, eq(programs.id, programVersions.programId))
      .where(
        and(
          eq(programVersions.id, application.programVersionId),
          eq(programVersions.status, "ACTIVE"),
          eq(programs.status, "ACTIVE"),
          eq(programs.athleteProfileId, actor.athleteProfileId),
        ),
      )
      .limit(1);
    if (activeVersion === undefined) return null;

    const schedule = await loadEffectiveBlockSchedule(this.db, actor.athleteProfileId, application.trainingBlockId);
    const candidates = schedule.occurrences.filter(
      (o) =>
        o.workoutOrder === application.workoutOrderIndex &&
        o.cycleOrder > application.effectiveFromCycleOrderIndex &&
        OWED_WORKOUT_STATUSES.has(o.status) &&
        (o.effectiveScheduledLocalDate === null || o.effectiveScheduledLocalDate >= today),
    );
    const claimed = await findCanonicalOccurrenceSessions(this.db, actor.userId, candidates.map((c) => c.plannedWorkoutId));
    const next = candidates.find((c) => !claimed.has(c.plannedWorkoutId));
    if (next === undefined) return null;

    const [exercise] = await this.db
      .select({ id: plannedExercises.id, exerciseRef: plannedExercises.exerciseRef })
      .from(plannedExercises)
      .where(and(eq(plannedExercises.plannedWorkoutId, next.plannedWorkoutId), eq(plannedExercises.orderIndex, application.exerciseOrderIndex)))
      .limit(1);
    if (exercise === undefined || exercise.exerciseRef !== application.exerciseRef) return null;
    const workingSets = await this.db
      .select({ loadKind: plannedSets.loadKind, loadAmountMilli: plannedSets.loadAmountMilli, loadUnit: plannedSets.loadUnit, loadBasis: plannedSets.loadBasis })
      .from(plannedSets)
      .where(and(eq(plannedSets.plannedExerciseId, exercise.id), eq(plannedSets.setType, "WORKING")));
    const authoredWorkingLoad = deriveUniformWorkingLoad(workingSets);
    // Same precondition as Workout Preview: no uniform authored load -> no overlay.
    if (authoredWorkingLoad === null) return null;
    const resolution = await resolveEffectiveWorkingLoadForOccurrence(this.db, {
      userId: actor.userId,
      programVersionId: application.programVersionId,
      trainingBlockId: application.trainingBlockId,
      workoutOrderIndex: application.workoutOrderIndex,
      exerciseOrderIndex: application.exerciseOrderIndex,
      exerciseRef: application.exerciseRef,
      targetCycleOrderIndex: next.cycleOrder,
      authoredWorkingLoad,
    });
    if (resolution.sourceApplicationId !== application.applicationId) return null;
    return { plannedWorkoutId: next.plannedWorkoutId, scheduledDate: next.effectiveScheduledLocalDate, workoutName: next.displayName };
  }

  private async selectCanonicalCompletedSessions(userId: string, extra: SQL | undefined, limit: number): Promise<CanonicalSessionRow[]> {
    const rows = await this.db
      .select({
        id: workoutSessions.id,
        plannedWorkoutId: plannedWorkoutOccurrenceClaims.plannedWorkoutId,
        prescriptionSnapshot: workoutSessions.prescriptionSnapshot,
        startedAt: workoutSessions.startedAt,
        completedAt: workoutSessions.completedAt,
        cursorCompletedAt: sql<string>`${workoutSessions.completedAt}::text`,
      })
      .from(workoutSessions)
      .innerJoin(plannedWorkoutOccurrenceClaims, canonicalClaimJoin())
      .where(and(canonicalCompletedSessionFilter(userId), extra))
      .orderBy(desc(workoutSessions.completedAt), desc(workoutSessions.id))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      plannedWorkoutId: row.plannedWorkoutId,
      // Trusted internal write (the START command's validated prescription), same as the progression evidence reader.
      snapshot: row.prescriptionSnapshot as WorkoutPrescriptionV1,
      startedAt: row.startedAt,
      completedAt: requireApplied(row.completedAt),
      cursorCompletedAt: row.cursorCompletedAt,
    }));
  }

  /**
   * Athlete-local history days come from the athlete's training time zone
   * via the Schedule Calendar Authority's `resolveScheduleDateContext` (the
   * same ordinary-read rule as Today/Plan: no zone yet -> its legacy UTC
   * fallback). Never the device zone, never the scheduled date: a history
   * day is the day the canonical session was actually completed.
   */
  private async localDateResolver(actor: AuthenticatedActor): Promise<LocalDateOf> {
    const [profile] =
      actor.athleteProfileId === undefined
        ? []
        : await this.db
            .select({ trainingTimeZone: athleteProfiles.trainingTimeZone })
            .from(athleteProfiles)
            .where(and(eq(athleteProfiles.id, actor.athleteProfileId), eq(athleteProfiles.userId, actor.userId)))
            .limit(1);
    const trainingTimeZone = profile?.trainingTimeZone ?? null;
    return (instant) => resolveScheduleDateContext({ trainingTimeZone }, instant).localDate;
  }

  private async toHistoryItems(rows: readonly CanonicalSessionRow[], localDateOf: LocalDateOf): Promise<WorkoutHistoryItemV1[]> {
    if (rows.length === 0) return [];
    const sessionIds = rows.map((r) => r.id);
    const counts = await this.db
      .select({ workoutSessionId: performedExercises.workoutSessionId, count: sql<number>`count(*)::int` })
      .from(performedSets)
      .innerJoin(performedExercises, eq(performedExercises.id, performedSets.performedExerciseId))
      .where(and(inArray(performedExercises.workoutSessionId, sessionIds), eq(performedSets.setType, "WORKING"), eq(performedSets.completionState, "COMPLETED")))
      .groupBy(performedExercises.workoutSessionId);
    const completedBySession = new Map(counts.map((c) => [c.workoutSessionId, c.count]));
    const adjusted = await this.db
      .select({ workoutSessionId: availableTimeApplications.workoutSessionId })
      .from(availableTimeApplications)
      .where(inArray(availableTimeApplications.workoutSessionId, sessionIds));
    const adjustedSessions = new Set(adjusted.map((a) => a.workoutSessionId));

    return rows.map((row) => {
      const plannedWorkingSets = row.snapshot.exercises.reduce((sum, exercise) => sum + countWorkingSets(exercise.sets), 0);
      const completedWorkingSets = completedBySession.get(row.id) ?? 0;
      return {
        workoutSessionId: row.id,
        plannedWorkoutId: row.plannedWorkoutId,
        workoutName: row.snapshot.name,
        startedAt: row.startedAt.toISOString(),
        completedAt: row.completedAt.toISOString(),
        completedLocalDate: localDateOf(row.completedAt),
        durationSeconds: Math.max(0, Math.round((row.completedAt.getTime() - row.startedAt.getTime()) / 1000)),
        plannedWorkingSets,
        completedWorkingSets,
        completion: completedWorkingSets >= plannedWorkingSets ? "FULL" : "PARTIAL",
        adaptations: {
          availableTime: adjustedSessions.has(row.id),
          equipment: row.snapshot.exercises.some((exercise) => exercise.substitution !== undefined),
        },
      };
    });
  }

  /** COMPLETED sets per performed exercise, logged order. A REOPENED set was un-done and is not shown. */
  private async completedSetsByPerformedExercise(performedExerciseIds: readonly string[], workingOnly: boolean): Promise<Map<string, ProgressPerformedSetV1[]>> {
    const result = new Map<string, ProgressPerformedSetV1[]>();
    if (performedExerciseIds.length === 0) return result;
    const rows = await this.db
      .select({
        performedExerciseId: performedSets.performedExerciseId,
        orderIndex: performedSets.orderIndex,
        setType: performedSets.setType,
        actualReps: performedSets.actualReps,
        loadAmountMilli: performedSets.loadAmountMilli,
        loadUnit: performedSets.loadUnit,
        loadBasis: performedSets.loadBasis,
      })
      .from(performedSets)
      .where(
        and(
          inArray(performedSets.performedExerciseId, [...performedExerciseIds]),
          eq(performedSets.completionState, "COMPLETED"),
          workingOnly ? eq(performedSets.setType, "WORKING") : undefined,
        ),
      )
      .orderBy(asc(performedSets.orderIndex), asc(performedSets.id));
    for (const row of rows) {
      const sets = result.get(row.performedExerciseId) ?? [];
      sets.push({
        order: row.orderIndex,
        setType: row.setType,
        reps: row.actualReps,
        load: { kind: "EXTERNAL_WEIGHT", amountMilli: row.loadAmountMilli, unit: row.loadUnit, basis: row.loadBasis },
      });
      result.set(row.performedExerciseId, sets);
    }
    return result;
  }

  /** The newest name the athlete logged this ref under (canonical completed sessions); `undefined` = no history. */
  private async latestPerformedDisplayName(userId: string, exerciseRef: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ displayName: performedExercises.displayName })
      .from(performedExercises)
      .innerJoin(workoutSessions, eq(workoutSessions.id, performedExercises.workoutSessionId))
      .innerJoin(plannedWorkoutOccurrenceClaims, canonicalClaimJoin())
      .where(and(canonicalCompletedSessionFilter(userId), eq(performedExercises.exerciseRef, exerciseRef)))
      .orderBy(desc(workoutSessions.completedAt), desc(performedExercises.id))
      .limit(1);
    return row?.displayName;
  }
}

/** A session joins only through ITS OWN claim as the canonical session (same owner). */
function canonicalClaimJoin(): SQL {
  return and(eq(plannedWorkoutOccurrenceClaims.canonicalWorkoutSessionId, workoutSessions.id), eq(plannedWorkoutOccurrenceClaims.userId, workoutSessions.userId))!;
}

function canonicalCompletedSessionFilter(userId: string): SQL {
  return and(eq(workoutSessions.userId, userId), eq(workoutSessions.status, "COMPLETED"), isNotNull(workoutSessions.completedAt))!;
}

function parseCursor(raw: string | undefined): ProgressCursor | undefined {
  if (raw === undefined) return undefined;
  const cursor = decodeProgressCursor(raw);
  if (cursor === undefined) throw new BadRequestException("INVALID_CURSOR");
  return cursor;
}

/** Legacy snapshots predate `setType`; a missing value is WORKING (same rule as the mobile read compat). */
function countWorkingSets(sets: readonly PrescribedSetV1[]): number {
  return sets.filter((set) => set.setType !== "WARM_UP").length;
}

/** Guarded by the SQL filter (`WAS_APPLIED` / COMPLETED sessions); a null here is corruption, never a display state. */
function requireApplied<T>(value: T | null): T {
  if (value === null) throw new Error("Progress read model: a filtered non-null column was null");
  return value;
}
