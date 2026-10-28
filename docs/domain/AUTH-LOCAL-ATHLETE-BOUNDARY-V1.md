# Vostivo — Auth & Local Athlete Boundary V1

**Status:** Phase 0 reconciliation COMPLETE; architecture decisions
APPROVED by tech lead (2026-10-19, §23). Slices renumbered (§21). Slice A —
Server Receipt Ownership Hardening: CLOSED / tech-lead approved
(2026-10-19, §24; repo-wide idempotency closure audit §25). Slice B — Local
Athlete Storage + IdentityGate: CLOSED / tech-lead approved
(2026-10-20, §26). Slice C — Supabase Auth + Session Lifecycle:
CLOSED / tech-lead approved (2026-10-26, §27; human acceptance A-F + R
passed).
Slices D–E: not started.

**Answers:** *"Whose workout is this phone showing, and who is it syncing
as?"* — always exactly the authenticated athlete's, and nothing else.

**Locked principles (from the phase brief):** local workout data belongs
to an athlete identity; an athlete never sees or resumes another athlete's
local session; sign-out / account switch never silently destroys unsynced
work; offline-first logging stays valid; server authority and the local
device authority during an active workout keep their existing roles;
recovery never repeats onboarding for a known athlete; every auth failure
has a recovery path (no "retry forever"); no multi-account UX — only safe
identity transitions.

---

## 1. Current auth architecture (as built, 2026-10-19)

| Concern | Reality | Code |
|---|---|---|
| How mobile obtains identity | It does not. Mobile only has a bearer token; it never learns or stores `userId`. | `apps/mobile/src/workout/auth-token-provider.ts` |
| Token source | Build-time `EXPO_PUBLIC_DEV_JWT` → `StaticTestAuthTokenProvider` (non-production env only); otherwise `DeferredSupabaseAuthTokenProvider`, which always rejects. | `apps/mobile/src/infrastructure/plan-runtime-config.ts` (`createPlanAuthTokenProvider`) |
| Token storage | Inlined into the JS bundle by Metro/Expo from `apps/mobile/.env`. Nothing in SecureStore (SecureStore holds only the DB key). | `.env`, `secure-store.ts`, `database-key.ts` |
| Supabase client | None. No `@supabase/supabase-js` dependency; `supabase-config.ts` only reads two `EXPO_PUBLIC_SUPABASE_*` vars, consumed by nothing. No Supabase project or provider configuration exists in the repo. | `apps/mobile/package.json`, `supabase-config.ts` |
| Refresh | None. Dev tokens are minted with a 24 h TTL (`auth:local:mint-jwt`). | `apps/api/src/dev/mint-local-dev-jwt.ts` |
| On expiry / 401 — reads | `FetchPlanApiClient` throws `PlanApiRequestFailure("Plan API request failed: 401")`; Today shows "Could not load today" + **the raw message** + Retry; Plan shows the same with Retry. Retry repeats the same expired token → dead end. | `plan-api-client.ts:54,65`, `app/index.tsx` hero `error`, `app/plan.tsx` `ErrorState` |
| On expiry / 401 — sync | `FetchWorkoutSyncApiClient` throws a plain `Error` (not `TransientSyncFailure`) → `SyncEngine` marks every command `RETRY` and rethrows → `WorkoutSyncCoordinator` treats it as retryable → **2/5/10/30 s backoff forever**. Data is safe, but the loop never ends and nothing tells the athlete. | `workout-sync-api-client.ts`, `sync-engine.ts`, `workout-sync-coordinator.ts` |
| App relaunch | Module-level singletons are rebuilt; the same bundled token is used; `RootLayout` immediately calls `requestSync("launch")`; Today reads the local active session and the server Plan in parallel. | `app/_layout.tsx`, `src/plan/plan-runtime.ts`, `app/index.tsx` |
| Token subject changes | Nothing on the device notices. The same `vostivo.db`, same outbox, same active session; only the `Authorization` header changes. | — |
| Server | `AuthGuard`: bearer → `SupabaseJwtVerifier` (jose, JWKS, issuer + `aud=authenticated`) → `resolveOrCreateIdentity("supabase", sub)` (creates `User` + `AuthIdentity` + `AthleteProfile` GUIDED/METRIC on first sight) → `request.actor = {userId, athleteProfileId}`. Any verification failure = generic 401. Local dev uses the same verifier with a local JWKS (`LOCAL_JWKS_PATH`, `NODE_ENV=local` only). | `apps/api/src/auth/*` |
| `GET /api/v1/me` | Returns `{userId, status, athleteProfileId, experienceMode, unitSystem, trainingTimeZone}`. There is **no** `/me/bootstrap` endpoint — creation is implicit in the guard on any authenticated call. | `apps/api/src/me/*` |

## 2. Current local DB ownership reality

- One file, `vostivo.db`, one SecureStore key
  (`vostivo.local-db-encryption-key`), opened once per process by
  `initializeLocalDatabase()` (`apps/mobile/src/local-database/client.ts`).
- Tables: `local_workout_sessions`, `local_performed_exercises`,
  `local_performed_sets`, `sync_outbox`, `local_set_drafts`,
  `local_rest_timer_state`, `bootstrap_health_check`, `__local_migrations`
  (`schema.ts`, migrations 0000–0012).
- **No row and no table stores `userId`, `athleteProfileId` or provider
  subject.** There is no metadata/owner table. The database as a whole has
  no owner.
- `readActiveSession()` = `WHERE status='ACTIVE' ORDER BY created_at DESC
  LIMIT 1` — unscoped.
- `getPendingCommands()` = every `PENDING/RETRY/SYNCING` row — unscoped.
  `payload_json` is the wire command, which carries no owner either.
- `getPreviousExercisePerformance()` (Active Workout "PREV") = latest local
  exercise row for an `exerciseRef` — unscoped.
- Drafts and rest timer hang off the session id — unscoped by inheritance.
- Changing the JWT subject changes no local state. Every old row stays
  visible to every later identity.
- SQLCipher key: device-level, identity-independent.

## 3. Root cause of the cross-athlete Resume (read-only reproduction)

Evidence: Progress & Feedback V1 Slice E (2026-10-19) — the AVDs
`Vostivo_Light` and `Pixel_7_Vostivo_Clean`, booted with the token of the
fresh `progress-e2e-1792424330` athlete, showed **Resume Workout** from a
local ACTIVE session created earlier under other test identities. Those
AVDs were deliberately left untouched; a new AVD was used instead. No new
reproduction was needed — the call chain is fully determined by code:

```text
build/bundle with EXPO_PUBLIC_DEV_JWT = token(B)
app/_layout.tsx  RootLayout mount
  ├─ requestSync("launch") ─► SyncEngine.getPendingCommands()  (ALL rows, A's included)
  │                          └─► POST /sync/workout-commands  Authorization: Bearer token(B)
  └─ Stack → app/index.tsx (Today)
       ├─ initializeLocalDatabase()            (vostivo.db, no owner)
       ├─ getPlanApplicationService().getActiveWorkoutSession()
       │    └─ WorkoutRepository.readActiveSession()   WHERE status='ACTIVE' (A's row)
       │         → setHasActiveSessionAnywhere(true)
       ├─ getCurrentPlan()  → B's server plan (correct)
       └─ deriveTodayHeroState({hasActiveSessionAnywhere:true, …})
            → { kind: "resume" }   ← checked FIRST, before any identity or overview
               → "Resume Workout" → /active-workout → A's prescription, A's sets,
                 A's drafts, A's "PREV" values, B logging INTO A's session
```

Resume intentionally ignores the network (offline-first), and nothing
between the token and the local query knows who owns the row.

### 3.1 Additional consequences found during reconciliation (not observed, derived from code)

1. **A's outbox is submitted under B's token on launch** (above). Server
   outcomes:
   - A's *planned* START → `resolveStartProvenance` sees a foreign planned
     workout → `REJECTED`.
   - A's *unplanned* START → **accepted and created as B's session**
     (unplanned provenance has nothing to own-check) — A's reality
     misattributed to B.
   - A's COMPLETE_SET/REOPEN/FINISH against a session B does not own →
     `REJECTED` (BOLA holds — no foreign mutation is applied).
2. **Receipt poisoning (server).** `workout_command_receipts.command_id`
   is a global primary key and `findReceipt()` looks it up **without the
   actor**. A rejected attempt by B stores `REJECTED` under A's
   `commandId`; when A later syncs the same command legitimately, the
   server replays the stored `REJECTED`. The client marks it terminal. A's
   real workout never reaches canonical history — **SEV-0 data-loss path**
   (local rows survive, server never gets them). Conversely, B replaying a
   command A already applied gets `DUPLICATE` (a minor cross-tenant
   outcome oracle). BOLA itself is not broken — no foreign data is read or
   mutated — but idempotency is not owner-scoped.
3. B's Active Workout would show A's previous performance ("PREV") —
   local history leak independent of Resume.
