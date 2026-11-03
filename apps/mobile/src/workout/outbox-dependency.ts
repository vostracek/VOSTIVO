/**
 * CC-03 — the ONE causal-safety rule for refused (BLOCKED) outbox commands,
 * shared by `SyncEngine` (within one isolation pass) and `WorkoutRepository`
 * (pending selection + unresolved summary), so both always agree.
 *
 * A command's dependency group is its local workout session. Inside a
 * session, a later command depends on the earlier ones (COMPLETE_SET needs
 * START, REOPEN needs its COMPLETE_SET, FINISH closes the session). A
 * command never depends on a LATER command, and a session cannot own a
 * command issued before that session's own START.
 *
 * `candidate` must wait behind an EARLIER refused command `r` when it may
 * depend on it:
 * - `candidate` has no known group     -> it could belong to any session: wait;
 * - `r` has a known group              -> wait only if it is the same group;
 * - `r` has NO known group (malformed / unresolvable) -> `r` could belong to
 *   any session that already existed when `r` was issued. Wait unless the
 *   candidate's session provably STARTED AFTER `r` (its START command is
 *   known and positioned after `r`); an unknown START position is treated
 *   as "before" — never assumed independent.
 *
 * Positions are outbox order (`created_at`, then `rowid`) — any total order
 * consistent with issue order works, which is all both callers need.
 */
export interface OutboxPosition {
  readonly position: number;
  readonly workoutSessionId: string | null;
}

export function mustWaitBehindRefused(
  candidate: OutboxPosition,
  refused: readonly OutboxPosition[],
  sessionStartPosition: (workoutSessionId: string) => number | undefined,
): boolean {
  return refused.some((blocker) => {
    if (blocker.position >= candidate.position) return false;
    if (candidate.workoutSessionId === null) return true;
    if (blocker.workoutSessionId !== null) return blocker.workoutSessionId === candidate.workoutSessionId;
    const startedAt = sessionStartPosition(candidate.workoutSessionId);
    return startedAt === undefined || startedAt < blocker.position;
  });
}
