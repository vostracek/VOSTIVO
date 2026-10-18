import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Database } from "@vostivo/database";
import type { MissedWorkoutPreviewResponseV1 } from "@vostivo/contracts";
import { requireAthleteTimeZoneDate } from "@vostivo/domain";
import { findCanonicalOccurrenceSessions } from "@vostivo/progression-application";
import type { TimelineConstraintV1 } from "@vostivo/training-engine";
import { DATABASE } from "../database/database.module.js";
import { CLOCK, type Clock } from "../common/clock.js";
import type { AuthenticatedActor } from "../auth/authenticated-actor.js";
import { resolveAthleteScheduleContext } from "../schedule/athlete-schedule-context.js";
import { loadEffectiveBlockSchedule, type ActiveScheduleOverlay } from "../schedule/effective-schedule-source.js";
import {
  computeMissedWorkoutPreview,
  type MissedWorkoutPreviewSource,
  type ScheduleOccurrenceRow,
} from "./missed-workout-preview.js";

export interface MissedWorkoutPreviewOptions {
  /**
   * Internal seam only — never reachable from HTTP. No persisted timeline
   * concept exists in V1, so production is always FLEXIBLE; tests use this
   * to prove HARD_DEADLINE reaches the policy through the real service.
   */
  readonly timelineConstraint?: TimelineConstraintV1;
}

export interface DerivedMissedWorkoutSource {
  readonly source: MissedWorkoutPreviewSource;
  /** The block's ACTIVE schedule overlay the effective dates came from (null without one, or without a current block). */
  readonly overlay: ActiveScheduleOverlay | null;
}

/**
 * The ONE server re-derivation of the missed-workout/v1 source, shared by
 * the read-only preview and the Slice C apply transaction (pass the tx as
 * `db`). Throws the stable HTTP errors: 404 (no matching profile), 409
 * TRAINING_TIME_ZONE_REQUIRED (ADAPTATION NEVER USES THE LEGACY FALLBACK),
 * 409 CURRENT_TRAINING_BLOCK_UNRESOLVED (anything but IN_CURRENT_BLOCK,
 * except NO_PLAN/NO_SCHEDULE/BEFORE_PLAN, which evaluate to NO_CHANGE).
 * The policy reads EFFECTIVE dates; authored dates ride along.
 */
export async function deriveMissedWorkoutSource(
  db: Database,
  actor: AuthenticatedActor,
  instant: Date,
  options: MissedWorkoutPreviewOptions = {},
): Promise<DerivedMissedWorkoutSource> {
  // Schedule Calendar Authority V1: the same date/program/calendar answer
  // Today and Plan use. Deny by default: no (matching) athlete profile -> 404.
  const context = await resolveAthleteScheduleContext(db, actor, instant);
  if (context === undefined) throw new NotFoundException("Athlete profile not found");

  const date = requireAthleteTimeZoneDate(context.date);
  if (date === null) throw new ConflictException("TRAINING_TIME_ZONE_REQUIRED");

  const base = {
    athleteProfileId: context.athleteProfileId,
    trainingTimeZone: date.trainingTimeZone,
    athleteLocalDate: date.localDate,
    timelineConstraint: options.timelineConstraint ?? "FLEXIBLE",
  } as const;
  const nothingToEvaluate = (programVersionId: string | null): DerivedMissedWorkoutSource => ({
    source: { ...base, programVersionId, trainingBlockId: null, activeScheduleApplicationId: null, occurrences: [] },
    overlay: null,
  });

  const { program, calendar } = context;
  if (program.kind === "NONE") return nothingToEvaluate(null);
  // Several ACTIVE programs, overlapping blocks/cycles, a gap or an ended
  // plan: no strict current block -> fail closed.
  if (program.kind === "AMBIGUOUS" || calendar === null) throw new ConflictException("CURRENT_TRAINING_BLOCK_UNRESOLVED");
  if (calendar.kind === "NO_SCHEDULE" || calendar.kind === "BEFORE_PLAN") return nothingToEvaluate(program.programVersionId);
  if (calendar.kind !== "IN_CURRENT_BLOCK") throw new ConflictException("CURRENT_TRAINING_BLOCK_UNRESOLVED");

  const schedule = await loadEffectiveBlockSchedule(db, context.athleteProfileId, calendar.currentBlockId);
  // Canonical execution state comes ONLY from the occurrence claim — an
  // unclaimed or SECONDARY session never resolves an occurrence.
  const canonical = await findCanonicalOccurrenceSessions(db, actor.userId, schedule.occurrences.map((o) => o.plannedWorkoutId));
  const occurrences: ScheduleOccurrenceRow[] = schedule.occurrences.map((o) => ({
    plannedWorkoutId: o.plannedWorkoutId,
    displayName: o.displayName,
    cycleOrder: o.cycleOrder,
    workoutOrder: o.workoutOrder,
    authoredScheduledLocalDate: o.authoredScheduledLocalDate,
    scheduledLocalDate: o.effectiveScheduledLocalDate,
    status: o.status,
    canonicalSessionStatus: canonical.get(o.plannedWorkoutId)?.status ?? null,
  }));
  return {
    source: { ...base, programVersionId: program.programVersionId, trainingBlockId: calendar.currentBlockId, activeScheduleApplicationId: schedule.activeScheduleApplicationId, occurrences },
    overlay: schedule.overlay,
  };
}

/**
 * Missed Workout / Schedule Adaptation V1 — READ-ONLY server preview
 * orchestration (`docs/domain/MISSED-WORKOUT-ADAPTATION-V1.md` §9/§10).
 *
 * server clock + the athlete's explicit training time zone -> athlete local
 * date -> ACTIVE ProgramVersion -> its ONE current TrainingBlock (all its
 * cycles) -> its EFFECTIVE schedule (authored + the ACTIVE overlay) ->
 * canonical occurrence state (Occurrence Authority claims only) -> known
 * training slots -> `missed-workout/v1` -> preview contract.
 *
 * Only ever SELECTs — a preview is a recommendation, never an application.
 * The request carries no date, no slots and no ids.
 */
@Injectable()
export class MissedWorkoutPreviewService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async preview(actor: AuthenticatedActor, options: MissedWorkoutPreviewOptions = {}): Promise<MissedWorkoutPreviewResponseV1> {
    const { source } = await deriveMissedWorkoutSource(this.db, actor, this.clock.now(), options);
    return computeMissedWorkoutPreview(source);
  }
}
