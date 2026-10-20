import type { AuthSession, AuthSessionSource } from "../auth-session";

/** TEST-ONLY session source whose current session the test sets (switch identity, refresh token, sign out). */
export class ControllableSessionSource implements AuthSessionSource {
  private listeners = new Set<() => void>();

  constructor(private session: AuthSession | null) {}

  set(session: AuthSession | null): void {
    this.session = session;
    for (const listener of [...this.listeners]) listener();
  }

  getSession(): Promise<AuthSession | null> {
    return Promise.resolve(this.session);
  }

  subscribe(onChange: () => void): () => void {
    this.listeners.add(onChange);
    return () => {
      this.listeners.delete(onChange);
    };
  }
}
