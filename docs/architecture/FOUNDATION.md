# Vostivo — Foundation Architecture

This document describes the repository foundation established by Foundation
Bootstrap. It is intentionally scoped to structure and dependency direction
— not product design. See `adr/` for the reasoning behind each decision.

## Topology

```text
apps/mobile   Expo (React Native) — offline-first Active Workout client
apps/web      Next.js — public marketing site + future coach app
apps/api      NestJS + Fastify — modular monolith HTTP API
apps/worker   Node process — async jobs / future Training Intelligence

packages/domain            pure TS — EntityId, DomainError, Result, events
packages/training-engine   pure TS — deterministic decision engine boundary
packages/contracts         transport-neutral shared contract vocabulary
packages/database          PostgreSQL/Drizzle migration infrastructure
packages/config            typed, fail-fast environment validation
packages/observability     vendor-agnostic logging + correlation ids
packages/test-fixtures     shared deterministic test fixtures
```

## Dependency directions

```text
apps/*  ──depends on──>  packages/*
packages/domain             depends on nothing in this repo
packages/training-engine    depends on packages/domain only
packages/contracts          depends on nothing in this repo
packages/config             depends on nothing in this repo
packages/observability      depends on nothing in this repo
packages/database           depends on packages/config, packages/observability
packages/test-fixtures      depends on nothing in this repo
```

## Forbidden dependency directions (enforced, not just documented)

`packages/domain` and `packages/training-engine` must never import a
framework or vendor SDK — this is the hard rule that keeps the domain model
and the Training Engine reusable across mobile/web/api/worker and testable
without any of them running.

Enforced by `.dependency-cruiser.cjs` (run via `pnpm boundaries:check`):

```text
packages/domain            cannot import: @nestjs/*, next/*, react/*, react-native,
                            expo*, drizzle-orm, drizzle-kit, @supabase/*, pg, fastify
packages/training-engine   cannot import: (same forbidden list)
```

This is a lightweight, targeted mechanism (dependency-cruiser), not a
custom architecture-enforcement framework — see spec section 20/33.

## Local development infrastructure

- **Server DB**: PostgreSQL via `docker-compose.yml` at the repo root.
  `packages/database` holds schema source, `drizzle-kit` migration output
  (`packages/database/drizzle/`), and `pnpm db:generate` / `pnpm db:migrate`.
  No product schema exists yet — only a harmless `bootstrap_health_check`
  table proving the migration pipeline works end-to-end.
- **Mobile local DB**: `expo-sqlite` (SQLCipher-encrypted, see below) +
  Drizzle's `expo-sqlite` driver (`apps/mobile/src/local-database`).
  Migrations are applied by a small, hand-rolled, idempotent runner
  (`migrations.ts`) rather than drizzle-kit's generated Expo migration
  bundle — that pipeline depends on a Metro/babel inline-import step that
  could not be verified end-to-end on a real device/emulator in this
  environment. The ordering/idempotency logic is unit-tested directly;
  swap in drizzle-kit's runner once verified on-device.