4. Per-process caches in `plan-runtime.ts` (e.g. the training-time-zone
   bootstrapper's single run) are identity-unaware.

Read-only check of `vostivo_manual` (2026-10-19): receipts are 8 START +
24 COMPLETE_SET + 6 FINISH `APPLIED` and 1 `REJECTED` COMPLETE_SET bound
to an owned session (the earlier Finish causal-boundary smoke test). **No
cross-identity poisoning has happened in the dev data** — the risk is
latent, not realized.

## 4. Identity key — DECISION PROPOSED: internal `userId`

| Candidate | Stable across refresh | Server-authoritative | Early at startup | Not email | Survives recovery | Fits local ownership | Not UI-constructed |
|---|---|---|---|---|---|---|---|
| provider subject (`sub`) | yes | external, provider-scoped | yes (in token) | yes | only while the same provider identity is used | no — one Vostivo user may later have several `AuthIdentity` rows | yes |
| **`userId`** | **yes** | **yes — every workout row, receipt and BOLA check is keyed by it** | **after one verified `GET /me`, then cached** | **yes** | **yes** | **yes** | **yes** |
| `athleteProfileId` | yes | yes | same as userId | yes | yes | athlete-specific; `workout_sessions` are owned by `user_id`, not profile | yes |

**Recommendation: `userId`.** It is exactly the key the server uses to own
workout sessions, receipts and claims (`workout_sessions.user_id`,
`AuthenticatedActor.userId`), so local and server ownership are the same
predicate. `athleteProfileId` is carried alongside for display/context but
never used as the ownership key (User stays general identity; coach
identity is a separate future concern and never owns athlete-local data).

"Available early enough": `userId` is learned from a **verified**
`GET /me` and persisted in an **identity binding** (SecureStore):
`{provider, providerSubject, userId, athleteProfileId, verifiedAt}`. On an
offline cold start the stored token's `sub` is used **only as a lookup hint**
into that binding (never as authorization — the server still verifies every
request). An unknown `sub` with no network → no local data is shown (§5).

## 5. Startup ordering — PROPOSED

```text
module load: installDomainIdGenerator()
RootLayout renders <IdentityGate> — NOTHING below it mounts yet
  1. load auth session (SecureStore: Supabase session, or the dev token in non-prod)
       none ─────────────────────────────► SIGNED_OUT  → Sign-in screen
  2. online?  GET /me (one refresh+retry on 401)
       ok ─► verified userId; upsert binding
       401 after refresh ─────────────────► REAUTH_REQUIRED → Sign-in (same-athlete hint)
       offline/5xx ─► binding lookup by token sub (hint)
                        known ─► userId (OFFLINE_OWNER)
                        unknown ───────────► NEEDS_NETWORK → "Connect to finish signing in"
  3. open owner store for userId (per-owner encrypted DB, §6) → migrations
       open fails (key/file) ──────────────► LOCAL_DATA_UNAVAILABLE (never wipes)
  4. build the owner-scoped runtime container (repository, SyncEngine bound
     to userId, coordinator, API clients, bootstrappers)
  5. READY(userId): mount <Stack key={userId}> and start sync recovery for
     THIS container only
identity changes (sign-out, re-auth as someone else, dev token switch):
  stop coordinator + lifecycle subscriptions → dispose container → close DB
  handle → unmount Stack (key change) → back to step 1
```

Why this removes the leak and the flicker: Today/Plan/Active Workout cannot
render before step 5, the local DB they can reach is the owner's file only,
and `key={userId}` throws away every in-memory screen state of the previous
identity. Resume remains offline-capable: step 2's offline branch reaches
READY without the network for a known athlete.

## 6. Local ownership model — DECISION PROPOSED: one encrypted DB per athlete (option A)

| Option | Isolation | Change surface | Unsynced A + B signs in | Failure modes |
|---|---|---|---|---|
| **A. One DB file per `userId`** (`vostivo-athlete-<userId>.db`) | **by construction** — every existing query is automatically owner-scoped | client.ts (open by owner), composition root becomes owner-scoped, gate; **zero changes to repository SQL or table schema** | A's file untouched, B gets a fresh file | many files over time (cleanup policy later); a lost per-owner key makes one file unreadable (quarantine, never wipe) |
| B. `owner_user_id` on every table | by discipline — every query (active session, outbox, PREV, drafts, timer, future tables) must remember the filter | every repository query + 6 table migrations + legacy backfill | works | one missed `WHERE` re-opens the leak; legacy rows have no provable owner to backfill |
| C. One DB + single owner metadata row | by blocking | small | B must be **blocked** until A syncs or signs back in, or A's data deleted — violates principle 3 / brief §7 | blocked device; pressure to "just clear it" |

**Recommendation: A.** It is not the most complex option — it is the
smallest one that is safe, because the repository already takes an injected
`openDatabase` provider (`WorkoutRepository` constructor), so owner scoping
is a composition change, not a query rewrite. The single-user-phone
assumption still holds (only one owner store is open at a time); option A
simply never has to destroy or hide one athlete's data to admit another.
Outbox, crash recovery, drafts, rest timer and PREV keep their exact
existing semantics inside each file. Coach identity is unaffected (coach is
web, never owns athlete-local data).

Migration complexity: no table migration. New files start at migration
0000 via the existing runner. Legacy `vostivo.db` handled in §15.

## 7. Unsynced work during sign-out / account switch

Safe V1 behavior (all guaranteed by option A + the sync guard):

- A's data stays in A's file, unread and unsynced while A is not the
  authenticated identity. Nothing is deleted, rewritten or re-owned.
- B gets an empty owner store and normal startup.
- A signing back in reopens A's file: Resume returns, pending commands sync
  **as A**.
- A's commands are never sent with B's token (§8): structurally (B's
  runtime cannot reach A's file) and by an explicit guard.

Not achievable without larger work, stated plainly: A's unsynced work only
syncs when A signs back in on **this** device. There is no cross-device
hand-off of unsynced local data (and none is proposed for V1).

## 8. Sync identity binding

Today the server derives ownership **only** from the JWT
(`WorkoutSyncController` → `actor.userId`); commands carry no owner. That
is correct for authorization and must stay. Proposed additions:

1. **Client guard (required).** `SyncEngine` is constructed with
   `ownerUserId`. The token provider becomes identity-bound:
   `getAccessTokenFor(ownerUserId)` returns a token only if the current
   verified session's `userId` equals `ownerUserId`; otherwise it throws
   `OwnerMismatch` → the engine sends nothing, leaves rows PENDING (no
   attempt counted) and reports `AUTH_OWNER_MISMATCH` to the coordinator,
   which pauses (no backoff loop) until the identity changes.
2. **Server hardening (recommended — decision D-4).**
   - Owner-scoped idempotency: `findReceipt` must match `(commandId,
     userId)`. A receipt owned by another user → `REJECTED` **without
     persisting anything**, and the stored outcome is never revealed.
   - Rejections caused by ownership (BOLA, foreign planned provenance) are
     returned statelessly — no receipt row — so a foreign attempt can never
     occupy a legitimate owner's `commandId`.
   - Optional additive wire field `SyncWorkoutCommandsRequest.ownerUserId`
     (the client's local owner): mismatch with the actor → 409
     `SYNC_OWNER_MISMATCH` for the whole batch, nothing persisted. This
     turns the client invariant into a server-checked one and closes the
     unplanned-START misattribution even for a buggy client.
   - BOLA stays exactly as is; nothing is weakened.

## 9. Active workout ownership

- Same athlete returns → owner file reopened → `readActiveSession()` →
  Resume (unchanged code).
- Different athlete → different file → no Resume, no PREV, no drafts from A.
- A later → Resume returns with every set, draft and rest timer intact.
- One-active-workout invariant becomes **per owner** (it was only ever a
  single-device guard; the server never enforced it). A having an ACTIVE
  local session does not stop B from starting B's own. No transition step
  ever creates, copies or finishes a session.

## 10. Logout

Current reality: **no logout exists** (no UI, no API, no token to revoke).

Minimal V1 behavior:

1. Entry point: a minimal Account surface (identity line + Sign out) —
   placement is decision D-7 (recommended: the currently inert Profile tab
   opens a one-screen Account view; full Profile stays a later phase).
2. On tap: count the owner's unsynced work (outbox `PENDING/RETRY/SYNCING`
   + ACTIVE session). If zero → sign out. If non-zero → try one sync pass
   (bounded, e.g. 10 s); if work remains, a calm confirmation:
   > **Your workout hasn't synced yet.**
   > It stays safely on this phone and finishes syncing the next time you
   > sign in.
   > [Stay signed in] [Sign out]
3. Sign out: stop the coordinator → dispose the owner container → close
   the DB handle → `supabase.auth.signOut()` (revoke refresh token when
   online; local session cleared regardless) → keep the identity binding
   map (so the same athlete is recognized again) → route to Sign-in.
4. Never wipes workout data. No "delete local data" option in V1.

## 11. Expired token / 401 recovery

```text
any API call or sync → 401
  → one refreshSession() (single-flight, shared by all callers)
     ok → retry the original request once
     fail (invalid/revoked refresh token, or dev token expired)
        → auth state REAUTH_REQUIRED
           - workout sync pauses (coordinator state AUTH_PAUSED: no backoff loop)
           - Active Workout keeps logging locally, uninterrupted; a quiet line
             "Sign in again to sync" — never a modal mid-set
           - Today/Plan/Progress → Sign-in screen with "Your session expired.
             Sign in to continue — your workout is saved on this phone."
        → re-auth resolves SAME userId → same owner store, Resume intact,
          coordinator resumes, outbox drains as that athlete
        → re-auth resolves a DIFFERENT userId → normal identity transition (§5);
          the previous owner's data stays isolated
```

Network failure and 5xx stay transient (unchanged). Only 401-after-refresh
moves to REAUTH_REQUIRED. Raw messages (`Plan API request failed: 401`)
are never shown; typed failures map to copy.

## 12. Sign-in reality

- **Implemented:** server-side Supabase JWT verification (JWKS, issuer,
  audience) and identity resolution.
- **Not implemented / not configured:** any Supabase project for Vostivo,
  `@supabase/supabase-js`, session persistence, refresh, any sign-in
  screen, any provider (email/password, magic link, OTP, Apple, Google).
  `.env.example` holds placeholders only.
- Dev: `EXPO_PUBLIC_DEV_JWT` (build-time, one identity per bundle).

Sign-in method is therefore an open product/security decision (D-2). Not
invented here; for the tech lead's evaluation: email one-time code (Supabase
`signInWithOtp` + `verifyOtp`) needs no deep-link callback handling and no
password storage, and offering no third-party social login avoids the App
Store "Sign in with Apple" requirement for V1. Whatever is chosen must keep
`(provider, providerSubject)` stable for a returning athlete (Supabase links
identities with the same verified email into one auth user → same `sub`).

Minimum sign-in UI: one screen (method per D-2), error states with a real
next action (resend code / try again / check connection), and the
REAUTH_REQUIRED variant of copy.

## 13. New vs returning athlete

- There is no `/me/bootstrap`; `GET /me` (via `AuthGuard` →
  `resolveOrCreateIdentity`) creates `User` + `AuthIdentity` +
  `AthleteProfile` (GUIDED, METRIC) on first sight, idempotently and
  race-safely.
- **Known identity** → the same rows → server profile, plan, history and
  progression restored; local owner store reattached by `userId`. No
  onboarding is repeated (none exists yet).
- **New identity** → fresh profile → Today "no plan" state, training time
  zone bootstrap as today. Onboarding/plan creation is a separate later
  phase; this phase only needs a future additive `/me` signal (e.g.
  `onboardingState`) and does not define it.

## 14. Local encryption

Current key: one device key, identity-independent. Proposal (no
cryptographic redesign): same mechanism, **one key per owner store** —
`vostivo.local-db-encryption-key.<userId>` generated by the existing
`getOrCreateDatabaseKey` logic. Benefit: removing one athlete's local data
later can be a crypto-erase of one key without touching another's. The key
is still never logged. A missing/invalid key for an existing file is
`LOCAL_DATA_UNAVAILABLE` (quarantine + support path), never an automatic
wipe — today the same situation throws at startup.

Separate but required by Slice C: the Supabase session (access + refresh
token) must live in SecureStore. Its value can exceed SecureStore's
practical per-item size on some platforms; the storage adapter design
(chunking, or a SecureStore-held key encrypting an AsyncStorage blob — the
pattern Supabase documents) is decision D-3.

## 15. Legacy local-data migration

Existing installs have `vostivo.db` with no owner, and no existing server
endpoint can **prove** who created it: commands carry no owner, and
`findReceipt` is not owner-scoped, so replaying a synced command returns
`DUPLICATE` to anyone.

Proposed rule (fail-safe):
- `vostivo.db` is never opened as an owner store and never auto-bound.
- On first launch of the new build it is **quarantined in place**
  (untouched file, untouched key; a `legacy-quarantined` marker in
  SecureStore). Not shown, not synced, not deleted.
- Binding requires proof; without proof, do not guess. Two options for
  D-6:
  1. **Quarantine only (recommended).** All existing installs are dev/test
     installs with dev JWTs (no sign-in was ever shipped). A dev-only
     script can inspect/export a quarantined file. Zero production
     surface.
  2. Proof-based binding: a read-only owner-scoped endpoint returning which
     of a list of session ids the actor owns; bind only if **every** legacy
     session is server-owned by the actor **and** nothing unprovable is
     pending; otherwise stay quarantined.

## 16. Dev / test auth

- The dev token goes through the same `AuthSession` abstraction as a real
  session: identity is always resolved by `GET /me`, never assumed from the
  token. Switching `EXPO_PUBLIC_DEV_JWT` between subjects therefore yields a
  different `userId` → a different owner store → no leak.
- Fail-closed rules stay: dev tokens only when `EXPO_PUBLIC_VOSTIVO_ENV` is
  non-production; production with a dev token still refuses to boot.
- Dev token expiry → REAUTH_REQUIRED (a dev-only hint "mint a new token"),
  not a retry loop.
- Human acceptance needs A → B → A on one device without a rebuild:
  decision D-8 — recommended a non-production-only dev identity picker fed
  by `EXPO_PUBLIC_DEV_JWTS` (labelled list), compiled behind the same
  environment gate. No server bypass; tokens remain real ES256 JWTs.

## 17. Profile relationship

This phase only needs: the signed-in identity line and Sign out (§10).
Profile settings stay out of scope; after this phase closes, Profile is a
safe next product phase.

## 18. Threat / failure model — expected V1 behavior

| # | Case | Expected V1 behavior |
|---|---|---|
| A | Token changes while app running | Auth layer emits identity-changed → gate re-resolves via `GET /me`; same `userId` → no-op; different → full transition (stop sync, dispose, remount). Until resolved, no sync is sent (owner guard). |
| B | Token changes while app closed | Startup resolves identity before mounting anything (§5); the new owner store is opened; the old one is never read. |
| C | Token expires during active workout | Logging continues locally; sync AUTH_PAUSED; quiet "Sign in again to sync"; after same-athlete re-auth, outbox drains. Never discards data. |
| D | Network lost during active workout | Unchanged offline-first behavior; transient retries; identity cached via binding. |
| E | Logout with unsynced commands | Bounded sync attempt → calm warning → sign-out keeps data in A's store; syncs on A's next sign-in. |
| F | B signs in after A on the same phone | B gets an empty store: no Resume, no PREV, no drafts; A's outbox never sent. |
| G | A signs back in | A's store reopened: Resume, sets, drafts, rest timer intact; outbox syncs as A. |
| H | Reinstall / local DB lost | Synced history is server-canonical and returns; unsynced local work is lost (Android backup is deliberately disabled — accepted, documented risk; not changed here). |
| I | Server rejects stale/foreign command | BOLA unchanged; with D-4, foreign rejections are stateless and receipts owner-scoped, so a foreign attempt can never poison the owner's later replay. |
| J | Crash during identity transition | Transition has no destructive step: worst case a key or an empty owner file exists; relaunch re-runs the gate from step 1. Binding is written only after a verified `/me`. |
| K | Duplicate sign-in callbacks | Identity transition is single-flight; binding upsert is idempotent; a second callback for the same `userId` is a no-op. |
| L | Same-user token refresh | Same `sub` → same `userId` → nothing changes; in-flight sync continues with the new token. |
| M | Legacy unowned data present | Quarantined (§15); never shown, synced or deleted. |
| N | Owner store cannot be opened (key lost / file corrupt) | LOCAL_DATA_UNAVAILABLE with a support path; never wiped automatically. |

## 19. Security invariants (for tests)

- **AUTH-LOCAL-001** Authenticated athlete B never receives athlete A's local active session (no Resume, no session read).
- **AUTH-LOCAL-002** An A-owned outbox command is never submitted under B's authentication.
- **AUTH-LOCAL-003** A token refresh for the same identity does not orphan, hide or re-own local workout data.
- **AUTH-LOCAL-004** Sign-out does not silently destroy unsynced A data.
- **AUTH-LOCAL-005** Re-authenticating as A restores A's resumable workout with every set.
- **AUTH-LOCAL-006** The server continues to reject foreign workout commands via BOLA.
- **AUTH-LOCAL-007** No local workout data (session, PREV, draft, rest timer) is readable before the identity gate reaches READY.
- **AUTH-LOCAL-008** A foreign attempt with A's `commandId` never changes the outcome A's own later submission receives (owner-scoped idempotency; D-4).
- **AUTH-LOCAL-009** Identity transition never deletes, rewrites or re-owns local workout rows.
- **AUTH-LOCAL-010** 401 never produces an unbounded retry loop: after one failed refresh, sync pauses until identity changes.
- **AUTH-LOCAL-011** Legacy unowned local data is never auto-bound without proof.
- **AUTH-LOCAL-012** Previous performance ("PREV") only ever comes from the current owner's data.
- **AUTH-LOCAL-013** The identity binding (`sub → userId`) is only written from a verified `GET /me`.
- **AUTH-LOCAL-014** Production builds still refuse a dev token and have no auth bypass.
- **AUTH-RECEIPT-001** Receipt lookup is keyed by authenticated `userId` + `commandId` (Slice A).
- **AUTH-RECEIPT-002** Two users may independently use the same `commandId` (Slice A).
- **AUTH-RECEIPT-003** A receipt from user A is never returned to user B (Slice A).
- **AUTH-RECEIPT-004** A foreign/BOLA rejection by B cannot poison A's later legitimate command (Slice A).
- **AUTH-RECEIPT-005** Same-owner retries remain idempotent under concurrency (Slice A).

## 20. Test strategy

- **Unit:** identity gate state machine (every §18 row), binding store,
  owner-bound token provider, `SyncEngine` owner guard (mismatch → no
  request, no attempt counted), coordinator AUTH_PAUSED, 401→refresh→retry
  single-flight, logout unsynced-work decision, error-copy mapping.
- **Local SQLite (real SQLite, existing `node:sqlite` harness):** two owner
  stores side by side — A's ACTIVE session/outbox/PREV invisible from B's
  repository; legacy file quarantine; per-owner key creation; migrations
  from 0000 on a fresh owner file.
- **Startup/transition:** A → B → A with process death between every step
  (simulated by rebuilding the container from persisted state only).
- **Real API (Postgres) integration:** AUTH-LOCAL-006 (existing BOLA
  suites re-run), AUTH-LOCAL-008 receipt poisoning (B submits A's
  `commandId` first, then A → APPLIED), unplanned START with
  `ownerUserId` mismatch → 409, nothing persisted.
- **Offline / process death (native):** offline cold start of a known
  athlete reaches READY and Resume; unknown `sub` offline → NEEDS_NETWORK.
- **Human acceptance (the critical journey):** athlete A starts a workout
  and logs sets offline → app closed / identity switched → B signs in → no
  Resume, empty PREV → server shows nothing of A's under B (receipts, no
  sessions) → A signs back in → Resume returns → every set present → sync
  succeeds only as A (receipts `user_id = A`) → no duplicates.

