import { uuidv7, V7Generator } from "uuidv7";

/**
 * The only contract packages/domain needs from a secure random source —
 * deliberately just this one function, not "the Web Crypto API" or any
 * specific vendor SDK, so any platform's secure RNG can satisfy it without
 * this package depending on that platform (spec: packages/domain must stay
 * platform/vendor independent — no expo-crypto import here).
 */
export interface DomainIdRandomSource {
  /** Returns a cryptographically secure random 32-bit unsigned integer. */
  nextUint32(): number;
}

let configuredGenerator: V7Generator | undefined;

/**
 * Explicit configuration seam for platforms where a secure RNG is not a
 * reliable ambient global. React Native/Hermes has no native
 * `crypto.getRandomValues` — rather than patch that in via a global
 * polyfill (fragile: an import that silently doesn't run early enough
 * leaves `Math.random`-quality "randomness" undetected), the platform
 * calls this once, explicitly, at startup, with a real secure RNG (see
 * apps/mobile's expo-crypto-backed adapter). Node/browser callers never
 * need to call this — see `generateDomainId()`.
 */
export function configureDomainIdGenerator(source: DomainIdRandomSource): void {
  configuredGenerator = new V7Generator(source);
}

function hasNativeWebCrypto(): boolean {
  return typeof globalThis.crypto?.getRandomValues === "function";
}

/**
 * Generates a UUIDv7 string. Never falls back to `Math.random()` and
 * never silently downgrades to UUIDv4 — if neither an explicitly
 * configured source nor a native Web Crypto global is available, this
 * throws loudly instead of returning a weaker ID.
 */
export function generateDomainId(): string {
  if (configuredGenerator !== undefined) {
    return configuredGenerator.generate().toString();
  }

  if (hasNativeWebCrypto()) {
    // uuidv7() reads the same native `globalThis.crypto.getRandomValues`
    // just checked above — a real, always-present global on Node 19+ and
    // in browsers, not a polyfill. This is the zero-config path for
    // apps/api, apps/worker, and apps/web.
    return uuidv7();
  }

  throw new Error(
    "No secure random source available for domain ID generation. On React " +
      "Native, call configureDomainIdGenerator() with a secure RNG (e.g. " +
      "expo-crypto) before generating any domain ID.",
  );
}
