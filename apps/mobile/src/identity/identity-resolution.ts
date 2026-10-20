import type { AuthSession } from "./auth-session";
import { IdentityBindingConflictError, type IdentityBindingStore, type VerifiedIdentity } from "./identity-binding-store";
import type { VerifiedMeOutcome } from "./verified-me-client";

export type IdentityErrorReason =
  /** No session at all (signed out, or a production build before Slice C's sign-in). */
  | "NO_SESSION"
  /** The server refused the token (expired / invalid dev token). No fallback to a cached binding. */
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
 * 2. the server refused the token: IDENTITY_ERROR — a cached binding is
 *    NEVER used to get around a 401.
 * 3. server unreachable: a binding verified earlier for exactly this
 *    `(provider, subject)` may open that user's data offline; unknown
 *    subject -> NEEDS_NETWORK (no athlete database is opened).
 */
export async function resolveIdentity(session: AuthSession, ports: IdentityResolutionPorts): Promise<IdentityResolution> {
  const me = await ports.fetchMe(session.accessToken);
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
