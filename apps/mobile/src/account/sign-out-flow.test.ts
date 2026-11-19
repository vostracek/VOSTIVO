import { describe, expect, it, vi } from "vitest";
import { checkBeforeSignOut, SIGN_OUT_COPY, waitForSyncPass, type SignOutCheckPorts, type UnsyncedWork } from "./sign-out-flow";

function ports(sequence: UnsyncedWork[]): SignOutCheckPorts & { syncRequests: number } {
  let index = 0;
  const listeners = new Set<() => void>();
  const result = {
    syncRequests: 0,
    readUnsyncedWork: () => Promise.resolve(sequence[Math.min(index++, sequence.length - 1)]!),
    requestSync: () => {
      result.syncRequests += 1;
      for (const listener of [...listeners]) listener();
    },
    onSyncPassSettled: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return result;
}

const none: UnsyncedWork = { pendingCommands: 0, hasActiveWorkout: false };

describe("Auth Slice D sign-out check", () => {
  it("AUTH-SO-001: nothing unsynced -> CLEAR without any sync pass", async () => {
    const p = ports([none]);
    await expect(checkBeforeSignOut(p)).resolves.toEqual({ kind: "CLEAR" });
    expect(p.syncRequests).toBe(0);
  });

  it("AUTH-SO-002: pending commands -> one bounded sync pass; synced in time -> CLEAR", async () => {
    const p = ports([{ pendingCommands: 3, hasActiveWorkout: false }, none]);
    await expect(checkBeforeSignOut(p)).resolves.toEqual({ kind: "CLEAR" });
    expect(p.syncRequests).toBe(1);
  });

  it("AUTH-SO-003 (offline sign-out): still unsynced after the pass -> UNSYNCED warning, never a block", async () => {
    const p = ports([{ pendingCommands: 2, hasActiveWorkout: false }]);
    await expect(checkBeforeSignOut(p)).resolves.toEqual({ kind: "UNSYNCED", work: { pendingCommands: 2, hasActiveWorkout: false } });
  });

  it("AUTH-SO-004: an ACTIVE workout always warns (it cannot be synced away)", async () => {
    const p = ports([{ pendingCommands: 0, hasActiveWorkout: true }]);
    await expect(checkBeforeSignOut(p)).resolves.toMatchObject({ kind: "UNSYNCED" });
    expect(p.syncRequests).toBe(0);
  });

  it("AUTH-SO-005: the sync wait is bounded — a pass that never settles resolves at the timeout", async () => {
    vi.useFakeTimers();
    const silent: SignOutCheckPorts = { readUnsyncedWork: () => Promise.resolve(none), requestSync: () => {}, onSyncPassSettled: () => () => {} };
    let resolved = false;
    void waitForSyncPass(silent, 10_000).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
    vi.useRealTimers();
  });

  it("AUTH-SO-006: the warning copy is calm and never says data is lost or deleted", () => {
    const copy = JSON.stringify(SIGN_OUT_COPY).toLowerCase();
    for (const forbidden of ["delete", "lost", "erase", "wipe", "!"]) expect(copy).not.toContain(forbidden);
    expect(SIGN_OUT_COPY.unsyncedTitle).toBe("Your workout hasn't synced yet.");
  });
});
