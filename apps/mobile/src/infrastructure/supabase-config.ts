/**
 * Client-safe Supabase configuration boundary (Auth Slice C).
 *
 * Only `EXPO_PUBLIC_`-prefixed environment variables are ever bundled into
 * client JS — Expo strips every other variable at build time. The mobile
 * app holds exactly two public values: the project URL and the PUBLISHABLE
 * key. A secret / service-role key is refused outright (fail closed), even
 * if someone puts one under the publishable name.
 *
 * Supabase is the identity provider ONLY: the app uses `supabase.auth` and
 * nothing else — the Data API is disabled for this project and athlete data
 * goes exclusively through the Vostivo API.
 */
export interface SupabaseClientConfig {
  readonly url: string;
  readonly publishableKey: string;
}

export interface SupabaseConfigInput {
  /** `EXPO_PUBLIC_SUPABASE_URL` */
  readonly url: string | undefined;
  /** `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` */
  readonly publishableKey: string | undefined;
}

export class SupabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupabaseConfigError";
  }
}

export class MissingSupabaseConfigError extends SupabaseConfigError {
  constructor(missing: readonly string[]) {
    super(`Missing required Supabase config: ${missing.join(", ")}`);
    this.name = "MissingSupabaseConfigError";
  }
}

const LOCAL_HTTP_HOSTS = new Set(["localhost", "127.0.0.1", "10.0.2.2"]);

/**
 * `null` = Supabase is not configured at all (both values empty). A half or
 * unsafe configuration throws — it is never silently ignored. Errors name
 * variables, never values.
 */
export function parseSupabaseClientConfig(input: SupabaseConfigInput): SupabaseClientConfig | null {
  const url = input.url?.trim() ?? "";
  const publishableKey = input.publishableKey?.trim() ?? "";
  if (url.length === 0 && publishableKey.length === 0) return null;
  if (url.length === 0 || publishableKey.length === 0) {
    throw new MissingSupabaseConfigError([url.length === 0 ? "EXPO_PUBLIC_SUPABASE_URL" : undefined, publishableKey.length === 0 ? "EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY" : undefined].filter((name): name is string => name !== undefined));
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SupabaseConfigError("EXPO_PUBLIC_SUPABASE_URL is not a valid URL");
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && LOCAL_HTTP_HOSTS.has(parsed.hostname))) {
    throw new SupabaseConfigError("EXPO_PUBLIC_SUPABASE_URL must use https (http only for a local Supabase)");
  }
  if (isSecretKey(publishableKey)) {
    throw new SupabaseConfigError("EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY holds a secret/service-role key — never ship it in the mobile app");
  }
  return { url: url.replace(/\/+$/, ""), publishableKey };
}

/** A new-style secret key, or a legacy JWT key whose role is `service_role`. */
function isSecretKey(key: string): boolean {
  if (key.startsWith("sb_secret_")) return true;
  const parts = key.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(atob((parts[1] ?? "").replace(/-/g, "+").replace(/_/g, "/"))) as { role?: unknown };
    return payload.role === "service_role";
  } catch {
    return false;
  }
}
