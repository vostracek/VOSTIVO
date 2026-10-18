import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncPendingCommandsResult } from "../workout/sync-engine";
import { WorkoutSyncCoordinator, type SyncScheduler } from "./workout-sync-coordinator";

const EMPTY: SyncPendingCommandsResult = { attempted: 0, synced: 0, retried: 0, conflicted: 0, rejected: 0 };
const SYNCED: SyncPendingCommandsResult = { attempted: 2, synced: 2, retried: 0, conflicted: 0, rejected: 0 };
const TRANSIENT_FAILURE: SyncPendingCommandsResult = { attempted: 2, synced: 0, retried: 2, conflicted: 0, rejected: 0 };
const REJECTED: SyncPendingCommandsResult = { attempted: 1, synced: 0, retried: 0, conflicted: 0, rejected: 1 };
const CONFLICTED: SyncPendingCommandsResult = { attempted: 1, synced: 0, retried: 0, conflicted: 1, rejected: 0 };

/** Real `setTimeout` under vitest fake timers, so time only moves when a test advances it. */
const fakeTimerScheduler: SyncScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A sync whose results are scripted per call; the last result repeats. */
function scriptedSync(...results: (SyncPendingCommandsResult | Error)[]) {
  const sync = vi.fn(() => {
    const next = results.length > 1 ? results.shift() : results[0];
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? EMPTY);
  });
  return sync;
}

