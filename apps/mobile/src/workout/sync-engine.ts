import type { SyncOutcome, SyncWorkoutCommandsRequest, SyncWorkoutCommandsResponse } from "@vostivo/contracts";
import { AuthServiceUnavailableError, SessionInvalidError, SyncPausedError, type AuthTokenProvider } from "./auth-token-provider";
import { sendWithAuthRecovery } from "./authorized-request";
import { mustWaitBehindRefused, type OutboxPosition } from "./outbox-dependency";
import type { OutboxCommandRecord, OutboxPort } from "./outbox-port";
import { RequestRejectedSyncResponse, TransientSyncFailure, UnauthorizedSyncResponse, type WorkoutSyncApiClient } from "./workout-sync-api-client";

export const DEFAULT_BATCH_SIZE = 25;

const UNAUTHORIZED: unique symbol = Symbol("unauthorized");

export interface SyncPendingCommandsResult {
  readonly attempted: number;
  readonly synced: number;
  readonly retried: number;
  readonly conflicted: number;
  readonly rejected: number;
  /**
   * CC-03 (present only when non-zero): commands the server refused ON THEIR
   * OWN at request level in this pass — now BLOCKED (out of the retry loop,
   * kept intact, re-probed on the next engine start).
   */
  readonly blocked?: number;
  /** CC-03 (present only when non-zero): not probed — an earlier command of their session was refused in this pass. */
  readonly held?: number;
  /**
   * CC-03 (present only when true): the whole request was refused and so was
   * every isolated probe — a systemic refusal (e.g. a client/server protocol
   * mismatch), not a bad command. Nothing was classified; everything stays
   * RETRY. A timer retry cannot fix this, so `retried` stays 0 and the
   * coordinator neither loops nor schedules a backoff — the next real trigger
   * (mutation, launch, foreground, network) tries again.
   */
  readonly requestRejected?: boolean;
}

interface MutableSyncResult {
  attempted: number;
  synced: number;
  retried: number;
  conflicted: number;
  rejected: number;
  blocked?: number;
  held?: number;
  requestRejected?: boolean;
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

  // CC-03: BLOCKED commands are released for ONE re-probe per engine — an
  // engine lives for one athlete runtime, i.e. one app launch / owner
  // switch — so a refusal is re-probed after a restart (e.g. a newer server
  // now accepts it) but never retried in a tight loop within one launch.
  // A released command that the server did not acknowledge returns to
  // BLOCKED at the end of the pass, so it never silently looks resolved
  // (Today's notice keeps showing it). If the server did not get to judge
  // it at all (paused, offline, 5xx, 401...), the release is repeated on
  // the next pass of this launch.
  private blockedReleased = false;
  private readonly reprobing = new Set<string>();
  // Per pass (single flight): which commands were selected, acknowledged
  // by the server, or decided without the server's help being missing
  // (refused alone / systemic refusal / held behind a refusal).
  private readonly passSelected = new Set<string>();
  private readonly passAcknowledged = new Set<string>();
  private readonly passDecided = new Set<string>();

  /**
   * `ownerUserId` (Auth & Local Athlete Boundary V1 Slice B) is the
   * verified `userId` that owns this runtime's local database — every
   * batch carries it so the server can refuse a batch read from the wrong
   * athlete's outbox. It is fixed for the engine's lifetime: an engine is
   * never re-pointed at another owner.
   */
  constructor(
    private readonly ownerUserId: string,
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
    this.passSelected.clear();
    this.passAcknowledged.clear();
    this.passDecided.clear();
    if (!this.blockedReleased) {
      this.blockedReleased = true;
      for (const commandId of await this.outbox.releaseBlockedCommands()) this.reprobing.add(commandId);
    }
    try {
      return await this.runPass();
    } finally {
      await this.settleReprobes();
    }
  }

  /** CC-03: see `blockedReleased` — a re-probed command returns to BLOCKED unless the server acknowledged it. */
  private async settleReprobes(): Promise<void> {
    for (const commandId of this.passSelected) {
      if (!this.reprobing.delete(commandId)) continue;
      if (this.passAcknowledged.has(commandId)) continue;
      await this.outbox.markBlocked(commandId);
      if (!this.passDecided.has(commandId)) this.blockedReleased = false;
    }
  }

