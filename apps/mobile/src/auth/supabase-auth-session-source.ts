import { isAuthApiError, isAuthRetryableFetchError, type AuthChangeEvent, type AuthError, type Session } from "@supabase/supabase-js";
import { SUPABASE_PROVIDER, SessionStorageUnavailableError, type AuthSession, type AuthSessionSource, type SessionLoss } from "../identity/auth-session";
import type { AppLifecycleSource } from "../infrastructure/sync-recovery";
import { AuthServiceUnavailableError, type UnauthorizedRecovery } from "../workout/auth-token-provider";
import { RequestTimeoutError, withRequestTimeout } from "../infrastructure/request-timeout";
import { mapAuthError, type AuthErrorCode } from "./auth-errors";

/** How long a session read waits for the SDK before answering with the stored session's identity. */
export const SUPABASE_SESSION_READ_TIMEOUT_MS = 3_000;

/**
 * The subset of `supabase.auth` this app uses — an interface so the source
 * is unit-tested against a fake SDK. Auth only: there is deliberately no
 * database/PostgREST surface anywhere in the app (the Data API is disabled;
 * athlete data goes through the Vostivo API).
 */
export interface SupabaseAuthPort {
  getSession(): Promise<{ data: { session: Session | null }; error: AuthError | null }>;
  refreshSession(): Promise<{ data: { session: Session | null }; error: AuthError | null }>;
  signInWithOtp(credentials: { email: string; options: { shouldCreateUser: boolean } }): Promise<{ error: AuthError | null }>;
  verifyOtp(params: { email: string; token: string; type: "email" }): Promise<{ data: { session: Session | null }; error: AuthError | null }>;
  signOut(options: { scope: "local" }): Promise<{ error: AuthError | null }>;
  onAuthStateChange(callback: (event: AuthChangeEvent, session: Session | null) => void): { data: { subscription: { unsubscribe(): void } } };
  startAutoRefresh(): Promise<void>;
  stopAutoRefresh(): Promise<void>;
}

/** The persisted session's identity + token, read straight from secure storage (offline fallback only). */
export interface StoredSessionIdentity {
  readonly subject: string;
  readonly accessToken: string;
}

export type AuthActionResult = { readonly ok: true } | { readonly ok: false; readonly code: AuthErrorCode };

/** What the sign-in UI needs — the only auth actions a screen can trigger. */
export interface EmailOtpSignIn {
  requestOtp(email: string): Promise<AuthActionResult>;
  verifyOtp(email: string, token: string, otpSentAt: number): Promise<AuthActionResult>;
}

/**
 * Auth Slice C — Supabase Auth adapted into the Slice B `AuthSessionSource`.
 *
 * `providerSubject` = Supabase `user.id`; it is only a lookup key — the
 * IdentityGate still trusts an owner only after authenticated `GET /me`.
 *
 * - SDK events (INITIAL_SESSION / SIGNED_IN / TOKEN_REFRESHED / SIGNED_OUT)
 *   are coalesced: the gate is notified only when (subject, token) or the
 *   signed-out reason actually changed since the last event (a repeated
 *   INITIAL_SESSION + SIGNED_IN for one session is one notification), and
 *   never synchronously inside the SDK callback (the SDK holds its auth
 *   lock there). The gate itself never rebuilds a runtime for the same
 *   subject, so a refreshed token keeps the owner's database open.
 * - `SIGNED_OUT` caused by anything but `signOut()` (refresh refused,
 *   revoked session, `markSessionInvalid`) is a `SESSION_INVALID` loss: the
 *   gate keeps the open owner's runtime and asks to sign in again.
 * - Offline with an expired access token the SDK reports no session but
 *   keeps it stored; the stored identity is returned so a VERIFIED binding
 *   may open that owner's data offline (Slice B rules) — `/me` and sync
 *   still need the network. The same fallback answers a session read the
 *   SDK has not finished within `SUPABASE_SESSION_READ_TIMEOUT_MS` (it
 *   retries an offline refresh for up to 30 s), so boot is never held by it.
 * - 401 recovery is single-flight: concurrent refused requests share ONE
 *   `refreshSession()`; a network failure is `AuthServiceUnavailableError`,
 *   never an invalid session.
 *
 * Never logs tokens, OTPs or session payloads.
 */
export class SupabaseAuthSessionSource implements AuthSessionSource, EmailOtpSignIn {
  private readonly listeners = new Set<() => void>();
  private readonly sdkSubscription: { unsubscribe(): void };
  private loss: SessionLoss = "SIGNED_OUT";
  private invalidated = false;
  private userSignOutPending = false;
  private refreshInFlight: Promise<UnauthorizedRecovery> | undefined;
  private lastSignature: string | undefined;

  constructor(
    private readonly auth: SupabaseAuthPort,
    private readonly readStoredSession: () => Promise<StoredSessionIdentity | null>,
    private readonly schedule: (task: () => void) => void = (task) => setTimeout(task, 0),
    private readonly sessionReadTimeoutMs = SUPABASE_SESSION_READ_TIMEOUT_MS,
  ) {
    this.sdkSubscription = auth.onAuthStateChange((event, session) => this.onSdkEvent(event, session)).data.subscription;
  }

  subscribe(onChange: () => void): () => void {
    this.listeners.add(onChange);
    return () => this.listeners.delete(onChange);
  }

