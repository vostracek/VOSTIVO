import { describe, expect, it, vi } from "vitest";
import type { SyncWorkoutCommandsRequest, SyncWorkoutCommandsResponse, WorkoutCommandV1 } from "@vostivo/contracts";
import { SyncEngine } from "./sync-engine";
import type { OutboxCommandRecord, OutboxPort } from "./outbox-port";
import { RuntimeOwnerMismatchError, type AuthTokenProvider } from "./auth-token-provider";
import { TransientSyncFailure, type WorkoutSyncApiClient } from "./workout-sync-api-client";

const OWNER = "0190a000-0000-7000-8000-00000000000a";

/**
 * Pure orchestration tests (spec section 30) — no SQLite, no network, no
 * React. `WorkoutRepository`'s actual transactional/native behavior is
 * verified on-device instead (spec section 39) — same reasoning already
 * applied to SQLCipher key generation and local migrations elsewhere in
 * this codebase.
 */
function fakeCommand(commandId: string): WorkoutCommandV1 {
  return {
    commandId,
    type: "REOPEN_SET_V1",
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    performedSetId: "set-1",
    revision: 2,
    sessionSeq: 2,
  };
}

class InMemoryOutbox implements OutboxPort {
  records: OutboxCommandRecord[];
  statuses = new Map<string, string>();

  constructor(commandIds: string[]) {
    this.records = commandIds.map((id) => ({ commandId: id, payload: fakeCommand(id) }));
    for (const id of commandIds) this.statuses.set(id, "PENDING");
  }

  getPendingCommands(limit: number): Promise<readonly OutboxCommandRecord[]> {
    return Promise.resolve(
      this.records
        .filter((r) => {
          const status = this.statuses.get(r.commandId);
          return status === "PENDING" || status === "RETRY";
        })
        .slice(0, limit),
    );
  }
  markSyncing(commandId: string): Promise<void> {
    this.statuses.set(commandId, "SYNCING");
    return Promise.resolve();
  }
  markSynced(commandId: string): Promise<void> {
    this.statuses.set(commandId, "SYNCED");
    return Promise.resolve();
  }
  markRetry(commandId: string): Promise<void> {
    this.statuses.set(commandId, "RETRY");
    return Promise.resolve();
  }
  markConflict(commandId: string): Promise<void> {
    this.statuses.set(commandId, "CONFLICT");
    return Promise.resolve();
  }
  markRejected(commandId: string): Promise<void> {
    this.statuses.set(commandId, "REJECTED");
    return Promise.resolve();
  }
}

class WorkingAuthTokenProvider implements AuthTokenProvider {
  getAccessToken(): Promise<string> {
    return Promise.resolve("test-token");
  }
}

class FailingAuthTokenProvider implements AuthTokenProvider {
  getAccessToken(): Promise<string> {
    return Promise.reject(new Error("token refresh failed"));
  }
}

