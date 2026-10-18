import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { buildSupabaseJwtVerifier, shouldUseLocalJwks } from "./auth.module.js";
import { apiConfigSchema } from "../common/config/api-config.js";

const SUPABASE_URL = "https://local-manual-e2e.supabase.example";
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const AUDIENCE = "authenticated";
const KID = "test-local-key";

describe("shouldUseLocalJwks (Local Manual E2E Runtime Unblock Slice, task section 6/25)", () => {
  it("AUTH-LOCAL-001: true only for NODE_ENV=local with a configured path", () => {
    expect(shouldUseLocalJwks("local", "/some/path.json")).toBe(true);
  });

  it("AUTH-LOCAL-002: false for local with no path configured", () => {
    expect(shouldUseLocalJwks("local", undefined)).toBe(false);
  });

  it("AUTH-LOCAL-003: false for development/staging/production even if a path is somehow present", () => {
    expect(shouldUseLocalJwks("development", "/some/path.json")).toBe(false);
    expect(shouldUseLocalJwks("staging", "/some/path.json")).toBe(false);
    expect(shouldUseLocalJwks("production", "/some/path.json")).toBe(false);
  });
});

describe("apiConfigSchema — LOCAL_JWKS_PATH fails closed (task section 6/25)", () => {
  it("AUTH-LOCAL-004: rejects LOCAL_JWKS_PATH set outside NODE_ENV=local", () => {
    for (const nodeEnv of ["development", "staging", "production"]) {
      const result = apiConfigSchema.safeParse({
        NODE_ENV: nodeEnv,
        DATABASE_URL: "postgres://u:p@localhost:5432/db",
        SUPABASE_URL,
        LOCAL_JWKS_PATH: "/some/path.json",
      });
      expect(result.success, `expected rejection for NODE_ENV=${nodeEnv}`).toBe(false);
    }
  });

  it("AUTH-LOCAL-005: accepts LOCAL_JWKS_PATH when NODE_ENV=local", () => {
    const result = apiConfigSchema.safeParse({
      NODE_ENV: "local",
      DATABASE_URL: "postgres://u:p@localhost:5432/db",
      SUPABASE_URL,
      LOCAL_JWKS_PATH: "/some/path.json",
    });
    expect(result.success).toBe(true);
  });

  it("AUTH-LOCAL-006: LOCAL_JWKS_PATH remains entirely optional — unset config still passes", () => {
    const result = apiConfigSchema.safeParse({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://u:p@localhost:5432/db",
      SUPABASE_URL,
    });
    expect(result.success).toBe(true);
  });
});

describe("buildSupabaseJwtVerifier — real local JWKS wiring (task section 25)", () => {
  let dir: string;
  let jwksPath: string;
  let sign: (payload: Record<string, unknown>) => Promise<string>;
  let signWithWrongKey: (payload: Record<string, unknown>) => Promise<string>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "vostivo-local-jwks-test-"));
    jwksPath = join(dir, "jwks.json");

    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    const { privateKey: wrongPrivateKey } = await generateKeyPair("ES256", { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    writeFileSync(jwksPath, JSON.stringify({ keys: [{ ...publicJwk, alg: "ES256", use: "sig", kid: KID }] }));

    sign = (payload) =>
      new SignJWT(payload)
        .setProtectedHeader({ alg: "ES256", kid: KID })
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
        .sign(privateKey);
    signWithWrongKey = (payload) =>
      new SignJWT(payload)
        .setProtectedHeader({ alg: "ES256", kid: KID })
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
        .sign(wrongPrivateKey);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("AUTH-LOCAL-007: NODE_ENV=local + LOCAL_JWKS_PATH — a validly signed local token is accepted", async () => {
    const verifier = buildSupabaseJwtVerifier({ SUPABASE_URL, NODE_ENV: "local", LOCAL_JWKS_PATH: jwksPath });
    const token = await sign({ sub: "local-manual-athlete-001", iss: ISSUER, aud: AUDIENCE });

    const principal = await verifier.verify(token);
    expect(principal.subject).toBe("local-manual-athlete-001");
  });

  it("AUTH-LOCAL-008: NODE_ENV=local — a token with a bad signature is rejected", async () => {
    const verifier = buildSupabaseJwtVerifier({ SUPABASE_URL, NODE_ENV: "local", LOCAL_JWKS_PATH: jwksPath });
    const badToken = await signWithWrongKey({ sub: "local-manual-athlete-001", iss: ISSUER, aud: AUDIENCE });

    await expect(verifier.verify(badToken)).rejects.toThrow();
  });

  it("AUTH-LOCAL-009: NODE_ENV=local — wrong issuer is rejected (existing SupabaseJwtVerifier semantics, unchanged)", async () => {
    const verifier = buildSupabaseJwtVerifier({ SUPABASE_URL, NODE_ENV: "local", LOCAL_JWKS_PATH: jwksPath });
    const token = await sign({ sub: "local-manual-athlete-001", iss: "https://a-different-project.example/auth/v1", aud: AUDIENCE });

    await expect(verifier.verify(token)).rejects.toThrow();
  });

  it("AUTH-LOCAL-010: NODE_ENV=local — wrong audience is rejected (existing SupabaseJwtVerifier semantics, unchanged)", async () => {
    const verifier = buildSupabaseJwtVerifier({ SUPABASE_URL, NODE_ENV: "local", LOCAL_JWKS_PATH: jwksPath });
    const token = await sign({ sub: "local-manual-athlete-001", iss: ISSUER, aud: "anon" });

    await expect(verifier.verify(token)).rejects.toThrow();
  });
});
