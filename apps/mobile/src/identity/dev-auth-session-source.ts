import { SUPABASE_PROVIDER, type AuthSession, type AuthSessionSource } from "./auth-session";
import { readUnverifiedJwtSubject } from "./jwt-subject";
import type { SecureValueStore } from "./secure-value-store";

/** One developer-configured identity: a safe alias for the UI, the token never shown. */
export interface DevIdentity {
  readonly alias: string;
  readonly token: string;
}

/** Remembers which dev identity was selected across relaunches (an alias, never a token). */
export const DEV_IDENTITY_SELECTION_STORAGE_KEY = "vostivo.dev-identity.selected-alias";

/**
 * Non-production session source over developer-configured, real ES256 dev
 * JWTs (`auth:local:mint-jwt`) — no server bypass; the API verifies them
 * exactly like production tokens. With several identities (D-8, `__DEV__`
 * only) `select()` switches the session, which goes through the normal
 * IdentityGate transition — there is no shortcut that picks a database.
 */
export class DevAuthSessionSource implements AuthSessionSource {
  private selectedAlias: string;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly identities: readonly DevIdentity[],
    private readonly selectionStore: SecureValueStore | null = null,
  ) {
    const first = identities[0];
    if (first === undefined) throw new Error("DevAuthSessionSource needs at least one identity");
    this.selectedAlias = first.alias;
  }

  get aliases(): readonly string[] {
    return this.identities.map((identity) => identity.alias);
  }

  get currentAlias(): string {
    return this.selectedAlias;
  }

  /** Restores the persisted selection (if it still names a configured alias). Call once before the gate starts. */
  async restoreSelection(): Promise<void> {
    if (this.selectionStore === null) return;
    const stored = await this.selectionStore.get(DEV_IDENTITY_SELECTION_STORAGE_KEY);
    if (stored !== null && this.identities.some((identity) => identity.alias === stored)) this.selectedAlias = stored;
  }

  async select(alias: string): Promise<void> {
    if (!this.identities.some((identity) => identity.alias === alias)) throw new Error("Unknown dev identity alias");
    if (alias === this.selectedAlias) return;
    this.selectedAlias = alias;
    await this.selectionStore?.set(DEV_IDENTITY_SELECTION_STORAGE_KEY, alias);
    for (const listener of [...this.listeners]) listener();
  }

  getSession(): Promise<AuthSession | null> {
    const identity = this.identities.find((candidate) => candidate.alias === this.selectedAlias);
    if (identity === undefined) return Promise.resolve(null);
    const subject = readUnverifiedJwtSubject(identity.token);
    // A token without a readable subject cannot be matched to a binding; the
    // gate treats it as "no session" (fail closed), never as anonymous.
    if (subject === null) return Promise.resolve(null);
    return Promise.resolve({ provider: SUPABASE_PROVIDER, providerSubject: subject, accessToken: identity.token });
  }

  subscribe(onChange: () => void): () => void {
    this.listeners.add(onChange);
    return () => {
      this.listeners.delete(onChange);
    };
  }
}
