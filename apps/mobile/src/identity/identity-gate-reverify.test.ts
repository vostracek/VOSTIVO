import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AuthSession } from "./auth-session";
import {
  IdentityGateController,
  OWNER_REVERIFY_RETRY_DELAYS_MS,
  type IdentityGateState,
  type OwnerVerification,
} from "./identity-gate-controller";
import type { IdentityResolution } from "./identity-resolution";
import type { VerifiedIdentity } from "./identity-binding-store";
import type {
  AppLifecycleSource,
  AppLifecycleState,
  ConnectivitySource,
} from "../infrastructure/sync-recovery";
import type { SyncScheduler } from "../infrastructure/workout-sync-coordinator";
import { ControllableSessionSource } from "./testing/controllable-session-source";

/** ANDROID-STAB-03 D3: owner re-verification retry while the app stays active. */

const A: VerifiedIdentity = {
  userId: "0190a000-0000-7000-8000-00000000000a",
  athleteProfileId: "0190a000-0000-7000-8000-0000000000aa",
};
const SESSION_A: AuthSession = {
  provider: "supabase",
  providerSubject: "sub-a",
  accessToken: "token-a",
};

class FakeRuntime {
  readonly permits: boolean[] = [];
  syncPermitted: boolean;
  constructor(
    readonly ownerUserId: string,
    verification: OwnerVerification,
  ) {
    this.syncPermitted = verification === "ONLINE";
  }
  setSyncPermitted(permitted: boolean): void {
    this.permits.push(permitted);
    this.syncPermitted = permitted;
  }
  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeSignal<T> {
  private readonly listeners = new Set<(value: T) => void>();
  subscribe(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }
}

class FakeScheduler implements SyncScheduler {
  private next = 0;
  readonly timers = new Map<number, { callback: () => void; delayMs: number }>();
  readonly delays: number[] = [];
  setTimeout(callback: () => void, delayMs: number): unknown {
    this.next += 1;
    this.timers.set(this.next, { callback, delayMs });
    this.delays.push(delayMs);
    return this.next;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  /** Fires every pending timer (there must be at most one). */
  fire(): void {
    expect(this.timers.size).toBeLessThanOrEqual(1);
    const pending = [...this.timers.values()];
    this.timers.clear();
    for (const timer of pending) timer.callback();
  }
}

/** `api` decides what `/me` answers right now: "down" -> the stored binding only. */
function harness(options: { api: "down" | "up" | "unauthorized" }) {
  const api = { state: options.api };
  const resolveCalls: string[] = [];
  const states: IdentityGateState<FakeRuntime>[] = [];
  const network = new FakeSignal<boolean>();
  const lifecycle = new FakeSignal<AppLifecycleState>();
  const scheduler = new FakeScheduler();
  const connectivity: ConnectivitySource = { subscribe: (listener) => network.subscribe(listener) };
  const appLifecycle: AppLifecycleSource = {
    subscribe: (listener) => lifecycle.subscribe(listener),
  };
  const controller = new IdentityGateController<FakeRuntime>({
    sessionSource: new ControllableSessionSource(SESSION_A),
    resolveIdentity: (): Promise<IdentityResolution> => {
      resolveCalls.push(api.state);
      if (api.state === "up")
        return Promise.resolve({ kind: "VERIFIED", identity: A, source: "ONLINE" });
      if (api.state === "unauthorized")
        return Promise.resolve({ kind: "IDENTITY_ERROR", reason: "UNAUTHORIZED" });
      return Promise.resolve({ kind: "VERIFIED", identity: A, source: "OFFLINE_BINDING" });
    },
    openRuntime: (identity, _session, verification) =>
      Promise.resolve({ kind: "OPENED", runtime: new FakeRuntime(identity.userId, verification) }),
    onStateChange: (state) => states.push(state),
    connectivity,
    appLifecycle,
    reverifyScheduler: scheduler,
  });
  const ready = () =>
    states[states.length - 1] as Extract<IdentityGateState<FakeRuntime>, { status: "READY" }>;
  /** Lets the serialized evaluation queue drain. */
  const flush = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };
  return { api, resolveCalls, states, network, lifecycle, scheduler, controller, ready, flush };
}

describe("IdentityGateController owner re-verification retry (ANDROID-STAB-03 D3)", () => {
  it("REVERIFY-001: API down at launch, device online, app stays in the foreground -> the timer re-verifies and grants sync with NO lifecycle/network event", async () => {
    const h = harness({ api: "down" });
    h.controller.start();
    await h.flush();
    expect(h.ready()).toMatchObject({
      status: "READY",
      verification: "OFFLINE_BINDING",
      auth: "VALID",
    });
    expect(h.ready().runtime.syncPermitted).toBe(false);
    expect(h.scheduler.timers.size).toBe(1);

    // Still down on the first retry: never permitted, next timer backs off.
    h.scheduler.fire();
    await h.flush();
    expect(h.ready().runtime.syncPermitted).toBe(false);

    h.api.state = "up";
    h.scheduler.fire();
    await h.flush();

    expect(h.ready()).toMatchObject({ status: "READY", verification: "ONLINE", auth: "VALID" });
    expect(h.ready().runtime.syncPermitted).toBe(true);
    expect(h.ready().runtime.permits).toEqual([true]);
    expect(h.scheduler.timers.size).toBe(0);
    expect(h.scheduler.delays).toEqual([
      OWNER_REVERIFY_RETRY_DELAYS_MS[0],
      OWNER_REVERIFY_RETRY_DELAYS_MS[1],
    ]);
  });

  it("REVERIFY-002: backoff is capped (last delay repeats) and there is never more than one timer", async () => {
    const h = harness({ api: "down" });
    h.controller.start();
    await h.flush();
    for (let i = 0; i < 6; i += 1) {
      h.scheduler.fire();
      await h.flush();
      expect(h.scheduler.timers.size).toBe(1);
    }
    expect(h.scheduler.delays).toEqual([5_000, 10_000, 30_000, 60_000, 60_000, 60_000, 60_000]);
    expect(h.resolveCalls).toHaveLength(7);
  });

  it("REVERIFY-003: background stops the retry; foreground re-verifies and restarts the backoff from the first step", async () => {
    const h = harness({ api: "down" });
    h.controller.start();
    await h.flush();
    h.scheduler.fire();
    await h.flush();

    h.lifecycle.emit("background");
    expect(h.scheduler.timers.size).toBe(0);
    const callsInBackground = h.resolveCalls.length;
    await h.flush();
    expect(h.resolveCalls).toHaveLength(callsInBackground);

    h.lifecycle.emit("active");
    await h.flush();
    expect(h.resolveCalls).toHaveLength(callsInBackground + 1);
    expect(h.scheduler.delays.at(-1)).toBe(OWNER_REVERIFY_RETRY_DELAYS_MS[0]);
  });

  it("REVERIFY-004: known offline -> no polling; network regain re-verifies", async () => {
    const h = harness({ api: "down" });
    h.controller.start();
    await h.flush();
    h.network.emit(false);
    expect(h.scheduler.timers.size).toBe(0);

    h.api.state = "up";
    h.network.emit(true);
    await h.flush();
    expect(h.ready()).toMatchObject({ verification: "ONLINE" });
    expect(h.scheduler.timers.size).toBe(0);
  });

  it("REVERIFY-005: an already ONLINE owner never schedules a retry", async () => {
    const h = harness({ api: "up" });
    h.controller.start();
    await h.flush();
    expect(h.ready()).toMatchObject({ verification: "ONLINE" });
    expect(h.scheduler.delays).toEqual([]);
  });

  it("REVERIFY-006: an invalid session (REAUTH_REQUIRED) is never retried by the timer and never syncs", async () => {
    const h = harness({ api: "down" });
    h.controller.start();
    await h.flush();
    h.api.state = "unauthorized";
    h.scheduler.fire();
    await h.flush();
    expect(h.ready()).toMatchObject({ auth: "REAUTH_REQUIRED" });
    expect(h.ready().runtime.syncPermitted).toBe(false);
    expect(h.scheduler.timers.size).toBe(0);
  });

  it("REVERIFY-007: stop() clears the pending timer", async () => {
    const h = harness({ api: "down" });
    h.controller.start();
    await h.flush();
    expect(h.scheduler.timers.size).toBe(1);
    await h.controller.stop();
    expect(h.scheduler.timers.size).toBe(0);
  });

  it("REVERIFY-008: the production gate wires the real scheduler", () => {
    const source = readFileSync(new URL("./identity-gate.tsx", import.meta.url), "utf8");
    expect(source).toContain("reverifyScheduler: realScheduler");
  });
});
