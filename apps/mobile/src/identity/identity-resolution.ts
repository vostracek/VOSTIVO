import { AuthServiceUnavailableError } from "../workout/auth-token-provider";
import { isSameSessionIdentity, type AuthSession, type AuthSessionSource } from "./auth-session";
import { IdentityBindingConflictError, type IdentityBindingStore, type VerifiedIdentity } from "./identity-binding-store";
import type { VerifiedMeOutcome } from "./verified-me-client";

export type IdentityErrorReason =
  /** The server refused the token, even after one refresh. No fallback to a cached binding (the gate asks to sign in again). */
  | "UNAUTHORIZED"
  /** The same provider subject resolved to a different user than the verified binding. */
  | "BINDING_CONFLICT"
  /** The server answered, but not with a usable identity. */
  | "INVALID_RESPONSE"
  /** Something failed while resolving/opening (a bug or a native failure) — fail closed. */
  | "UNEXPECTED";

export type IdentityResolution =
  | { readonly kind: "VERIFIED"; readonly identity: VerifiedIdentity; readonly source: "ONLINE" | "OFFLINE_BINDING" }
  | { readonly kind: "NEEDS_NETWORK" }
  | { readonly kind: "IDENTITY_ERROR"; readonly reason: IdentityErrorReason };

export interface IdentityResolutionPorts {
  fetchMe(accessToken: string): Promise<VerifiedMeOutcome>;
  /**
   * Auth Slice C: `/me` refused `session`'s token — refresh it ONCE
   * (single-flight in the session source). Returns the refreshed session of
   * the SAME provider identity, `SESSION_INVALID`, or `UNAVAILABLE` (the
   * auth service could not be reached: treated like an unreachable API).
   * Omitted for sources that cannot refresh (dev tokens): 401 is final.
   */
  retryAfterUnauthorized?(session: AuthSession): Promise<AuthSession | "SESSION_INVALID" | "UNAVAILABLE">;
  /** The refreshed token was refused by `/me` too: the session is unusable (dropped locally as SESSION_INVALID). */
  reportSessionInvalid?(): Promise<void>;
  readonly bindings: IdentityBindingStore;
  now(): Date;
}

/**
 * session -> verified internal identity, in the only order allowed:
 *
 * 1. online: authenticated `GET /me` is the authority; its answer is the
 *    only thing that may create/confirm a binding (AUTH-LOCAL-013). A
 *    subject already bound to another user is BINDING_CONFLICT (fail closed,
 *    binding untouched).
 * 2. the server refused the token (even after one refresh, Slice C):
 *    IDENTITY_ERROR — a cached binding is NEVER used to get around a 401.
 * 3. server unreachable: a binding verified earlier for exactly this
 *    `(provider, subject)` may open that user's data offline; unknown
 *    subject -> NEEDS_NETWORK (no athlete database is opened).
 */
export async function resolveIdentity(session: AuthSession, ports: IdentityResolutionPorts): Promise<IdentityResolution> {
  let me = await ports.fetchMe(session.accessToken);
  if (me.kind === "UNAUTHORIZED" && ports.retryAfterUnauthorized !== undefined) {
    const retried = await ports.retryAfterUnauthorized(session);
    if (retried === "UNAVAILABLE") me = { kind: "UNREACHABLE" };
    else if (retried !== "SESSION_INVALID") {
      me = await ports.fetchMe(retried.accessToken);
      if (me.kind === "UNAUTHORIZED") await ports.reportSessionInvalid?.();
    }
  }
  switch (me.kind) {
    case "VERIFIED": {
      const identity: VerifiedIdentity = { userId: me.userId, athleteProfileId: me.athleteProfileId };
      try {
        await ports.bindings.recordVerified(session.provider, session.providerSubject, identity, ports.now());
      } catch (error) {
        if (error instanceof IdentityBindingConflictError) return { kind: "IDENTITY_ERROR", reason: "BINDING_CONFLICT" };
        throw error;
      }
      return { kind: "VERIFIED", identity, source: "ONLINE" };
    }
    case "UNAUTHORIZED":
      return { kind: "IDENTITY_ERROR", reason: "UNAUTHORIZED" };
    case "INVALID_RESPONSE":
      return { kind: "IDENTITY_ERROR", reason: "INVALID_RESPONSE" };
    case "UNREACHABLE": {
      const binding = await ports.bindings.find(session.provider, session.providerSubject);
      if (binding === null) return { kind: "NEEDS_NETWORK" };
      return { kind: "VERIFIED", identity: { userId: binding.userId, athleteProfileId: binding.athleteProfileId }, source: "OFFLINE_BINDING" };
    }
  }
}

/**
 * `retryAfterUnauthorized` over a session source that can refresh (Supabase):
 * one single-flight refresh, then the refreshed session — only if it is
 * still the SAME provider identity. Sources without refresh get no retry.
 */
export function unauthorizedRetryFor(source: AuthSessionSource): Pick<IdentityResolutionPorts, "retryAfterUnauthorized" | "reportSessionInvalid"> {
  const recover = source.recoverFromUnauthorized?.bind(source);
  if (recover === undefined) return {};
  return {
    async retryAfterUnauthorized(session) {
      let recovery;
      try {
        recovery = await recover(session.accessToken);
      } catch (error) {
        if (error instanceof AuthServiceUnavailableError) return "UNAVAILABLE";
        throw error;
      }
      if (recovery === "SESSION_INVALID") return "SESSION_INVALID";
      const refreshed = await source.getSession();
      return refreshed !== null && isSameSessionIdentity(refreshed, session) ? refreshed : "SESSION_INVALID";
    },
    async reportSessionInvalid() {
      await source.markSessionInvalid?.();
    },
  };
}