  async getSession(): Promise<AuthSession | null> {
    if (this.invalidated) return null;
    let result: Awaited<ReturnType<SupabaseAuthPort["getSession"]>>;
    try {
      result = await withRequestTimeout(this.sessionReadTimeoutMs, () => this.auth.getSession());
    } catch (thrown) {
      // The SDK is still recovering the stored session (an expired token offline is retried for up to 30 s):
      // answer with the stored identity now; the SDK's later TOKEN_REFRESHED / SIGNED_OUT re-runs the gate.
      if (thrown instanceof RequestTimeoutError) return this.storedSession();
      throw thrown instanceof SessionStorageUnavailableError ? thrown : new SessionStorageUnavailableError();
    }
    const { data, error } = result;
    if (data.session !== null) return toAuthSession(data.session.user.id, data.session.access_token);
    if (error !== null && isAuthServiceUnreachable(error)) return this.storedSession();
    return null;
  }

  sessionLoss(): SessionLoss {
    return this.invalidated ? "SESSION_INVALID" : this.loss;
  }

  async recoverFromUnauthorized(rejectedAccessToken: string): Promise<UnauthorizedRecovery> {
    const current = await this.getSession();
    if (current === null) return "SESSION_INVALID";
    // Someone already refreshed (a concurrent 401, the auto-refresh ticker): just retry.
    if (current.accessToken !== rejectedAccessToken) return "REFRESHED";
    this.refreshInFlight ??= this.refreshOnce().finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  async markSessionInvalid(): Promise<void> {
    this.invalidated = true;
    await this.auth.signOut({ scope: "local" }).catch(() => undefined);
    this.notifyIfChanged(null);
  }

  /** Low-level sign-out primitive (the Account UX is Slice D). Local scope: this device's session only. */
  async signOut(): Promise<void> {
    this.userSignOutPending = true;
    const { error } = await this.auth.signOut({ scope: "local" });
    if (error !== null) {
      this.userSignOutPending = false;
      throw error;
    }
  }

  async requestOtp(email: string): Promise<AuthActionResult> {
    try {
      const { error } = await this.auth.signInWithOtp({ email: normalizeEmail(email), options: { shouldCreateUser: true } });
      return error === null ? { ok: true } : { ok: false, code: mapAuthError(error) };
    } catch (thrown) {
      return { ok: false, code: mapAuthError(thrown) };
    }
  }

  async verifyOtp(email: string, token: string, otpSentAt: number): Promise<AuthActionResult> {
    try {
      const { data, error } = await this.auth.verifyOtp({ email: normalizeEmail(email), token, type: "email" });
      if (error !== null) return { ok: false, code: mapAuthError(error, { otpSentAt, now: Date.now() }) };
      if (data.session === null) return { ok: false, code: "UNKNOWN" };
      this.invalidated = false;
      return { ok: true };
    } catch (thrown) {
      return { ok: false, code: mapAuthError(thrown, { otpSentAt, now: Date.now() }) };
    }
  }

  /** Supabase React Native guidance: refresh tokens only while the app is in the foreground. Never touches athlete runtimes. */
  attachAppLifecycle(lifecycle: AppLifecycleSource): () => void {
    void this.auth.startAutoRefresh();
    return lifecycle.subscribe((state) => {
      if (state === "active") void this.auth.startAutoRefresh();
      else void this.auth.stopAutoRefresh();
    });
  }

  dispose(): void {
    this.sdkSubscription.unsubscribe();
    this.listeners.clear();
  }

  /** Offline fallback only: the persisted session's identity, or null (no session -> nothing can be opened). */
  private async storedSession(): Promise<AuthSession | null> {
    const stored = await this.readStoredSession();
    return stored === null ? null : toAuthSession(stored.subject, stored.accessToken);
  }

  private async refreshOnce(): Promise<UnauthorizedRecovery> {
    const { data, error } = await this.auth.refreshSession();
    if (data.session !== null) return "REFRESHED";
    if (error !== null && isAuthServiceUnreachable(error)) throw new AuthServiceUnavailableError();
    await this.markSessionInvalid();
    return "SESSION_INVALID";
  }

  private onSdkEvent(event: AuthChangeEvent, session: Session | null): void {
    if (session !== null) {
      this.invalidated = false;
      this.notifyIfChanged(toAuthSession(session.user.id, session.access_token));
      return;
    }
    if (event === "SIGNED_OUT") {
      this.loss = this.userSignOutPending ? "SIGNED_OUT" : "SESSION_INVALID";
      this.userSignOutPending = false;
    }
    // INITIAL_SESSION without a session (signed out, or offline with an expired token): the gate re-reads.
    this.notifyIfChanged(null);
  }

  private notifyIfChanged(session: AuthSession | null): void {
    const signature = this.signature(session);
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.schedule(() => {
      for (const listener of [...this.listeners]) listener();
    });
  }

  private signature(session: AuthSession | null): string {
    return session === null ? `none:${this.sessionLoss()}` : `${session.providerSubject}:${session.accessToken}`;
  }
}

function toAuthSession(subject: string, accessToken: string): AuthSession {
  return { provider: SUPABASE_PROVIDER, providerSubject: subject, accessToken };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Offline / DNS / timeout, or the auth server itself failing — it could not judge the session. */
function isAuthServiceUnreachable(error: AuthError): boolean {
  return isAuthRetryableFetchError(error) || (isAuthApiError(error) && error.status >= 500);
}

/** Reads the persisted Supabase session's identity (subject + access token) from the session storage — never anything else. */
export async function readStoredSupabaseSession(storage: { getItem(key: string): Promise<string | null> }, storageKey: string): Promise<StoredSessionIdentity | null> {
  const raw = await storage.getItem(storageKey);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { access_token?: unknown; user?: { id?: unknown } | null };
    if (typeof parsed.access_token !== "string" || typeof parsed.user?.id !== "string" || parsed.user.id.length === 0) return null;
    return { subject: parsed.user.id, accessToken: parsed.access_token };
  } catch {
    return null;
  }
}
