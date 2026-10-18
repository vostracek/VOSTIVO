/**
 * What the API may trust after verifying a token — nothing else (spec
 * section 13). `email` is optional, unverified-beyond-signature metadata;
 * it is never the canonical identity key (spec section 5 — never identify
 * a Vostivo user solely by email).
 */
export interface VerifiedExternalPrincipal {
  readonly subject: string;
  readonly issuer: string;
  readonly audience?: string;
  readonly email?: string;
}

export const AUTH_TOKEN_VERIFIER = Symbol("AUTH_TOKEN_VERIFIER");

/**
 * Boundary between framework/vendor-specific token verification and the
 * rest of the API. A test double implementing this interface is injected
 * in tests instead of the real Supabase verifier (spec section 25) — the
 * interface itself has no Supabase/JWT-library dependency.
 */
export interface AuthTokenVerifier {
  verify(bearerToken: string): Promise<VerifiedExternalPrincipal>;
}
