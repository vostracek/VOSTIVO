/**
 * The only thing `SyncEngine` and the API clients need to authenticate a
 * request (spec section 31) — decouples them entirely from how a token is
 * obtained. In the app every provider is owner-bound
 * (`src/identity/owner-bound-auth-token-provider.ts`): it only ever hands
 * out the token of the athlete the runtime belongs to.
 */
export interface AuthTokenProvider {
  getAccessToken(): Promise<string>;
}

/**
 * Auth & Local Athlete Boundary V1 Slice B — the session currently
 * available is not the identity the runtime (and its local outbox) belongs
 * to, or there is no session at all. Thrown BEFORE any network request
 * (owner-bound token provider) or mapped from the server's whole-batch 409
 * `SYNC_OWNER_MISMATCH`. Never a normal retryable sync failure: the engine
 * leaves the outbox untouched and the coordinator schedules no backoff —
 * the IdentityGate replaces the runtime instead.
 */
export class RuntimeOwnerMismatchError extends Error {
  constructor() {
    super("The current session does not belong to this runtime's owner");
    this.name = "RuntimeOwnerMismatchError";
  }
}
