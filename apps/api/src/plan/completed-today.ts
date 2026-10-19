import { and, desc, eq, gte, isNotNull, lt } from "drizzle-orm";
import { plannedWorkoutOccurrenceClaims, plannedWorkouts, programVersions, programs, trainingBlocks, trainingCycles, workoutSessions, type Database } from "@vostivo/database";
import { resolveScheduleDateContext } from "@vostivo/domain";
import type { PlanCompletedTodayV1 } from "@vostivo/contracts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Progress & Feedback V1 Slice D closure — COMPLETED-TODAY IS
 * SERVER-AUTHORITATIVE AND INDEPENDENT OF THE DISPLAYED PLAN CYCLE.
 *
 * The caller's planned occurrence whose CANONICAL session (occurrence claim)
 * was COMPLETED on the athlete-local `localDate` — whichever cycle, block or
 * effective date it belongs to (a previous-cycle workout rolled forward and
 * finished today counts). Ownership: the claim and the session are the
 * caller's (`userId`), and the planned workout belongs to the caller's own
 * program (`athleteProfileId`) — SECONDARY, unclaimed and foreign sessions
 * never match. The completion day comes from the session's real
 * `completedAt` in the training time zone (`resolveScheduleDateContext`,
 * the same rule as Progress history), never the scheduled date.
 *
 * Several today: the most recently completed (id tie-break) — deterministic,
 * never combined; the others stay in Progress history.
 *
 * One bounded query: a UTC window of [localDate − 1 day, localDate + 2 days)
 * contains every instant of that local day in any IANA zone (offsets stay
 * within ±14 h); the exact local-day match is then decided per row.
 */
export async function findCompletedToday(
  db: Database,
  owner: { readonly userId: string; readonly athleteProfileId: string },
  date: { readonly localDate: string; readonly trainingTimeZone: string | null },
): Promise<PlanCompletedTodayV1 | undefined> {
  const dayStartUtc = new Date(`${date.localDate}T00:00:00.000Z`).getTime();
  const rows = await db
    .select({
      plannedWorkoutId: plannedWorkoutOccurrenceClaims.plannedWorkoutId,
      workoutSessionId: workoutSessions.id,
      workoutName: plannedWorkouts.name,
      completedAt: workoutSessions.completedAt,
    })
    .from(plannedWorkoutOccurrenceClaims)
    .innerJoin(workoutSessions, and(eq(workoutSessions.id, plannedWorkoutOccurrenceClaims.canonicalWorkoutSessionId), eq(workoutSessions.userId, plannedWorkoutOccurrenceClaims.userId)))
    .innerJoin(plannedWorkouts, eq(plannedWorkouts.id, plannedWorkoutOccurrenceClaims.plannedWorkoutId))
    .innerJoin(trainingCycles, eq(trainingCycles.id, plannedWorkouts.trainingCycleId))
    .innerJoin(trainingBlocks, eq(trainingBlocks.id, trainingCycles.trainingBlockId))
    .innerJoin(programVersions, eq(programVersions.id, trainingBlocks.programVersionId))
    .innerJoin(programs, eq(programs.id, programVersions.programId))
    .where(
      and(
        eq(plannedWorkoutOccurrenceClaims.userId, owner.userId),
        eq(programs.athleteProfileId, owner.athleteProfileId),
        eq(workoutSessions.status, "COMPLETED"),
        isNotNull(workoutSessions.completedAt),
        gte(workoutSessions.completedAt, new Date(dayStartUtc - DAY_MS)),
        lt(workoutSessions.completedAt, new Date(dayStartUtc + 2 * DAY_MS)),
      ),
    )
    .orderBy(desc(workoutSessions.completedAt), desc(workoutSessions.id));

  for (const row of rows) {
    if (row.completedAt === null) continue;
    const completedLocalDate = resolveScheduleDateContext({ trainingTimeZone: date.trainingTimeZone }, row.completedAt).localDate;
    if (completedLocalDate === date.localDate) {
      return { plannedWorkoutId: row.plannedWorkoutId, workoutSessionId: row.workoutSessionId, workoutName: row.workoutName, completedLocalDate };
    }
  }
  return undefined;
}
