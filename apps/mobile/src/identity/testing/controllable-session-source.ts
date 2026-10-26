import { SessionStorageUnavailableError, type AuthSession, type AuthSessionSource, type SessionLoss } from "../auth-session";

/** TEST-ONLY session source whose current session the test sets (switch identity, refresh token, sign out, invalidate, storage failure). */
export class ControllableSessionSource implements AuthSessionSource {
  private listeners = new Set<() => void>();
  private loss: SessionLoss = "SIGNED_OUT";
  private storageUnavailable = false;

  constructor(private session: AuthSession | null) {}

  set(session: AuthSession | null, loss: SessionLoss = "SIGNED_OUT"): void {
    this.session = session;
    this.loss = loss;
    this.notify();
  }

  /** The session stopped being valid (refresh refused / revoked) — not a sign-out. */
  invalidate(): void {
    this.set(null, "SESSION_INVALID");
  }

  failStorage(unavailable: boolean): void {
    this.storageUnavailable = unavailable;
    this.notify();
  }

  getSession(): Promise<AuthSession | null> {
    if (this.storageUnavailable) return Promise.reject(new SessionStorageUnavailableError());
    return Promise.resolve(this.session);
  }

  sessionLoss(): SessionLoss {
    return this.loss;
  }

  subscribe(onChange: () => void): () => void {
    this.listeners.add(onChange);
    return () => {
      this.listeners.delete(onChange);
    };
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