/** A sync that stays in flight until the test resolves it. */
function controllableSync() {
  const pending: ((result: SyncPendingCommandsResult) => void)[] = [];
  const sync = vi.fn(
    () =>
      new Promise<SyncPendingCommandsResult>((resolve) => {
        pending.push(resolve);
      }),
  );
  return {
    sync,
    resolveNext(result: SyncPendingCommandsResult = EMPTY) {
      const resolve = pending.shift();
      if (resolve === undefined) throw new Error("no sync in flight");
      resolve(result);
    },
  };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("WorkoutSyncCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a mutation trigger requests a sync immediately", async () => {
    const sync = scriptedSync(SYNCED);
    const coordinator = new WorkoutSyncCoordinator(sync, { scheduler: fakeTimerScheduler });

    coordinator.requestSync("mutation");

    expect(sync).toHaveBeenCalledTimes(1);
    await flush();
  });

  it("a successful (or empty) sync schedules no retry and never polls again", async () => {
    const sync = scriptedSync(EMPTY);
    const coordinator = new WorkoutSyncCoordinator(sync, { scheduler: fakeTimerScheduler });

    coordinator.requestSync("launch");
    await flush();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(coordinator.hasScheduledRetry).toBe(false);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("a retryable failure schedules the first retry after exactly 2 s", async () => {
    const sync = scriptedSync(TRANSIENT_FAILURE, SYNCED);
    const coordinator = new WorkoutSyncCoordinator(sync, { scheduler: fakeTimerScheduler });

    coordinator.requestSync("mutation");
    await flush();
    expect(coordinator.hasScheduledRetry).toBe(true);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(sync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("repeated failures back off 2 -> 5 -> 10 -> 30 -> 30 s", async () => {
    const sync = scriptedSync(TRANSIENT_FAILURE);
    const coordinator = new WorkoutSyncCoordinator(sync, { scheduler: fakeTimerScheduler });

    coordinator.requestSync("mutation");
    await flush();

    const expectedGapsMs = [2_000, 5_000, 10_000, 30_000, 30_000];
    for (const [index, gapMs] of expectedGapsMs.entries()) {
      await vi.advanceTimersByTimeAsync(gapMs - 1);
      expect(sync).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sync).toHaveBeenCalledTimes(index + 2);
    }
  });

  it("an unexpected error thrown by the engine is retried on the same backoff (the engine already left the commands RETRY)", async () => {
    const sync = scriptedSync(new Error("unexpected"), SYNCED);
    const coordinator = new WorkoutSyncCoordinator(sync, { scheduler: fakeTimerScheduler });

    expect(() => coordinator.requestSync("mutation")).not.toThrow();
    await flush();
    expect(coordinator.hasScheduledRetry).toBe(true);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(coordinator.hasScheduledRetry).toBe(false);
  });

  it("a later success cancels retrying and resets the backoff to 2 s", async () => {
    const sync = scriptedSync(TRANSIENT_FAILURE, TRANSIENT_FAILURE, SYNCED, TRANSIENT_FAILURE, SYNCED);
    const coordinator = new WorkoutSyncCoordinator(sync, { scheduler: fakeTimerScheduler });

    coordinator.requestSync("mutation"); // fails -> retry in 2 s
    await flush();
    await vi.advanceTimersByTimeAsync(2_000); // fails -> retry in 5 s
    await vi.advanceTimersByTimeAsync(5_000); // succeeds
    expect(sync).toHaveBeenCalledTimes(3);
    expect(coordinator.hasScheduledRetry).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(sync).toHaveBeenCalledTimes(3); // idle: nothing left to sync

    coordinator.requestSync("mutation"); // fails -> backoff restarts at 2 s, not 10 s
    await flush();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(sync).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledTimes(5);
  });

  it("a trigger while a retry timer is pending runs immediately and replaces the timer — no second timer, no storm", async () => {
    const sync = scriptedSync(TRANSIENT_FAILURE, SYNCED);
    const coordinator = new WorkoutSyncCoordinator(sync, { scheduler: fakeTimerScheduler });

    coordinator.requestSync("mutation");
    await flush();
    expect(coordinator.hasScheduledRetry).toBe(true);

    coordinator.requestSync("network-regain");
    expect(sync).toHaveBeenCalledTimes(2);
    expect(coordinator.hasScheduledRetry).toBe(false);
    await flush();

    // The superseded 2 s timer never fires a third request.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("several simultaneous triggers start at most one sync", async () => {
    const control = controllableSync();
    const coordinator = new WorkoutSyncCoordinator(control.sync, { scheduler: fakeTimerScheduler });

    coordinator.requestSync("mutation");
    coordinator.requestSync("foreground");
    coordinator.requestSync("network-regain");
    coordinator.requestSync("retry");

    expect(control.sync).toHaveBeenCalledTimes(1);

    control.resolveNext(SYNCED);
    await flush();
    // The three triggers that arrived mid-flight coalesce into ONE follow-up pass.
    expect(control.sync).toHaveBeenCalledTimes(2);

    control.resolveNext(EMPTY);
    await flush();
    expect(control.sync).toHaveBeenCalledTimes(2);
  });

  it("a trigger during an active sync is coalesced into a follow-up pass after it, never an overlapping request", async () => {
    const control = controllableSync();
    const coordinator = new WorkoutSyncCoordinator(control.sync, { scheduler: fakeTimerScheduler });

    coordinator.requestSync("mutation");
    await flush();
    coordinator.requestSync("mutation"); // e.g. the next set logged while the first sync is still in flight
    await flush();
    expect(control.sync).toHaveBeenCalledTimes(1);

    control.resolveNext(SYNCED);
    await flush();
    expect(control.sync).toHaveBeenCalledTimes(2);
  });

  it("a full batch triggers one more pass right away, since more commands may be pending", async () => {
    const fullBatch: SyncPendingCommandsResult = { attempted: 2, synced: 2, retried: 0, conflicted: 0, rejected: 0 };
    const sync = scriptedSync(fullBatch, EMPTY);
    const coordinator = new WorkoutSyncCoordinator(sync, { scheduler: fakeTimerScheduler, batchSize: 2 });

    coordinator.requestSync("launch");
    await flush();

    expect(sync).toHaveBeenCalledTimes(2);
    expect(coordinator.hasScheduledRetry).toBe(false);
  });

  it.each([
    ["REJECTED", REJECTED],
    ["CONFLICT", CONFLICTED],
  ])("a %s outcome is terminal: no retry is scheduled, no loop", async (_label, result) => {
    const sync = scriptedSync(result);
    const coordinator = new WorkoutSyncCoordinator(sync, { scheduler: fakeTimerScheduler });

    coordinator.requestSync("mutation");
    await flush();
    await vi.advanceTimersByTimeAsync(300_000);

    expect(coordinator.hasScheduledRetry).toBe(false);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("dispose clears the retry timer and ignores every later trigger", async () => {
    const sync = scriptedSync(TRANSIENT_FAILURE);
    const coordinator = new WorkoutSyncCoordinator(sync, { scheduler: fakeTimerScheduler });

    coordinator.requestSync("mutation");
    await flush();
    expect(coordinator.hasScheduledRetry).toBe(true);

    coordinator.dispose();
    expect(coordinator.hasScheduledRetry).toBe(false);

    coordinator.requestSync("foreground");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("logs attempt, scheduled retry and recovery for DEV observability", async () => {
    const debug = vi.fn();
    const sync = scriptedSync(TRANSIENT_FAILURE, SYNCED);
    const coordinator = new WorkoutSyncCoordinator(sync, { scheduler: fakeTimerScheduler, logger: { debug } });

    coordinator.requestSync("mutation");
    await flush();
    await vi.advanceTimersByTimeAsync(2_000);

    const messages = debug.mock.calls.map(([message]) => message);
    expect(messages).toEqual([
      "workout sync attempt",
      "workout sync retry scheduled",
      "workout sync attempt",
      "workout sync succeeded",
      "workout sync recovered after retry",
    ]);
  });
});
