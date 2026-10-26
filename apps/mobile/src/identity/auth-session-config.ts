import { isProduction, type Environment } from "@vostivo/config";
import { parseSupabaseClientConfig, SupabaseConfigError, type SupabaseClientConfig, type SupabaseConfigInput } from "../infrastructure/supabase-config";
import type { AppLifecycleSource } from "../infrastructure/sync-recovery";
import type { EmailOtpSignIn } from "../auth/supabase-auth-session-source";
import { NoSignInAuthSessionSource, type AuthSessionSource } from "./auth-session";
import { DevAuthSessionSource, type DevIdentity } from "./dev-auth-session-source";
import type { SecureValueStore } from "./secure-value-store";

/**
 * Build-time inputs, passed in (not read here) so every branch is unit
 * tested. `app`-side wiring reads the literal `process.env.EXPO_PUBLIC_*`
 * names (Expo only inlines literal accesses) and the real `__DEV__`.
 */
export interface AuthSessionEnvironment {
  readonly environment: Environment;
  /** `EXPO_PUBLIC_DEV_JWT` — one dev identity (also usable in a non-production RELEASE build for native verification). */
  readonly devJwt: string | undefined;
  /** `EXPO_PUBLIC_DEV_JWTS` — `alias=jwt,alias=jwt`; the D-8 identity selector, honoured ONLY in a `__DEV__` build. */
  readonly devJwts: string | undefined;
  /** The real `__DEV__`. */
  readonly isDevBuild: boolean;
  /** `EXPO_PUBLIC_SUPABASE_URL` + `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (Auth Slice C). */
  readonly supabase: SupabaseConfigInput;
}

/** The Supabase-backed session source as the wiring needs it (built by `createSupabaseAuthSessionSource` in the app, a fake in tests). */
export type SupabaseSessionSource = AuthSessionSource & EmailOtpSignIn & { attachAppLifecycle(lifecycle: AppLifecycleSource): () => void };

export interface AuthSessionWiring {
  readonly source: AuthSessionSource;
  /** Present only in a `__DEV__`, non-production build configured with `EXPO_PUBLIC_DEV_JWTS`. */
  readonly devIdentitySwitcher: DevAuthSessionSource | null;
  /** Real email-OTP sign-in — present exactly when Supabase is the session source. */
  readonly supabase: SupabaseSessionSource | null;
  /** Sign-in cannot work in this build (missing/unsafe Supabase config). Names variables only, never values. The gate fails closed. */
  readonly configurationError: string | null;
}

const DEV_ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{0,23}$/;

/**
 * Fail-closed session wiring (AUTH-LOCAL-014, Auth Slice C):
 * - production: Supabase email OTP ONLY. A dev token configured into a
 *   production build refuses to boot; missing/unsafe Supabase config means
 *   no session at all (CONFIGURATION_ERROR) — never a dev token, a cached
 *   binding, the legacy DB or an anonymous user.
 * - non-production: explicit dev identities win when configured (the
 *   identity selector only when `__DEV__`); otherwise Supabase when
 *   configured; otherwise no session.
 */
export function createAuthSessionWiring(
  env: AuthSessionEnvironment,
  selectionStore: SecureValueStore | null,
  createSupabaseSource: (config: SupabaseClientConfig) => SupabaseSessionSource,
): AuthSessionWiring {
  const devJwtConfigured = isConfigured(env.devJwt);
  const devJwtsConfigured = isConfigured(env.devJwts);

  if (isProduction(env.environment)) {
    if (devJwtConfigured || devJwtsConfigured) {
      throw new Error(
        "A dev JWT (EXPO_PUBLIC_DEV_JWT / EXPO_PUBLIC_DEV_JWTS) is set but EXPO_PUBLIC_VOSTIVO_ENV resolves to " +
          "'production' — refusing to start rather than silently allowing a development auth override in a production build.",
      );
    }
    return supabaseWiring(env, createSupabaseSource, true);
  }

  if (env.isDevBuild && devJwtsConfigured) {
    const switcher = new DevAuthSessionSource(parseDevIdentities(env.devJwts as string), selectionStore);
    return { source: switcher, devIdentitySwitcher: switcher, supabase: null, configurationError: null };
  }
  if (devJwtConfigured) {
    return { source: new DevAuthSessionSource([{ alias: "dev", token: env.devJwt as string }]), devIdentitySwitcher: null, supabase: null, configurationError: null };
  }
  return supabaseWiring(env, createSupabaseSource, false);
}

function supabaseWiring(env: AuthSessionEnvironment, createSupabaseSource: (config: SupabaseClientConfig) => SupabaseSessionSource, required: boolean): AuthSessionWiring {
  let config: SupabaseClientConfig | null;
  try {
    config = parseSupabaseClientConfig(env.supabase);
  } catch (error) {
    if (!(error instanceof SupabaseConfigError)) throw error;
    return noSession(error.message);
  }
  if (config === null) return noSession(required ? "Supabase sign-in is not configured (EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY)" : null);
  const source = createSupabaseSource(config);
  return { source, devIdentitySwitcher: null, supabase: source, configurationError: null };
}

function noSession(configurationError: string | null): AuthSessionWiring {
  return { source: new NoSignInAuthSessionSource(), devIdentitySwitcher: null, supabase: null, configurationError };
}

/** `alias=jwt,alias=jwt` (a JWT never contains `,` or `=`). Errors name the entry position, never its token. */
export function parseDevIdentities(raw: string): readonly DevIdentity[] {
  const identities: DevIdentity[] = [];
  raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .forEach((entry, index) => {
      const separator = entry.indexOf("=");
      const alias = separator > 0 ? entry.slice(0, separator).trim() : "";
      const token = separator > 0 ? entry.slice(separator + 1).trim() : "";
      if (!DEV_ALIAS_PATTERN.test(alias) || token.length === 0) {
        throw new Error(`EXPO_PUBLIC_DEV_JWTS entry #${index + 1} is not 'alias=jwt' (alias: lowercase letters, digits, '-', '_')`);
      }
      if (identities.some((identity) => identity.alias === alias)) throw new Error(`EXPO_PUBLIC_DEV_JWTS alias '${alias}' is duplicated`);
      identities.push({ alias, token });
    });
  if (identities.length === 0) throw new Error("EXPO_PUBLIC_DEV_JWTS is set but contains no identities");
  return identities;
}

function isConfigured(value: string | undefined): boolean {
  return value !== undefined && value.length > 0;
}
