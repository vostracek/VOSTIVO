import type { SecureValueStore } from "../secure-value-store";

/** TEST-ONLY in-memory SecureStore; records every write so tests can prove what was (not) written. */
export class InMemorySecureValueStore implements SecureValueStore {
  readonly values = new Map<string, string>();
  readonly writes: string[] = [];
  readonly deletes: string[] = [];
  /** Fault injection: the next `set` calls succeed this many times, then every further `set` throws (simulates a crash mid-write). */
  failSetsAfter: number | null = null;
  /** Fault injection: every read/write throws (SecureStore unavailable). */
  unavailable = false;

  get(key: string): Promise<string | null> {
    if (this.unavailable) return Promise.reject(new Error("SecureStore unavailable"));
    return Promise.resolve(this.values.get(key) ?? null);
  }

  set(key: string, value: string): Promise<void> {
    if (this.unavailable) return Promise.reject(new Error("SecureStore unavailable"));
    if (this.failSetsAfter !== null) {
      if (this.failSetsAfter <= 0) return Promise.reject(new Error("simulated crash during write"));
      this.failSetsAfter -= 1;
    }
    this.writes.push(key);
    this.values.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    if (this.unavailable) return Promise.reject(new Error("SecureStore unavailable"));
    this.deletes.push(key);
    this.values.delete(key);
    return Promise.resolve();
  }
}

/** TEST-ONLY unsigned JWT-shaped token carrying `sub` (the app never verifies tokens locally; the server does). */
export function devToken(subject: string, nonce = "1"): string {
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "ES256", typ: "JWT" })}.${encode({ sub: subject, aud: "authenticated", jti: nonce })}.c2lnbmF0dXJl`;
}
