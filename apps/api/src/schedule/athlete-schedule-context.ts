import { and, eq } from "drizzle-orm";
import { athleteProfiles, programVersions, programs, trainingBlocks, trainingCycles, type Database } from "@vostivo/database";
import { classifyScheduleCalendar, resolveScheduleDateContext, type ScheduleCalendarState, type ScheduleCycleRef, type ScheduleDateContext } from "@vostivo/domain";
import type { AuthenticatedActor } from "../auth/authenticated-actor.js";

/**
 * Schedule Calendar Authority V1 — the ONE server answer to "what is the
 * athlete's schedule date, which plan applies, and where in it are they?"
 * (docs/domain/SCHEDULE-CALENDAR-AUTHORITY-V1.md). Today, Plan, Workout
 * Preview and Missed Workout all resolve it here; none answers it alone.
 * Read only.
 */

export type ActiveProgramResolution =
  | { readonly kind: "NONE" }
  | { readonly kind: "ACTIVE"; readonly programId: string; readonly programVersionId: string }
  /** More than one ACTIVE program — a configuration defect; never an arbitrary first row. */
  | { readonly kind: "AMBIGUOUS"; readonly programIds: readonly string[] };

/**
 * ACTIVE PROGRAM SELECTION MUST BE DETERMINISTIC. The DB only enforces one
 * ACTIVE version per *program* (`program_versions_one_active_per_program`);
 * nothing enforces one ACTIVE program per athlete, so that is decided here:
 * zero -> NONE, two or more -> AMBIGUOUS, exactly one -> its ACTIVE
 * version (DB-unique), or NONE when it has none.
 */
export async function resolveActiveProgram(db: Database, athleteProfileId: string): Promise<ActiveProgramResolution> {
  const active = await db
    .select({ id: programs.id })
    .from(programs)
    .where(and(eq(programs.athleteProfileId, athleteProfileId), eq(programs.status, "ACTIVE")));
  if (active.length === 0) return { kind: "NONE" };
  if (active.length > 1) return { kind: "AMBIGUOUS", programIds: active.map((p) => p.id).sort() };

  const programId = active[0]!.id;
  const versions = await db
    .select({ id: programVersions.id })
    .from(programVersions)
    .where(and(eq(programVersions.programId, programId), eq(programVersions.status, "ACTIVE")));
  if (versions.length === 0) return { kind: "NONE" };
  return { kind: "ACTIVE", programId, programVersionId: versions[0]!.id };
}

/** Every cycle of a ProgramVersion, with its block's order — the calendar `classifyScheduleCalendar` reads. */
export async function loadScheduleCycles(db: Database, programVersionId: string): Promise<ScheduleCycleRef[]> {
  return db
    .select({
      trainingBlockId: trainingBlocks.id,
      blockOrder: trainingBlocks.orderIndex,
      trainingCycleId: trainingCycles.id,
      cycleOrder: trainingCycles.orderIndex,
      startDate: trainingCycles.startDate,
      endDate: trainingCycles.endDate,
    })
    .from(trainingCycles)
    .innerJoin(trainingBlocks, eq(trainingBlocks.id, trainingCycles.trainingBlockId))
    .where(eq(trainingBlocks.programVersionId, programVersionId));
}

export interface AthleteScheduleContext {
  readonly athleteProfileId: string;
  readonly date: ScheduleDateContext;
  readonly program: ActiveProgramResolution;
  /** `null` unless `program` is ACTIVE. */
  readonly calendar: ScheduleCalendarState | null;
}

/**
 * The full schedule context for `actor` at `instant`. `undefined` when the
 * actor has no athlete profile (or the pair does not match — deny by
 * default). Uses the ordinary-read date context; adaptation callers must
 * additionally require `date.source === "ATHLETE_TIME_ZONE"`
 * (`requireAthleteTimeZoneDate`). Never writes the profile.
 */
/**
 * Only the schedule date for `actor` at `instant` (ordinary-read context —
 * may be LEGACY_UTC_FALLBACK). `undefined` when the actor has no matching
 * athlete profile. Never writes the profile.
 */
export async function resolveAthleteScheduleDate(db: Database, actor: AuthenticatedActor, instant: Date): Promise<ScheduleDateContext | undefined> {
  if (actor.athleteProfileId === undefined) return undefined;
  const [profile] = await db
    .select({ trainingTimeZone: athleteProfiles.trainingTimeZone })
    .from(athleteProfiles)
    .where(and(eq(athleteProfiles.id, actor.athleteProfileId), eq(athleteProfiles.userId, actor.userId)))
    .limit(1);
  return profile === undefined ? undefined : resolveScheduleDateContext(profile, instant);
}

/**
 * The full schedule context for `actor` at `instant`. `undefined` when the
 * actor has no athlete profile (or the pair does not match — deny by
 * default). Uses the ordinary-read date context; adaptation callers must
 * additionally require `date.source === "ATHLETE_TIME_ZONE"`
 * (`requireAthleteTimeZoneDate`). Never writes the profile.
 */
export async function resolveAthleteScheduleContext(db: Database, actor: AuthenticatedActor, instant: Date): Promise<AthleteScheduleContext | undefined> {
  const date = await resolveAthleteScheduleDate(db, actor, instant);
  if (date === undefined || actor.athleteProfileId === undefined) return undefined;
  const program = await resolveActiveProgram(db, actor.athleteProfileId);
  const calendar = program.kind === "ACTIVE" ? classifyScheduleCalendar(await loadScheduleCycles(db, program.programVersionId), date.localDate) : null;
  return { athleteProfileId: actor.athleteProfileId, date, program, calendar };
}
