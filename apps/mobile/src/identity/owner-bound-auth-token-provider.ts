import { RuntimeOwnerMismatchError, type AuthTokenProvider } from "../workout/auth-token-provider";
import { isSameSessionIdentity, type AuthSession, type AuthSessionSource } from "./auth-session";

/**
 * The ONLY token provider an athlete runtime gets. It returns the current
 * access token only while the current session is still the provider
 * identity this runtime was verified for — `(provider, subject)` was bound
 * to the runtime's `userId` by a verified `/me`, so equality here means the
 * same owner. Otherwise it throws `RuntimeOwnerMismatchError` before any
 * request is made: a runtime built for A can never send anything with B's
 * token (AUTH-LOCAL-002). A new token for the SAME identity (refresh) is
 * picked up transparently (AUTH-LOCAL-003).
 */
export class OwnerBoundAuthTokenProvider implements AuthTokenProvider {
  constructor(
    private readonly source: AuthSessionSource,
    private readonly owner: Pick<AuthSession, "provider" | "providerSubject">,
  ) {}

  async getAccessToken(): Promise<string> {
    const session = await this.source.getSession();
    if (session === null || !isSameSessionIdentity(session, this.owner)) throw new RuntimeOwnerMismatchError();
    return session.accessToken;
  }
}
