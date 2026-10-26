import { describe, expect, it } from "vitest";
import type { AuthSession } from "./auth-session";
import { IdentityGateController, type IdentityGateState, type OpenRuntimeResult, type OwnerVerification } from "./identity-gate-controller";
import type { AppLifecycleSource, ConnectivitySource } from "../infrastructure/sync-recovery";
import type { IdentityResolution } from "./identity-resolution";
import type { VerifiedIdentity } from "./identity-binding-store";
import { ControllableSessionSource } from "./testing/controllable-session-source";

const A: VerifiedIdentity = { userId: "0190a000-0000-7000-8000-00000000000a", athleteProfileId: "0190a000-0000-7000-8000-0000000000aa" };
const B: VerifiedIdentity = { userId: "0190a000-0000-7000-8000-00000000000b", athleteProfileId: "0190a000-0000-7000-8000-0000000000bb" };
const SESSION_A: AuthSession = { provider: "supabase", providerSubject: "sub-a", accessToken: "token-a" };
const SESSION_B: AuthSession = { provider: "supabase", providerSubject: "sub-b", accessToken: "token-b" };

class FakeRuntime {
  disposed = false;
  syncPermitted: boolean;
  constructor(
    readonly ownerUserId: string,
    private readonly log: string[],
    verification: OwnerVerification = "ONLINE",
  ) {
    this.syncPermitted = verification === "ONLINE";
  }
  setSyncPermitted(permitted: boolean): void {
    this.log.push(`sync:${this.ownerUserId}:${permitted}`);
    this.syncPermitted = permitted;
  }
  dispose(): Promise<void> {
    this.log.push(`dispose:${this.ownerUserId}`);
    this.disposed = true;
    return Promise.resolve();
  }
}

type ResolveFn = (session: AuthSession) => Promise<IdentityResolution>;

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

function harness(initial: AuthSession | null, resolve: ResolveFn, open?: (identity: VerifiedIdentity) => OpenRuntimeResult<FakeRuntime>) {
  const log: string[] = [];
  const states: IdentityGateState<FakeRuntime>[] = [];
  const source = new ControllableSessionSource(initial);
  const network = new FakeSignal<boolean>();
  const lifecycle = new FakeSignal<"active" | "background" | "inactive">();
  const connectivity: ConnectivitySource = { subscribe: (listener) => network.subscribe(listener) };
  const appLifecycle = { subscribe: (listener: (state: "active" | "background" | "inactive") => void) => lifecycle.subscribe(listener) } as AppLifecycleSource;
  const controller = new IdentityGateController<FakeRuntime>({
    sessionSource: source,
    resolveIdentity: async (session) => {
      log.push(`resolve:${session.providerSubject}`);
      return resolve(session);
    },
    openRuntime: (identity, _session, verification) => {
      log.push(`open:${identity.userId}`);
      return Promise.resolve(open?.(identity) ?? { kind: "OPENED", runtime: new FakeRuntime(identity.userId, log, verification) });
    },
    connectivity,
    appLifecycle,
    onStateChange: (state) => {
      states.push(state);
      log.push(`state:${state.status}${state.status === "READY" ? `:${state.identity.userId}` : ""}`);
    },
  });
  const current = () => states[states.length - 1]!;
  const settle = () => controller.reevaluate().then(() => undefined);
  const runtime = () => (current() as ReadyState).runtime;
  return { log, states, source, controller, current, settle, network, lifecycle, runtime };
}

type ReadyState = Extract<IdentityGateState<FakeRuntime>, { status: "READY" }>;

const online: Record<string, VerifiedIdentity> = { "sub-a": A, "sub-b": B };
const verifyOnline: ResolveFn = (session) => Promise.resolve({ kind: "VERIFIED", identity: online[session.providerSubject]!, source: "ONLINE" });

