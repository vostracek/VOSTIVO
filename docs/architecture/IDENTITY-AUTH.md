# Vostivo — Identity & Authentication Foundation

Scope: the identity/security boundary between an external Supabase login
and a Vostivo-internal actor. No product feature, no login UI, no
onboarding, no coach authorization — see `CLAUDE.md` for what this
foundation deliberately excludes and what comes next.

## External auth vs internal identity

Authentication answers _"who are you?"_; authorization later answers
_"are you allowed to do this?"_. These are never conflated here:

```text
Supabase-issued JWT
        |
        v
  JWT verification            <- packages/domain never sees this
        |
        v
VerifiedExternalPrincipal      (subject, issuer, audience, optional email)
        |
        v
AuthIdentity                   (provider + providerSubject, unique)
        |
        v
User                           (general account identity, status)
        |
        v
AthleteProfile                 (experienceMode, unitSystem)
        |
        v
AuthenticatedActor              (userId, athleteProfileId?) — attached to
                                 the request; downstream code never re-parses
                                 a JWT or trusts a client-supplied identity.
```

## Why email is not identity

A `User` is identified by `(provider, providerSubject)` via `AuthIdentity`
— never by email. Email can change, be reused across accounts over time,
or be entirely absent for some future auth provider. If Vostivo ever
stores email at all, it is optional metadata carried alongside the
canonical identity, never the join key.

## JWT verification

**Chosen approach**: `jose`'s `createRemoteJWKSet` + `jwtVerify` against
Supabase's per-project JWKS endpoint — Supabase's own documented
recommendation for asymmetric-signing projects (the default for projects
created since May 2025).

```text
JWKS endpoint : {SUPABASE_URL}/auth/v1/.well-known/jwks.json
issuer (iss)  : {SUPABASE_URL}/auth/v1
audience (aud): "authenticated"  (Supabase's fixed value for user tokens)
```

This needs **no shared secret at all** — the API only ever holds
Supabase's _public_ verification keys, fetched and cached by `jose`
itself. Nothing in `SupabaseJwtVerifier` is a credential.

Legacy HS256 (shared-secret) Supabase projects are explicitly out of
scope: Supabase's own guidance there is to verify against the Auth server
directly rather than locally, which is a different strategy this
foundation does not implement.

