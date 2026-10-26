import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createAuthSessionWiring as createWiring, parseDevIdentities, type AuthSessionEnvironment, type SupabaseSessionSource } from "./auth-session-config";
import { NoSignInAuthSessionSource } from "./auth-session";
import { DEV_IDENTITY_SELECTION_STORAGE_KEY, DevAuthSessionSource } from "./dev-auth-session-source";
import { devToken, InMemorySecureValueStore } from "./testing/fakes";

const TOKEN_A = devToken("sub-a");
const TOKEN_B = devToken("sub-b");
const DEV_JWTS = `athlete-a=${TOKEN_A},athlete-b=${TOKEN_B}`;

const NO_SUPABASE = { url: undefined, publishableKey: undefined };
const SUPABASE = { url: "https://project-ref.supabase.co", publishableKey: "sb_publishable_placeholder" };

function env(overrides: Partial<AuthSessionEnvironment>): AuthSessionEnvironment {
  return { environment: "local", devJwt: undefined, devJwts: undefined, isDevBuild: true, supabase: NO_SUPABASE, ...overrides };
}

/** A stand-in for the real Supabase source: these tests are about WHICH source is wired, never about the SDK. */
function fakeSupabaseSource(): SupabaseSessionSource {
  return {
    subscribe: () => () => undefined,
    getSession: async () => null,
    requestOtp: async () => ({ ok: true }),
    verifyOtp: async () => ({ ok: true }),
    attachAppLifecycle: () => () => undefined,
  };
}

const createSupabase = vi.fn(fakeSupabaseSource);

function createAuthSessionWiring(environment: AuthSessionEnvironment, store: Parameters<typeof createWiring>[1]): ReturnType<typeof createWiring> {
  return createWiring(environment, store, createSupabase);
}

describe("createAuthSessionWiring — AUTH-LOCAL-014 production fail-closed", () => {
  it("production with nothing configured: no session at all (no dev token, no binding, no legacy DB, no anonymous user) + a configuration error naming the variables only", async () => {
    const wiring = createAuthSessionWiring(env({ environment: "production", isDevBuild: false }), null);
    expect(wiring.source).toBeInstanceOf(NoSignInAuthSessionSource);
    expect(await wiring.source.getSession()).toBeNull();
    expect(wiring.devIdentitySwitcher).toBeNull();
    expect(wiring.supabase).toBeNull();
    expect(wiring.configurationError).toMatch(/EXPO_PUBLIC_SUPABASE_URL/);
  });

  it("AUTH-020: production with Supabase configured -> Supabase email OTP is the ONLY session source", () => {
    const wiring = createAuthSessionWiring(env({ environment: "production", isDevBuild: false, supabase: SUPABASE }), null);
    expect(wiring.supabase).not.toBeNull();
    expect(wiring.source).toBe(wiring.supabase);
    expect(wiring.devIdentitySwitcher).toBeNull();
    expect(wiring.configurationError).toBeNull();
  });

  it("AUTH-020: production still refuses a dev token even when Supabase is configured", () => {
    expect(() => createAuthSessionWiring(env({ environment: "production", devJwt: TOKEN_A, supabase: SUPABASE }), null)).toThrow(/production/);
  });

  it("an unsafe Supabase key (secret / service_role) is a configuration error, never a session source", () => {
    const wiring = createAuthSessionWiring(env({ environment: "production", isDevBuild: false, supabase: { ...SUPABASE, publishableKey: "sb_secret_abc" } }), null);
    expect(wiring.supabase).toBeNull();
    expect(wiring.configurationError).not.toBeNull();
    expect(wiring.configurationError).not.toContain("sb_secret_abc");
  });

  it("non-production: an explicit dev identity wins over a configured Supabase (precedence is documented in .env.example)", async () => {
    const wiring = createAuthSessionWiring(env({ devJwt: TOKEN_A, supabase: SUPABASE }), null);
    expect(wiring.supabase).toBeNull();
    expect((await wiring.source.getSession())?.providerSubject).toBe("sub-a");
  });

  it("non-production without dev tokens uses Supabase when configured", () => {
    const wiring = createAuthSessionWiring(env({ environment: "development", supabase: SUPABASE }), null);
    expect(wiring.supabase).not.toBeNull();
    expect(wiring.source).toBe(wiring.supabase);
  });

  it.each([
    ["EXPO_PUBLIC_DEV_JWT", { devJwt: TOKEN_A }],
    ["EXPO_PUBLIC_DEV_JWTS", { devJwts: DEV_JWTS }],
  ])("production refuses to start when %s is configured (even in a __DEV__ build)", (_name, configured) => {
    expect(() => createAuthSessionWiring(env({ environment: "production", ...configured }), null)).toThrow(/production/);
    expect(() => createAuthSessionWiring(env({ environment: "production", isDevBuild: false, ...configured }), null)).toThrow(/production/);
  });

  it("non-production without any token or Supabase: no session (fail closed), no configuration error", async () => {
    const wiring = createAuthSessionWiring(env({ environment: "development" }), null);
    expect(await wiring.source.getSession()).toBeNull();
    expect(wiring.configurationError).toBeNull();
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
