import type { WorkoutCommandV1 } from "@vostivo/contracts";

/**
 * The only thing `SyncEngine` needs from local storage — deliberately not
 * "give me the SQLite database," so the engine itself never imports
 * expo-sqlite/drizzle/React (spec section 30). `WorkoutRepository`
 * implements this against the real encrypted local database; tests
 * implement it in memory.
 */
export interface OutboxCommandRecord {
  readonly commandId: string;
  readonly payload: WorkoutCommandV1;
  /**
   * CC-03: the local workout session this command belongs to — its
   * dependency group. `REOPEN_SET_V1` carries no session id in its payload,
   * so the repository resolves it from local data. `null`/absent = no known
   * group: the command is never held behind another one.
   */
  readonly workoutSessionId?: string | null;
}

/**
 * CC-03: outbox commands that will not reach the server without attention —
 * shown to the athlete as unresolved sync state. Nothing counted here is
 * ever deleted.
 */
export interface UnresolvedSyncSummary {
  /** Refused by the server on its own at request level; re-probed on the next app launch. */
  readonly blocked: number;
  /** Pending, but held because it may depend on a BLOCKED command. */
  readonly waitingOnBlocked: number;
  /** The server's final per-command REJECTED outcome. */
  readonly rejected: number;
  /** The server's final per-command CONFLICT outcome. */
  readonly conflicted: number;
}

export interface OutboxPort {
  /**
   * Oldest-first sendable commands. CC-03: never returns a BLOCKED command,
   * nor any command of a session that has a BLOCKED command (held, so a
   * session's commands are never delivered out of order) — and those never
   * count against `limit`.
   */
  getPendingCommands(limit: number): Promise<readonly OutboxCommandRecord[]>;
  markSyncing(commandId: string): Promise<void>;
  markSynced(commandId: string): Promise<void>;
  markRetry(commandId: string): Promise<void>;
  markConflict(commandId: string): Promise<void>;
  markRejected(commandId: string): Promise<void>;
  /**
   * CC-03: the server refused this command on its own at request level
   * (400/413/422). Out of the automatic retry loop, never deleted, payload
   * and command id untouched — recoverable via `releaseBlockedCommands`.
   */
  markBlocked(commandId: string): Promise<void>;
  /**
   * CC-03: BLOCKED -> RETRY for every blocked command so it is probed again
   * (once per engine/app launch). Returns the released command ids.
   */
  releaseBlockedCommands(): Promise<readonly string[]>;
}
