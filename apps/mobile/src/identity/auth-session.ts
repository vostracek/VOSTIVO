/**
 * Auth & Local Athlete Boundary V1 Slice B — the minimum session
 * abstraction the IdentityGate needs. Slice C replaces the dev source with
 * a Supabase-backed one; nothing above this file knows how a session is
 * obtained, and no product screen ever sees a token.
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
  /** The current session, or `null` when there is none (signed out / no production sign-in yet). */
  getSession(): Promise<AuthSession | null>;
  /** Fires whenever the session may have changed (new token, other identity, signed out). */
  subscribe(onChange: () => void): () => void;
}

/** The server's identity provider name (`AuthIdentity.provider`); dev tokens are verified through the same path. */
export const SUPABASE_PROVIDER = "supabase";

/** Same provider identity — a new token for it (refresh) is NOT an identity change. */
export function isSameSessionIdentity(a: Pick<AuthSession, "provider" | "providerSubject">, b: Pick<AuthSession, "provider" | "providerSubject">): boolean {
  return a.provider === b.provider && a.providerSubject === b.providerSubject;
}

/**
 * Production wiring until Slice C: there is no sign-in yet, so there is
 * never a session — the IdentityGate fails closed. Never a fallback to a
 * dev token, a cached binding, the legacy database or an anonymous user.
 */
export class NoSignInAuthSessionSource implements AuthSessionSource {
  getSession(): Promise<AuthSession | null> {
    return Promise.resolve(null);
  }

  subscribe(): () => void {
    return () => {};
  }
}
