import { readFileSync } from "node:fs";
import { importJWK, SignJWT } from "jose";

/**
 * Local Manual E2E Runtime Unblock Slice (task section 8/9) — mints a
 * real, cryptographically signed, short-lived LOCAL dev athlete JWT that
 * `SupabaseJwtVerifier` will genuinely verify (correct issuer/audience/
 * subject/expiry, real ES256 signature) when the real API is started with
 * `NODE_ENV=local` and `LOCAL_JWKS_PATH` pointing at the JWKS this
 * script's sibling (`generate-local-auth-key.ts`) produced. This is NOT
 * an auth bypass: there is no code path that skips verification — the
 * token must pass the exact same `jwtVerify(...)` call production tokens
 * go through.
 *
 * Deterministic manual-test identity (task section 14): a stable,
 * obviously-non-production subject, `(provider, providerSubject) =
 * ("supabase", LOCAL_MANUAL_ATHLETE_SUBJECT)` once resolved through the
 * real `GET /api/v1/me` identity-resolution path — this script never
 * creates a `User`/`AuthIdentity` row itself.
 *
 * Usage (SUPABASE_URL must match the value apps/api/.env uses — no
 * script in this repo auto-loads .env, matching the existing
 * db:migrate/db:bootstrap-roles convention):
 *
 *   SUPABASE_URL=<same value as apps/api/.env> \
 *     pnpm --filter @vostivo/api auth:local:mint-jwt
 *
 * Optional: LOCAL_DEV_JWT_SUBJECT (default below), LOCAL_DEV_JWT_TTL_SECONDS
 * (default 86400 = 24h — a practical local-dev lifetime, never an
 * effectively-permanent production-style credential; re-run this script to
 * mint a fresh one once it expires).
 */
export const LOCAL_MANUAL_ATHLETE_SUBJECT = "local-manual-athlete-001";

const SIGNING_KEY_PATH = new URL("../../.local/signing-key.json", import.meta.url).pathname;
const DEFAULT_TTL_SECONDS = 86400;

interface LocalSigningKeyFile {
  readonly kid: string;
  readonly alg: "ES256";
  readonly privateJwk: Record<string, unknown>;
}

async function main(): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  if (supabaseUrl === undefined || supabaseUrl.length === 0) {
    throw new Error(
      "SUPABASE_URL env var is required and must match the value configured in apps/api/.env " +
        "(it determines the token's issuer claim).",
    );
  }

  const subject = process.env.LOCAL_DEV_JWT_SUBJECT ?? LOCAL_MANUAL_ATHLETE_SUBJECT;
  const ttlSeconds = Number(process.env.LOCAL_DEV_JWT_TTL_SECONDS ?? DEFAULT_TTL_SECONDS);

  const keyFile = JSON.parse(readFileSync(SIGNING_KEY_PATH, "utf-8")) as LocalSigningKeyFile;
  const privateKey = await importJWK(keyFile.privateJwk, keyFile.alg);

  const issuer = `${supabaseUrl}/auth/v1`;
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ttlSeconds;

  const token = await new SignJWT({ sub: subject, iss: issuer, aud: "authenticated" })
    .setProtectedHeader({ alg: keyFile.alg, kid: keyFile.kid })
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(privateKey);

  // Every human-readable message goes to STDERR, never stdout — stdout
  // carries ONLY the token (written last, below), so
  // `... | tail -1` / direct capture into a variable is reliable. Mixing
  // these on one stream previously caused a real bug here: pino's logger
  // writes asynchronously, so a `logger.info(...)` sharing stdout with a
  // synchronous `process.stdout.write` could flush AFTER it, silently
  // corrupting "the last line is the token" for any caller/script.
  console.error(
    `Minted local dev athlete JWT — subject=${subject} issuer=${issuer} audience=authenticated expiresAt=${new Date(expiresAt * 1000).toISOString()}`,
  );
  console.error("Set this as apps/mobile/.env's EXPO_PUBLIC_DEV_JWT (also requires EXPO_PUBLIC_VOSTIVO_ENV=local). Token (stdout):");
  process.stdout.write(`${token}\n`);
}

main().catch((error: unknown) => {
  console.error("Local dev JWT minting failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
