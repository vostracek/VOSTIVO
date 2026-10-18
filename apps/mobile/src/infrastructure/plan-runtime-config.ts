import { ENVIRONMENTS, isProduction, type Environment } from "@vostivo/config";
import { DeferredSupabaseAuthTokenProvider, StaticTestAuthTokenProvider, type AuthTokenProvider } from "../workout/auth-token-provider";

/**
 * Wires the real Plan/Workout screens to an access token and an API base
 * URL. Production Supabase mobile sign-in is still deferred (spec section
 * 26, docs/architecture/IDENTITY-AUTH.md) — with no dev override
 * configured, this always resolves to `DeferredSupabaseAuthTokenProvider`,
 * which throws loudly rather than granting any access. There is no
 * production authentication bypass, and no server-side auth-bypass
 * endpoint exists either.
 *
 * The dev/native-verification override
 * (`StaticTestAuthTokenProvider` + `EXPO_PUBLIC_DEV_JWT`) requires TWO
 * explicit, independent opt-ins, both baked in at build time via Expo's
 * `EXPO_PUBLIC_*` convention:
 *
 *   1. `EXPO_PUBLIC_VOSTIVO_ENV` set to something other than `production`
 *      — reusing the same `LOCAL`/`DEVELOPMENT`/`STAGING`/`PRODUCTION`
 *      environment model `packages/config` already defines for the
 *      server, not a second taxonomy.
 *   2. `EXPO_PUBLIC_DEV_JWT` actually set to a token.
 *
 * The environment defaults to `"production"` (the strictest value) when
 * unset or unrecognized — a fail-closed default, not fail-open. If the
 * token happens to be configured while the resolved environment is
 * `production` (e.g. a build pipeline misconfiguration that sets the JWT
 * but forgets to also flip the environment), this throws immediately
 * rather than silently granting access — a real build in that state must
 * fail loudly, not boot with a live authentication bypass. Neither
 * variable is ever committed to the repository — `EXPO_PUBLIC_DEV_JWT`
 * only ever comes from a developer's gitignored `.env.local`, and no real
 * build/release pipeline sets it.
 *
 * Deliberately NOT also gated on `__DEV__`: the mandatory native offline
 * verification for this project always uses a *release* build (embedded
 * JS bundle, no Metro dependency at runtime — see
 * docs/architecture/WORKOUT-DATA-INTEGRITY.md), and a release build
 * always has `__DEV__ === false`. Gating on `__DEV__` would make this
 * override impossible to exercise in exactly the build variant that
 * needs it — the environment check above is the real safety boundary.
 */
export function createPlanAuthTokenProvider(): AuthTokenProvider {
  const environment = resolveVostivoEnvironment();
  const devJwt = process.env.EXPO_PUBLIC_DEV_JWT;
  const devJwtConfigured = devJwt !== undefined && devJwt.length > 0;

  if (isProduction(environment)) {
    if (devJwtConfigured) {
      // Fail safely rather than silently enabling a production bypass.
      throw new Error(
        "EXPO_PUBLIC_DEV_JWT is set but EXPO_PUBLIC_VOSTIVO_ENV resolves to " +
          "'production' — refusing to start rather than silently allowing a " +
          "development auth override in a production build. See " +
          "docs/architecture/PLAN-PRESCRIPTION.md.",
      );
    }
    return new DeferredSupabaseAuthTokenProvider();
  }

  if (devJwtConfigured) {
    return new StaticTestAuthTokenProvider(devJwt);
  }
  return new DeferredSupabaseAuthTokenProvider();
}

/**
 * Fails closed: an unset or unrecognized value resolves to `"production"`,
 * the strictest environment, never a permissive default.
 */
function resolveVostivoEnvironment(): Environment {
  const raw = process.env.EXPO_PUBLIC_VOSTIVO_ENV;
  if (raw !== undefined && (ENVIRONMENTS as readonly string[]).includes(raw)) {
    return raw as Environment;
  }
  return "production";
}

export function getPlanApiBaseUrl(): string {
  const configured = process.env.EXPO_PUBLIC_API_BASE_URL;
  if (configured !== undefined && configured.length > 0) return configured;
  // No production API deployment exists yet either — failing loudly here
  // is the honest behavior, not a silent fallback to some guessed URL.
  throw new Error(
    "EXPO_PUBLIC_API_BASE_URL is not configured — no production API endpoint exists yet. " +
      "See docs/architecture/PLAN-PRESCRIPTION.md.",
  );
}