describe("IdentityGateController", () => {
  it("GATE-1/4: verified A -> opens A's runtime; READY is the only state that carries a runtime and it comes last", async () => {
    const h = harness(SESSION_A, verifyOnline);
    h.controller.start();
    await h.settle();

    expect(h.log).toEqual(["state:BOOTING", "state:VERIFYING", "resolve:sub-a", "open:" + A.userId, "state:READY:" + A.userId]);
    expect(h.states.filter((state) => state.status === "READY")).toHaveLength(1);
  });

  it("GATE-2/3: A -> B disposes A (database closed) BEFORE B is resolved or opened, with a neutral state in between", async () => {
    const h = harness(SESSION_A, verifyOnline);
    h.controller.start();
    await h.settle();
    const runtimeA = h.runtime();
    h.log.length = 0;

    h.source.set(SESSION_B);
    await h.settle();

    expect(h.log).toEqual(["state:VERIFYING", "dispose:" + A.userId, "state:VERIFYING", "resolve:sub-b", "open:" + B.userId, "state:READY:" + B.userId]);
    expect(runtimeA.disposed).toBe(true);
  });

  it("GATE-8 / AUTH-LOCAL-003: a new token for the same subject keeps the SAME runtime (no dispose, no reopen, no state flicker)", async () => {
    const h = harness(SESSION_A, verifyOnline);
    h.controller.start();
    await h.settle();
    const ready = h.current();
    h.log.length = 0;

    h.source.set({ ...SESSION_A, accessToken: "token-a-refreshed" });
    await h.settle();

    expect(h.log).toEqual(["resolve:sub-a"]);
    expect(h.current()).toBe(ready);
  });

  it("GATE-5: unknown subject offline -> NEEDS_NETWORK and nothing is opened", async () => {
    const h = harness(SESSION_A, () => Promise.resolve({ kind: "NEEDS_NETWORK" }));
    h.controller.start();
    await h.settle();
    expect(h.current()).toEqual({ status: "NEEDS_NETWORK" });
    expect(h.log.some((entry) => entry.startsWith("open:"))).toBe(false);
  });

  it("GATE-6: known subject offline -> READY offline with the bound user's runtime", async () => {
    const h = harness(SESSION_A, () => Promise.resolve({ kind: "VERIFIED", identity: A, source: "OFFLINE_BINDING" }));
    h.controller.start();
    await h.settle();
    expect(h.current()).toMatchObject({ status: "READY", identity: A, verification: "OFFLINE_BINDING" });
  });

  it("GATE-9: a binding conflict while READY tears the runtime down and fails closed", async () => {
    let conflict = false;
    const h = harness(SESSION_A, (session) => (conflict ? Promise.resolve({ kind: "IDENTITY_ERROR", reason: "BINDING_CONFLICT" }) : verifyOnline(session)));
    h.controller.start();
    await h.settle();
    conflict = true;
    h.source.set({ ...SESSION_A, accessToken: "token-a-2" });
    await h.settle();

    expect(h.log).toContain("dispose:" + A.userId);
    expect(h.current()).toEqual({ status: "IDENTITY_ERROR", reason: "BINDING_CONFLICT" });
  });

  it("GATE-10: identity failure never opens any database (no legacy / cached fallback)", async () => {
    const h = harness(SESSION_B, () => Promise.resolve({ kind: "IDENTITY_ERROR", reason: "INVALID_RESPONSE" }));
    h.controller.start();
    await h.settle();
    expect(h.log.some((entry) => entry.startsWith("open:"))).toBe(false);
    expect(h.current()).toEqual({ status: "IDENTITY_ERROR", reason: "INVALID_RESPONSE" });
  });

  it("a /me 401 (after its one refresh) with no owner open -> REAUTH_REQUIRED, no database opened", async () => {
    const h = harness(SESSION_B, () => Promise.resolve({ kind: "IDENTITY_ERROR", reason: "UNAUTHORIZED" }));
    h.controller.start();
    await h.settle();
    expect(h.log.some((entry) => entry.startsWith("open:"))).toBe(false);
    expect(h.current()).toEqual({ status: "REAUTH_REQUIRED" });
  });

  it("AUTH-012/013: a /me 401 for the READY owner keeps the SAME runtime (no dispose), pauses sync and asks to sign in again", async () => {
    let refused = false;
    const h = harness(SESSION_A, (session) => (refused ? Promise.resolve({ kind: "IDENTITY_ERROR", reason: "UNAUTHORIZED" }) : verifyOnline(session)));
    h.controller.start();
    await h.settle();
    const runtime = h.runtime();
    refused = true;
    h.source.set({ ...SESSION_A, accessToken: "expired" });
    await h.settle();
    expect(h.log).not.toContain("dispose:" + A.userId);
    expect(h.current()).toMatchObject({ status: "READY", identity: A, auth: "REAUTH_REQUIRED", runtime });
    expect(runtime.syncPermitted).toBe(false);
  });

  it("AUTH-001: no session at boot -> SIGNED_OUT (the sign-in surface), nothing opened", async () => {
    const h = harness(null, verifyOnline);
    h.controller.start();
    await h.settle();
    expect(h.current()).toEqual({ status: "SIGNED_OUT" });
    expect(h.log.some((entry) => entry.startsWith("open:") || entry.startsWith("resolve:"))).toBe(false);
  });

  it("an explicit sign-out of A disposes A -> SIGNED_OUT", async () => {
    const h = harness(SESSION_A, verifyOnline);
    h.controller.start();
    await h.settle();
    h.source.set(null, "SIGNED_OUT");
    await h.settle();
    expect(h.log).toContain("dispose:" + A.userId);
    expect(h.current()).toEqual({ status: "SIGNED_OUT" });
  });

  it("AUTH-012/013: the session becoming invalid while READY keeps A's runtime (active workout survives), sync paused, REAUTH_REQUIRED", async () => {
    const h = harness(SESSION_A, verifyOnline);
    h.controller.start();
    await h.settle();
    const runtime = h.runtime();
    h.source.invalidate();
    await h.settle();
    expect(h.log).not.toContain("dispose:" + A.userId);
    expect(h.current()).toMatchObject({ status: "READY", identity: A, verification: "ONLINE", auth: "REAUTH_REQUIRED", runtime });
    expect(runtime.syncPermitted).toBe(false);
  });

  it("an invalid session with no owner open -> REAUTH_REQUIRED (never NEEDS_NETWORK)", async () => {
    const h = harness(null, verifyOnline);
    h.source.set(null, "SESSION_INVALID");
    h.controller.start();
    await h.settle();
    expect(h.current()).toEqual({ status: "REAUTH_REQUIRED" });
  });

  it("AUTH-014: same-owner re-auth keeps the SAME runtime, re-verifies /me and resumes sync (no dispose, no reopen)", async () => {
    const h = harness(SESSION_A, verifyOnline);
    h.controller.start();
    await h.settle();
    const runtime = h.runtime();
    h.source.invalidate();
    await h.settle();
    h.log.length = 0;

    h.source.set({ ...SESSION_A, accessToken: "token-a-new-sign-in" });
    await h.settle();

    expect(h.log).toEqual(["resolve:sub-a", `sync:${A.userId}:true`, `state:READY:${A.userId}`]);
    expect(h.current()).toMatchObject({ status: "READY", identity: A, auth: "VALID", verification: "ONLINE", runtime });
    expect(runtime.syncPermitted).toBe(true);
  });

  it("AUTH-015: re-auth as ANOTHER subject during REAUTH disposes A before B is resolved or opened", async () => {
    const h = harness(SESSION_A, verifyOnline);
    h.controller.start();
    await h.settle();
    h.source.invalidate();
    await h.settle();
    h.log.length = 0;

    h.source.set(SESSION_B);
    await h.settle();

    expect(h.log).toEqual(["state:VERIFYING", "dispose:" + A.userId, "state:VERIFYING", "resolve:sub-b", "open:" + B.userId, "state:READY:" + B.userId]);
    expect(h.current()).toMatchObject({ status: "READY", identity: B, auth: "VALID" });
  });

  it("AUTH-009: TOKEN_REFRESHED for the same subject keeps the runtime and does not touch sync permission", async () => {
    const h = harness(SESSION_A, verifyOnline);
    h.controller.start();
    await h.settle();
    const ready = h.current();
    h.log.length = 0;
    h.source.set({ ...SESSION_A, accessToken: "token-a-refreshed" });
    await h.settle();
    expect(h.log).toEqual(["resolve:sub-a"]);
    expect(h.current()).toBe(ready);
    expect(h.runtime().syncPermitted).toBe(true);
  });

  it("AUTH-016/018: offline-bound boot opens A with sync OFF; network regain re-verifies /me online, THEN permits sync", async () => {
    let offline = true;
    const h = harness(SESSION_A, (session) => (offline ? Promise.resolve({ kind: "VERIFIED", identity: A, source: "OFFLINE_BINDING" }) : verifyOnline(session)));
    h.controller.start();
    h.network.emit(false);
    await h.settle();
    const runtime = h.runtime();
    expect(h.current()).toMatchObject({ status: "READY", identity: A, verification: "OFFLINE_BINDING", auth: "VALID" });
    expect(runtime.syncPermitted).toBe(false);
    h.log.length = 0;

    offline = false;
    h.network.emit(true);
    await h.settle();

    expect(h.log).toEqual(["resolve:sub-a", `sync:${A.userId}:true`, `state:READY:${A.userId}`]);
    expect(h.current()).toMatchObject({ status: "READY", verification: "ONLINE", runtime });
  });

  it("AUTH-018: network regain while /me is still unreachable keeps sync off; a later foreground re-verifies and permits it", async () => {
    let reachable = false;
    const h = harness(SESSION_A, (session) => (reachable ? verifyOnline(session) : Promise.resolve({ kind: "VERIFIED", identity: A, source: "OFFLINE_BINDING" })));
    h.controller.start();
    await h.settle();
    h.network.emit(false);
    h.network.emit(true);
    await h.settle();
    expect(h.runtime().syncPermitted).toBe(false);

    reachable = true;
    h.lifecycle.emit("active");
    await h.settle();
    expect(h.current()).toMatchObject({ verification: "ONLINE", auth: "VALID" });
    expect(h.runtime().syncPermitted).toBe(true);
  });

  it("a non-conflict, untrustworthy /me answer while READY keeps A's data but revokes sync until re-verified", async () => {
    let broken = false;
    const h = harness(SESSION_A, (session) => (broken ? Promise.resolve({ kind: "IDENTITY_ERROR", reason: "INVALID_RESPONSE" }) : verifyOnline(session)));
    h.controller.start();
    await h.settle();
    broken = true;
    h.source.set({ ...SESSION_A, accessToken: "token-a-2" });
    await h.settle();
    expect(h.log).not.toContain("dispose:" + A.userId);
    expect(h.current()).toMatchObject({ status: "READY", verification: "OFFLINE_BINDING" });
    expect(h.runtime().syncPermitted).toBe(false);
  });

  it("network regain does NOT re-verify an owner that is already verified online (no /me storm)", async () => {
    const h = harness(SESSION_A, verifyOnline);
    h.controller.start();
    await h.settle();
    h.log.length = 0;
    h.network.emit(false);
    h.network.emit(true);
    h.lifecycle.emit("active");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.log).toEqual([]);
  });

  it("AUTH-017: unknown subject offline -> NEEDS_NETWORK, no database, and no runtime ever opened", async () => {
    const h = harness(SESSION_B, () => Promise.resolve({ kind: "NEEDS_NETWORK" }));
    h.controller.start();
    await h.settle();
    expect(h.current()).toEqual({ status: "NEEDS_NETWORK" });
    expect(h.log.filter((entry) => entry.startsWith("open:"))).toEqual([]);
  });

  it("AUTH-022: a session-storage failure with an owner open keeps the runtime (nothing disposed/deleted) with sync paused", async () => {
    const h = harness(SESSION_A, verifyOnline);
    h.controller.start();
    await h.settle();
    const runtime = h.runtime();
    h.source.failStorage(true);
    await h.settle();
    expect(h.log).not.toContain("dispose:" + A.userId);
    expect(h.current()).toMatchObject({ status: "READY", identity: A, verification: "OFFLINE_BINDING", runtime });
    expect(runtime.syncPermitted).toBe(false);

    // Storage back: the same owner re-verifies online and sync resumes.
    h.source.failStorage(false);
    await h.settle();
    expect(h.current()).toMatchObject({ verification: "ONLINE", auth: "VALID", runtime });
    expect(runtime.syncPermitted).toBe(true);
  });

  it("AUTH-022: a session-storage failure at boot -> IDENTITY_ERROR SESSION_STORAGE_UNAVAILABLE, nothing opened", async () => {
    const h = harness(SESSION_A, verifyOnline);
    h.source.failStorage(true);
    h.controller.start();
    await h.settle();
    expect(h.current()).toEqual({ status: "IDENTITY_ERROR", reason: "SESSION_STORAGE_UNAVAILABLE" });
    expect(h.log.some((entry) => entry.startsWith("open:"))).toBe(false);
  });

  it("LOCAL_DATA_UNAVAILABLE is surfaced, never READY", async () => {
    const h = harness(SESSION_A, verifyOnline, () => ({ kind: "LOCAL_DATA_UNAVAILABLE", reason: "KEY_MISSING" }));
    h.controller.start();
    await h.settle();
    expect(h.current()).toEqual({ status: "LOCAL_DATA_UNAVAILABLE", reason: "KEY_MISSING" });
  });

  it("rapid A -> B -> A: a superseded evaluation disposes what it built; the final READY is A and only A's runtime is alive", async () => {
    let release: (() => void) | undefined;
    const h = harness(null, (session) =>
      session.providerSubject === "sub-b" ? new Promise((resolve) => (release = () => resolve({ kind: "VERIFIED", identity: B, source: "ONLINE" }))) : verifyOnline(session),
    );
    h.controller.start();
    h.source.set(SESSION_B);
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.source.set(SESSION_A);
    release?.();
    await h.settle();

    expect(h.current()).toMatchObject({ status: "READY", identity: A });
    expect(h.log.filter((entry) => entry.startsWith("open:"))).toEqual(["open:" + A.userId]);
  });

  it("stop() disposes the current runtime and publishes nothing afterwards", async () => {
    const h = harness(SESSION_A, verifyOnline);
    h.controller.start();
    await h.settle();
    const count = h.states.length;
    await h.controller.stop();
    expect(h.log).toContain("dispose:" + A.userId);
    expect(h.states.length).toBe(count);
  });
});
