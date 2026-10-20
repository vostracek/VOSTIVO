import { describe, expect, it } from "vitest";
import type { AuthSession } from "./auth-session";
import { IdentityGateController, type IdentityGateState, type OpenRuntimeResult } from "./identity-gate-controller";
import type { IdentityResolution } from "./identity-resolution";
import type { VerifiedIdentity } from "./identity-binding-store";
import { ControllableSessionSource } from "./testing/controllable-session-source";

const A: VerifiedIdentity = { userId: "0190a000-0000-7000-8000-00000000000a", athleteProfileId: "0190a000-0000-7000-8000-0000000000aa" };
const B: VerifiedIdentity = { userId: "0190a000-0000-7000-8000-00000000000b", athleteProfileId: "0190a000-0000-7000-8000-0000000000bb" };
const SESSION_A: AuthSession = { provider: "supabase", providerSubject: "sub-a", accessToken: "token-a" };
const SESSION_B: AuthSession = { provider: "supabase", providerSubject: "sub-b", accessToken: "token-b" };

class FakeRuntime {
  disposed = false;
  constructor(
    readonly ownerUserId: string,
    private readonly log: string[],
  ) {}
  dispose(): Promise<void> {
    this.log.push(`dispose:${this.ownerUserId}`);
    this.disposed = true;
    return Promise.resolve();
  }
}

type ResolveFn = (session: AuthSession) => Promise<IdentityResolution>;

function harness(initial: AuthSession | null, resolve: ResolveFn, open?: (identity: VerifiedIdentity) => OpenRuntimeResult<FakeRuntime>) {
  const log: string[] = [];
  const states: IdentityGateState<FakeRuntime>[] = [];
  const source = new ControllableSessionSource(initial);
  const controller = new IdentityGateController<FakeRuntime>({
    sessionSource: source,
    resolveIdentity: async (session) => {
      log.push(`resolve:${session.providerSubject}`);
      return resolve(session);
    },
    openRuntime: (identity) => {
      log.push(`open:${identity.userId}`);
      return Promise.resolve(open?.(identity) ?? { kind: "OPENED", runtime: new FakeRuntime(identity.userId, log) });
    },
    onStateChange: (state) => {
      states.push(state);
      log.push(`state:${state.status}${state.status === "READY" ? `:${state.identity.userId}` : ""}`);
    },
  });
  const current = () => states[states.length - 1]!;
  const settle = () => controller.reevaluate().then(() => undefined);
  return { log, states, source, controller, current, settle };
}

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
    const runtimeA = (h.current() as Extract<IdentityGateState<FakeRuntime>, { status: "READY" }>).runtime;
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
    const h = harness(SESSION_B, () => Promise.resolve({ kind: "IDENTITY_ERROR", reason: "UNAUTHORIZED" }));
    h.controller.start();
    await h.settle();
    expect(h.log.some((entry) => entry.startsWith("open:"))).toBe(false);
    expect(h.current()).toEqual({ status: "IDENTITY_ERROR", reason: "UNAUTHORIZED" });
  });

  it("401 for a refreshed token of the READY owner -> the runtime is disposed and the gate fails closed (no reuse under a refused token)", async () => {
    let refused = false;
    const h = harness(SESSION_A, (session) => (refused ? Promise.resolve({ kind: "IDENTITY_ERROR", reason: "UNAUTHORIZED" }) : verifyOnline(session)));
    h.controller.start();
    await h.settle();
    refused = true;
    h.source.set({ ...SESSION_A, accessToken: "expired" });
    await h.settle();
    expect(h.log).toContain("dispose:" + A.userId);
    expect(h.current()).toEqual({ status: "IDENTITY_ERROR", reason: "UNAUTHORIZED" });
  });

  it("no session -> IDENTITY_ERROR NO_SESSION; signing out of A disposes A", async () => {
    const h = harness(SESSION_A, verifyOnline);
    h.controller.start();
    await h.settle();
    h.source.set(null);
    await h.settle();
    expect(h.log).toContain("dispose:" + A.userId);
    expect(h.current()).toEqual({ status: "IDENTITY_ERROR", reason: "NO_SESSION" });
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
