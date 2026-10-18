import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import { athleteProfiles, plannedExercises, plannedSets, plannedWorkouts, programVersions, programs, trainingBlocks, trainingCycles, type Database } from "@vostivo/database";
import type { EquipmentAdaptationNotApplicableErrorV1, EquipmentAdaptationPreviewRequestV1, EquipmentAdaptationPreviewResponseV1 } from "@vostivo/contracts";
import { EXERCISE_EQUIPMENT_CATALOG_VERSION_V1, repTargetFromRange, requireAthleteTimeZoneDate } from "@vostivo/domain";
import { findCanonicalOccurrenceSessions } from "@vostivo/progression-application";
import { DATABASE } from "../database/database.module.js";
import { CLOCK, type Clock } from "../common/clock.js";
import type { AuthenticatedActor } from "../auth/authenticated-actor.js";
import { resolveAthleteScheduleContext } from "../schedule/athlete-schedule-context.js";
import { resolveEffectiveScheduledDate } from "../schedule/effective-schedule-source.js";
import { canonicalizeSessionInventory, computeEquipmentAdaptationPreview, type EquipmentPreviewExerciseRow } from "./equipment-adaptation-preview.js";

function notApplicable(reasonCode: EquipmentAdaptationNotApplicableErrorV1["reasonCode"]): ConflictException {
  const body: EquipmentAdaptationNotApplicableErrorV1 = { statusCode: 409, message: "EQUIPMENT_ADAPTATION_NOT_APPLICABLE", reasonCode };
  return new ConflictException(body);
}

export interface DerivedEquipmentAdaptation {
  readonly preview: EquipmentAdaptationPreviewResponseV1;
  readonly athleteProfileId: string;
  readonly programVersionId: string;
  readonly trainingBlockId: string;
  readonly trainingTimeZone: string;
  /** The current authored exercise rows (for building the effective prescription). */
  readonly exercises: readonly EquipmentPreviewExerciseRow[];
}

/** Today's pre-start effective workout an equipment adaptation (or its options) may target — every applicability check passed. */
export interface EquipmentAdaptationTarget {
  readonly plannedWorkoutId: string;
  readonly workoutName: string;
  readonly athleteProfileId: string;
  readonly programVersionId: string;
  readonly trainingBlockId: string;
  readonly athleteLocalDate: string;
  readonly effectiveScheduledDate: string;
  readonly trainingTimeZone: string;
}

/**
 * The ONE applicability authority for temporary equipment adaptation —
 * shared by the preview/apply derivation and the Slice D options read:
 * owned target (404) -> explicit training time zone (409) -> ACTIVE
 * ProgramVersion + strict current block -> effective date == athlete-local
 * today -> pre-start occurrence. Throws the stable HTTP errors.
 */
export async function resolveEquipmentAdaptationTarget(db: Database, actor: AuthenticatedActor, plannedWorkoutId: string, instant: Date): Promise<EquipmentAdaptationTarget> {
  if (actor.athleteProfileId === undefined) throw new NotFoundException("Planned workout not found");

  // Deny by default: not found and someone else's workout are the same 404 (no existence leakage).
  const [target] = await db
    .select({
      plannedWorkoutId: plannedWorkouts.id,
      name: plannedWorkouts.name,
      status: plannedWorkouts.status,
      authoredScheduledDate: plannedWorkouts.scheduledDate,
      trainingBlockId: trainingBlocks.id,
      programVersionId: programVersions.id,
    })
    .from(plannedWorkouts)
    .innerJoin(trainingCycles, eq(trainingCycles.id, plannedWorkouts.trainingCycleId))
    .innerJoin(trainingBlocks, eq(trainingBlocks.id, trainingCycles.trainingBlockId))
    .innerJoin(programVersions, eq(programVersions.id, trainingBlocks.programVersionId))
    .innerJoin(programs, eq(programs.id, programVersions.programId))
    .innerJoin(athleteProfiles, eq(athleteProfiles.id, programs.athleteProfileId))
    .where(and(eq(plannedWorkouts.id, plannedWorkoutId), eq(athleteProfiles.id, actor.athleteProfileId), eq(athleteProfiles.userId, actor.userId)))
    .limit(1);
  if (target === undefined) throw new NotFoundException("Planned workout not found");

  // ADAPTATION REQUIRES ATHLETE-LOCAL TODAY — never the legacy UTC fallback.
  const context = await resolveAthleteScheduleContext(db, actor, instant);
  if (context === undefined) throw new NotFoundException("Planned workout not found");
  const date = requireAthleteTimeZoneDate(context.date);
  if (date === null) throw new ConflictException("TRAINING_TIME_ZONE_REQUIRED");

  const { program, calendar } = context;
  if (program.kind !== "ACTIVE" || calendar === null || calendar.kind !== "IN_CURRENT_BLOCK") throw notApplicable("SCHEDULE_CONTEXT_UNRESOLVED");
  if (target.programVersionId !== program.programVersionId || target.trainingBlockId !== calendar.currentBlockId) throw notApplicable("OUTSIDE_CURRENT_BLOCK");
  if (target.status !== "PLANNED" && target.status !== "AVAILABLE") throw notApplicable("WORKOUT_RESOLVED");

  // EFFECTIVE SCHEDULE WINS OVER AUTHORED DATE (a rolled-forward workout is today's; its authored past date is irrelevant).
  const effectiveScheduledDate = await resolveEffectiveScheduledDate(db, context.athleteProfileId, target.trainingBlockId, target.plannedWorkoutId, target.authoredScheduledDate);
  if (effectiveScheduledDate !== date.localDate) throw notApplicable("NOT_TODAYS_WORKOUT");

  // PRE-START only: an occurrence with a canonical session (ACTIVE/COMPLETED) is never re-prescribed here.
  const canonical = await findCanonicalOccurrenceSessions(db, actor.userId, [target.plannedWorkoutId]);
  if (canonical.has(target.plannedWorkoutId)) throw notApplicable("WORKOUT_ALREADY_STARTED");

  return {
    plannedWorkoutId: target.plannedWorkoutId,
    workoutName: target.name,
    athleteProfileId: context.athleteProfileId,
    programVersionId: program.programVersionId,
    trainingBlockId: target.trainingBlockId,
    athleteLocalDate: date.localDate,
    effectiveScheduledDate,
    trainingTimeZone: date.trainingTimeZone,
  };
}

