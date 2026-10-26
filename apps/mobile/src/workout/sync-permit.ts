import { SyncNotPermittedError, type AuthTokenProvider, type UnauthorizedRecovery } from "./auth-token-provider";

/**
 * Auth Slice C — whether this runtime's outbox may leave the device right
 * now. The IdentityGate grants it only while the owner is verified ONLINE
 * (authenticated `/me` matched this runtime's `userId`) and the session is
 * valid; it withdraws it on an offline-bound boot and while re-
 * authentication is pending. Local logging is never affected.
 */
export class SyncPermit {
  private permitted: boolean;

  constructor(initiallyPermitted: boolean) {
    this.permitted = initiallyPermitted;
  }

  get isPermitted(): boolean {
    return this.permitted;
  }

  set(permitted: boolean): void {
    this.permitted = permitted;
  }
}

/**
 * The token provider `SyncEngine` gets: the owner-bound provider, but it
 * refuses (before any outbox row is touched) while the permit is withdrawn.
 * Reads (Plan/Today/Progress) keep using the plain owner-bound provider.
 */
export class PermitGatedAuthTokenProvider implements AuthTokenProvider {
  constructor(
    private readonly inner: AuthTokenProvider,
    private readonly permit: SyncPermit,
  ) {}

  getAccessToken(): Promise<string> {
    if (!this.permit.isPermitted) return Promise.reject(new SyncNotPermittedError());
    return this.inner.getAccessToken();
  }

  recoverFromUnauthorized(rejectedAccessToken: string): Promise<UnauthorizedRecovery> {
    return this.inner.recoverFromUnauthorized?.(rejectedAccessToken) ?? Promise.resolve("SESSION_INVALID");
  }

  async reportSessionInvalid(): Promise<void> {
    await this.inner.reportSessionInvalid?.();
  }
}