describe("SyncEngine", () => {
  it("does nothing when the outbox is empty", async () => {
    const outbox = new InMemoryOutbox([]);
    const engine = new SyncEngine(OWNER, outbox, new WorkingAuthTokenProvider(), {
      syncCommands: () => Promise.resolve({ acknowledgements: [] }),
    });

    const result = await engine.syncPendingCommands();
    expect(result).toEqual({ attempted: 0, synced: 0, retried: 0, conflicted: 0, rejected: 0 });
  });

  it("spec section 32: an auth failure leaves every pending command retryable, never rejected", async () => {
    const outbox = new InMemoryOutbox(["cmd-1", "cmd-2"]);
    const engine = new SyncEngine(OWNER, outbox, new FailingAuthTokenProvider(), {
      syncCommands: () => Promise.reject(new Error("should never be called")),
    });

    const result = await engine.syncPendingCommands();

    expect(result.retried).toBe(2);
    expect(outbox.statuses.get("cmd-1")).toBe("RETRY");
    expect(outbox.statuses.get("cmd-2")).toBe("RETRY");
  });

  it("spec section 33: a transient network failure leaves commands retryable, not rejected", async () => {
    const outbox = new InMemoryOutbox(["cmd-1"]);
    const client: WorkoutSyncApiClient = {
      syncCommands: () => Promise.reject(new TransientSyncFailure("offline")),
    };
    const engine = new SyncEngine(OWNER, outbox, new WorkingAuthTokenProvider(), client);

    const result = await engine.syncPendingCommands();

    expect(result.retried).toBe(1);
    expect(outbox.statuses.get("cmd-1")).toBe("RETRY");
  });

  it("maps APPLIED/DUPLICATE/STALE acknowledgements to SYNCED — all mean 'no further action'", async () => {
    const outbox = new InMemoryOutbox(["cmd-applied", "cmd-duplicate", "cmd-stale"]);
    const client: WorkoutSyncApiClient = {
      syncCommands: (_token, request: SyncWorkoutCommandsRequest): Promise<SyncWorkoutCommandsResponse> =>
        Promise.resolve({
          acknowledgements: request.commands.map((command, index) => ({
            commandId: command.commandId,
            outcome: (["APPLIED", "DUPLICATE", "STALE"] as const)[index] ?? "APPLIED",
          })),
        }),
    };
    const engine = new SyncEngine(OWNER, outbox, new WorkingAuthTokenProvider(), client);

    const result = await engine.syncPendingCommands();

    expect(result.synced).toBe(3);
    expect(outbox.statuses.get("cmd-applied")).toBe("SYNCED");
    expect(outbox.statuses.get("cmd-duplicate")).toBe("SYNCED");
    expect(outbox.statuses.get("cmd-stale")).toBe("SYNCED");
  });

  it("spec section 34: a REJECTED acknowledgement only marks the outbox row — never deletes local data", async () => {
    const outbox = new InMemoryOutbox(["cmd-1"]);
    const client: WorkoutSyncApiClient = {
      syncCommands: () =>
        Promise.resolve({ acknowledgements: [{ commandId: "cmd-1", outcome: "REJECTED" }] }),
    };
    const engine = new SyncEngine(OWNER, outbox, new WorkingAuthTokenProvider(), client);

    const result = await engine.syncPendingCommands();

    expect(result.rejected).toBe(1);
    expect(outbox.statuses.get("cmd-1")).toBe("REJECTED");
    // The outbox port has no delete-workout-data method at all — a
    // REJECTED outcome structurally cannot touch performed-set rows.
  });

  it("spec section 40 (lost ACK, client side): retrying after a transient failure resends the same commandId, not a new one", async () => {
    const outbox = new InMemoryOutbox(["cmd-1"]);
    let callCount = 0;
    const seenCommandIds: string[] = [];
    const client: WorkoutSyncApiClient = {
      syncCommands: (_token, request) => {
        callCount += 1;
        seenCommandIds.push(...request.commands.map((c) => c.commandId));
        if (callCount === 1) return Promise.reject(new TransientSyncFailure("timeout"));
        return Promise.resolve({
          acknowledgements: request.commands.map((c) => ({ commandId: c.commandId, outcome: "APPLIED" as const })),
        });
      },
    };
    const engine = new SyncEngine(OWNER, outbox, new WorkingAuthTokenProvider(), client);

    await engine.syncPendingCommands(); // fails transiently, stays RETRY
    expect(outbox.statuses.get("cmd-1")).toBe("RETRY");
    const secondResult = await engine.syncPendingCommands();

    expect(seenCommandIds).toEqual(["cmd-1", "cmd-1"]); // exact same commandId both times
    expect(secondResult.synced).toBe(1);
  });

  it("single-flight: overlapping calls share one in-flight run instead of double-sending", async () => {
    const outbox = new InMemoryOutbox(["cmd-1", "cmd-2"]);
    let callCount = 0;
    let resolveSync: ((response: SyncWorkoutCommandsResponse) => void) | undefined;
    const client: WorkoutSyncApiClient = {
      syncCommands: (_token, request) => {
        callCount += 1;
        return new Promise((resolve) => {
          resolveSync = () =>
            resolve({
              acknowledgements: request.commands.map((c) => ({ commandId: c.commandId, outcome: "APPLIED" as const })),
            });
        });
      },
    };
    const engine = new SyncEngine(OWNER, outbox, new WorkingAuthTokenProvider(), client);

    // Two "independent" triggers (e.g. a workout mutation and an app-resume
    // event) fire before the first network call has resolved.
    const first = engine.syncPendingCommands();
    const second = engine.syncPendingCommands();

    // Let the shared run's internal awaits (getPendingCommands, markSyncing,
    // getAccessToken) actually progress before it reaches the network call.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(callCount).toBe(1); // the second call joined the first instead of starting a new one

    resolveSync?.({ acknowledgements: [] });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(callCount).toBe(1);
    expect(firstResult).toBe(secondResult); // same result object — one shared run
    expect(firstResult.synced).toBe(2);

    // Once settled, a genuinely new call starts a fresh run rather than
    // replaying the finished one — with nothing left pending, it does not
    // even reach the network (no-op, not a stale duplicate).
    const thirdResult = await engine.syncPendingCommands();
    expect(callCount).toBe(1);
    expect(thirdResult.attempted).toBe(0);
  });
});

