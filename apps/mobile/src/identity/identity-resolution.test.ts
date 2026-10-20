import { describe, expect, it, vi } from "vitest";
import { IDENTITY_BINDINGS_STORAGE_KEY, IdentityBindingStore } from "./identity-binding-store";
import { resolveIdentity } from "./identity-resolution";
import type { VerifiedMeOutcome } from "./verified-me-client";
import { InMemorySecureValueStore } from "./testing/fakes";

const A = { userId: "0190a000-0000-7000-8000-00000000000a", athleteProfileId: "0190a000-0000-7000-8000-0000000000aa" };
const B = { userId: "0190a000-0000-7000-8000-00000000000b", athleteProfileId: "0190a000-0000-7000-8000-0000000000bb" };
const SESSION_A = { provider: "supabase", providerSubject: "sub-a", accessToken: "token-a" };
const NOW = new Date("2026-10-19T10:00:00.000Z");

function setup(...outcomes: VerifiedMeOutcome[]) {
  const secure = new InMemorySecureValueStore();
  const bindings = new IdentityBindingStore(secure);
  const fetchMe = vi.fn((accessToken: string) => {
    void accessToken;
    return Promise.resolve(outcomes.length > 1 ? outcomes.shift()! : outcomes[0]!);
  });
  return { secure, bindings, fetchMe, ports: { fetchMe, bindings, now: () => NOW } };
}

describe("resolveIdentity", () => {
  it("GATE-1/7: online -> the verified /me identity, and only then the binding is written (AUTH-LOCAL-013)", async () => {
    const { secure, ports, fetchMe } = setup({ kind: "VERIFIED", ...A });
    expect(await resolveIdentity(SESSION_A, ports)).toEqual({ kind: "VERIFIED", identity: A, source: "ONLINE" });
    expect(fetchMe).toHaveBeenCalledWith("token-a");
    expect(secure.writes).toEqual([IDENTITY_BINDINGS_STORAGE_KEY]);
  });

  it("GATE-5 / AUTH-LOCAL-013: unknown subject + offline -> NEEDS_NETWORK, no binding written, no identity guessed from the token", async () => {
    const { secure, ports } = setup({ kind: "UNREACHABLE" });
    expect(await resolveIdentity(SESSION_A, ports)).toEqual({ kind: "NEEDS_NETWORK" });
    expect(secure.writes).toEqual([]);
  });

  it("GATE-6: known subject + offline -> the previously VERIFIED binding's user", async () => {
    const { ports } = setup({ kind: "VERIFIED", ...A }, { kind: "UNREACHABLE" });
    await resolveIdentity(SESSION_A, ports);
    expect(await resolveIdentity({ ...SESSION_A, accessToken: "token-a-2" }, ports)).toEqual({ kind: "VERIFIED", identity: A, source: "OFFLINE_BINDING" });
  });

  it("401 never falls back to a cached binding (fail closed), and writes nothing", async () => {
    const { secure, ports } = setup({ kind: "VERIFIED", ...A }, { kind: "UNAUTHORIZED" });
    await resolveIdentity(SESSION_A, ports);
    const writes = secure.writes.length;
    expect(await resolveIdentity(SESSION_A, ports)).toEqual({ kind: "IDENTITY_ERROR", reason: "UNAUTHORIZED" });
    expect(secure.writes.length).toBe(writes);
  });

  it("GATE-9: the same subject resolving to a different userId -> BINDING_CONFLICT, the binding keeps the original user", async () => {
    const { ports, bindings } = setup({ kind: "VERIFIED", ...A }, { kind: "VERIFIED", ...B });
    await resolveIdentity(SESSION_A, ports);
    expect(await resolveIdentity(SESSION_A, ports)).toEqual({ kind: "IDENTITY_ERROR", reason: "BINDING_CONFLICT" });
    expect((await bindings.find("supabase", "sub-a"))?.userId).toBe(A.userId);
  });

  it("an unusable /me answer is an identity error, never a binding", async () => {
    const { secure, ports } = setup({ kind: "INVALID_RESPONSE" });
    expect(await resolveIdentity(SESSION_A, ports)).toEqual({ kind: "IDENTITY_ERROR", reason: "INVALID_RESPONSE" });
    expect(secure.writes).toEqual([]);
  });
});
