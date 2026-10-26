import { describe, expect, it } from "vitest";
import { AuthApiError, AuthRetryableFetchError, type AuthChangeEvent, type AuthError, type Session } from "@supabase/supabase-js";
import { SessionStorageUnavailableError } from "../identity/auth-session";
import { InMemorySecureValueStore } from "../identity/testing/fakes";
import { AuthServiceUnavailableError } from "../workout/auth-token-provider";
import { ChunkedSecureSessionStorage } from "./chunked-secure-session-storage";
import { readStoredSupabaseSession, SupabaseAuthSessionSource, type SupabaseAuthPort } from "./supabase-auth-session-source";

function supabaseSession(userId: string, accessToken: string): Session {
  return { access_token: accessToken, refresh_token: `${accessToken}-refresh`, expires_in: 3600, token_type: "bearer", user: { id: userId } } as Session;
}

type Listener = (event: AuthChangeEvent, session: Session | null) => void;

/** A fake `supabase.auth`: the test drives its current session, results and events. */
class FakeSupabaseAuth implements SupabaseAuthPort {
  session: Session | null = null;
  getSessionError: AuthError | null = null;
  getSessionThrows: unknown = undefined;
  refreshResult: { session: Session | null; error: AuthError | null } = { session: null, error: null };
  refreshCalls = 0;
  private releaseRefresh: (() => void) | undefined;
  holdRefresh = false;
  otpRequests: { email: string; shouldCreateUser: boolean }[] = [];
  otpRequestError: AuthError | null = null;
  verifyError: AuthError | null = null;
  verifyCalls: { email: string; token: string; type: string }[] = [];
  signOuts = 0;
  autoRefresh: string[] = [];
  private listener: Listener | undefined;

  emit(event: AuthChangeEvent, session: Session | null): void {
    this.session = session;
    this.listener?.(event, session);
  }

  release(): void {
    this.releaseRefresh?.();
  }

  getSession() {
    if (this.getSessionThrows !== undefined) return Promise.reject(this.getSessionThrows);
    return Promise.resolve({ data: { session: this.session }, error: this.getSessionError });
  }

  async refreshSession() {
    this.refreshCalls += 1;
    if (this.holdRefresh) await new Promise<void>((resolve) => (this.releaseRefresh = resolve));
    if (this.refreshResult.session !== null) this.session = this.refreshResult.session;
    return { data: { session: this.refreshResult.session }, error: this.refreshResult.error };
  }

  signInWithOtp(credentials: { email: string; options: { shouldCreateUser: boolean } }) {
    this.otpRequests.push({ email: credentials.email, shouldCreateUser: credentials.options.shouldCreateUser });
    return Promise.resolve({ error: this.otpRequestError });
  }

  verifyOtp(params: { email: string; token: string; type: "email" }) {
    this.verifyCalls.push(params);
    if (this.verifyError !== null) return Promise.resolve({ data: { session: null }, error: this.verifyError });
    const session = supabaseSession("user-a", "token-a");
    this.emit("SIGNED_IN", session);
    return Promise.resolve({ data: { session }, error: null });
  }

  signOut() {
    this.signOuts += 1;
    this.emit("SIGNED_OUT", null);
    return Promise.resolve({ error: null });
  }

  onAuthStateChange(callback: Listener) {
    this.listener = callback;
    return { data: { subscription: { unsubscribe: () => (this.listener = undefined) } } };
  }

  startAutoRefresh() {
    this.autoRefresh.push("start");
    return Promise.resolve();
  }

  stopAutoRefresh() {
    this.autoRefresh.push("stop");
    return Promise.resolve();
  }
}

function harness(stored: { subject: string; accessToken: string } | null = null) {
  const auth = new FakeSupabaseAuth();
  const tasks: (() => void)[] = [];
  const source = new SupabaseAuthSessionSource(auth, () => Promise.resolve(stored), (task) => tasks.push(task));
  let notifications = 0;
  source.subscribe(() => (notifications += 1));
  const flush = () => {
    for (const task of tasks.splice(0)) task();
    return notifications;
  };
  return { auth, source, flush, notified: () => notifications };
}

