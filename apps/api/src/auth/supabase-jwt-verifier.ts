import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { AuthTokenVerifier, VerifiedExternalPrincipal } from "./token-verifier.js";

/**
 * Production Supabase JWT verification.
 *
 * Approach (see docs/architecture/IDENTITY-AUTH.md for the full writeup
 * and sources consulted from Supabase's current documentation):
 *
 * - Supabase projects created since May 2025 sign access tokens with an
 *   asymmetric key (RS256/ES256/Ed25519 depending on project config) and
 *   publish the public verification keys at a per-project JWKS endpoint.
 *   This lets the API verify signatures **without ever holding a shared
 *   secret** — nothing here is a credential.
 * - `jose` (createRemoteJWKSet + jwtVerify) is Supabase's own documented
 *   recommendation for this. It fetches/caches/rotates the JWKS
 *   automatically; we never decode-without-verifying and never implement
 *   the cryptography ourselves.
 * - We additionally pin `issuer` (`${SUPABASE_URL}/auth/v1`) and
 *   `audience` (`"authenticated"`, Supabase's fixed value for logged-in
 *   user tokens) so a token from an unrelated issuer, or a Supabase
 *   anon-key-shaped token, is rejected even if some other project's JWKS
 *   happened to validate the signature.
 *
 * Legacy HS256 (shared-secret) Supabase projects are explicitly out of
 * scope — Supabase's own guidance for that legacy mode is to verify
 * against the Auth server directly rather than locally, which is a
 * different verification strategy this class does not implement.
 */
export class SupabaseJwtVerifier implements AuthTokenVerifier {
  private readonly issuer: string;
  private readonly jwks: JWTVerifyGetKey;

  /**
   * `jwks` is normally omitted — production always fetches Supabase's
   * real published JWKS. Tests pass a `createLocalJWKSet(...)` resolver
   * here instead, so the exact same verification logic (signature,
   * issuer, audience, expiry) runs against a local test keypair with zero
   * network calls and zero dependency on a real Supabase project.
   */
  constructor(supabaseUrl: string, jwks?: JWTVerifyGetKey) {
    this.issuer = `${supabaseUrl}/auth/v1`;
    this.jwks = jwks ?? createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`));
  }

  async verify(bearerToken: string): Promise<VerifiedExternalPrincipal> {
    const { payload } = await jwtVerify(bearerToken, this.jwks, {
      issuer: this.issuer,
      audience: "authenticated",
    });

    return toVerifiedPrincipal(payload);
  }
}

function toVerifiedPrincipal(payload: JWTPayload): VerifiedExternalPrincipal {
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("Verified token is missing a subject claim");
  }

  return {
    subject: payload.sub,
    issuer: typeof payload.iss === "string" ? payload.iss : "",
    ...(typeof payload.aud === "string" ? { audience: payload.aud } : {}),
    ...(typeof payload.email === "string" ? { email: payload.email } : {}),
  };
}
