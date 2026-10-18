import type { Database } from "@vostivo/database";
import { findCanonicalOccurrenceSessions } from "@vostivo/progression-application";

export interface MatchingSessionInfo {
  readonly status: "ACTIVE" | "COMPLETED";
  readonly plannedWorkoutId: string;
}

/**
 * "Which WorkoutSession represents this planned workout occurrence?" —
 * answered ONLY through the Planned Workout Occurrence Authority V1 claim:
 * the CANONICAL session (the first valid server-accepted START). A
 * SECONDARY session of the same occurrence (another device, offline) never
 * replaces it here, whatever its status, set count or insertion order —
 * there is no "last row wins". Shared by the Plan/Workout Preview
 * projections and the Available-Time preview's pre-start guard. Scoped to
 * `userId` — server-derived ownership, never a request value.
 */
export async function findMatchingSessions(
  db: Database,
  userId: string,
  plannedWorkoutIds: readonly string[],
): Promise<Map<string, MatchingSessionInfo>> {
  const canonical = await findCanonicalOccurrenceSessions(db, userId, plannedWorkoutIds);
  return new Map([...canonical].map(([plannedWorkoutId, session]) => [plannedWorkoutId, { status: session.status, plannedWorkoutId }]));
}
