import { describe, expect, it } from "vitest";
import {
  startOutboxSyncRecovery,
  type AppLifecycleSource,
  type AppLifecycleState,
  type ConnectivitySource,
} from "./sync-recovery";
import type { WorkoutSyncTrigger } from "./workout-sync-coordinator";

/**
 * Fakes at the lifecycle and connectivity boundaries — real `AppState` and
 * `expo-network` transitions are verified natively instead (spec: "Do not
 * pretend a unit test proves native lifecycle behavior"). This proves the
 * wiring only: which events become which sync requests, and that cleanup
 * detaches every listener. Single-flight, coalescing and retry are the
 * coordinator's job (workout-sync-coordinator.test.ts).
 */
class FakeAppLifecycleSource implements AppLifecycleSource {
  private listener: ((nextState: AppLifecycleState) => void) | undefined;
  unsubscribeCount = 0;

  subscribe(onChange: (nextState: AppLifecycleState) => void): () => void {
    this.listener = onChange;
    return () => {
      this.unsubscribeCount += 1;
      this.listener = undefined;
    };
  }

  emit(nextState: AppLifecycleState): void {
    this.listener?.(nextState);
  }
}

class FakeConnectivitySource implements ConnectivitySource {
  private listener: ((isConnected: boolean) => void) | undefined;
  unsubscribeCount = 0;

  subscribe(onChange: (isConnected: boolean) => void): () => void {
    this.listener = onChange;
    return () => {
      this.unsubscribeCount += 1;
      this.listener = undefined;
    };
  }

  emit(isConnected: boolean): void {
    this.listener?.(isConnected);
  }
}

function recordingTarget() {
  const requests: WorkoutSyncTrigger[] = [];
  return { requests, requestSync: (trigger: WorkoutSyncTrigger) => requests.push(trigger) };
}

describe("startOutboxSyncRecovery", () => {
  it("requests a sync immediately on launch — covers a recovered SYNCING/PENDING/RETRY command with no further mutation needed", () => {
    const target = recordingTarget();

    startOutboxSyncRecovery(target, new FakeAppLifecycleSource());

    expect(target.requests).toEqual(["launch"]);
  });

  it("requests another sync on every foreground resume", () => {
    const lifecycle = new FakeAppLifecycleSource();
    const target = recordingTarget();

    startOutboxSyncRecovery(target, lifecycle);
    lifecycle.emit("active");
    lifecycle.emit("active");

    expect(target.requests).toEqual(["launch", "foreground", "foreground"]);
  });

  it("does not request on background/inactive transitions — only 'active' means resumed", () => {
    const lifecycle = new FakeAppLifecycleSource();
    const target = recordingTarget();

    startOutboxSyncRecovery(target, lifecycle);
    lifecycle.emit("background");
    lifecycle.emit("inactive");

    expect(target.requests).toEqual(["launch"]);
  });

  it("requests a sync when connectivity goes unavailable -> available", () => {
    const connectivity = new FakeConnectivitySource();
    const target = recordingTarget();

    startOutboxSyncRecovery(target, new FakeAppLifecycleSource(), connectivity);
    connectivity.emit(true); // baseline
    connectivity.emit(false);
    connectivity.emit(true); // regained

    expect(target.requests).toEqual(["launch", "network-regain"]);
  });

  it("does not treat the first connectivity report, or a repeated 'connected', as a regain", () => {
    const connectivity = new FakeConnectivitySource();
    const target = recordingTarget();

    startOutboxSyncRecovery(target, new FakeAppLifecycleSource(), connectivity);
    connectivity.emit(true);
    connectivity.emit(true);
    connectivity.emit(true);

    expect(target.requests).toEqual(["launch"]);
  });

  it("an initially offline device that comes online requests a sync", () => {
    const connectivity = new FakeConnectivitySource();
    const target = recordingTarget();

    startOutboxSyncRecovery(target, new FakeAppLifecycleSource(), connectivity);
    connectivity.emit(false);
    connectivity.emit(true);

    expect(target.requests).toEqual(["launch", "network-regain"]);
  });

  it("works without a connectivity source (a build without the native module)", () => {
    const lifecycle = new FakeAppLifecycleSource();
    const target = recordingTarget();

    const stop = startOutboxSyncRecovery(target, lifecycle, undefined);
    lifecycle.emit("active");
    stop();

    expect(target.requests).toEqual(["launch", "foreground"]);
    expect(lifecycle.unsubscribeCount).toBe(1);
  });

  it("cleanup unsubscribes both the lifecycle and the connectivity listener", () => {
    const lifecycle = new FakeAppLifecycleSource();
    const connectivity = new FakeConnectivitySource();
    const target = recordingTarget();

    const stop = startOutboxSyncRecovery(target, lifecycle, connectivity);
    stop();

    expect(lifecycle.unsubscribeCount).toBe(1);
    expect(connectivity.unsubscribeCount).toBe(1);

    lifecycle.emit("active");
    connectivity.emit(false);
    connectivity.emit(true);
    expect(target.requests).toEqual(["launch"]);
  });
});
