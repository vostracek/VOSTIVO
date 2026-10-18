# ADR-0006: UUIDv7 for Vostivo domain IDs

- **Status**: Accepted (superseding the mobile RNG strategy from this
  ADR's original version — see "Update" below)
- **Date**: 2026-09-03 (original); updated 2026-09-03

## Context

Foundation Bootstrap's `packages/domain` `createEntityId()` generated
UUIDv4 (via `node:crypto`'s `randomUUID()`). The Auth & Internal Identity
Foundation is the first slice to actually persist domain entities
(`User`, `AuthIdentity`, `AthleteProfile`) with primary keys, and the
approved architecture locks the ID strategy as UUIDv7 for all Vostivo
domain IDs — not UUIDv4, and never an auto-increment/sequence PK.

The original version of this ADR generated UUIDv7 via the `uuidv7`
package's top-level `uuidv7()` function, which reads randomness from the
ambient `globalThis.crypto.getRandomValues`. That works natively on Node
and in browsers, but **Hermes (React Native's JS engine) has no native
implementation of `crypto.getRandomValues`** — confirmed against current
Hermes behavior. At the time, `apps/mobile` did not generate any domain
IDs, so this was documented as a deferred gap. The Workout Data Integrity
vertical slice now requires stable, offline, client-generated UUIDv7 IDs
on mobile, making this a hard gate.

## Decision

Keep UUIDv7 and the `uuidv7` package (1.2.1) as the locked ID format and
implementation — but generate it through the package's lower-level,
**explicitly RNG-injectable** `V7Generator` class instead of its top-level
convenience function, and give `packages/domain` a small seam
(`configureDomainIdGenerator()`) for platforms to supply their own secure
RNG:

```text
packages/domain/src/id-generator.ts
  DomainIdRandomSource         { nextUint32(): number }  <- the only contract
  configureDomainIdGenerator() explicit registration, called once at startup
  generateDomainId()           uses the configured source if set;
                                otherwise auto-detects native Web Crypto
                                (Node/browser — a real global, not a
                                polyfill); otherwise throws
```

- **Server/web (`apps/api`, `apps/worker`, `apps/web`)**: unchanged, zero
  configuration — native Web Crypto is detected and used automatically.
- **Mobile (`apps/mobile`)**: calls `configureDomainIdGenerator()` once, at
  module load in `app/_layout.tsx` (before any screen mounts), with a
  source backed by `expo-crypto`'s `getRandomValues` — implemented in
  `apps/mobile/src/infrastructure/domain-id-generator.ts`, **not** inside
  `packages/domain`, which stays platform/vendor independent (no
  `expo-crypto` import there; `pnpm boundaries:check` still enforces this).

`createEntityId()` itself is unchanged at the call site — every existing
caller (`packages/domain`, `apps/api`'s identity resolution, etc.)
continues to work with zero changes.

### Why `expo-crypto`'s `getRandomValues`, not `getRandomBytes`

`expo-crypto`'s own documentation states `getRandomBytes` (the sync
byte-array API) "falls back to `Math.random` during development to
prevent issues with React Native Debugger." That is explicitly forbidden
by this task. `getRandomValues` (the Web-Crypto-shaped sync API) carries
no such documented fallback, so the mobile adapter uses that instead.

## Alternatives considered

- **A global `crypto.getRandomValues` polyfill** (e.g.
  `react-native-get-random-values`, imported once at the app entry point):
  rejected — explicitly ruled out by this task as "a fragile global crypto
  polyfill." An import that silently fails to run early enough, or gets
  tree-shaken/reordered, leaves the gap undetected until a real ID is
  generated with weak randomness; the injectable-source approach instead
  fails loudly if misconfigured.
- **UUIDv4 (status quo)**: rejected — explicitly locked against by this
  task; UUIDv7's time-ordered structure gives better index locality for
  append-heavy tables (which most of Vostivo's history-tracking tables
  will be) without the coordination cost of an auto-increment sequence.
- **Auto-increment integer PKs**: rejected — explicitly forbidden;
  sequence-based PKs leak row-count information, complicate
  client-generated IDs, and don't work well with UUIDv7's
  global-uniqueness properties needed for a sync architecture.
- **The general-purpose `uuid` npm package (v9+ supports v7)**: rejected
  in favor of the smaller, single-purpose `uuidv7` package — `uuid` bundles
  generation/parsing/validation for versions 1–8, which is unnecessary
  surface area for a project that only ever generates v7.
- **Hand-rolled UUIDv7 byte-packing**: rejected — `uuidv7`'s `V7Generator`
  already exposes exactly the RNG-injection seam needed
  (`{ nextUint32(): number }`), so there was no need to reimplement the
  timestamp/version/variant bit-packing ourselves.

## Consequences

- Server IDs and mobile IDs are produced by the _same_ library/algorithm
  (`uuidv7`'s `V7Generator`), just parameterized with different RNG
  sources — both are valid RFC UUIDv7 and store identically in
  PostgreSQL's `uuid` column type.
- `apps/mobile` must call `installDomainIdGenerator()` (or equivalent)
  before any code path that could call `createEntityId()`. Verified on a
  real Android emulator (Hermes) with a 2000-ID batch, with **network
  disabled** during generation and local SQLite insert/read — see
  `docs/architecture/IDENTITY-AUTH.md` for the captured evidence.
- If a future platform (e.g. a web extension, a different mobile runtime)
  also lacks native Web Crypto, it follows the same pattern: implement a
  small adapter satisfying `DomainIdRandomSource` in that platform's own
  app code, never inside `packages/domain`.