  private async runPass(): Promise<SyncPendingCommandsResult> {
    const pending = await this.outbox.getPendingCommands(this.batchSize);
    for (const record of pending) this.passSelected.add(record.commandId);
    const result: MutableSyncResult = {
      attempted: pending.length,
      synced: 0,
      retried: 0,
      conflicted: 0,
      rejected: 0,
    };
    if (pending.length === 0) return result;

    // The token is obtained BEFORE anything is marked SYNCING: a paused
    // runtime (wrong owner — Slice B; not verified online or re-auth
    // pending — Slice C) leaves the outbox exactly as it was — no attempt
    // counted, no backoff.
    try {
      await this.authTokenProvider.getAccessToken();
    } catch (error) {
      if (error instanceof SyncPausedError) throw error;
      // Cannot authenticate right now (JWT refresh failed, deferred auth
      // wiring, offline) — everything stays retryable (spec section
      // 32/33), never treated as a permanent rejection.
      for (const record of pending) await this.outbox.markRetry(record.commandId);
      result.retried = pending.length;
      return result;
    }

    for (const record of pending) {
      await this.outbox.markSyncing(record.commandId);
    }

    let response: SyncWorkoutCommandsResponse;
    try {
      response = await this.send(pending);
    } catch (error) {
      if (error instanceof RequestRejectedSyncResponse) return this.isolateRequestRejection(pending, result);
      return this.failSend(error, pending, result);
    }

    await this.applyAcknowledgements(response, result);
    return result;
  }

  /** One request with the Auth Slice C policy: one refresh + one retry on 401, never a loop. */
  private async send(records: readonly OutboxCommandRecord[]): Promise<SyncWorkoutCommandsResponse> {
    const request: SyncWorkoutCommandsRequest = { ownerUserId: this.ownerUserId, commands: records.map((record) => record.payload) };
    // The replayed batch is idempotent server-side (owner-scoped receipts).
    const sent = await sendWithAuthRecovery(
      this.authTokenProvider,
      (accessToken): Promise<SyncWorkoutCommandsResponse | typeof UNAUTHORIZED> =>
        this.apiClient.syncCommands(accessToken, request).catch((error: unknown) => {
          if (error instanceof UnauthorizedSyncResponse) return UNAUTHORIZED;
          throw error;
        }),
      (outcome) => outcome === UNAUTHORIZED,
    );
    if (sent.result === UNAUTHORIZED) throw new SessionInvalidError();
    return sent.result;
  }

  /**
   * Every non-classifying send failure: the affected commands go back to
   * RETRY (never classified as permanent), then the failure is surfaced.
   */
  private async failSend(
    error: unknown,
    records: readonly OutboxCommandRecord[],
    result: MutableSyncResult,
  ): Promise<SyncPendingCommandsResult> {
    for (const record of records) await this.outbox.markRetry(record.commandId);
    if (error instanceof SyncPausedError) {
      // The server refused the whole batch (409 SYNC_OWNER_MISMATCH) or the
      // session is invalid — nothing was processed. Put the rows back for
      // their real owner; the coordinator schedules no retry for this.
      throw error;
    }
    // Transient (offline/timeout/5xx/429) — never classified as permanent;
    // leave everything retryable (spec section 33).
    result.retried += records.length;
    // The auth service being unreachable while refreshing is offline, not an invalid session (AUTH-019).
    if (!(error instanceof TransientSyncFailure) && !(error instanceof AuthServiceUnavailableError)) {
      // A genuinely unexpected (non-network) error — still leaves the
      // outbox safely retryable above, but surface it rather than
      // silently swallowing a real bug.
      throw error;
    }
    return result;
  }

