/**
 * The only thing `SyncEngine` needs to authenticate a sync request (spec
 * section 31) — decouples it entirely from how a token is obtained.
 */
export interface AuthTokenProvider {
  getAccessToken(): Promise<string>;
}

/**
 * Production stub. The mobile Supabase sign-in flow is deliberately
 * deferred (spec section 23/31, docs/architecture/IDENTITY-AUTH.md) — no
 * login UI, no `@supabase/supabase-js` client exists yet. Wiring this to
 * a real Supabase session is exactly what that future work will replace
 * this with. Throwing loudly here (never returning a fake/empty token) is
 * the point: there must be no production authentication bypass.
 */
export class DeferredSupabaseAuthTokenProvider implements AuthTokenProvider {
  getAccessToken(): Promise<string> {
    return Promise.reject(
      new Error(
        "Supabase sign-in is not implemented yet — mobile sync cannot obtain " +
          "a real access token. See docs/architecture/IDENTITY-AUTH.md.",
      ),
    );
  }
}

/**
 * Development/test-only implementation for native runtime verification —
 * returns a pre-signed token from the real local JWT/JWKS test
 * infrastructure (never a production bypass; never used by
 * `DeferredSupabaseAuthTokenProvider`, which remains the only production
 * wiring). Construct with a token obtained the same way
 * apps/api's tests do (a local test keypair + `jose`'s `SignJWT`).
 */
export class StaticTestAuthTokenProvider implements AuthTokenProvider {
  constructor(private readonly token: string) {}

  getAccessToken(): Promise<string> {
    return Promise.resolve(this.token);
  }
}
