/**
 * The only thing `SyncEngine` and the API clients need to authenticate a
 * request (spec section 31) — decouples them entirely from how a token is
 * obtained. In the app every provider is owner-bound
 * (`src/identity/owner-bound-auth-token-provider.ts`): it only ever hands
 * out the token of the athlete the runtime belongs to.
 */
export interface AuthTokenProvider {
  getAccessToken(): Promise<string>;
  /**
   * Auth Slice C: a request sent with `rejectedAccessToken` got 401. Resolves
   * `REFRESHED` when a different (refreshed) token is now available — the
   * caller retries ONCE — or `SESSION_INVALID` when the session cannot be
   * recovered. Throws `AuthServiceUnavailableError` when the auth service
   * could not be reached: that is NOT an invalid session. Providers without
   * a refresh mechanism omit it (a 401 is then final).
   */
  recoverFromUnauthorized?(rejectedAccessToken: string): Promise<UnauthorizedRecovery>;
  /** The retry after a successful refresh was refused too: the session is unusable. */
  reportSessionInvalid?(): Promise<void>;
}

export type UnauthorizedRecovery = "REFRESHED" | "SESSION_INVALID";

/** The auth service could not be reached to judge the session — offline, never "invalid". */
export class AuthServiceUnavailableError extends Error {
  constructor() {
    super("The authentication service could not be reached");
    this.name = "AuthServiceUnavailableError";
  }
}

/**
 * Sync cannot run for this runtime right now, and retrying on a timer will
 * not change that — only an identity/auth event will. `SyncEngine` leaves
 * the outbox untouched (or returns in-flight commands to RETRY) and the
 * coordinator schedules no backoff and counts no failure.
 */
export class SyncPausedError extends Error {}

/**
 * Auth & Local Athlete Boundary V1 Slice B — the session currently
 * available is not the identity the runtime (and its local outbox) belongs
 * to (no session at all is `SessionInvalidError`). Thrown BEFORE any network request
 * (owner-bound token provider) or mapped from the server's whole-batch 409
 * `SYNC_OWNER_MISMATCH`. Never a normal retryable sync failure: the engine
 * leaves the outbox untouched and the coordinator schedules no backoff —
 * the IdentityGate replaces the runtime instead.
 */
export class RuntimeOwnerMismatchError extends SyncPausedError {
  constructor() {
    super("The current session does not belong to this runtime's owner");
    this.name = "RuntimeOwnerMismatchError";
  }
}

/**
 * Auth Slice C: this owner has no usable session — the server kept refusing
 * it (401 after one refresh + retry), or it is gone while the runtime waits
 * for re-authentication. Sync waits for re-auth. The message is shown as-is
 * by screens that render a load error, so it is athlete copy.
 */
export class SessionInvalidError extends SyncPausedError {
  constructor() {
    super("Sign in again to load your latest training.");
    this.name = "SessionInvalidError";
  }
}

/** Auth Slice C: the owner is not (re-)verified online yet (offline-bound boot, re-auth pending). No outbox command may leave the device. */
export class SyncNotPermittedError extends SyncPausedError {
  constructor() {
    super("Sync is paused until this owner is verified online");
    this.name = "SyncNotPermittedError";
  }
}
