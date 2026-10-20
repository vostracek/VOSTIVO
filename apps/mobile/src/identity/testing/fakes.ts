import type { SecureValueStore } from "../secure-value-store";

/** TEST-ONLY in-memory SecureStore; records every write so tests can prove what was (not) written. */
export class InMemorySecureValueStore implements SecureValueStore {
  readonly values = new Map<string, string>();
  readonly writes: string[] = [];

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }

  set(key: string, value: string): Promise<void> {
    this.writes.push(key);
    this.values.set(key, value);
    return Promise.resolve();
  }
}

/** TEST-ONLY unsigned JWT-shaped token carrying `sub` (the app never verifies tokens locally; the server does). */
export function devToken(subject: string, nonce = "1"): string {
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "ES256", typ: "JWT" })}.${encode({ sub: subject, aud: "authenticated", jti: nonce })}.c2lnbmF0dXJl`;
}
