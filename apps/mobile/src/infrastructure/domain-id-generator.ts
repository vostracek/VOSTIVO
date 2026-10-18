import * as Crypto from "expo-crypto";
import { configureDomainIdGenerator } from "@vostivo/domain";

/**
 * Wires packages/domain's injectable ID-generator seam to Expo's
 * cryptographically secure RNG (expo-crypto) — not a global
 * `crypto.getRandomValues` polyfill. Hermes has no native implementation
 * of that API, and a polyfill import can silently fail to run early
 * enough (or be shadowed), leaving weak randomness undetected. Explicit
 * configuration fails loudly instead if this is ever skipped.
 *
 * Uses `Crypto.getRandomValues` (the Web-Crypto-shaped sync API), not
 * `Crypto.getRandomBytes` — expo-crypto's own documentation states
 * `getRandomBytes` "falls back to Math.random during development to
 * prevent issues with React Native Debugger," which this task's
 * requirements explicitly forbid relying on. `getRandomValues` carries no
 * such caveat.
 *
 * Must run once, before any `createEntityId()` call — see app/_layout.tsx,
 * which calls this at module scope (i.e. on JS bundle load, before the
 * app tree mounts).
 */
export function installDomainIdGenerator(): void {
  configureDomainIdGenerator({
    nextUint32: () => {
      const bytes = Crypto.getRandomValues(new Uint8Array(4));
      return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    },
  });
}
