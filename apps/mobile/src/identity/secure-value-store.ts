/**
 * The small key/value surface the identity layer needs from SecureStore —
 * an interface so the binding store and dev identity selection run in unit
 * tests without the native module. The app wires `src/infrastructure/
 * secure-store.ts`.
 */
export interface SecureValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