/**
 * The ONE server derivation of a temporary equipment adaptation — shared by
 * the read-only preview (Slice B), the apply transaction (Slice C, pass the
 * tx as `db`) and the effective Workout Preview revalidation. Throws the
 * stable HTTP errors described on the preview endpoint.
 */
export async function deriveEquipmentAdaptation(db: Database, actor: AuthenticatedActor, request: EquipmentAdaptationPreviewRequestV1, instant: Date): Promise<DerivedEquipmentAdaptation> {
  if (actor.athleteProfileId === undefined) throw new NotFoundException("Planned workout not found");

  // CATALOG VERSION PARTICIPATES IN PREVIEW STALENESS: never evaluate against a different catalog.
  if (request.catalogVersion !== EXERCISE_EQUIPMENT_CATALOG_VERSION_V1) throw new ConflictException("EQUIPMENT_CATALOG_VERSION_MISMATCH");
  const inventory = canonicalizeSessionInventory(request.availableEquipmentIds);
  if (!inventory.ok) throw new BadRequestException({ statusCode: 400, message: "UNKNOWN_EQUIPMENT_ID", unknownEquipmentIds: inventory.unknownEquipmentIds });

  const target = await resolveEquipmentAdaptationTarget(db, actor, request.plannedWorkoutId, instant);
  const exercises = await loadEquipmentPreviewExercises(db, target.plannedWorkoutId);
  if (exercises === null) throw new UnprocessableEntityException("EQUIPMENT_ADAPTATION_INVALID_PRESCRIPTION");

  const outcome = computeEquipmentAdaptationPreview({
    athleteProfileId: target.athleteProfileId,
    programVersionId: target.programVersionId,
    trainingBlockId: target.trainingBlockId,
    plannedWorkoutId: target.plannedWorkoutId,
    workoutName: target.workoutName,
    athleteLocalDate: target.athleteLocalDate,
    effectiveScheduledDate: target.effectiveScheduledDate,
    canonicalSessionStatus: null,
    exercises,
    availableEquipmentIds: inventory.availableEquipmentIds,
  });
  if (!outcome.ok) throw new UnprocessableEntityException(outcome.code);
  return {
    preview: outcome.preview,
    athleteProfileId: target.athleteProfileId,
    programVersionId: target.programVersionId,
    trainingBlockId: target.trainingBlockId,
    trainingTimeZone: target.trainingTimeZone,
    exercises,
  };
}

/** Authored exercises + set structure (no load: the policy never carries it). `null` = an invalid authored rep range. */
export async function loadEquipmentPreviewExercises(db: Database, plannedWorkoutId: string): Promise<EquipmentPreviewExerciseRow[] | null> {
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
      targetRepsMin: plannedSets.targetRepsMin,
      targetRepsMax: plannedSets.targetRepsMax,
    })
    .from(plannedSets)
    .where(inArray(plannedSets.plannedExerciseId, exerciseRows.map((row) => row.id)))
    .orderBy(asc(plannedSets.orderIndex));

  const exercises: EquipmentPreviewExerciseRow[] = [];
  for (const row of exerciseRows) {
    const sets = [];
    for (const set of setRows.filter((s) => s.plannedExerciseId === row.id)) {
      const targetReps = repTargetFromRange({ minReps: set.targetRepsMin, maxReps: set.targetRepsMax });
      if (!targetReps.ok) return null;
      sets.push({ plannedSetId: set.id, order: set.orderIndex, setType: set.setType, targetReps: targetReps.value, restSeconds: set.restSeconds });
    }
    exercises.push({ plannedExerciseId: row.id, exerciseRef: row.exerciseRef, displayName: row.displayName, order: row.orderIndex, priorityTier: row.priorityTier, minimumWorkingSets: row.minimumWorkingSets, sets });
  }
  return exercises;
}

/**
 * Temporary Equipment / Gym Adaptation V1 — Slice B: READ-ONLY server
 * preview (`docs/domain/TEMPORARY-EQUIPMENT-ADAPTATION-V1.md` §11).
 *
 * target identity (owned) -> athlete-local TODAY (explicit training time
 * zone, never the legacy UTC fallback) -> ACTIVE ProgramVersion + strict
 * current block -> EFFECTIVE schedule (the missed-workout overlay wins over
 * the authored date) -> pre-start occurrence (Occurrence Authority) ->
 * canonical catalog facts -> unchanged `equipment-adaptation/v1` -> preview.
 *
 * Only ever SELECTs: no session, claim, ProgramVersion, application,
 * decision, job or plan row is written. Exercise requirements, curated
 * candidates, locks and blocks are server-owned; the client sends only the
 * target id, the catalog version and the COMPLETE session inventory.
 */
@Injectable()
export class EquipmentAdaptationPreviewService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async preview(actor: AuthenticatedActor, request: EquipmentAdaptationPreviewRequestV1): Promise<EquipmentAdaptationPreviewResponseV1> {
    return (await deriveEquipmentAdaptation(this.db, actor, request, this.clock.now())).preview;
  }
}