- **pnpm + Expo/React Native**: `.npmrc` sets `node-linker=hoisted` and
  `shamefully-hoist=true` — React Native's autolinking expects to walk a
  conventional `node_modules` tree, which pnpm's default strict/symlinked
  layout breaks (this is Expo's own documented pnpm guidance).

## SQLCipher (encrypted local SQLite)

**Correction (Fix Pass 01):** an earlier version of this document incorrectly
stated that `expo-sqlite` has no SQLCipher support. That was wrong.
`expo-sqlite`'s own config plugin (`expo-sqlite/plugin`) vendors SQLCipher
source and exposes a first-party `useSQLCipher` option — no third-party
SQLite library or SQLCipher wrapper is needed.

```jsonc
// apps/mobile/app.json
"plugins": [
  "expo-router",
  ["expo-sqlite", { "useSQLCipher": true }],
  "expo-secure-store"
]
```

Confirmed for real, not just asserted: `expo config --type public` shows
the resolved plugin option, and running `expo prebuild --platform android`
writes `expo.sqlite.useSQLCipher=true` into the generated
`android/gradle.properties` — i.e. the flag genuinely reaches the native
build (verified, then the generated `android/` directory was removed again
since this project uses CNG and does not commit native folders).

**SQLCipher requires a native development/production build — Expo Go
cannot load it.** Expo Go is not a valid test environment for the encrypted
database; `apps/mobile/package.json`'s `android`/`ios` scripts already run
`expo run:android` / `expo run:ios` (a dev-client build) rather than
`expo start --android/--ios` (Expo Go), reflecting this.

### Key management

`apps/mobile/src/infrastructure/database-key.ts` generates a 256-bit random
key via `expo-crypto`'s `getRandomBytesAsync` on first run, persists it in
`expo-secure-store`, and reuses it thereafter. The key is never logged,
never placed in AsyncStorage or a source-controlled env file, and is
returned only to the local-database client that consumes it immediately.

### Initialization order (enforced by `apps/mobile/src/local-database/client.ts`)

```text
obtain/create key (SecureStore, or generate)
        ↓
open SQLite database
        ↓
apply PRAGMA key immediately (first statement on the connection)
        ↓
verify the key by forcing a real read (SELECT on sqlite_master)
        ↓
enable required PRAGMAs (foreign_keys)
        ↓
run local migrations
        ↓
expose the database to the application
```

`initializeLocalDatabase()` is the _only_ exported way to get a database
handle — there is no path that reaches a query before the key is applied
and verified.

### Unavoidable SQLCipher API constraint

SQLite PRAGMAs do not support bound `?` parameters, so `PRAGMA key` must be
built as inline SQL text rather than passed as a query parameter. This is
safe here specifically because the key is never user input — it is always
a 64-character lowercase-hex string this module generates itself, and
`assertValidKeyFormat()` defensively re-validates that shape before every
use (guards against a corrupted/tampered SecureStore value ever reaching
raw SQL, even though nothing in this flow currently accepts external
input). The key is applied via SQLCipher's raw-key form (`PRAGMA key =
"x'<hex>'"`) rather than as a passphrase, since it is already
high-entropy random material and does not need PBKDF2 stretching.

### Verification status

- **Expo config**: PASS — confirmed via `expo config --type public` and a
  real `expo prebuild --platform android` run showing
  `expo.sqlite.useSQLCipher=true` in the generated Gradle properties.
- **Native SQLCipher runtime verification**: **PASS**. Once disk space was
  freed up (145 GB available), a real native development build was run and
  verified on an **Android emulator (Pixel_7, API level matching Android
  SDK system image installed on the dev machine)** via
  `pnpm --filter @vostivo/mobile android`. Evidence captured (a temporary,
  since-removed diagnostic screen exercised the real
  `initializeLocalDatabase()` boundary — no key material was ever logged):
  - `PRAGMA cipher_version` returned `4.7.0 community` — a non-empty
    SQLCipher version, proving the app is linked against SQLCipher, not
    vanilla SQLite (vanilla SQLite has no such PRAGMA and returns empty).
  - Write + read of a verification record inside the encrypted database
    succeeded in the same session.
  - **Process-restart persistence**: the app was fully killed
    (`am force-stop`, not just backgrounded) and relaunched as a genuinely
    new OS process (different PID). `initializeLocalDatabase()` succeeded
    without throwing and the verification record written before the
    restart was read back intact — proving the correct key was retrieved
    from SecureStore and reused (an incorrect/newly-generated key would
    have failed the built-in `verifyEncryptedDatabaseOpens()` step with
    SQLITE_NOTADB before ever reaching the record).
  - **Wrong-key rejection**: an isolated, throwaway SQLCipher database
    (never the real app database or the real SecureStore key) was created
    with one key and reopened with a different one. The reopen failed
    with `Error code : file is not a database` — proving the database is
    genuinely encrypted, not merely "SQLCipher available but not
    enforcing anything."

This closes the gate from Foundation Fix Pass 01 (previously NOT RUN due
to disk space). The generated `android/` directory and the temporary
verification screen were removed afterward — this project uses CNG and
does not commit native folders or leave test-only code behind.

### Android application backup — disabled for V1 (locked decision)

**Decision**: `apps/mobile/app.json`'s `expo.android.allowBackup` is
`false` — Android's system-level Auto Backup for Apps never runs for
Vostivo. Set through Expo config (CNG source of truth), never a manual
generated-manifest edit.

**Why**: the canonical local database is SQLCipher-encrypted
(`useSQLCipher: true`, above) and its decryption key lives in
`expo-secure-store`, which is itself backed by the Android Keystore. A
Keystore-backed key does not travel with a standard Android app-data
backup in a way that is guaranteed to restore compatibly with the
encrypted database file it belongs to — a restored database paired with a
lost/regenerated key becomes permanently unreadable (`file is not a
database`, the same failure mode this document's wrong-key-rejection
test above deliberately proves). Disabling backup entirely removes that
failure mode by construction rather than attempting to reason about which
partial-restore states are safe.

**Recovery model for V1**: there is no local backup/restore path. Locally
unsynced workout state (drafts, a session mid-workout that has not yet
synced) is device-local only and does not survive an uninstall or device
replacement. Historical workout data that has already synced to the
server remains canonical and durable in Postgres regardless of what
happens to the device — it becomes available again once the athlete signs
in on a new/reinstalled device (once real mobile sign-in exists — see
`docs/architecture/IDENTITY-AUTH.md`'s "Mobile auth foundation"). Do not
claim reinstall/device-replacement recovery of *unsynced* local state
exists — it deliberately does not, for V1.

**Known limitation, accepted for V1**: an athlete who uninstalls the app
(or loses the device) with unsynced local workout data loses that specific
unsynced data. This is judged an acceptable, well-understood V1 trade-off
in exchange for never risking a silently unreadable restored database —
revisit only alongside a real encrypted-backup-with-key-migration design,
which is explicitly not V1 scope.

**Verified**: `expo config --type public` resolves `android.allowBackup:
false`; a temporary `expo prebuild --platform android` confirmed
`android:allowBackup="false"` genuinely reaches the generated
`AndroidManifest.xml` (the generated `android/` directory was removed
again immediately afterward, per this project's CNG strategy). iOS has no
equivalent setting in this document — Apple's iCloud/Finder backup
behavior for Keychain-backed items has not been verified on this Linux
machine (see the iOS gap noted in
`docs/audits/V1-ENGINEERING-SECURITY-BASELINE.md`).

## Known temporary technical debt: split ESLint major versions

Root and the backend packages/apps (`packages/*`, `apps/api`, `apps/worker`)
run **ESLint 10.9.1**. `apps/web` and `apps/mobile` are pinned to
**ESLint 9.39.5** instead.

**Why**: `eslint-config-next` and `eslint-config-expo` both transitively
depend on `eslint-plugin-react`, which crashes outright on ESLint 10
(confirmed by actually running it: `TypeError: contextOrFilename.getFilename
is not a function` — ESLint 10 removed the legacy `context.getFilename()`
API the plugin still calls). Backend packages don't pull in that plugin, so
they stay on current ESLint. Each app declares its own `eslint` version, and
pnpm's hoisted install correctly nests the divergent version per-app
(verified: `apps/web/node_modules/eslint` and `apps/mobile/node_modules/eslint`
resolve to 9.39.5, everything else resolves to 10.9.1 at the workspace
root — no unpredictable cross-workspace leakage).

**Status**: temporary technical debt, not a permanent architecture choice.
Revisit once `eslint-plugin-react` (or `eslint-config-next`/`eslint-config-expo`
themselves) ship ESLint 10 support upstream. `pnpm lint` at the root
reliably runs both configurations today — this has been re-verified after
every change in this fix pass.

## What Foundation Bootstrap deliberately does not include

See spec section 32 for the full list. In short: no product screens, no
workout domain, no Program/Progression Engine algorithms, no sync protocol,
no real Supabase auth flows, no full DB schema, no subscriptions/analytics
vendor integrations.