## 21. Implementation slices (renumbered by tech lead, 2026-10-19)

The Phase 0 draft listed the client store first; the approved order puts
the server hardening first (D-9).

**Slice A — Server Receipt Ownership Hardening.** CLOSED / tech-lead
approved (2026-10-19) — see §24 and the repo-wide closure audit §25.

**Slice B — Local Athlete Storage + IdentityGate (mobile, dev auth).**
CLOSED / tech-lead approved (2026-10-20) — see §26.
- Job: make cross-athlete local exposure structurally impossible.
- Scope: `AuthSession` abstraction (dev source only); verified `GET /me`
  identity resolution; identity binding store; per-owner DB file + per-owner
  key; owner-scoped composition root (replaces module singletons in
  `plan-runtime.ts`); `IdentityGate` in `app/_layout.tsx` with
  `key={userId}`; sync recovery bound to the container; `SyncEngine` owner
  guard; legacy `vostivo.db` quarantine; LOCAL_DATA_UNAVAILABLE /
  NEEDS_NETWORK states with minimal copy; dev-only identity selector (D-8).
  Also the request-level consistency guard `SyncWorkoutCommandsRequest
  .ownerUserId === actor.userId` (409, nothing persisted) — a CONSISTENCY
  GUARD only, never authorization (deferred from Slice A: mobile has no
  verified local `userId` until this slice).
