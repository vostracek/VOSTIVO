import type { SyncOutcome, SyncWorkoutCommandsRequest } from "@vostivo/contracts";
import type { AuthTokenProvider } from "./auth-token-provider";
import type { OutboxPort } from "./outbox-port";
import { TransientSyncFailure, type WorkoutSyncApiClient } from "./workout-sync-api-client";

export const DEFAULT_BATCH_SIZE = 25;

export interface SyncPendingCommandsResult {
  readonly attempted: number;
  readonly synced: number;
  readonly retried: number;
  readonly conflicted: number;
  readonly rejected: number;
}

interface MutableSyncResult {
  attempted: number;
  synced: number;
  retried: number;
  conflicted: number;
  rejected: number;
}

/**
 * Orchestrates outbox -> batch -> auth -> send -> process acks -> update
 * outbox status (spec section 30). Sync never blocks local logging (spec
 * section 32) — this only ever runs AFTER durable local success (spec
 * section 1), and any failure here leaves the outbox retryable without
 * ever touching local workout reality (spec section 34).
 */
export class SyncEngine {
  // Single-flight guard: multiple triggers now call `syncPendingCommands()`
  // independently (a workout mutation, app launch, app foreground-resume —
  // see src/infrastructure/sync-recovery.ts), and they are not coordinated
  // with each other. Without this, two overlapping calls would both read
  // the same pending batch and send it twice. Concurrent callers instead
  // share the one in-flight run's result; a call made after it settles
  // starts a genuinely new run.
  private inFlight: Promise<SyncPendingCommandsResult> | undefined;

  constructor(
    private readonly outbox: OutboxPort,
    private readonly authTokenProvider: AuthTokenProvider,
    private readonly apiClient: WorkoutSyncApiClient,
    private readonly batchSize: number = DEFAULT_BATCH_SIZE,
  ) {}

  async syncPendingCommands(): Promise<SyncPendingCommandsResult> {
    if (this.inFlight !== undefined) return this.inFlight;

    const run = this.runSyncPendingCommands();
    this.inFlight = run;
    try {
      return await run;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async runSyncPendingCommands(): Promise<SyncPendingCommandsResult> {
    const pending = await this.outbox.getPendingCommands(this.batchSize);
    const result: MutableSyncResult = {
      attempted: pending.length,
      synced: 0,
      retried: 0,
      conflicted: 0,
      rejected: 0,
    };
    if (pending.length === 0) return result;

    for (const record of pending) {
      await this.outbox.markSyncing(record.commandId);
    }

    let accessToken: string;
    try {
      accessToken = await this.authTokenProvider.getAccessToken();
    } catch {
      // Cannot authenticate right now (JWT refresh failed, deferred auth
      // wiring, offline) — everything stays retryable (spec section
      // 32/33), never treated as a permanent rejection.
      for (const record of pending) await this.outbox.markRetry(record.commandId);
      result.retried = pending.length;
      return result;
    }

    const request: SyncWorkoutCommandsRequest = { commands: pending.map((record) => record.payload) };

    let response;
    try {
      response = await this.apiClient.syncCommands(accessToken, request);
    } catch (error) {
      // Transient (offline/timeout/5xx) — never classified as permanent;
      // leave everything retryable (spec section 33).
      for (const record of pending) await this.outbox.markRetry(record.commandId);
      result.retried = pending.length;
      if (!(error instanceof TransientSyncFailure)) {
        // A genuinely unexpected (non-network) error — still leaves the
        // outbox safely retryable above, but surface it rather than
        // silently swallowing a real bug.
        throw error;
      }
      return result;
    }

    for (const acknowledgement of response.acknowledgements) {
      await this.applyAcknowledgement(acknowledgement.commandId, acknowledgement.outcome, result);
    }

    return result;
  }

  private async applyAcknowledgement(
    commandId: string,
    outcome: SyncOutcome,
    result: MutableSyncResult,
  ): Promise<void> {
    switch (outcome) {
      case "APPLIED":
      case "DUPLICATE":
      case "STALE":
        // All three mean "no further client action needed" (spec section
        // 27) — the underlying reality was applied, already applied, or
        // superseded-but-never-reverted. Safe to mark synced either way.
        await this.outbox.markSynced(commandId);
        result.synced += 1;
        return;
      case "CONFLICT":
        await this.outbox.markConflict(commandId);
        result.conflicted += 1;
        return;
      case "REJECTED":
        await this.outbox.markRejected(commandId);
        result.rejected += 1;
        return;
    }
  }
}
