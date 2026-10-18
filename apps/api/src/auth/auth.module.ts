import { readFileSync } from "node:fs";
import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createLocalJWKSet, type JWTVerifyGetKey } from "jose";
import type { ApiConfig } from "../common/config/api-config.js";
import { AUTH_TOKEN_VERIFIER } from "./token-verifier.js";
import { SupabaseJwtVerifier } from "./supabase-jwt-verifier.js";
import { IdentityResolverService } from "./identity-resolver.service.js";
import { AuthGuard } from "./auth.guard.js";

/**
 * Local Manual E2E Runtime Unblock Slice - loads the same kind of local
 * JWKS resolver `supabase-jwt-verifier.test.ts` already uses
 * (`createLocalJWKSet`), but read from a generated file
 * (`apps/api/src/dev/generate-local-auth-key.ts`) instead of an in-test
 * keypair. Only ever called when `NODE_ENV === "local"` AND
 * `LOCAL_JWKS_PATH` is set - `apiConfigSchema`'s own `superRefine` already
 * makes the latter impossible outside `NODE_ENV === "local"`, and this
 * function re-checks both explicitly as defense-in-depth rather than
 * trusting that invariant silently.
 */
function loadLocalJwks(localJwksPath: string): JWTVerifyGetKey {
  const jwks: unknown = JSON.parse(readFileSync(localJwksPath, "utf-8"));
  return createLocalJWKSet(jwks as Parameters<typeof createLocalJWKSet>[0]);
}

/**
 * Pure predicate, directly unit-testable without a NestJS DI container:
 * the ONLY condition under which a local JWKS may ever be used. Production/
 * staging/development always return `false` here regardless of what
 * `localJwksPath` happens to contain — `apiConfigSchema`'s own
 * `superRefine` additionally makes it impossible for `localJwksPath` to be
 * defined at all outside `NODE_ENV === "local"`, so this is defense-in-
 * depth, not the only gate.
 */
export function shouldUseLocalJwks(nodeEnv: string, localJwksPath: string | undefined): boolean {
  return nodeEnv === "local" && localJwksPath !== undefined;
}

/**
 * Builds the real `AUTH_TOKEN_VERIFIER`. Takes plain config values (not a
 * `ConfigService`) so it is directly unit-testable with a real generated
 * local JWKS, exercising the actual wiring this slice added rather than
 * only `SupabaseJwtVerifier`'s already-tested verification logic.
 */
export function buildSupabaseJwtVerifier(config: Pick<ApiConfig, "SUPABASE_URL" | "NODE_ENV" | "LOCAL_JWKS_PATH">): SupabaseJwtVerifier {
  if (shouldUseLocalJwks(config.NODE_ENV, config.LOCAL_JWKS_PATH)) {
    return new SupabaseJwtVerifier(config.SUPABASE_URL, loadLocalJwks(config.LOCAL_JWKS_PATH!));
  }
  return new SupabaseJwtVerifier(config.SUPABASE_URL);
}

@Module({
  providers: [
    {
      provide: AUTH_TOKEN_VERIFIER,
      useFactory: (configService: ConfigService<ApiConfig, true>): SupabaseJwtVerifier =>
        buildSupabaseJwtVerifier({
          SUPABASE_URL: configService.get("SUPABASE_URL", { infer: true }),
          NODE_ENV: configService.get("NODE_ENV", { infer: true }),
          LOCAL_JWKS_PATH: configService.get("LOCAL_JWKS_PATH", { infer: true }),
        }),
      inject: [ConfigService],
    },
    IdentityResolverService,
    AuthGuard,
  ],
  exports: [AUTH_TOKEN_VERIFIER, IdentityResolverService, AuthGuard],
})
export class AuthModule {}
