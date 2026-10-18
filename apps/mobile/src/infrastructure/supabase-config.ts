/**
 * Client-safe Supabase configuration boundary (spec section 23).
 *
 * Only `EXPO_PUBLIC_`-prefixed environment variables are ever bundled into
 * client JS — Expo strips every other variable at build time. That is the
 * actual mechanism (enforced by tooling, not convention) that keeps a
 * service-role key or any other server secret out of the mobile bundle
 * (spec section 24) — never read a non-`EXPO_PUBLIC_` variable here.
 *
 * Deliberately deferred (see docs/architecture/IDENTITY-AUTH.md): the
 * `@supabase/supabase-js` client itself, its SecureStore-backed session
 * storage adapter, and any sign-in flow. Adding the SDK now — with no
 * real project and no consumer — would mean designing session-persistence
 * behavior speculatively, which this task's scope explicitly excludes.
 */
export interface SupabaseClientConfig {
  readonly url: string;
  readonly anonKey: string;
}

export class MissingSupabaseConfigError extends Error {
  constructor(missing: readonly string[]) {
    super(`Missing required Supabase config: ${missing.join(", ")}`);
    this.name = "MissingSupabaseConfigError";
  }
}

export function loadSupabaseClientConfig(): SupabaseClientConfig {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

  if (url === undefined || anonKey === undefined) {
    const missing = [
      url === undefined ? "EXPO_PUBLIC_SUPABASE_URL" : undefined,
      anonKey === undefined ? "EXPO_PUBLIC_SUPABASE_ANON_KEY" : undefined,
    ].filter((name): name is string => name !== undefined);
    throw new MissingSupabaseConfigError(missing);
  }

  return { url, anonKey };
}
