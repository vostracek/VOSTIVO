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
}

export interface OutboxPort {
  getPendingCommands(limit: number): Promise<readonly OutboxCommandRecord[]>;
  markSyncing(commandId: string): Promise<void>;
  markSynced(commandId: string): Promise<void>;
  markRetry(commandId: string): Promise<void>;
  markConflict(commandId: string): Promise<void>;
  markRejected(commandId: string): Promise<void>;
}
