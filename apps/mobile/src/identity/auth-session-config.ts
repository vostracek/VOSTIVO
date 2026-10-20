import { isProduction, type Environment } from "@vostivo/config";
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
}

export interface AuthSessionWiring {
  readonly source: AuthSessionSource;
  /** Present only in a `__DEV__`, non-production build configured with `EXPO_PUBLIC_DEV_JWTS`. */
  readonly devIdentitySwitcher: DevAuthSessionSource | null;
}

const DEV_ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{0,23}$/;

/**
 * Fail-closed session wiring (AUTH-LOCAL-014):
 * - production: there is no sign-in before Slice C, so there is NO session
 *   — never a dev token, a cached binding, the legacy DB or an anonymous
 *   user. A dev token configured into a production build refuses to boot.
 * - non-production: the dev identities, if configured; otherwise no session.
 * The identity selector exists only when `__DEV__` is true.
 */
export function createAuthSessionWiring(env: AuthSessionEnvironment, selectionStore: SecureValueStore | null): AuthSessionWiring {
  const devJwtConfigured = isConfigured(env.devJwt);
  const devJwtsConfigured = isConfigured(env.devJwts);

  if (isProduction(env.environment)) {
    if (devJwtConfigured || devJwtsConfigured) {
      throw new Error(
        "A dev JWT (EXPO_PUBLIC_DEV_JWT / EXPO_PUBLIC_DEV_JWTS) is set but EXPO_PUBLIC_VOSTIVO_ENV resolves to " +
          "'production' — refusing to start rather than silently allowing a development auth override in a production build.",
      );
    }
    return { source: new NoSignInAuthSessionSource(), devIdentitySwitcher: null };
  }

  if (env.isDevBuild && devJwtsConfigured) {
    const switcher = new DevAuthSessionSource(parseDevIdentities(env.devJwts as string), selectionStore);
    return { source: switcher, devIdentitySwitcher: switcher };
  }
  if (devJwtConfigured) {
    return { source: new DevAuthSessionSource([{ alias: "dev", token: env.devJwt as string }]), devIdentitySwitcher: null };
  }
  return { source: new NoSignInAuthSessionSource(), devIdentitySwitcher: null };
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