describe("SyncEngine — Auth & Local Athlete Boundary V1 Slice B owner binding", () => {
  class MismatchedOwnerTokenProvider implements AuthTokenProvider {
    getAccessToken(): Promise<string> {
      return Promise.reject(new RuntimeOwnerMismatchError());
    }
  }

  it("SYNC-21/22: every batch carries the runtime's verified ownerUserId", async () => {
    const requests: SyncWorkoutCommandsRequest[] = [];
    const client: WorkoutSyncApiClient = {
      syncCommands: (_token, request) => {
        requests.push(request);
        return Promise.resolve({ acknowledgements: request.commands.map((c) => ({ commandId: c.commandId, outcome: "APPLIED" as const })) });
      },
    };
    const ownerB = "0190a000-0000-7000-8000-00000000000b";

    await new SyncEngine(OWNER, new InMemoryOutbox(["a-1"]), new WorkingAuthTokenProvider(), client).syncPendingCommands();
    await new SyncEngine(ownerB, new InMemoryOutbox(["b-1"]), new WorkingAuthTokenProvider(), client).syncPendingCommands();

    expect(requests.map((r) => [r.ownerUserId, r.commands.map((c) => c.commandId)])).toEqual([
      [OWNER, ["a-1"]],
      [ownerB, ["b-1"]],
    ]);
  });

  it("SYNC-23/24: runtime owner != current session -> no network call, the outbox is not touched (no SYNCING, no attempt, no RETRY)", async () => {
    const outbox = new InMemoryOutbox(["cmd-1", "cmd-2"]);
    const syncCommands = vi.fn<WorkoutSyncApiClient["syncCommands"]>();
    const engine = new SyncEngine(OWNER, outbox, new MismatchedOwnerTokenProvider(), { syncCommands });

    await expect(engine.syncPendingCommands()).rejects.toBeInstanceOf(RuntimeOwnerMismatchError);

    expect(syncCommands).not.toHaveBeenCalled();
    expect([...outbox.statuses.values()]).toEqual(["PENDING", "PENDING"]);
  });

  it("server 409 SYNC_OWNER_MISMATCH (defence in depth): nothing was processed -> rows go back to retryable for their owner and the mismatch propagates", async () => {
    const outbox = new InMemoryOutbox(["cmd-1"]);
    const engine = new SyncEngine(OWNER, outbox, new WorkingAuthTokenProvider(), {
      syncCommands: () => Promise.reject(new RuntimeOwnerMismatchError()),
    });

    await expect(engine.syncPendingCommands()).rejects.toBeInstanceOf(RuntimeOwnerMismatchError);
    expect(outbox.statuses.get("cmd-1")).toBe("RETRY");
  });
});