describe("SupabaseAuthSessionSource", () => {
  it("AUTH-001: requests a 6-digit email OTP with shouldCreateUser and a normalized email; no password/magic link path exists", async () => {
    const { auth, source } = harness();
    expect(await source.requestOtp("  Athlete@Example.com ")).toEqual({ ok: true });
    expect(auth.otpRequests).toEqual([{ email: "athlete@example.com", shouldCreateUser: true }]);
  });

  it("AUTH-002: a valid code -> verifyOtp(type email) -> the session maps to (supabase, user.id, access_token)", async () => {
    const { auth, source, flush } = harness();
    expect(await source.verifyOtp("athlete@example.com", "123456", Date.now())).toEqual({ ok: true });
    expect(auth.verifyCalls).toEqual([{ email: "athlete@example.com", token: "123456", type: "email" }]);
    expect(await source.getSession()).toEqual({ provider: "supabase", providerSubject: "user-a", accessToken: "token-a" });
    expect(flush()).toBe(1);
  });

  it("AUTH-003/004/005: verification and send failures come back as stable codes", async () => {
    const { auth, source } = harness();
    auth.verifyError = new AuthApiError("Token has expired or is invalid", 403, "otp_expired");
    expect(await source.verifyOtp("a@b.cz", "000000", Date.now())).toEqual({ ok: false, code: "INVALID_OTP" });
    expect(await source.verifyOtp("a@b.cz", "000000", Date.now() - 601_000)).toEqual({ ok: false, code: "OTP_EXPIRED" });
    auth.verifyError = new AuthApiError("rate", 429, "over_request_rate_limit");
    expect(await source.verifyOtp("a@b.cz", "000000", Date.now())).toEqual({ ok: false, code: "RATE_LIMITED" });
    auth.otpRequestError = new AuthApiError("rate", 429, "over_email_send_rate_limit");
    expect(await source.requestOtp("a@b.cz")).toEqual({ ok: false, code: "RATE_LIMITED" });
    auth.otpRequestError = new AuthRetryableFetchError("Failed to fetch", 0);
    expect(await source.requestOtp("a@b.cz")).toEqual({ ok: false, code: "NETWORK_UNAVAILABLE" });
  });

  it("AUTH-009: repeated INITIAL_SESSION/SIGNED_IN for one session notify once; TOKEN_REFRESHED notifies with the new token, same subject", async () => {
    const { auth, source, flush } = harness();
    const session = supabaseSession("user-a", "token-a");
    auth.emit("INITIAL_SESSION", session);
    auth.emit("SIGNED_IN", session);
    expect(flush()).toBe(1);
    auth.emit("TOKEN_REFRESHED", supabaseSession("user-a", "token-a2"));
    expect(flush()).toBe(2);
    expect(await source.getSession()).toMatchObject({ providerSubject: "user-a", accessToken: "token-a2" });
  });

  it("listeners are never called synchronously inside the SDK callback (the SDK holds its auth lock there)", () => {
    const { auth, flush, notified } = harness();
    auth.emit("SIGNED_IN", supabaseSession("user-a", "token-a"));
    expect(notified()).toBe(0);
    expect(flush()).toBe(1);
  });

  it("an SDK SIGNED_OUT without signOut() (refresh refused / revoked) is SESSION_INVALID; signOut() is SIGNED_OUT", async () => {
    const first = harness();
    first.auth.emit("SIGNED_IN", supabaseSession("user-a", "token-a"));
    first.auth.emit("SIGNED_OUT", null);
    expect(first.source.sessionLoss()).toBe("SESSION_INVALID");

    const second = harness();
    second.auth.emit("SIGNED_IN", supabaseSession("user-a", "token-a"));
    await second.source.signOut();
    expect(second.source.sessionLoss()).toBe("SIGNED_OUT");
    expect(await second.source.getSession()).toBeNull();
  });

  it("AUTH-010: concurrent 401 recoveries for the same token share ONE refreshSession()", async () => {
    const { auth, source } = harness();
    auth.session = supabaseSession("user-a", "token-a");
    auth.holdRefresh = true;
    auth.refreshResult = { session: supabaseSession("user-a", "token-a2"), error: null };

    const recoveries = Promise.all([source.recoverFromUnauthorized("token-a"), source.recoverFromUnauthorized("token-a"), source.recoverFromUnauthorized("token-a")]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    auth.release();
    expect(await recoveries).toEqual(["REFRESHED", "REFRESHED", "REFRESHED"]);
    expect(auth.refreshCalls).toBe(1);
    // A late 401 for the already-replaced token does not refresh again.
    expect(await source.recoverFromUnauthorized("token-a")).toBe("REFRESHED");
    expect(auth.refreshCalls).toBe(1);
  });

  it("a refused refresh -> SESSION_INVALID: the session is dropped locally and reported as an invalid-session loss", async () => {
    const { auth, source } = harness();
    auth.session = supabaseSession("user-a", "token-a");
    auth.refreshResult = { session: null, error: new AuthApiError("Invalid Refresh Token", 400, "refresh_token_not_found") };
    expect(await source.recoverFromUnauthorized("token-a")).toBe("SESSION_INVALID");
    expect(auth.signOuts).toBe(1);
    expect(source.sessionLoss()).toBe("SESSION_INVALID");
    expect(await source.getSession()).toBeNull();
  });

  it("AUTH-019: the auth server unreachable while refreshing is AuthServiceUnavailableError — the session is kept, never invalidated", async () => {
    const { auth, source } = harness();
    auth.session = supabaseSession("user-a", "token-a");
    auth.refreshResult = { session: null, error: new AuthRetryableFetchError("Failed to fetch", 0) };
    await expect(source.recoverFromUnauthorized("token-a")).rejects.toBeInstanceOf(AuthServiceUnavailableError);
    expect(auth.signOuts).toBe(0);
    expect(await source.getSession()).toMatchObject({ providerSubject: "user-a" });
  });

  it("AUTH-016: offline with an expired access token (SDK: no session + retryable error) -> the stored identity, so a verified binding can open offline", async () => {
    const { auth, source } = harness({ subject: "user-a", accessToken: "token-expired" });
    auth.getSessionError = new AuthRetryableFetchError("Failed to fetch", 0);
    expect(await source.getSession()).toEqual({ provider: "supabase", providerSubject: "user-a", accessToken: "token-expired" });
    // Without a network failure, no stored session is ever resurrected.
    auth.getSessionError = null;
    expect(await source.getSession()).toBeNull();
  });

  it("AUTH-022: a storage failure surfaces as SessionStorageUnavailableError (not 'signed out')", async () => {
    const { auth, source } = harness();
    auth.getSessionThrows = new Error("keystore");
    await expect(source.getSession()).rejects.toBeInstanceOf(SessionStorageUnavailableError);
  });

  it("refreshes tokens only while the app is in the foreground", () => {
    const { auth, source } = harness();
    let emit: (state: "active" | "background" | "inactive") => void = () => {};
    source.attachAppLifecycle({ subscribe: (listener) => ((emit = listener), () => {}) });
    emit("background");
    emit("active");
    expect(auth.autoRefresh).toEqual(["start", "stop", "start"]);
  });
});

describe("readStoredSupabaseSession", () => {
  it("AUTH-006: reads subject + access token of the persisted session from the chunked SecureStore; garbage -> null", async () => {
    const storage = new ChunkedSecureSessionStorage(new InMemorySecureValueStore());
    expect(await readStoredSupabaseSession(storage, "k")).toBeNull();
    await storage.setItem("k", JSON.stringify(supabaseSession("user-a", "token-a")));
    expect(await readStoredSupabaseSession(storage, "k")).toEqual({ subject: "user-a", accessToken: "token-a" });
    await storage.setItem("k", "{bad");
    expect(await readStoredSupabaseSession(storage, "k")).toBeNull();
  });
});
