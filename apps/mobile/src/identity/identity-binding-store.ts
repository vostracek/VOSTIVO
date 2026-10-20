import type { SecureValueStore } from "./secure-value-store";

/**
 * A VERIFIED mapping `(provider, providerSubject) -> {userId,
 * athleteProfileId}`. Written ONLY from a successful authenticated
 * `GET /api/v1/me` (AUTH-LOCAL-013) and used for exactly one thing: an
 * OFFLINE cold start of an athlete this device has already verified.
 */
export interface IdentityBinding {
  readonly provider: string;
  readonly providerSubject: string;
  readonly userId: string;
  readonly athleteProfileId: string;
  /** ISO instant of the `/me` verification that wrote (or last confirmed) it. */
  readonly verifiedAt: string;
}

export interface VerifiedIdentity {
  readonly userId: string;
  readonly athleteProfileId: string;
}

/**
 * The same provider subject resolved to a DIFFERENT `userId` than the
 * binding already recorded. A security error, never an automatic
 * reassignment: the stored binding is left untouched and the gate fails
 * closed.
 */
export class IdentityBindingConflictError extends Error {
  constructor() {
    super("A verified identity binding already maps this provider subject to another user");
    this.name = "IdentityBindingConflictError";
  }
}

/** One SecureStore item holding a tiny versioned list — V1 devices have one or a few athletes, never a general multi-account store. */
export const IDENTITY_BINDINGS_STORAGE_KEY = "vostivo.identity-bindings.v1";

/**
 * Upper bound that keeps the item well under SecureStore's practical
 * per-value size. Evicting the least recently verified binding only means
 * that athlete needs the network once more to start — it never touches
 * any local workout data.
 */
export const MAX_IDENTITY_BINDINGS = 8;

interface StoredBindingsV1 {
  readonly version: 1;
  readonly bindings: readonly IdentityBinding[];
}

export class IdentityBindingStore {
  constructor(private readonly store: SecureValueStore) {}

  async find(provider: string, providerSubject: string): Promise<IdentityBinding | null> {
    const bindings = await this.readAll();
    return bindings.find((binding) => binding.provider === provider && binding.providerSubject === providerSubject) ?? null;
  }

  /**
   * Records a binding from a VERIFIED `/me` response. Idempotent for the
   * same user (refreshes `verifiedAt`); throws `IdentityBindingConflictError`
   * — writing nothing — if the subject is already bound to another user.
   */
  async recordVerified(provider: string, providerSubject: string, identity: VerifiedIdentity, verifiedAt: Date): Promise<IdentityBinding> {
    const bindings = await this.readAll();
    const existing = bindings.find((binding) => binding.provider === provider && binding.providerSubject === providerSubject);
    if (existing !== undefined && existing.userId !== identity.userId) throw new IdentityBindingConflictError();

    const binding: IdentityBinding = {
      provider,
      providerSubject,
      userId: identity.userId,
      athleteProfileId: identity.athleteProfileId,
      verifiedAt: verifiedAt.toISOString(),
    };
    const others = bindings.filter((candidate) => candidate !== existing);
    const kept = [...others].sort((a, b) => b.verifiedAt.localeCompare(a.verifiedAt)).slice(0, MAX_IDENTITY_BINDINGS - 1);
    const stored: StoredBindingsV1 = { version: 1, bindings: [binding, ...kept] };
    await this.store.set(IDENTITY_BINDINGS_STORAGE_KEY, JSON.stringify(stored));
    return binding;
  }

  /**
   * An unreadable item is treated as "no bindings": an offline start then
   * shows NEEDS_NETWORK (fail closed), and the next verified `/me`
   * rewrites a clean item. It never grants access.
   */
  private async readAll(): Promise<readonly IdentityBinding[]> {
    const raw = await this.store.get(IDENTITY_BINDINGS_STORAGE_KEY);
    if (raw === null) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isStoredBindingsV1(parsed)) return [];
      return parsed.bindings;
    } catch {
      return [];
    }
  }
}

function isStoredBindingsV1(value: unknown): value is StoredBindingsV1 {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { version?: unknown; bindings?: unknown };
  return candidate.version === 1 && Array.isArray(candidate.bindings) && candidate.bindings.every(isIdentityBinding);
}

function isIdentityBinding(value: unknown): value is IdentityBinding {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return ["provider", "providerSubject", "userId", "athleteProfileId", "verifiedAt"].every((key) => typeof candidate[key] === "string" && (candidate[key] as string).length > 0);
}
