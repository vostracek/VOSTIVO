import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncWorkoutCommandsRequest, SyncWorkoutCommandsResponse, WorkoutCommandV1 } from "@vostivo/contracts";
import { SyncEngine } from "../workout/sync-engine";
import type { OutboxCommandRecord, OutboxPort } from "../workout/outbox-port";
import { TransientSyncFailure, type WorkoutSyncApiClient } from "../workout/workout-sync-api-client";
import { WorkoutSyncCoordinator } from "./workout-sync-coordinator";

/**
 * The Manual Test #4 scenario, end to end through the REAL `SyncEngine`
 * (only the outbox and the HTTP client are in-memory): commands logged
 * while the API is down, then the API comes back while the app sits in the
 * foreground and nobody touches it. The coordinator's retry alone must
 * bring the server up to date — no mutation, no lifecycle event.
 */
function completeSetCommand(commandId: string, sessionSeq: number): WorkoutCommandV1 {
  return {
    commandId,
    type: "REOPEN_SET_V1",
    schemaVersion: 1,
    createdAt: new Date(0).toISOString(),
    performedSetId: `set-${sessionSeq}`,
    revision: 1,
    sessionSeq,
  };
}

class InMemoryOutbox implements OutboxPort {
  readonly statuses = new Map<string, string>();

  constructor(private readonly records: OutboxCommandRecord[]) {
    for (const record of records) this.statuses.set(record.commandId, "PENDING");
  }

  getPendingCommands(limit: number): Promise<readonly OutboxCommandRecord[]> {
    return Promise.resolve(
      this.records.filter((r) => ["PENDING", "RETRY", "SYNCING"].includes(this.statuses.get(r.commandId) ?? "")).slice(0, limit),
    );
  }
  private set(commandId: string, status: string): Promise<void> {
    this.statuses.set(commandId, status);
    return Promise.resolve();
  }
  markSyncing = (id: string) => this.set(id, "SYNCING");
  markSynced = (id: string) => this.set(id, "SYNCED");
  markRetry = (id: string) => this.set(id, "RETRY");
  markConflict = (id: string) => this.set(id, "CONFLICT");
  markRejected = (id: string) => this.set(id, "REJECTED");
}

/** An API that is down until `restore()`, then applies each command id once. */
class OutageApiClient implements WorkoutSyncApiClient {
  available = false;
  readonly requests: string[][] = [];
  readonly applied = new Set<string>();

  restore(): void {
    this.available = true;
  }

  syncCommands(_token: string, request: SyncWorkoutCommandsRequest): Promise<SyncWorkoutCommandsResponse> {
    const ids = request.commands.map((command) => command.commandId);
    this.requests.push(ids);
    if (!this.available) return Promise.reject(new TransientSyncFailure("ECONNREFUSED"));
    return Promise.resolve({
      acknowledgements: ids.map((commandId) => {
        const outcome = this.applied.has(commandId) ? "DUPLICATE" : "APPLIED";
        this.applied.add(commandId);
        return { commandId, outcome };
      }),
    } as SyncWorkoutCommandsResponse);
  }
}

describe("WorkoutSyncCoordinator + SyncEngine: backend outage while the device stays connected", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pending offline commands reach the server within 35 s of the API returning, with no further trigger and no duplicates", async () => {
    const outbox = new InMemoryOutbox([
      { commandId: "cmd-set-2", payload: completeSetCommand("cmd-set-2", 4) },
      { commandId: "cmd-set-3", payload: completeSetCommand("cmd-set-3", 5) },
    ]);
    const api = new OutageApiClient();
    const engine = new SyncEngine(outbox, { getAccessToken: () => Promise.resolve("token") }, api);
    const coordinator = new WorkoutSyncCoordinator(() => engine.syncPendingCommands());

    // Sets 2 and 3 logged while the API is down: each mutation tries once.
    coordinator.requestSync("mutation");
    await vi.advanceTimersByTimeAsync(0);
    coordinator.requestSync("mutation");
    await vi.advanceTimersByTimeAsync(0);
    expect(outbox.statuses.get("cmd-set-2")).toBe("RETRY");
    expect(api.applied.size).toBe(0);

    // The outage lasts a while: retries keep backing off, nothing is lost.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.applied.size).toBe(0);
    expect(outbox.statuses.get("cmd-set-3")).toBe("RETRY");

    // API restored. Nobody touches the app.
    api.restore();
    await vi.advanceTimersByTimeAsync(35_000);

    expect(api.applied).toEqual(new Set(["cmd-set-2", "cmd-set-3"]));
    expect(outbox.statuses.get("cmd-set-2")).toBe("SYNCED");
    expect(outbox.statuses.get("cmd-set-3")).toBe("SYNCED");
    expect(coordinator.hasScheduledRetry).toBe(false);

    // Idle afterwards: no further requests once the outbox is empty.
    const requestsAfterCatchUp = api.requests.length;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(api.requests.length).toBe(requestsAfterCatchUp);
    // Every successful request carried each command exactly once.
    expect(api.requests.filter((batch) => batch.length > 0).at(-1)).toEqual(["cmd-set-2", "cmd-set-3"]);
  });
});
