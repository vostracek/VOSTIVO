import type { UnauthorizedRecovery } from "../workout/auth-token-provider";

/**
 * Auth & Local Athlete Boundary V1 Slice B — the minimum session
 * abstraction the IdentityGate needs. Slice C adds the Supabase-backed
 * source (`src/auth/supabase-auth-session-source.ts`); nothing above this
 * file knows how a session is obtained, and no product screen ever sees a
 * token.
 *
 * `provider` + `providerSubject` are only a LOOKUP KEY into a previously
 * verified identity binding (`identity-binding-store.ts`) — reading them
 * locally is never authorization, and never enough on its own to decide
 * which athlete's data to open. Only a verified `GET /api/v1/me` does that.
 */
export interface AuthSession {
  readonly provider: string;
  readonly providerSubject: string;
  readonly accessToken: string;
}

export interface AuthSessionSource {
  /**
   * The current session, or `null` when there is none. May throw
   * `SessionStorageUnavailableError` when the secure session store cannot be
   * read — never treated as "signed out", and never a reason to delete data.
   */
  getSession(): Promise<AuthSession | null>;
  /** Fires whenever the session may have changed (new token, other identity, signed out). */
  subscribe(onChange: () => void): () => void;
  /**
   * Auth Slice C — why `getSession()` is `null`: the athlete signed out, or
   * the session stopped being valid (refresh refused / revoked). Sources
   * without real sign-in omit it (= `SIGNED_OUT`).
   */
  sessionLoss?(): SessionLoss;
  /** Single-flight recovery after a request with `rejectedAccessToken` got 401 (see `AuthTokenProvider`). */
  recoverFromUnauthorized?(rejectedAccessToken: string): Promise<UnauthorizedRecovery>;
  /** The session keeps being refused even after a refresh: drop it locally as `SESSION_INVALID`. */
  markSessionInvalid?(): Promise<void>;
}

export type SessionLoss = "SIGNED_OUT" | "SESSION_INVALID";

/** The secure session store could not be read or written — a typed storage failure, never "signed out". */
export class SessionStorageUnavailableError extends Error {
  constructor() {
    super("The secure session store is unavailable");
    this.name = "SessionStorageUnavailableError";
  }
}

/** The server's identity provider name (`AuthIdentity.provider`); dev tokens are verified through the same path. */
export const SUPABASE_PROVIDER = "supabase";

/** Same provider identity — a new token for it (refresh) is NOT an identity change. */
export function isSameSessionIdentity(a: Pick<AuthSession, "provider" | "providerSubject">, b: Pick<AuthSession, "provider" | "providerSubject">): boolean {
  return a.provider === b.provider && a.providerSubject === b.providerSubject;
}

/**
 * No configured sign-in (a non-production build without Supabase config or
 * dev tokens): there is never a session — the IdentityGate fails closed.
 * Never a fallback to a dev token, a cached binding, the legacy database or
 * an anonymous user.
 */
export class NoSignInAuthSessionSource implements AuthSessionSource {
  getSession(): Promise<AuthSession | null> {
    return Promise.resolve(null);
  }

  subscribe(): () => void {
    return () => {};
  }
}