Sources consulted (current as of this task):
[Supabase JWT docs](https://supabase.com/docs/guides/auth/jwts),
[JWT Signing Keys](https://supabase.com/docs/guides/auth/signing-keys).

### What is verified

Signature (via JWKS), issuer, audience, and expiry (`jose` rejects an
expired token by default). A malformed token, an invalid signature, an
unexpected issuer/audience, or an expired token are all treated
identically by the API: a generic 401 via the existing safe error
envelope. Verification internals are never exposed to the client and
never logged — see `apps/api/src/auth/supabase-jwt-verifier.ts` and
`auth.guard.ts`.

## Identity resolution

`resolveOrCreateIdentity()` (`apps/api/src/auth/identity-resolution.ts`) is
the one deterministic, idempotent function that turns a verified external
subject into a Vostivo `User` + `AthleteProfile`:

1. Look for an existing `AuthIdentity` for `(provider, providerSubject)`.
2. If found, return its `User`/`AthleteProfile`.
3. If not, create `User` + `AuthIdentity` + `AthleteProfile` together in a
   single transaction.
4. If that transaction's `INSERT` into `auth_identities` hits the
   `UNIQUE(provider, provider_subject)` constraint (because a concurrent
   request just created it), catch that specific unique-violation and
   re-read what the other request created — never a bare
   "SELECT then INSERT" race.

Verified with a real concurrent-request test against local Postgres
(`identity-resolution.integration.test.ts`): two simultaneous first-time
resolutions for the same subject produce exactly one `User`, one
`AuthIdentity`, one `AthleteProfile`.

## User / AuthIdentity / AthleteProfile

Domain vocabulary lives in `packages/domain/src/identity/` (pure
TypeScript, no framework dependency — enforced by
`pnpm boundaries:check`). Server persistence lives in
`packages/database/src/schema/identity.ts`, in a dedicated `app` Postgres
schema (`app.users`, `app.auth_identities`, `app.athlete_profiles`).

- **`User`**: general account identity — `id`, `status`, timestamps.
  `status` is `ACTIVE | DELETION_PENDING | SUSPENDED | DELETED`; only
  `ACTIVE` is currently treated as usable
  (`isUsableAccountStatus()`) — the enforcement boundary exists, but
  deletion/suspension _processing_ is not implemented yet.
- **`AuthIdentity`**: the external-identity join — `userId`, `provider`,
  `providerSubject`, unique on `(provider, providerSubject)`.
- **`AthleteProfile`**: minimal profile foundation — `userId` (unique: one
  profile per user in this foundation), `experienceMode`
  (`GUIDED | ADAPTIVE | EXPERT` — **not** `COACHED`, see below),
  `unitSystem` (`METRIC | IMPERIAL`, matching
  `docs/domain/load-model-v1.md` section 96).

### Why `COACHED` is not a persisted experience mode

A locked correction from this task: coached experience is _derived_ from
an active `CoachingRelationship` (a future concept), not stored as a
fourth base mode. Storing `COACHED` directly would let the stored mode
and the actual coaching relationship disagree — e.g. a mode still reading
`COACHED` after a coaching relationship ends. Deriving it keeps the two
facts from ever diverging.

### Why `User` stays general-purpose

`User` is account identity, not "athlete." A future coach, or any other
account type, is a `User` first — role-specific data (`AthleteProfile`
today, a future `CoachProfile`) attaches to a `User` rather than replacing
it. `AuthenticatedActor.athleteProfileId` is optional for exactly this
reason.

## Domain IDs: UUIDv7

All domain entity IDs (`User`, `AuthIdentity`, `AthleteProfile`, and every
future entity) are UUIDv7, generated by the single boundary
`createEntityId()` in `packages/domain/src/entity-id.ts` (via the `uuidv7`
package's RNG-injectable `V7Generator`). Server/web apps need no
configuration (native Web Crypto auto-detected). Mobile explicitly wires
an `expo-crypto`-backed random source at startup
(`apps/mobile/src/infrastructure/domain-id-generator.ts`, called from
`app/_layout.tsx`) — not a global `crypto.getRandomValues` polyfill, and
never `Math.random()`. `packages/domain` never imports `expo-crypto`; it
only depends on a one-method interface (`{ nextUint32(): number }`),
enforced by `pnpm boundaries:check`. Full reasoning: ADR-0006.

**Verified on a real Android emulator (Hermes), network disabled**: a
2000-ID batch generated through the real `createEntityId()` boundary —
every ID matched the UUIDv7 shape (version nibble `7`), all 2000 were
unique, and all 2000 round-tripped correctly through an insert/read into
the real encrypted local SQLite database. Sample IDs captured:
`01a064aa-9f67-7061-9727-9179807e5944`,
`01a064aa-9f67-7061-9727-917a76a41930`.

## Request actor

`AuthGuard` is the only place a JWT is parsed and an identity resolved.
It attaches a minimal `AuthenticatedActor { userId, athleteProfileId? }`
to the Fastify request; `@CurrentActor()` reads it back in controllers.
No fabricated fields (`isAdmin`, `isCoach`, `isPro`) exist on this type —
they would have to be derived from real domain state that doesn't exist
yet.

## `GET /api/v1/me`

Proves the full chain end to end. Uses an explicit `MeResponse` DTO
(`packages/contracts`) — never a serialized database row (a locked
Vostivo principle: database table != API contract). Verified against a
**real** local JWKS HTTP server and **real** local Postgres (not just
mocked tests) — see the final task report for the exact request/response
evidence captured.

```json
{
  "userId": "01a0649a-5edb-7a51-a04d-bf1512265252",
  "status": "ACTIVE",
  "athleteProfileId": "01a0649a-5edc-7980-9284-474b9faf13f7",
  "experienceMode": "GUIDED",
  "unitSystem": "METRIC"
}
```

## Mobile sign-in and session lifecycle (Auth Slice C)

Supabase is the identity provider only — the app never reads or writes data
through Supabase (the project's Data API is disabled); athlete data goes
exclusively through the Vostivo API, authenticated by the Supabase access
token and verified here via JWKS (no API-side code change was needed for
real cloud tokens: set `SUPABASE_URL=https://<ref>.supabase.co` and leave
`LOCAL_JWKS_PATH` unset; the project must use asymmetric signing keys).

- Config (`apps/mobile/src/infrastructure/supabase-config.ts`):
  `EXPO_PUBLIC_SUPABASE_URL` + `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (the
  `EXPO_PUBLIC_` prefix is what Expo bundles; everything else is stripped).
  A secret (`sb_secret_...`) or service_role key is refused at startup; the
  old `EXPO_PUBLIC_SUPABASE_ANON_KEY` is gone.
- Login: email + 6-digit OTP only (`apps/mobile/src/auth/`).
- Session persistence: chunked, manifest-switched expo-secure-store
  storage — never AsyncStorage; corrupt/incomplete data fails closed.
- `providerSubject` (Supabase `user.id`) is only a lookup key; the internal
  `userId` comes from an authenticated `GET /api/v1/me` (IdentityGate).
- 401: one single-flight refresh, one retry, then re-auth. An invalid
  session never closes the open owner's runtime (an Active Workout keeps
  working locally; sync pauses until the same owner re-authenticates).
- Sync runs only while the owner is verified online with a valid session.
- Same-owner re-auth (REAUTH_REQUIRED -> VALID) re-runs Today's load; a
  request made while no session exists reports "Sign in again to load your
  latest training." — never the owner-mismatch error. Human acceptance
  passed 2026-10-26 (spec §27.8).

Full design, states and evidence:
`docs/domain/AUTH-LOCAL-ATHLETE-BOUNDARY-V1.md` §26 (Slice B) and §27
(Slice C).

## Future authorization relationship

This foundation stops at "who are you, and is your account usable." It
deliberately does not introduce `CoachProfile`, `CoachingRelationship`, or
any permission model — those arrive with the Coach slice. What is locked
now: `User` stays general-purpose, `AuthenticatedActor` carries no
fabricated permissions, and any future authorization check is a separate,
explicit decision made against real domain state — never inferred from
authentication success or from client-supplied claims.