  /**
   * CC-03 (D-SYNC-1): the server refused the whole request at request level
   * (400/413/422) BEFORE processing any command (CC01-BATCH-001), so
   * re-sending is free of side effects. Find out which command(s) cause it
   * by sending each one alone, oldest first:
   *
   * - accepted alone -> its acknowledgement is applied as usual;
   * - refused alone  -> candidate for BLOCKED, and every later command that
   *   may depend on it (`mustWaitBehindRefused`: same session; for a refused
   *   command of unknown session, every session not provably started after
   *   it; a command of unknown session behind any refusal) is not sent at
   *   all (held, RETRY) — dependents must never overtake what they depend on;
   * - any other failure (offline, 5xx, 429, 401, owner mismatch, unknown)
   *   -> stop; the candidates and everything not yet probed go back to RETRY
   *   unclassified, and the failure is handled like any other send failure.
   *
   * If EVERY probe (at least two) was refused, the refusal is systemic, not
   * a bad command: nothing is blocked, everything stays RETRY, and the pass
   * reports `requestRejected` so no timer/immediate loop is started.
   * A lone command refused in a batch of one is BLOCKED directly (a
   * conservative, recoverable state — never REJECTED, never deleted).
   */
  private async isolateRequestRejection(
    pending: readonly OutboxCommandRecord[],
    result: MutableSyncResult,
  ): Promise<SyncPendingCommandsResult> {
    const [only] = pending;
    if (pending.length === 1 && only !== undefined) {
      // Already sent alone: no probe needed.
      await this.outbox.markBlocked(only.commandId);
      this.passDecided.add(only.commandId);
      result.blocked = 1;
      return result;
    }

    // Where each session's START sits in this batch: a session started
    // after a refused command of unknown group provably does not depend on
    // it. A START outside this batch counts as "earlier" (never assumed independent).
    const startPositions = new Map<string, number>();
    for (const [index, record] of pending.entries()) {
      const sessionId = dependencyGroupOf(record);
      if (record.payload.type === "START_WORKOUT_SESSION_V1" && sessionId !== null && !startPositions.has(sessionId)) {
        startPositions.set(sessionId, index);
      }
    }
    const refusedPositions: OutboxPosition[] = [];
    const refused: OutboxCommandRecord[] = [];
    let probed = 0;
    let held = 0;

    for (const [index, record] of pending.entries()) {
      const position: OutboxPosition = { position: index, workoutSessionId: dependencyGroupOf(record) };
      if (mustWaitBehindRefused(position, refusedPositions, (sessionId) => startPositions.get(sessionId))) {
        await this.outbox.markRetry(record.commandId);
        this.passDecided.add(record.commandId);
        held += 1;
        continue;
      }
      probed += 1;
      let response: SyncWorkoutCommandsResponse;
      try {
        response = await this.send([record]);
      } catch (error) {
        if (error instanceof RequestRejectedSyncResponse) {
          refused.push(record);
          refusedPositions.push(position);
          continue;
        }
        if (held > 0) result.held = held;
        return this.failSend(error, [...refused, ...pending.slice(index)], result);
      }
      await this.applyAcknowledgements(response, result);
    }

    if (held > 0) result.held = held;
    for (const record of refused) this.passDecided.add(record.commandId);
    if (probed >= 2 && refused.length === probed) {
      for (const record of refused) await this.outbox.markRetry(record.commandId);
      result.requestRejected = true;
      return result;
    }
    for (const record of refused) await this.outbox.markBlocked(record.commandId);
    if (refused.length > 0) result.blocked = refused.length;
    return result;
  }

  private async applyAcknowledgements(response: SyncWorkoutCommandsResponse, result: MutableSyncResult): Promise<void> {
    for (const acknowledgement of response.acknowledgements) {
      this.passAcknowledged.add(acknowledgement.commandId);
      await this.applyAcknowledgement(acknowledgement.commandId, acknowledgement.outcome, result);
    }
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

/** CC-03: a command's dependency group — its local workout session, when known. */
function dependencyGroupOf(record: OutboxCommandRecord): string | null {
  if (record.workoutSessionId !== undefined) return record.workoutSessionId;
  const sessionId = (record.payload as { readonly workoutSessionId?: unknown }).workoutSessionId;
  return typeof sessionId === "string" ? sessionId : null;
}
