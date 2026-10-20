import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createAuthSessionWiring, parseDevIdentities, type AuthSessionEnvironment } from "./auth-session-config";
import { NoSignInAuthSessionSource } from "./auth-session";
import { DEV_IDENTITY_SELECTION_STORAGE_KEY, DevAuthSessionSource } from "./dev-auth-session-source";
import { devToken, InMemorySecureValueStore } from "./testing/fakes";

const TOKEN_A = devToken("sub-a");
const TOKEN_B = devToken("sub-b");
const DEV_JWTS = `athlete-a=${TOKEN_A},athlete-b=${TOKEN_B}`;

function env(overrides: Partial<AuthSessionEnvironment>): AuthSessionEnvironment {
  return { environment: "local", devJwt: undefined, devJwts: undefined, isDevBuild: true, ...overrides };
}

describe("createAuthSessionWiring — AUTH-LOCAL-014 production fail-closed", () => {
  it("production with nothing configured: no session at all (no dev token, no binding, no legacy DB, no anonymous user)", async () => {
    const wiring = createAuthSessionWiring(env({ environment: "production", isDevBuild: false }), null);
    expect(wiring.source).toBeInstanceOf(NoSignInAuthSessionSource);
    expect(await wiring.source.getSession()).toBeNull();
    expect(wiring.devIdentitySwitcher).toBeNull();
  });

  it.each([
    ["EXPO_PUBLIC_DEV_JWT", { devJwt: TOKEN_A }],
    ["EXPO_PUBLIC_DEV_JWTS", { devJwts: DEV_JWTS }],
  ])("production refuses to start when %s is configured (even in a __DEV__ build)", (_name, configured) => {
    expect(() => createAuthSessionWiring(env({ environment: "production", ...configured }), null)).toThrow(/production/);
    expect(() => createAuthSessionWiring(env({ environment: "production", isDevBuild: false, ...configured }), null)).toThrow(/production/);
  });

  it("non-production without any token: no session (fail closed)", async () => {
    const wiring = createAuthSessionWiring(env({ environment: "development" }), null);
    expect(await wiring.source.getSession()).toBeNull();
  });

  it("non-production single EXPO_PUBLIC_DEV_JWT: one dev session (also in a release build), no selector", async () => {
    const wiring = createAuthSessionWiring(env({ devJwt: TOKEN_A, isDevBuild: false }), null);
    expect(await wiring.source.getSession()).toEqual({ provider: "supabase", providerSubject: "sub-a", accessToken: TOKEN_A });
    expect(wiring.devIdentitySwitcher).toBeNull();
  });
});

describe("D-8 dev identity selector", () => {
  it("DEV-41: available under __DEV__ with EXPO_PUBLIC_DEV_JWTS, exposing aliases only", () => {
    const wiring = createAuthSessionWiring(env({ devJwts: DEV_JWTS }), null);
    expect(wiring.devIdentitySwitcher).not.toBeNull();
    expect(wiring.devIdentitySwitcher!.aliases).toEqual(["athlete-a", "athlete-b"]);
  });

  it("DEV-42: a non-__DEV__ build can never get the selector (EXPO_PUBLIC_DEV_JWTS is ignored)", async () => {
    const wiring = createAuthSessionWiring(env({ devJwts: DEV_JWTS, isDevBuild: false }), null);
    expect(wiring.devIdentitySwitcher).toBeNull();
    expect(await wiring.source.getSession()).toBeNull();
  });

  it("DEV-42: the app wires isDevBuild from the real __DEV__ and the env names literally (no other way to enable the selector)", () => {
    const gateSource = readFileSync(new URL("./identity-gate.tsx", import.meta.url), "utf8");
    expect(gateSource).toContain("isDevBuild: __DEV__");
    expect(gateSource).toContain("devJwts: process.env.EXPO_PUBLIC_DEV_JWTS");
    expect(gateSource.match(/new DevAuthSessionSource|DevAuthSessionSource\(/g)).toBeNull();
  });

  it("DEV-43/44: switching A -> B -> A changes only the session and notifies (the gate then transitions); the selection persists as an alias", async () => {
    const store = new InMemorySecureValueStore();
    const switcher = createAuthSessionWiring(env({ devJwts: DEV_JWTS }), store).devIdentitySwitcher!;
    const onChange = vi.fn();
    switcher.subscribe(onChange);

    expect((await switcher.getSession())?.providerSubject).toBe("sub-a");
    await switcher.select("athlete-b");
    expect((await switcher.getSession())?.providerSubject).toBe("sub-b");
    await switcher.select("athlete-a");
    expect((await switcher.getSession())?.providerSubject).toBe("sub-a");
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(store.values.get(DEV_IDENTITY_SELECTION_STORAGE_KEY)).toBe("athlete-a");

    // A relaunch restores the last selected alias.
    await switcher.select("athlete-b");
    const relaunched = new DevAuthSessionSource(parseDevIdentities(DEV_JWTS), store);
    await relaunched.restoreSelection();
    expect(relaunched.currentAlias).toBe("athlete-b");
  });

  it("DEV-45: config errors and labels never contain a token", () => {
    expect(() => parseDevIdentities(`Bad Alias=${TOKEN_A}`)).toThrow(/entry #1/);
    try {
      parseDevIdentities(`ok=${TOKEN_A},${TOKEN_B}`);
    } catch (error) {
      expect(String(error)).not.toContain(TOKEN_B);
      expect(String(error)).toContain("entry #2");
    }
    expect(() => parseDevIdentities(`a=${TOKEN_A},a=${TOKEN_B}`)).toThrow(/duplicated/);
    const switcher = createAuthSessionWiring(env({ devJwts: DEV_JWTS }), null).devIdentitySwitcher!;
    for (const alias of switcher.aliases) expect([TOKEN_A, TOKEN_B].some((token) => alias.includes(token))).toBe(false);
  });

  it("a token with no readable subject is 'no session', never an anonymous identity", async () => {
    const wiring = createAuthSessionWiring(env({ devJwt: "garbage" }), null);
    expect(await wiring.source.getSession()).toBeNull();
  });
});