- Non-goals: Supabase, sign-in UI, refresh, logout.
- Migrations: none to tables; new file layout + SecureStore keys.
- Tests: AUTH-LOCAL-001/002/005/007/009/011/012/013/014.
- Human acceptance: A → B → A via the dev identity selector, offline relaunch.

**Slice C — Supabase Auth + Session Lifecycle.** CLOSED / tech-lead
approved (2026-10-26; human acceptance A-F + R passed) — see §27.
- Job: a real athlete can sign in, stay signed in, and recover from expiry.
- Scope: `@supabase/supabase-js`, SecureStore-backed session adapter (D-3),
  refresh + single-flight 401 handling, REAUTH_REQUIRED, email OTP sign-in
  screen (D-2), coordinator AUTH_PAUSED, typed error copy (no raw messages);
  creating the dev + prod Supabase projects (D-1).
- Non-goals: onboarding, password/social login, Profile.
- Migrations: none.
- Tests: AUTH-LOCAL-003/010; refresh races; sign-in error states.
- Human acceptance: sign in, expire, re-auth mid-workout, same athlete
  restored.

**Slice D — Sign-out + Minimal Account.**
- Job: safe, calm sign-out.
- Scope: Profile tab → one-screen Account (D-7), unsynced-work check +
  bounded sync + warning, teardown order, Supabase sign-out.
- Non-goals: Profile settings, account deletion, local data deletion UI.
- Migrations: none.
- Tests: AUTH-LOCAL-004; teardown order; offline sign-out.
- Human acceptance: sign out with an unsynced set → warning → sign back in →
  set syncs.

**Slice E — Human Acceptance + Final Closure.**
- The full §20 critical journey on a real device/emulator with real API,
  worker and Postgres, plus process-death and offline variants; data
  integrity queries (receipt owners, no misattributed sessions).

## 22. Recorded, not solved here

- Performance (pre-beta): Today/Plan duplicate initial + focus reads; Plan
  performs one Workout Preview read per open session for the progression
  signal.
- Progress & Feedback V1 stays FULLY CLOSED; Archivo integration remains a
  separate design task.

## 23. Tech-lead decisions (APPROVED 2026-10-19)

- **D-1** Separate Supabase development and production projects; actual
  setup deferred until Slice C.
- **D-2** Email OTP code for V1; no password, no social login.
- **D-3** `supabase-js` session adapter backed by Expo SecureStore; no
  insecure AsyncStorage token fallback.
- **D-4** APPROVED — workout command receipt idempotency is owner-scoped
  (implemented in Slice A). The batch `ownerUserId` consistency guard is
  deferred to Slice B.
- **D-5** APPROVED — identity key `userId`; one encrypted SQLite DB per
  athlete.
- **D-6** APPROVED — legacy `vostivo.db`: quarantine only.
- **D-7** Profile tab → Account (sign-out lives there).
- **D-8** APPROVED — dev-only identity selector (same fail-closed
  environment gate).
- **D-9** APPROVED — server hardening first (Slice A).

## 24. Slice A — Server Receipt Ownership Hardening: evidence (2026-10-19) — CLOSED / tech-lead approved (2026-10-19)

**Locked rule: WORKOUT COMMAND IDEMPOTENCY IS OWNER-SCOPED.** The
idempotency identity is `(authenticated userId, commandId)`, never
`commandId` globally. A receipt of athlete A is never returned to B, never
blocks B, is never created/overwritten by B, and never makes A's later
legitimate command fail — even when two users use the exact same
`commandId` (UUID collision probability is not a security boundary).

### 24.1 Receipt schema before / after

| | Before (0002 + 0005) | After (0021) |
|---|---|---|
| Primary key | `command_id` (global) | `(user_id, command_id)` — constraint name unchanged, `workout_command_receipts_pkey` |
| `user_id` | `uuid NOT NULL` FK → `users.id`, always the authenticated actor | unchanged |
| Other unique | partial `(workout_session_id, session_seq) WHERE session_seq IS NOT NULL` | unchanged |
| Nullable | `workout_session_id`, `session_seq` | unchanged |
| Referenced by | nothing (no FK targets the receipt PK) | nothing |
| Command types | START / COMPLETE_SET / REOPEN_SET / FINISH | unchanged |

Composite primary key rather than a surrogate id: nothing references the
receipt, the pair is the true identity, and it keeps a single DB-enforced
uniqueness rule (no second unique index to keep in sync).

### 24.2 Migration / legacy behavior

`0021_bizarre_the_hand.sql`: `DROP CONSTRAINT workout_command_receipts_pkey`
→ `ADD … PRIMARY KEY (user_id, command_id)`, inside the normal drizzle
migrator transaction. Phase 0 assumed legacy receipts might be ownerless;
inspection showed otherwise: `user_id` has been `NOT NULL` and written from
the authenticated actor since the table's creation (0002), so **every
existing row already belongs to its submitter's namespace**. Therefore no
backfill, no reassignment, no deletion, no inference. A legacy row (including
a legacy BOLA-rejected attempt) stays authoritative only for its own
`user_id`, never for an arbitrary actor. The old global key implies the new
one, so the migration cannot fail on existing data. Applied to `vostivo_dev`
(193 rows) and `vostivo_manual` (39 rows) — counts unchanged.

