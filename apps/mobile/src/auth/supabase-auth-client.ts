import { createClient } from "@supabase/supabase-js";
import type { SupabaseClientConfig } from "../infrastructure/supabase-config";
import type { SecureValueStore } from "../identity/secure-value-store";
import { ChunkedSecureSessionStorage } from "./chunked-secure-session-storage";
import { readStoredSupabaseSession, SupabaseAuthSessionSource } from "./supabase-auth-session-source";

/** The single, fixed storage key for this app's Supabase session (chunked in SecureStore). */
export const SUPABASE_SESSION_STORAGE_KEY = "supabase-session";

/**
 * The ONLY place `@supabase/supabase-js` is instantiated (enforced by
 * `no-hidden-runtime-path.test.ts`). Only `client.auth` ever leaves this
 * function — there is no PostgREST/Storage/Realtime use in the app.
 *
 * - session persisted only in SecureStore (chunked, manifest-switched)
 * - `detectSessionInUrl: false` (no magic links / OAuth redirects in V1)
 * - auto-refresh started/stopped with the app foreground
 *   (`SupabaseAuthSessionSource.attachAppLifecycle`)
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
  });
  return new SupabaseAuthSessionSource(client.auth, () => readStoredSupabaseSession(storage, SUPABASE_SESSION_STORAGE_KEY));
}
