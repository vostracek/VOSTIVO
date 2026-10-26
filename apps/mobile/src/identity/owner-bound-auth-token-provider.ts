import { RuntimeOwnerMismatchError, SessionInvalidError, type AuthTokenProvider, type UnauthorizedRecovery } from "../workout/auth-token-provider";
import { isSameSessionIdentity, type AuthSession, type AuthSessionSource } from "./auth-session";

/**
 * The ONLY token provider an athlete runtime gets. It returns the current
 * access token only while the current session is still the provider
 * identity this runtime was verified for — `(provider, subject)` was bound
 * to the runtime's `userId` by a verified `/me`, so equality here means the
 * same owner. Otherwise it throws before any request is made —
 * `SessionInvalidError` when there is no session at all (re-auth pending),
 * `RuntimeOwnerMismatchError` when the session is another identity's: a runtime built for A can never send anything with B's
 * token (AUTH-LOCAL-002). A new token for the SAME identity (refresh) is
 * picked up transparently (AUTH-LOCAL-003).
 *
 * Auth Slice C: a 401 is recovered through the session source's single-
 * flight refresh — but only while the session is still this owner's. An
 * unrecoverable session is reported to the IdentityGate
 * (`onSessionInvalid`), which pauses sync and asks for re-authentication
 * WITHOUT closing this runtime (an active workout keeps working locally).
 */
export class OwnerBoundAuthTokenProvider implements AuthTokenProvider {
  constructor(
    private readonly source: AuthSessionSource,
    private readonly owner: Pick<AuthSession, "provider" | "providerSubject">,
    private readonly onSessionInvalid: () => void = () => {},
  ) {}

  async getAccessToken(): Promise<string> {
    return (await this.currentOwnerSession()).accessToken;
  }

  async recoverFromUnauthorized(rejectedAccessToken: string): Promise<UnauthorizedRecovery> {
    await this.currentOwnerSession();
    const recovery = this.source.recoverFromUnauthorized === undefined ? "SESSION_INVALID" : await this.source.recoverFromUnauthorized(rejectedAccessToken);
    if (recovery === "SESSION_INVALID") this.onSessionInvalid();
    return recovery;
  }

  async reportSessionInvalid(): Promise<void> {
    await this.source.markSessionInvalid?.();
    this.onSessionInvalid();
  }

  private async currentOwnerSession(): Promise<AuthSession> {
    const session = await this.source.getSession();
    // Auth Slice C: a runtime alive without any session is waiting for re-auth — not another owner.
    if (session === null) throw new SessionInvalidError();
    if (!isSameSessionIdentity(session, this.owner)) throw new RuntimeOwnerMismatchError();
    return session;
  }
}