### 24.3 Owner-scoped lookup

One lookup only: `findReceipt(db, userId, commandId)` in
`apps/api/src/workout/workout-command-processing.ts`, used for the replay
short-circuit and the race-loss re-read; the receipt insert's
`ON CONFLICT DO NOTHING` targets `(user_id, command_id)`. No other API/worker
path reads `workout_command_receipts`. The owner is always
`AuthenticatedActor.userId`; no payload value is ever trusted as owner.

### 24.4 Rejection persistence categories

| Category | Examples | Receipt |
|---|---|---|
| **Foreign ownership / unresolved resource** (stateless) | COMPLETE_SET/FINISH on a session that is not the actor's or does not exist; REOPEN of a set not in the actor's session; START whose session id is taken by another user; START claiming another user's planned workout (`FOREIGN_PLANNED_WORKOUT`) | **none** — transaction rolled back, generic `REJECTED`; a replay re-evaluates to the same answer |
| Same-owner deterministic validation | invalid load; Finish causal gate (`sessionSeq > finishSeq`); snapshot mismatch (WDI-SYNC-011); performed exercise id clash; malformed provenance (`INVALID_PLAN_PROVENANCE` — own workout with foreign set ids, unplanned with planned ids); equipment / Available-Time contradictions; `(session, sessionSeq)` reuse | persisted `REJECTED` in the actor's namespace (unchanged) |

The wire answer is identical in both categories (`REJECTED`, no reason), so
nothing reveals whether another athlete's resource exists. Side effect for
the same owner: a COMPLETE_SET/FINISH that arrives before its session's
START is no longer frozen as a permanent `REJECTED` receipt (the mobile
client still treats `REJECTED` as terminal, unchanged).

### 24.5 Cross-user behavior proven (real Postgres)

