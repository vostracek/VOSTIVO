import { describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { SupabaseJwtVerifier } from "./supabase-jwt-verifier.js";

/**
 * Real `jose` verification logic (signature, issuer, audience, expiry)
 * exercised against a local, test-only JWKS — never the network, never a
 * real Supabase project (spec section 25). `SupabaseJwtVerifier` accepts
 * an injectable JWKS resolver specifically so this test runs the same
 * verification code path as production, only swapping the key source.
 */
const TEST_SUPABASE_URL = "https://test-project.supabase.example";
const TEST_ISSUER = `${TEST_SUPABASE_URL}/auth/v1`;
const TEST_AUDIENCE = "authenticated";
const TEST_KID = "test-key";

async function buildTestFixture() {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const { privateKey: wrongPrivateKey } = await generateKeyPair("ES256", { extractable: true });

  const publicJwk = await exportJWK(publicKey);
  const localJwks: JWTVerifyGetKey = createLocalJWKSet({
    keys: [{ ...publicJwk, alg: "ES256", use: "sig", kid: TEST_KID }],
  });

  const verifier = new SupabaseJwtVerifier(TEST_SUPABASE_URL, localJwks);

  const sign = (
    payload: Record<string, unknown>,
    expiresAtEpochSeconds?: number,
  ): Promise<string> =>
    new SignJWT(payload)
      .setProtectedHeader({ alg: "ES256", kid: TEST_KID })
      .setIssuedAt()
      .setExpirationTime(expiresAtEpochSeconds ?? Math.floor(Date.now() / 1000) + 3600)
      .sign(privateKey);

  const signWithWrongKey = (payload: Record<string, unknown>): Promise<string> =>
    new SignJWT(payload)
      .setProtectedHeader({ alg: "ES256", kid: TEST_KID })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(wrongPrivateKey);

  return { verifier, sign, signWithWrongKey };
}

describe("SupabaseJwtVerifier", () => {
  it("AUTH-005: accepts a validly signed token with correct issuer/audience/subject", async () => {
    const { verifier, sign } = await buildTestFixture();
    const token = await sign({
      sub: "user-subject-1",
      iss: TEST_ISSUER,
      aud: TEST_AUDIENCE,
      email: "athlete@example.com",
    });

    const principal = await verifier.verify(token);

    expect(principal.subject).toBe("user-subject-1");
    expect(principal.issuer).toBe(TEST_ISSUER);
    expect(principal.audience).toBe(TEST_AUDIENCE);
    expect(principal.email).toBe("athlete@example.com");
  });

  it("AUTH-002: rejects a malformed token", async () => {
    const { verifier } = await buildTestFixture();
    await expect(verifier.verify("this-is-not-a-jwt")).rejects.toThrow();
  });

  it("AUTH-003: rejects a token with an invalid signature", async () => {
    const { verifier, signWithWrongKey } = await buildTestFixture();
    const token = await signWithWrongKey({
      sub: "user-subject-1",
      iss: TEST_ISSUER,
      aud: TEST_AUDIENCE,
    });

    await expect(verifier.verify(token)).rejects.toThrow();
  });

  it("AUTH-004: rejects an expired token", async () => {
    const { verifier, sign } = await buildTestFixture();
    const token = await sign(
      { sub: "user-subject-1", iss: TEST_ISSUER, aud: TEST_AUDIENCE },
      Math.floor(Date.now() / 1000) - 10,
    );

    await expect(verifier.verify(token)).rejects.toThrow();
  });

  it("rejects a token issued for a different Supabase project", async () => {
    const { verifier, sign } = await buildTestFixture();
    const token = await sign({
      sub: "user-subject-1",
      iss: "https://a-different-project.supabase.example/auth/v1",
      aud: TEST_AUDIENCE,
    });

    await expect(verifier.verify(token)).rejects.toThrow();
  });

  it("rejects a token with the wrong audience", async () => {
    const { verifier, sign } = await buildTestFixture();
    const token = await sign({ sub: "user-subject-1", iss: TEST_ISSUER, aud: "anon" });

    await expect(verifier.verify(token)).rejects.toThrow();
  });
});
