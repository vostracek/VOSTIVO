import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { exportJWK, generateKeyPair } from "jose";
import { createLogger } from "@vostivo/observability";

/**
 * Local Manual E2E Runtime Unblock Slice (task section 7) — generates the
 * smallest reproducible DEV-ONLY asymmetric signing key + public JWKS
 * needed to verify a locally-minted athlete JWT without a real Supabase
 * project. ES256, same algorithm already exercised by
 * `supabase-jwt-verifier.test.ts`.
 *
 * Writes two files under `apps/api/.local/` (matched by the repo's own
 * `*.local` gitignore rule — see `generated files cannot be committed`
 * check below, also verified independently via `git check-ignore` in this
 * task's final report):
 *
 * - `jwks.json`   — public key only, in JWKS form. This is what
 *                   `LOCAL_JWKS_PATH` points `AuthModule` at.
 * - `signing-key.json` — the PRIVATE key (as an extractable JWK) + its
 *                   `kid`. Never read by the running API — only
 *                   `mint-local-dev-jwt.ts` reads it, to sign a dev JWT.
 *                   NEVER commit this file.
 *
 * Refuses to overwrite existing key material unless `--force` is passed —
 * regenerating silently would invalidate every already-minted dev JWT
 * (including one a human may already have pasted into
 * `apps/mobile/.env`) without warning.
 */
const LOCAL_AUTH_DIR = new URL("../../.local/", import.meta.url).pathname;
const JWKS_PATH = `${LOCAL_AUTH_DIR}jwks.json`;
const SIGNING_KEY_PATH = `${LOCAL_AUTH_DIR}signing-key.json`;
const KID = "local-dev-key-1";

const logger = createLogger({ serviceName: "api-dev-generate-local-auth-key" });

async function main(): Promise<void> {
  const force = process.argv.includes("--force");

  if (!force && (existsSync(JWKS_PATH) || existsSync(SIGNING_KEY_PATH))) {
    logger.error("Local dev auth key material already exists — refusing to overwrite", {
      jwksPath: JWKS_PATH,
      signingKeyPath: SIGNING_KEY_PATH,
    });
    logger.error("Pass --force to regenerate (this invalidates every previously-minted dev JWT).");
    process.exitCode = 1;
    return;
  }

  mkdirSync(dirname(JWKS_PATH), { recursive: true });

  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);

  writeFileSync(
    JWKS_PATH,
    JSON.stringify({ keys: [{ ...publicJwk, alg: "ES256", use: "sig", kid: KID }] }, null, 2),
  );
  // 0o600: this file holds private key material — never world/group readable.
  writeFileSync(SIGNING_KEY_PATH, JSON.stringify({ kid: KID, alg: "ES256", privateJwk }, null, 2), {
    mode: 0o600,
  });

  logger.info("Generated local dev auth key material (LOCAL ONLY — never commit, never use outside NODE_ENV=local)", {
    jwksPath: JWKS_PATH,
    signingKeyPath: SIGNING_KEY_PATH,
    kid: KID,
  });
  logger.info(
    "Next: set apps/api/.env's LOCAL_JWKS_PATH to the jwks.json path above (NODE_ENV must be 'local'), " +
      "then run `pnpm --filter @vostivo/api auth:local:mint-jwt` to mint a dev athlete JWT.",
  );
}

main().catch((error: unknown) => {
  logger.error("Local dev auth key generation failed", { error: error instanceof Error ? error.message : error });
  process.exitCode = 1;
});
