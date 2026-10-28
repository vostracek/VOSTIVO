import { createClient } from "@supabase/supabase-js";
import { createBoundedFetch } from "../infrastructure/request-timeout";
import type { SupabaseClientConfig } from "../infrastructure/supabase-config";
import type { SecureValueStore } from "../identity/secure-value-store";
import { ChunkedSecureSessionStorage } from "./chunked-secure-session-storage";
import { readStoredSupabaseSession, SupabaseAuthSessionSource } from "./supabase-auth-session-source";

/** The single, fixed storage key for this app's Supabase session (chunked in SecureStore). */
export const SUPABASE_SESSION_STORAGE_KEY = "supabase-session";

/** Per-request bound for Supabase Auth calls; a timed-out request is the SDK's ordinary retryable network failure. */
export const SUPABASE_AUTH_REQUEST_TIMEOUT_MS = 8_000;

/**
 * The ONLY place `@supabase/supabase-js` is instantiated (enforced by
 * `no-hidden-runtime-path.test.ts`). Only `client.auth` ever leaves this
 * function — there is no PostgREST/Storage/Realtime use in the app.
 *
 * - session persisted only in SecureStore (chunked, manifest-switched)
 * - `detectSessionInUrl: false` (no magic links / OAuth redirects in V1)
 * - auto-refresh started/stopped with the app foreground
 *   (`SupabaseAuthSessionSource.attachAppLifecycle`)
 * - every auth request bounded (`SUPABASE_AUTH_REQUEST_TIMEOUT_MS`) —
 *   React Native's Android fetch has no timeout of its own
 */
export function createSupabaseAuthSessionSource(config: SupabaseClientConfig, secureStore: SecureValueStore): SupabaseAuthSessionSource {
  const storage = new ChunkedSecureSessionStorage(secureStore);
  const client = createClient(config.url, config.publishableKey, {
    auth: {
      storage,
      storageKey: SUPABASE_SESSION_STORAGE_KEY,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
    // This client is auth-only, so this bounds exactly the auth requests; the Vostivo API clients keep their own fetch.
    global: { fetch: createBoundedFetch(SUPABASE_AUTH_REQUEST_TIMEOUT_MS) },
  });
  return new SupabaseAuthSessionSource(client.auth, () => readStoredSupabaseSession(storage, SUPABASE_SESSION_STORAGE_KEY));
}