`apps/api/src/workout/receipt-ownership.integration.test.ts`:
RCPT-001 (replay = own receipt), RCPT-002 (B with A's applied X never gets
A's DUPLICATE), RCPT-003 (same `commandId`, two users, both valid → two
receipts), RCPT-004/004b (A's planned START / whole unsynced outbox under B
→ REJECTED with no trace; A then syncs every command normally), RCPT-005
(B's valid unplanned START with X and A's own X both APPLIED), RCPT-006/006b
(10 concurrent identical same-owner requests → one mutation; two owners
racing one id never block each other), RCPT-007/008 (COMPLETE_SET/FINISH
replay unchanged), RCPT-009 (B's persisted REJECTED never answers A),
RCPT-010 (legacy row authoritative only for its own user), RCPT-011
(AUTH-LOCAL-006 BOLA, stateless), RCPT-012 (same-owner validation still
persisted). `receipt-ownership-migration.integration.test.ts` (MIG-RCPT-001):
scratch database migrated to 0020, old-style rows inserted (including the
poisoning row), 0021 applied twice via the normal migrator, rows
byte-identical, every other `app` constraint/index/column identical, new key
enforced in both directions.

### 24.6 Known limitation (closed by Slice B, not by receipts)

RCPT-005b documents it explicitly: if B submits the **literal** unplanned
START of A (A's own `workoutSessionId`), nothing on the server can prove A
authored it, so the session is created as B's. A's later START is then
rejected — by the session-id collision (statelessly, A's receipt namespace
stays empty), not by a receipt. Planned STARTs and every set/finish command
are safe (ownership-checked). Workout session / performed exercise / set ids
remain global primary keys by design. The prevention is client-side: Slice B
makes it impossible for B's runtime to read A's outbox at all, plus the
batch `ownerUserId` consistency guard.

## 25. Slice A closure audit — repo-wide owner-scoped idempotency (2026-10-19)

Required invariant: a command belonging to security principal A never
affects the idempotency result for principal B. Every persistent
command/idempotency namespace in `apps/` + `packages/` (schema, migrations,
API, worker, mobile) was inventoried and classified.

### 25.1 Inventory

| Namespace | Key | Who produces ids / keys | Multi-user? | Owner-scoped? | Verdict |
|---|---|---|---|---|---|
| `workout_command_receipts` | `(user_id, command_id)` | mobile client (UUIDv7) | yes | yes (0021) | fixed in §24 |
| **`progression_application_commands`** | was `command_id` → now `(owner_user_id, command_id)` | ATHLETE Apply/KEEP_ORIGINAL: mobile client; SYSTEM: server (`createEntityId()` at dispatch enqueue / guided setup) | yes | **was NO → fixed (0022)** | **same defect class — fixed, §25.2** |
| `progression_decisions.evidence_fingerprint` (UNIQUE) | SHA-256 of a canonical document that **includes `userId`** + owned source ids | server/worker only | yes | yes, by construction | safe — executable proof: `progression-fingerprint.test.ts` "changes when userId changes, even with byte-identical evidence" |
| `progression_applications.progression_decision_id` (UNIQUE) | one workflow per decision | server/worker | yes | decision is owner-bound (composite FK `(decision_id, user_id)`) | safe |
| `missed_workout_schedule_applications` fingerprint (UNIQUE) | `(athlete_profile_id, training_block_id, preview_fingerprint)`; replay lookup filters `athlete_profile_id` | server preview fingerprint | yes | yes | safe |
| `equipment_adaptation_applications` replay | lookup by `(user_id, planned_workout_id, preview_fingerprint)`; partial UNIQUE `(user_id, planned_workout_id) WHERE ACTIVE` | server preview fingerprint | yes | yes | safe |
| `available_time_applications.workout_session_id` (UNIQUE) | one per session | written in the owner-checked START tx | yes | via session ownership | safe (session-id collision is the accepted RCPT-005b boundary) |
| `planned_workout_occurrence_claims` | UNIQUE `(user_id, planned_workout_id)` + UNIQUE canonical session | START tx, owner-checked provenance | yes | yes | safe |
| `workout_change_cursor` | `bigserial` | server | — | not an idempotency key | n/a |
| pg-boss jobs (`progression-evaluate-session-v1`, `progression-application-dispatch-v1`) | pg-boss job id; no `singletonKey` used anywhere | server only, payload ids server-generated | trusted single principal (server) | n/a | class A — safe |
| mobile `sync_outbox.command_id` (local SQLite) | `command_id` | the device | device-local | per-athlete DB in Slice B | Slice B scope (D-5) |

Client-generated entity ids (`workout_sessions.id`, performed exercise/set
ids) are global primary keys by design; their cross-user copy is the
accepted RCPT-005b boundary (§24.6), prevented client-side by Slice B.

### 25.2 `progression_application_commands` — defect and fix

Before: `command_id` was the global primary key; `findCommandReceipt(commandId)`
had no owner filter and both `applyProgressionCore` (ATHLETE Apply and SYSTEM
dispatch) and `keepOriginal` short-circuited on it. Concrete effect: if
athlete B (or a SYSTEM dispatch for B's application) had a receipt for X, A's
later Apply/KEEP_ORIGINAL with X on A's own application returned
`COMMAND_CONFLICT` (receipt `application_id` ≠ A's application) — A was
**blocked** (the API maps it to 409; the mobile review offers Retry). B could
not receive A's result, mutate A's application, or make it look applied
(BOLA load → `NOT_FOUND`, which returns before any receipt is written), but
blocking alone is the same defect class.

Fix (same principle as §24):
- New `owner_user_id uuid NOT NULL` = the **application's canonical owner**
  (`progression_applications.user_id`), never a caller value. For ATHLETE it
  equals the authenticated actor (a receipt is only written after the BOLA
  ownership load succeeded); for SYSTEM it is read from the application row.
- Primary key `(owner_user_id, command_id)`; every lookup is
  `findCommandReceipt(db, ownerUserId, commandId)`; every insert's
  `ON CONFLICT` targets the pair.
- DB-enforced owner integrity: composite FK `(application_id, owner_user_id)`
  → `progression_applications(id, user_id)` (new trivially-satisfied
  `UNIQUE(id, user_id)` there, the existing `progression_decisions` pattern),
  plus CHECK `actor_type <> 'ATHLETE' OR user_id = owner_user_id`.
- Actor audit semantics unchanged: `user_id` stays the actor (NULL for
  SYSTEM), `actor_type` unchanged.
- Same-owner semantics unchanged: replay returns the stored outcome, the same
  `commandId` reused by the same owner for another application/action is still
  `COMMAND_CONFLICT`, concurrency still serialized by the `ProgramVersion` lock
  + receipt PK.

Migration `0022_sticky_miss_america.sql` (non-destructive): add
`UNIQUE(id, user_id)` on applications → add nullable `owner_user_id` →
backfill from each row's own NOT NULL `application_id` FK (proven, never
inferred) → `SET NOT NULL` → swap PK → add composite FK + CHECK. No row
deleted or reassigned; nothing references this PK. Pre-check on the dev DBs:
`vostivo_dev` 1 row, `vostivo_manual` 3 rows (all SYSTEM) — every row had an
application, no ATHLETE row with actor ≠ owner. Applied to both; counts
unchanged.

### 25.3 Proof

- `packages/progression-application/src/progression-application-apply.integration.test.ts`:
  PROG-RCPT-001/002/003 (A and B Apply with the same X → both APPLIED, each
  replay returns only its own owner's result; pre-fix: COMMAND_CONFLICT),
  PROG-RCPT-004/005 (B's KEEP_ORIGINAL with X never blocks or answers A's
  Apply with X; same-owner reuse still conflicts), PROG-RCPT-004b (B's
  foreign attempt on A's application leaves no receipt; A's X later
  APPLIED), PROG-RCPT-006/007 (6 concurrent identical same-owner Applies → one
  receipt, one application, 100 → 102.5 kg; 4 concurrent SYSTEM dispatches of
  one `systemCommandId` → one SYSTEM receipt with `user_id` NULL, actor SYSTEM,
  never a second increment), PROG-RCPT-008 (the same `systemCommandId` for two
  athletes' applications never conflicts), PROG-RCPT-009 (DB refuses a
  non-owner `owner_user_id` and an ATHLETE actor ≠ owner).
- `apps/api/src/workout/receipt-ownership-migration.integration.test.ts`
  MIG-RCPT-002: scratch DB at 0021, real pre-migration fixture (2 athletes,
  ATHLETE + SYSTEM + foreign-id rows), 0022 applied twice via the normal
  migrator → rows identical, owners equal each row's application owner,
  applications untouched, every other table's schema identical, new key and
  owner FK enforced. MIG-RCPT-001 now applies 0021 alone.
- The full progression journey (decision → SYSTEM apply → effective next
  target) stays green in the existing progression-application, worker and
  API suites (§24 regression list).


## 26. Slice B — Local Athlete Storage + IdentityGate: evidence (2026-10-20) — CLOSED / tech-lead approved (2026-10-20)

**Locked by this slice:** NOTHING ATHLETE-OWNED EXISTS BEFORE READY; THE
LOCAL OWNER IS THE VERIFIED INTERNAL `userId`, NEVER A TOKEN CLAIM, EMAIL OR
"THE DB THAT HAPPENS TO EXIST"; ONE ENCRYPTED DB + ONE KEY PER ATHLETE; AN
OWNER CHANGE DISPOSES THE OLD RUNTIME BEFORE THE NEXT ONE IS RESOLVED;
SYNC CARRIES `ownerUserId` AND REFUSES TO SEND UNDER ANOTHER IDENTITY; THE
LEGACY `vostivo.db` IS QUARANTINED, NEVER ASSIGNED.

### 26.1 Session abstraction (`apps/mobile/src/identity/`)

`AuthSession {provider, providerSubject, accessToken}` behind
`AuthSessionSource {getSession, subscribe}` (`auth-session.ts`). Slice B
ships only dev/none sources (`auth-session-config.ts`
`createAuthSessionWiring`): production → `NoSignInAuthSessionSource`, and
it THROWS at startup if `EXPO_PUBLIC_DEV_JWT` or `EXPO_PUBLIC_DEV_JWTS` is
set (AUTH-LOCAL-014). Dev: `EXPO_PUBLIC_DEV_JWTS=alias=jwt,alias=jwt` builds
`DevAuthSessionSource` (selection persisted under SecureStore
`vostivo.dev-identity.selected-alias`) — the switcher exists only when
`__DEV__` AND `EXPO_PUBLIC_DEV_JWTS` is set (D-8); a single legacy
`EXPO_PUBLIC_DEV_JWT` gives one fixed `dev` identity. The subject is read
unverified (`jwt-subject.ts`) only as a lookup key — trust comes from §26.2.

### 26.2 Verified binding

`resolveIdentity` (`identity-resolution.ts`): online → `GET /api/v1/me`
(`verified-me-client.ts`: VERIFIED / UNAUTHORIZED 401·403 / UNREACHABLE
network·5xx / INVALID_RESPONSE) → record binding → VERIFIED. 401 →
IDENTITY_ERROR (never a binding fallback). Unreachable → stored binding
(OFFLINE_BINDING) or NEEDS_NETWORK. The binding is written ONLY from a
verified `/me` (AUTH-LOCAL-013): SecureStore `vostivo.identity-bindings.v1` =
`{version:1, bindings:[{provider, providerSubject, userId,
athleteProfileId, verifiedAt}]}`, max 8 (least-recently-verified evicted);
`(provider, subject)` already bound to another `userId`, or a `userId` bound
to another subject → `IdentityBindingConflictError`, nothing written →
BINDING_CONFLICT (fail closed). A corrupt store reads as empty (→ online
re-verification).

### 26.3 IdentityGate state machine

`IdentityGateController` (`identity-gate-controller.ts`): BOOTING →
VERIFYING → READY | NEEDS_NETWORK | LOCAL_DATA_UNAVAILABLE | IDENTITY_ERROR
(reasons NO_SESSION / UNAUTHORIZED / BINDING_CONFLICT / INVALID_RESPONSE /
UNEXPECTED). Only READY carries a runtime. Evaluations are serialized;
superseded tickets dispose what they built. Identity change: the current
runtime is detached and `dispose()` AWAITED (DB closed) before the next
identity is resolved/opened. Same subject + new token: same runtime kept,
re-verified in the background; refusal/conflict tears it down. `IdentityGate`
(`identity-gate.tsx`) renders the screen tree only in READY as
`<AthleteRuntimeProvider key={userId}>`; screens get everything via
`useAthleteRuntime()` (throws outside READY). Non-READY renders a calm gate
screen with "Try again" (NEEDS_NETWORK copy: "Connect once to verify this
account"). Offline: a known subject opens READY offline from its binding; an
unknown subject never opens anything. No re-verification is triggered when
the network returns after an offline READY (limitation, Slice C).

### 26.4 Per-athlete database and keys

`athleteDatabaseName(userId)` = `vostivo-athlete-<userId>.db`;
`athleteDatabaseKeyStorageKey(userId)` =
`vostivo.local-db-encryption-key.<userId>` (UUID-validated, no email/name).
`decideAthleteDatabaseOpen`: no file + no key → generate + STORE key first,
then create; file + key → open; file without key → LOCAL_DATA_UNAVAILABLE
(no key generated, file untouched); key without file → create with it
(interrupted first open); malformed/non-opening key → LOCAL_DATA_UNAVAILABLE.
`openNativeAthleteDatabase` (`local-database/client.ts`) probes with a
keyless separate connection, then opens with SQLCipher, verifies, applies
pragmas, runs migrations. Nothing is ever deleted. The global
`initializeLocalDatabase` and module-singleton runtime are gone:
`createAthleteRuntime` (`plan/plan-runtime.ts`) builds one owner-scoped
container; after `dispose()` its repository provider rejects
(`AthleteRuntimeDisposedError`). Active workout, PREV, drafts and rest timer
are physically per-file — no name/owner filtering exists or is needed.

### 26.5 Legacy quarantine

`vostivo.db` and its device key (`LEGACY_DATABASE_NAME`,
`LEGACY_DATABASE_KEY_STORAGE_KEY`) are never opened, read, assigned, synced
or deleted (AUTH-LOCAL-011). Its data is invisible to the new runtime
(accepted, D-6). `no-hidden-runtime-path.test.ts` scans the source for any
remaining non-gated runtime/DB entry point.

### 26.6 Sync ownership

`SyncEngine(ownerUserId, …)` obtains the token BEFORE `markSyncing`;
`OwnerBoundAuthTokenProvider` throws `RuntimeOwnerMismatchError` unless the
current session has the runtime's provider + subject → nothing sent, outbox
untouched. Every batch carries `ownerUserId`. Server
(`workout-sync.service.ts`): `ownerUserId !== actor.userId` → whole-batch
409 `SYNC_OWNER_MISMATCH` before any command — zero receipts/sessions/sets/
claims/cursor rows; DTO `@IsUUID()` required (400 otherwise). It is a
CONSISTENCY GUARD, NOT AUTHORIZATION (BOLA stays the boundary). Client: 409
→ `RuntimeOwnerMismatchError`; the coordinator schedules no retry/backoff.
Sync-recovery triggers live inside the owner-keyed tree, so they unsubscribe
before the next owner exists.

### 26.7 RCPT-005b closure

§24.6's residue is closed in depth: (1) B's runtime cannot read A's outbox
(separate file + key); (2) A's runtime cannot send under B's session
(owner-bound token provider); (3) a batch whose `ownerUserId` ≠ actor is
refused whole (SYNC-OWNER-001). The literal server behavior of §24.6 is kept
as a documented "SERVER RESIDUE" test; a new real-Postgres test proves A's
unplanned START + set sent with B's actor → 409, then A's own sync → S is
A's.

### 26.8 Tests

Mobile (Vitest, real SQLite via `node:sqlite`): `athlete-isolation.test.ts`
(real gate + runtime + SQLite + fake server: ISO-11..16/19/20/30,
AUTH-LOCAL-001/002/005/009/011/012, SYNC-21..24, RCPT-005b client side,
GATE-8/AUTH-LOCAL-003, process death + offline relaunch, GATE-5, crash during
switch), `identity-gate-controller.test.ts` (GATE-1..10, rapid A→B→A,
`stop()`), `identity-resolution`, `identity-binding-store`
(AUTH-LOCAL-013), `verified-me-client`, `jwt-subject`, `auth-session-config`
(AUTH-LOCAL-014, DEV-41..45), `local-database/athlete-database` (LOCAL-16..20,
cases A–D), sync-engine/coordinator (SYNC-21..24, 409), and
`no-hidden-runtime-path`. AUTH-LOCAL-007 is structural (no runtime before
READY). API real Postgres: SYNC-OWNER-001/002, RCPT-005b CLOSED, controller
400 for missing/non-UUID `ownerUserId`.

### 26.9 Human acceptance (2026-10-20, evidence outside the repo:
`vostivo-acceptance-evidence/auth-local-slice-b/`)

New AVD `Vostivo_Auth_Slice_B` (dev build + Metro), real API + worker,
`vostivo_manual`, two fresh athletes A/B, dev switcher. A started online; API
stopped; A logged 60×10 offline + draft 8 + rest timer. Switch → B with API
down: NEEDS_NETWORK (B never verified; no fallback). API up → B READY, Start
(no A Resume); server still had only A's START (A's set NOT sent as B). B's
own workout showed no A set/draft/timer/PREV; B logged 60×12 → B-owned
receipts, session, claim. Switch → A: A's pending set synced as A; Resume
intact (60×10, draft 8). API down + force-stop + relaunch → READY offline as
A; offline switch → B (bound) shows only B's data. Device: exactly two
`vostivo-athlete-<userId>.db` files, encrypted headers. A planted legacy
`vostivo.db` stayed byte-identical (SHA-256 + mtime) across an online
relaunch. Final SQL: A = START + 2 sets, B = START + 1 set, 0 cross-owner
receipts, one CANONICAL claim each, no SECONDARY. No JWT in any evidence log.

### 26.10 Known limitations

Gate screen is a non-navigator root before READY; a server 409 bumps
`attempt_count` once (no backoff); dev JWTs are inlined into dev bundles via
`EXPO_PUBLIC_*`; legacy data is invisible (D-6); no re-verification on
network regain after offline READY; binding store capped at 8; the probe
treats any non-empty plaintext file as HAS_CONTENT (→ key path).

---

## 27. Slice C — Supabase Auth + Session Lifecycle: evidence (2026-10-21) — human acceptance PASSED — CLOSED / tech-lead approved (2026-10-26)

Slice B's boundary is unchanged: provider subject is only a lookup key, the
owner is trusted only after an authenticated `GET /api/v1/me`, one SQLCipher
DB + key per `userId`, runtime disposed before another owner opens. Slice C
only replaces "where the session comes from" and adds its lifecycle.

### 27.1 Provider role

Supabase (dev project `vostivo-dev`, Frankfurt) is the IDENTITY PROVIDER
ONLY. The project's Data API is intentionally disabled; the app has no
PostgREST/Storage/Realtime/Functions use (structural test in
`no-hidden-runtime-path.test.ts`); athlete data goes only through the
Vostivo API. The product database stays the Vostivo Postgres.

V1 login = email + 6-digit OTP only: `signInWithOtp({email, options:
{shouldCreateUser: true}})` -> `verifyOtp({email, token, type: "email"})`.
No password, magic link, social or anonymous sign-in
(`detectSessionInUrl: false`). Emails are sent by Supabase Auth through
Resend SMTP (sender `Vostivo <no-reply@auth.vostivo.cz>`, code-only
templates using `{{ .Token }}`); the SMTP credential lives only in the
Supabase dashboard, never in this repo. OTP lifetime 600 s; resend cooldown
60 s in the UI (`OTP_RESEND_COOLDOWN_MS`), restarted also by a refused
resend.

### 27.2 Configuration (names only — values live in gitignored `.env`)

| App | Variable | Notes |
|---|---|---|
| mobile | `EXPO_PUBLIC_SUPABASE_URL` | `https://<ref>.supabase.co`; `http` only for localhost / 10.0.2.2 |
| mobile | `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_...`; `sb_secret_...` / service_role JWT refused at startup. Replaces `EXPO_PUBLIC_SUPABASE_ANON_KEY` (removed) |
| api | `SUPABASE_URL` | the same project URL; JWKS + issuer derive from it; no key of any kind in the API |
| api | `LOCAL_JWKS_PATH` | leave UNSET for real sign-ins (it switches verification to locally minted dev tokens; `NODE_ENV=local` only) |

Wiring (`createAuthSessionWiring`): production = Supabase only (a dev token
refuses to boot; missing/unsafe config -> a "Sign-in unavailable" screen,
no session). Non-production: `EXPO_PUBLIC_DEV_JWTS` (`__DEV__` only) or
`EXPO_PUBLIC_DEV_JWT` win when set; else Supabase when configured; else no
session. Dev tokens and cloud tokens never verify against the same API
configuration.

API verification needed no code change: `jose` + remote JWKS at
`<SUPABASE_URL>/auth/v1/.well-known/jwks.json`, issuer
`<SUPABASE_URL>/auth/v1`, audience `authenticated`. This requires the
project to use asymmetric JWT signing keys (the JWKS must list a key); no
service_role or shared secret. Cloud users arrive with UUID subjects and
provider `supabase`; their `User`/`AthleteProfile` is created by `/me`
through the existing identity resolution.

### 27.3 Session storage (`apps/mobile/src/auth/chunked-secure-session-storage.ts`)

Supabase session JSON is stored in expo-secure-store only (never
AsyncStorage, never a plaintext fallback), as chunks of one generation
(`vostivo.auth.<slot>.g<N>.<i>`, 1800 chars) plus a manifest written LAST
(`vostivo.auth.<slot>.manifest`: generation, chunk count, length, FNV-1a
checksum). A crash before the manifest switch keeps the previous session;
a missing/corrupt chunk or manifest fails closed (no session, never a
partial one); a keystore failure is `SessionStorageUnavailableError` —
never "signed out" and never a reason to delete anything (the gate keeps an
open owner's data with sync paused, or shows SESSION_STORAGE_UNAVAILABLE).

### 27.4 Session source (`supabase-auth-session-source.ts`, `supabase-auth-client.ts`)

`createClient` exists only in `supabase-auth-client.ts` (`persistSession`,
`autoRefreshToken`, `detectSessionInUrl: false`); only `client.auth`
leaves it. `SupabaseAuthSessionSource` adapts it to Slice B's
`AuthSessionSource`: `providerSubject = user.id`. SDK events are coalesced
by (subject, token) / loss signature and delivered outside the SDK's auth
lock. A `SIGNED_OUT` not caused by `signOut()` is loss `SESSION_INVALID`.
Offline with an expired access token (SDK: no session + retryable error) the
stored identity is returned so a VERIFIED binding can still open offline.
Auto-refresh runs only in the foreground (app lifecycle). Tokens, OTPs and
session payloads are never logged; UI copy comes only from
`auth-errors.ts` (NETWORK_UNAVAILABLE / INVALID_EMAIL / INVALID_OTP /
OTP_EXPIRED / RATE_LIMITED / SESSION_INVALID / STORAGE_UNAVAILABLE /
CONFIGURATION_ERROR / UNKNOWN). Supabase answers `otp_expired` for a wrong
code too, so OTP_EXPIRED is reported only when >= 600 s since the send.

### 27.5 401 policy (`workout/authorized-request.ts`)

Every authenticated request (plan, progress, missed-workout, equipment,
loading setup, progression, `/me`, sync): 401 -> ONE single-flight
`refreshSession()` shared by all concurrent 401s -> ONE retry -> still 401
-> session marked invalid locally (`signOut({scope: "local"})`) -> the gate
re-evaluates. Never a loop. The auth service being unreachable is
`AuthServiceUnavailableError` = offline, never SESSION_INVALID.

### 27.6 IdentityGate additions

States: `SIGNED_OUT` (sign-in screen), `REAUTH_REQUIRED` (no owner open),
`READY {verification: ONLINE | OFFLINE_BINDING, auth: VALID |
REAUTH_REQUIRED}`. Sync (outbox) is permitted only for `ONLINE && VALID`
(`SyncPermit` + `PermitGatedAuthTokenProvider`; a paused engine leaves the
outbox untouched, the coordinator schedules no backoff).
- Invalid session while READY: the SAME runtime stays (Active Workout keeps
  logging and can Finish locally), sync paused, a "Sign in again to sync"
  pill + a re-auth sheet (not auto-opened on `/active-workout`, "Not now"
  available).
- Same-subject re-auth: no dispose, `/me` re-verifies the same `userId`,
  sync resumes (`requestSync("reverified")`); commands are the same ids, so
  nothing duplicates (owner-scoped receipts).
- Other-subject sign-in: the ordinary Slice B A -> B transition (A disposed
  before B is resolved/opened).
- Offline-bound boot: data usable, sync OFF until network regain or
  foreground re-verifies `/me` for the same owner (closes §26.10 "no
  re-verification on network regain").
- `/me` BINDING_CONFLICT still fails closed (dispose); another untrustworthy
  answer only revokes sync.
- Only an explicit sign-out (Slice D UX; primitive `signOut()` exists)
  disposes without a successor.

### 27.7 Tests (automated)

Mobile 497 tests / 51 files green (2026-10-26; +AUTH-023 `owner-bound-
auth-token-provider` no session -> `SessionInvalidError` with sign-in copy,
never `RuntimeOwnerMismatchError`; +AUTH-024 `auth-recovery` REAUTH_REQUIRED
-> VALID bumps the recovery count that re-runs Today's load). Slice C: `auth-errors` (AUTH-003/004/005/
019), `chunked-secure-session-storage` (AUTH-006/007/008/022),
`supabase-auth-session-source` with a fake SDK port (AUTH-001/002/009/010/
016/019/022, loss mapping, foreground refresh), `sign-in-flow` (AUTH-001/
002/003, cooldown), `authorized-request` (AUTH-011/019), `sync-engine`
(AUTH-011/012/014/018/019), `identity-gate-controller` (AUTH-001/009/012/
013/014/015/016/017/018/022), `athlete-isolation` on real SQLite (AUTH-013/
014 mid-workout revoke -> finish locally -> same-owner re-auth syncs each
command exactly once; AUTH-015/021 cross-owner re-auth; AUTH-018 offline
relaunch needs `/me` before sync; AUTH-019), `auth-session-config`
(AUTH-020), `no-hidden-runtime-path` (one client, auth only, no data
access, no AsyncStorage, no ANON/secret key names). API 266 unit + 328
real-Postgres integration, worker 19 integration, turbo build/typecheck/
lint/test, `boundaries:check`, Android `expo export` — all green.
Closure re-run 2026-10-26 (evidence `closure/`): turbo typecheck 19/19,
lint 19/19, test 18/18 (mobile 497, API 266), build 11/11, `boundaries:check`
0 violations (628 modules), `expo export --platform android` OK with no
secret/JWT in the bundle, API integration 328/328, worker 19/19, progression-
application 88/88. Two environment-only flakes, no code change: API EQC-01/
X-034 hit the 5 s timeout once under host load (EQC-02 failed in the broken
cleanup after it; the same files 31/31 in isolation, the full suite 328/328
on re-run); progression-application exhausted Postgres connection slots
while the acceptance API/worker held pools (88/88 with
`--no-file-parallelism`; CI has no such stack). `vostivo_manual` fingerprint
identical before/after (tests use `vostivo_dev`). `format:check` is not a CI
gate and fails on the same files at HEAD (pre-existing).

### 27.8 Human acceptance — PASSED (2026-10-21 .. 2026-10-26, evidence outside the repo: `vostivo-acceptance-evidence/auth-slice-c/`)

AVD `Vostivo_Auth_Slice_C` (dev build + Metro; embedded-bundle debug APK
for F), real cloud Supabase project (email OTP), local API + worker,
`vostivo_manual`, athletes A and B. Supabase access-token expiry was
temporarily lowered to 300 s for the run; a session was revoked by deleting
the athlete's rows in `auth.sessions`. An acceptance-only proxy logged
method/path/status only (no headers, bodies or tokens).

- A fresh OTP sign-in -> `/me` bound the provider subject to one internal
  `userId`; B relaunch without OTP (SecureStore session restored) — PASS.
- C mid-workout revoke: pill only on Active Workout (no sheet), sets and
  Finish kept working locally into A's open DB, server unchanged — PASS.
- D same-owner re-auth: pending commands synced exactly once, 0 duplicate
  `command_id`s — PASS, but Today needed a manual Retry and showed the
  owner-mismatch text while signed out -> fixes AUTH-023/AUTH-024.
- E cross-owner B (missed-workout apply + a logged set) and back to A: only
  one athlete DB handle open at a time, 0 cross-owner receipts — PASS.
- F offline boot (wifi + data off) -> READY offline, a set logged offline,
  server untouched until reconnect, then `/me` re-verified before sync —
  PASS.
- R (device re-check of both fixes, 2026-10-26, same owner A, runtime kept
  open while the session was revoked): Plan with no session shows "Could not
  load your plan / Sign in again to load your latest training." with no
  request sent (twice); after re-auth via the pill, Today's
  `plan/current`, `pending`, `attention` and `missed-workout-preview` ran
  within 345 ms of `/me` 200 with no Retry and the missed-workout card came
  back — PASS. Today itself shows Resume (an active workout outranks the
  error state by design), so fix AUTH-023 is observed on Plan.
- Throughout: no new identity rows, A/B DBs intact (SHA-256 identical across
  an emulator restart), 0 cross-owner receipts, 0 duplicate command ids,
  no JWT/OTP/key in any evidence file.

supabase-js under Hermes/RN 0.86 (RN's own `URL`, no polyfill) and the
chunked SecureStore session are now native-verified on the emulator.

### 27.9 Known limitations / open

Production Supabase project not created (D-1 prod half); sign-out UX is
Slice D; the re-auth sheet auto-opens once on any READY screen except
Active Workout (there only the pill offers it); `otp_expired` cannot distinguish a
wrong code from an expired one inside 600 s (by design of the provider).

Acceptance findings (2026-10-26 triage; none blocks Slice C closure):
- FOLLOW-UP, high (release gate): offline boot sat 20-40 s on "Getting your
  training ready" (F, emulator, wifi + data off). No bounded timeout exists
  on the session refresh / `/me` path at boot; on poor gym connectivity
  this could be longer. Data stayed correct; investigate + add a bounded
  timeout before release.
  **Phase 1 bounded timeouts (2026-10-28, not yet committed):** root cause
  was supabase-js holding `getSession()` while it retried the offline
  refresh of an expired token (backoff up to ~30 s), plus no timeout at all
  on RN Android `fetch` (an API that accepts and never answers hung boot
  > 5 min). Now: `/me` <= 5 s (`VERIFIED_ME_TIMEOUT_MS`, request + body ->
  `UNREACHABLE`), the gate's session read <= 3 s
  (`SUPABASE_SESSION_READ_TIMEOUT_MS`, then the stored session's identity —
  the same offline fallback as before; later TOKEN_REFRESHED/SIGNED_OUT run
  the normal flow), every Supabase Auth request <= 8 s
  (`SUPABASE_AUTH_REQUEST_TIMEOUT_MS`, `global.fetch` of the single
  client). No binding / SyncPermit / gate-order change. Emulator, launch ->
  Today (JS main -> Today): online 5.6-6.1 s (2.8-3.0 s); offline + expired
  token 9.1-9.3 s (6.4-6.5 s), was 30.1-31.5 s (26.2-28.3 s); API
  blackhole 9.3-11.3 s (6.5-8.5 s), was > 5 min. Not done (Phase 2
  candidate): an instant OFFLINE_BINDING boot that does not wait for the
  3 s session read at all.
  Measurement caveat: the debug APK embeds `assets/index.android.bundle`;
  with wifi/data off the emulator cannot reach the packager at `10.0.2.2`
  and silently runs that embedded (build-time) bundle. Offline measurements
  of current code need the RN dev setting `debug_http_host=localhost:8081`
  (served over `adb reverse`).
- FOLLOW-UP, medium (not Slice C): `parseLoadInput` rejects a decimal comma
  (`42,5`), which a Czech-locale `decimal-pad` keyboard can offer. FIXED for
  Active Workout (2026-10-26, `f7f3a74`); Loading Setup still open.
- NON-BLOCKER, UI polish: the "Sign in again to sync" pill (absolute,
  top 44) overlaps the Active Workout header and touches Today's title.
- WATCH, now reproducible (not fixed): native SIGSEGV in RN Fabric
  `MountingCoordinator::pullTransaction` (`libreactnative.so`, JS thread
  `mqt_v_js`) during offline boots of the debug APK, right when the first
  screen mounts. First seen on acceptance F; again 1 of 5 offline +
  expired-token boots (2026-10-26, embedded bundle), 1 of 4 (2026-10-26,
  Metro bundle) and 2 of 5 (2026-10-28, Phase 1 code; one `SEGV_MAPERR`
  at 0x4, one `SEGV_ACCERR`). Never seen online. No data written or lost;
  relaunch works. Needs its own investigation (RN version / release build)
  before beta.
- ENVIRONMENT (not product): the Android emulator must run with
  `-no-snapshot`; with Quickboot save enabled its file-backed guest RAM
  wrote ~64 MB/s to the host SSD and froze the desktop.

