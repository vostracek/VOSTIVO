import type { SyncPendingCommandsResult } from "../workout/sync-engine";

/**
 * Why a sync pass was requested. Only used for DEV observability — every
 * trigger is handled identically (spec: one coordinator, one policy).
 */
export type WorkoutSyncTrigger = "mutation" | "launch" | "foreground" | "network-regain" | "retry";

/**
 * The deterministic V1 retry backoff after a retryable failure: 2 s, 5 s,
 * 10 s, then 30 s for every further attempt. No jitter in V1 (one device,
 * one API — there is no thundering herd to spread out).
 */
export const WORKOUT_SYNC_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000, 30_000];

/**
 * Timer boundary, injected so tests drive retries with fake timers instead
 * of real 30-second sleeps.
 */
export interface SyncScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface WorkoutSyncLogger {
  debug(message: string, details?: Readonly<Record<string, unknown>>): void;
}

export interface WorkoutSyncCoordinatorOptions {
  readonly scheduler?: SyncScheduler;
  readonly logger?: WorkoutSyncLogger;
  readonly retryDelaysMs?: readonly number[];
  /**
   * The engine's batch size. A pass that attempted a full batch may have
   * left more pending commands behind, so the coordinator runs one more
   * pass right away instead of waiting for the next trigger.
   */
  readonly batchSize?: number;
}

const realScheduler: SyncScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const silentLogger: WorkoutSyncLogger = { debug: () => {} };

/**
 * Decides WHEN pending workout commands are synchronized; `SyncEngine`
 * still decides HOW (outbox -> batch -> send -> acks), and
 * `WorkoutApplicationService` still owns the local workout mutations.
 *
 * Guarantees:
 * - at most one `sync()` in flight — a trigger arriving mid-pass is
 *   coalesced into exactly one follow-up pass;
 * - at most one retry timer — any immediate trigger supersedes it;
 * - a retryable outcome (transport/5xx/auth failure, or an unexpected
 *   error, all of which `SyncEngine` leaves as RETRY in the outbox)
 *   schedules the next attempt on the 2/5/10/30 s backoff;
 * - a pass with nothing left to retry clears the timer and resets the
 *   backoff, so an idle coordinator never polls the server. CONFLICT and
 *   REJECTED are terminal outbox states, never re-sent (spec sections
 *   27/33).
 *
 * Sync stays fire-and-forget for callers: `requestSync()` never throws and
 * never blocks local logging (CLAUDE.md: local logging never depends on
 * successful network sync).
 */
export class WorkoutSyncCoordinator {
  private readonly scheduler: SyncScheduler;
  private readonly logger: WorkoutSyncLogger;
  private readonly retryDelaysMs: readonly number[];
  private readonly batchSize: number | undefined;

  private running = false;
  private followUpTrigger: WorkoutSyncTrigger | undefined;
  private retryHandle: unknown;
  private consecutiveFailures = 0;
  private disposed = false;

  constructor(
    private readonly sync: () => Promise<SyncPendingCommandsResult>,
    options: WorkoutSyncCoordinatorOptions = {},
  ) {
    this.scheduler = options.scheduler ?? realScheduler;
    this.logger = options.logger ?? silentLogger;
    this.retryDelaysMs = options.retryDelaysMs ?? WORKOUT_SYNC_RETRY_DELAYS_MS;
    this.batchSize = options.batchSize;
  }

  /** Whether a retry timer is currently scheduled (for tests/diagnostics). */
  get hasScheduledRetry(): boolean {
    return this.retryHandle !== undefined;
  }

  requestSync(trigger: WorkoutSyncTrigger): void {
    if (this.disposed) return;
    if (this.running) {
      this.followUpTrigger = trigger;
      return;
    }
    this.cancelRetry();
    void this.runPass(trigger);
  }

  dispose(): void {
    this.disposed = true;
    this.followUpTrigger = undefined;
    this.cancelRetry();
  }

  private async runPass(trigger: WorkoutSyncTrigger): Promise<void> {
    this.running = true;
    this.logger.debug("workout sync attempt", { trigger, consecutiveFailures: this.consecutiveFailures });

    let retryable = false;
    let moreMayBePending = false;
    try {
      const result = await this.sync();
      retryable = result.retried > 0;
      moreMayBePending = !retryable && this.batchSize !== undefined && result.attempted >= this.batchSize;
      if (!retryable && result.attempted > 0) {
        this.logger.debug("workout sync succeeded", {
          trigger,
          synced: result.synced,
          conflicted: result.conflicted,
          rejected: result.rejected,
        });
      }
    } catch (error) {
      // SyncEngine has already returned every affected command to RETRY
      // before rethrowing, so this is retryable work, not a lost command.
      retryable = true;
      this.logger.debug("workout sync failed unexpectedly", {
        trigger,
        error: error instanceof Error ? error.name : "unknown",
      });
    } finally {
      this.running = false;
    }

    if (this.disposed) return;

    if (retryable) {
      this.consecutiveFailures += 1;
    } else {
      if (this.consecutiveFailures > 0) {
        this.logger.debug("workout sync recovered after retry", { failures: this.consecutiveFailures });
      }
      this.consecutiveFailures = 0;
    }

    const followUp = this.followUpTrigger ?? (moreMayBePending ? trigger : undefined);
    this.followUpTrigger = undefined;
    if (followUp !== undefined) {
      this.cancelRetry();
      void this.runPass(followUp);
      return;
    }

    if (retryable) this.scheduleRetry();
  }

  private scheduleRetry(): void {
    this.cancelRetry();
    const index = Math.min(this.consecutiveFailures - 1, this.retryDelaysMs.length - 1);
    const delayMs = this.retryDelaysMs[index] ?? this.retryDelaysMs[this.retryDelaysMs.length - 1] ?? 30_000;
    this.logger.debug("workout sync retry scheduled", { delayMs, consecutiveFailures: this.consecutiveFailures });
    this.retryHandle = this.scheduler.setTimeout(() => {
      this.retryHandle = undefined;
      this.requestSync("retry");
    }, delayMs);
  }

  private cancelRetry(): void {
    if (this.retryHandle === undefined) return;
    this.scheduler.clearTimeout(this.retryHandle);
    this.retryHandle = undefined;
  }
}
