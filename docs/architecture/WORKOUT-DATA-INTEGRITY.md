# Vostivo — Workout Data Integrity Vertical Slice

Scope: the first real business vertical slice. Proves the core offline
invariant end to end — local-first logging, domain-aware sync, revision-
based conflict resolution, durable idempotency, and authenticated-actor-
only authorization — for exactly three actions: start a workout, complete
a set, reopen a set. No Active Workout UI, no Plan UI, no Training Engine,
no Program domain, no coaching, no subscriptions, no analytics. See
`CLAUDE.md` for what this slice deliberately excludes.

## Core invariant

**A completed set must never depend on network availability.** Every
mutation (`startWorkoutSession`, `completeSet`, `reopenSet`) writes to
local SQLite only, inside one transaction that also enqueues the sync
command. Sync happens strictly after, and only if/when the network
allows it — see ADR-0007 for the full sync protocol design.

## Reality vs. prescription

```text
WorkoutPrescriptionV1   immutable snapshot of what was intended — captured
                        once, at start, into local_workout_sessions /
                        app.workout_sessions.prescription_snapshot.
                        Never a live reference to a Program/ProgramVersion.

WorkoutSession          -> PerformedExercise -> PerformedSet
                        what actually happened. This slice implements
                        Reality (B) and Intent-as-snapshot (A) only —
                        Interpretation (C, a Training Engine judging
                        reality against intent) is explicitly out of
                        scope.
```

`packages/domain/src/workout/`: `prescription.ts`, `workout-session.ts`,
`performed-exercise.ts`, `performed-set.ts`, `outbox.ts`.

## Load Model Stage 1

Every load is `{ kind: "EXTERNAL_WEIGHT", amountMilli, unit, basis }` —
never a bare number. See `docs/domain/load-model-v1.md` for the full
locked spec; this slice only uses Stage 1 (`KG`/`LB`,
`TOTAL`/`PER_IMPLEMENT`).

`PerformedSet` deliberately has **no RIR field at all** — not even
nullable. RIR needs a validated numeric range/policy decision this slice's
scope does not resolve; adding a bare `number | null` field now would
freeze an unreviewed shape into both the local schema and the wire
contract.

## Local persistence (mobile)

```text
apps/mobile/src/local-database/schema.ts       local_workout_sessions,
                                                local_performed_exercises,
                                                local_performed_sets,
                                                sync_outbox
apps/mobile/src/local-database/migrations.ts   hand-rolled, additive,
                                                one statement each; applied
                                                atomically with the ledger
                                                (see "Local migration
                                                integrity" below)
apps/mobile/src/local-database/migration-store.ts
                                                the production migration
                                                store (device + tests)
apps/mobile/src/workout/workout-repository.ts  all local reads/writes;
                                                implements OutboxPort
```

`WorkoutRepository` never imports HTTP/Supabase — it is the single
authority for local reality while a workout is active. `readActiveSession`
reconstructs the full in-progress session (session → exercises → sets)
from local rows alone, which is what makes "force-stop and relaunch
offline, same IDs, same data" possible.

### Known gotcha (found and fixed during this slice's native verification)

expo-sqlite's `drizzle-orm` adapter returns **`null`**, not `undefined`,
for "no row matched" on `db.get()`. Code written as
`if (row === undefined) return undefined;` silently passes through a
`null` row and crashes (or, worse, silently treats "not applied yet" as
"already applied" — which is exactly what happened to the local migration
runner's `isApplied()` check: every migration, including the original
Foundation Bootstrap one, was silently skipped on real devices the entire
time, undetected because the Vitest suite for the migration runner uses a
fully in-memory fake store and never exercises the real expo-sqlite
adapter). Fixed at all three call sites
(`local-database/client.ts`, `workout-repository.ts` ×2) by checking both
`null` and `undefined` explicitly. This is precisely why this task's
mandatory native verification step exists — "do not claim PASS from unit
tests alone."

### Local migration integrity (CC-02, D-MIG-1)

**Defect (fixed).** The runner used to execute a migration's statement and
insert its `__local_migrations` ledger row as two separate autocommit
writes. `CREATE TABLE IF NOT EXISTS` tolerates a crash between them;
`ALTER TABLE ... ADD COLUMN` does not — on the next launch it threw
`duplicate column name`, `openKeyedDatabase` failed, and the athlete got
`LOCAL_DATA_UNAVAILABLE` on **every** launch, with all workout data intact
but unreachable.

**Atomicity.** `runLocalMigrations` now runs, per migration, one SQLite
write transaction on the database's own connection
(`LocalMigrationStore.runInTransaction` → drizzle's sync
`db.transaction(...)` → `begin` / `commit` / `rollback`, the mechanism the
workout repository's writes already use on device): re-check the ledger, inspect the schema, run the
statement, insert the ledger row, commit. SQLite DDL is transactional, so a
crash or error anywhere leaves the migration either fully applied **and**
recorded, or not applied at all. Transactions are never nested.

**Reconciling databases written by the old runner.** The old runner could
leave a migration's object committed with no ledger row. Such a migration
is recorded without re-running **only on textual proof** that the object is
exactly what that frozen historical statement creates. SQLite stores a
table's definition verbatim in `sqlite_master.sql` — the `CREATE TABLE`
statement minus `IF NOT EXISTS` and the trailing `;`; each `ADD COLUMN`
appends `, <column definition>` to it (pinned per migration by
`CC02-MIG-018`). That text carries every column type, PRIMARY KEY,
NOT NULL, DEFAULT, REFERENCES, UNIQUE, CHECK and COLLATE; matching column
names alone would prove none of it.

| Unrecorded migration, actual schema | Action |
| --- | --- |
| object absent | run the statement and record it, in one transaction |
| `CREATE_TABLE`: stored definition **equals** the historical statement's stored form | record **without** re-running (`reconciled`) |
| `ADD_COLUMN`: `pragma_table_info` type / NOT NULL / DEFAULT match **and** the stored definition contains `, <exact column definition>` followed by `,` or `)` | record **without** re-running (`reconciled`) |
| anything else (different type, key, nullability, default, FK, CHECK, COLLATE, column set; other whitespace or formatting; missing table for ADD COLUMN) | `LocalMigrationReconciliationError` — fail closed, nothing written |

The last row is deliberately strict: a table that is equivalent but was
created by some other text (e.g. re-formatted) is treated as ambiguous and
not recorded. Only this app's runner ever created these tables, from these
exact strings, so a legitimate old partial migration always matches.

**Post-run check (weaker, by design).** After the loop every migration's
object must exist: the table, all its declared column names, and each added
column with its declared type / NOT NULL / DEFAULT. This is a *presence*
guard against a recorded-but-missing object — not an equivalence proof
(the stored text of an altered table no longer equals its CREATE statement).
Equivalence is proven only where it is needed: before recording an
unrecorded object.

**Downgrade (older build, newer database) — pre-existing risk, unchanged
by CC-02.** Ledger rows with ids unknown to this build are ignored, exactly
as before CC-02, and extra tables/columns pass the presence check. An older
build therefore opens a database a newer build migrated, but nothing
guarantees its writes remain valid against newer columns (e.g. a future
`NOT NULL` column without a default). If a future migration rebuilds a
table this build knows, the presence check may fail closed — data intact,
`LOCAL_DATA_UNAVAILABLE`. Downgrades are not a supported path; a future
migration that is not purely additive must address this explicitly.

**Recovery path for a fail-closed database.** The failing migration's
transaction rolled back, so the file holds exactly what it held before the
launch — every session, set, draft and outbox command (with its
`command_id`) is preserved, and the open is retried unchanged on every
launch (no partial writes accumulate). The app shows the existing
`LOCAL_DATA_UNAVAILABLE` / `OPEN_FAILED` state. Recovery is an app update
whose migration code (or a new, reviewed forward migration) handles the
reported shape — the error message names the migration and the actual vs.
expected schema. The athlete must **not** be told to reinstall or clear
data. *Follow-up (not in CC-02):* a distinct LOCAL_DATA_UNAVAILABLE reason
and diagnostic for this error.

**Verification.** `apps/mobile/src/local-database/migrations.crash-recovery.test.ts`
kills a real child `node` process (SIGKILL) before a statement, between the
statement and the ledger insert, and between the ledger insert and commit,
on disposable SQLite files, then reopens through the real app path
(`openTestLocalDatabase` → `createLocalMigrationStore`); it also builds the
exact half-migrated file the old runner produced and proves workout rows,
outbox payloads and command ids survive reconciliation byte-for-byte.
CC-02B adds same-column-names impostor tables (wrong type, missing
PRIMARY KEY / NOT NULL / FOREIGN KEY, extra CHECK, missing composite key,
different DEFAULT) and impostor columns (extra CHECK / FOREIGN KEY, other
COLLATE): each fails closed, with schema, ledger and rows unchanged.

**What is and is not verified.** All of the above runs on Node's
`node:sqlite` (SQLite 3.53) through drizzle's real expo driver code and the
production migration store. The production store issues schema
inspection, migration SQL and the ledger insert through the one drizzle
session over the one `expo-sqlite` connection opened in `client.ts`, and
drizzle rolls back and rethrows on any error. **Not yet verified on a
device:** the same behavior under SQLCipher on iOS/Android — DDL rollback
inside `begin`/`rollback`, `pragma_table_info(?)` with a bound parameter,
and the exact `sqlite_master.sql` text that SQLCipher's SQLite version
stores — **UNVERIFIED**: if it differs, a legitimately half-migrated
database fails closed (no data loss) instead of reconciling. Until that
native run passes, these guarantees are claimed for `node:sqlite` only.

## Sync protocol

Full design and rationale: **ADR-0007**. Summary:

```text
Command types    START_WORKOUT_SESSION_V1, COMPLETE_SET_V1, REOPEN_SET_V1,
                 FINISH_WORKOUT_SESSION_V1 (added by Active Workout Core
                 Logger V1 — see docs/architecture/ACTIVE-WORKOUT.md and
                 ADR-0007's "Extension" section; every WorkoutSession this
                 slice originally created stayed ACTIVE forever, which is
                 now resolved)
Conflict rule    per-set revision, monotonically increasing, client-owned
                 — never timestamps, never generic last-write-wins
Idempotency      app.workout_command_receipts, command_id PRIMARY KEY —
                 durable, at-least-once-safe, race-checked
Ownership        AuthenticatedActor only — request bodies never carry
                 userId/athleteProfileId/coachId/role/isPro
```

```text
apps/mobile/src/workout/sync-engine.ts              orchestration only —
                                                     no SQLite/HTTP/React
                                                     imports; pure and
                                                     Vitest-testable
apps/mobile/src/workout/workout-sync-api-client.ts  the one place fetch()
                                                     is called
apps/mobile/src/workout/auth-token-provider.ts      DeferredSupabaseAuth
                                                     TokenProvider always
                                                     throws — no production
                                                     bypass; a real Supabase
                                                     sign-in flow is future
                                                     work (see
                                                     IDENTITY-AUTH.md)
apps/api/src/workout/workout-command-processing.ts  server-side apply +
                                                     idempotency + revision
                                                     gate + ownership
apps/api/src/workout/workout-sync.controller.ts     POST
                                                     /api/v1/sync/workout-commands
```

**Adjusted START (Available-Time Adaptation V1 Slice C).**
`START_WORKOUT_SESSION_V1` may carry an optional, additive
`availableTimeApplication`. It is written in the same local transaction as
the session row (`available_time_application_json`) and its outbox command.
Server-side, a forged or foreign one, or one the server proves contradicts
`available-time/v1`, is `REJECTED` with nothing persisted. Otherwise it is
accepted and classified `VERIFIED`/`STALE`/`UNVERIFIED` in
`app.available_time_applications`, without ever touching the immutable
snapshot. Every START, ordinary included, now has its planned provenance
checked (owned planned workout with only its own exercise/set identities,
or a genuinely unplanned prescription) before any write. See ADR-0007's extension and `docs/domain/
AVAILABLE-TIME-ADAPTATION-V1.md` §18.

### When sync runs (V1 trigger contract)

**Invariant: local logging never depends on successful network sync.** A
mutation commits to SQLite + the outbox first; sync is always
fire-and-forget afterwards and can never block, roll back or fail a
logged set.

Every sync request goes through one application-owned
`WorkoutSyncCoordinator`
(`apps/mobile/src/infrastructure/workout-sync-coordinator.ts`, created
once in `src/plan/plan-runtime.ts`), which calls the unchanged
`SyncEngine.syncPendingCommands()`. Triggers:

| Trigger | Where it is wired |
|---|---|
| Post-mutation (START, COMPLETE_SET, REOPEN_SET, FINISH) | `app/index.tsx`, `app/workout/[plannedWorkoutId].tsx` (START), `app/active-workout.tsx` (the rest) |
| Application start and foreground (`AppState` -> `"active"`) | `app/_layout.tsx` -> `startOutboxSyncRecovery` (`src/infrastructure/sync-recovery.ts`) |
| Network regain (connectivity unavailable -> available) | same registration; `expo-network` via `src/infrastructure/expo-network-connectivity.ts` |
| Bounded automatic retry after a retryable failure | the coordinator itself |

- **Retry backoff:** 2 s, 5 s, 10 s, then 30 s for every further attempt
  (capped, no jitter in V1). "Retryable" is the engine's own outcome: any
  command returned to `RETRY` (transport failure, 5xx, auth unavailable)
  or an unexpected engine error (the engine has already returned the
  batch to `RETRY` before rethrowing). `CONFLICT` and `REJECTED` are
  terminal and are never re-sent. A request-level 400/413/422 is not
  retried on the timer: it is isolated (see "Request-level refusals,
  BLOCKED and dependency holds" below).
- **Network regain alone is not enough:** Manual Test #4 (2026-10-04)
  showed a backend outage while the device stayed connected — no
  connectivity event ever fires. The retry timer is what recovers that
  case; network regain only shortens the wait when the device itself was
  offline. **Manually verified (Manual Test #4, CLOSED / PASS):** with the
  API stopped, two sets logged on Vostivo_Light stayed local while the
  coordinator backed off 2 → 5 → 10 → 30 → 30 s; after the API returned,
  with no tap, lifecycle event or new mutation, the next retry delivered
  the two original offline commands 9.3 s later (same session, contiguous
  `sessionSeq`, no duplicates, no REJECTED/CONFLICT), and the coordinator
  went idle.
- **Single flight:** at most one sync pass in flight and at most one retry
  timer. A trigger during a pass is coalesced into one follow-up pass; an
  immediate trigger replaces a pending retry timer. A pass that attempted
  a full batch (25) runs once more right away.
- **Idle when done:** a pass with nothing retryable clears the timer and
  resets the backoff — nothing polls the server while the outbox is empty.
- **Observability:** in `__DEV__` builds the coordinator logs attempt /
  retry scheduled / succeeded / recovered with counts, triggers and delays
  only — never tokens or command payloads. Release builds log nothing.
- **Native module:** `expo-network` needs a development build compiled
  after it was added. On an older build the connectivity source is simply
  absent (checked with `requireOptionalNativeModule`); every other
  trigger, including the retry, still works.

### Request-level refusals, BLOCKED and dependency holds (CC-03, D-SYNC-1)

**Why:** the API validates the WHOLE batch before processing any command
(global `ValidationPipe`, proven by `CC01-BATCH-001`): one invalid command
used to fail every request with 400, the client returned everything to
`RETRY`, and oldest-first selection re-sent the same batch forever — no
newer command ever left the device. Fixed client-side only; no server
contract, no wire format and no schema migration changed (`sync_outbox.status`
is unconstrained TEXT).

**Classification** (`workout-sync-api-client.ts`):

| Response | Typed failure | Outbox effect |
|---|---|---|
| network error, 5xx, 408, 429 | `TransientSyncFailure` | `RETRY`, timer backoff |
| 401 (after one refresh) | `SessionInvalidError` (paused) | `RETRY`, no timer |
| 409 `SYNC_OWNER_MISMATCH` | `RuntimeOwnerMismatchError` (paused) | `RETRY`, no timer |
| 400 / 413 / 422 | `RequestRejectedSyncResponse` | isolation (below) |
| other 4xx | unclassified error | `RETRY`, timer backoff (unchanged) |

A 400/413/422 is **never treated as proof that a command is invalid**. It
says only that the request as a whole was refused before anything was
processed, so re-sending is free of side effects (receipts make replay
idempotent anyway).

**Isolation** (`SyncEngine.isolateRequestRejection`): each command of the
refused batch is sent alone, oldest first.
- Accepted alone: its acknowledgement is applied as usual.
- Refused alone: it becomes `BLOCKED`, and every later command that may
  depend on it is not sent (held, stays `PENDING`/`RETRY`).
- Any other failure while probing (offline, 5xx, 429, 401, 409,
  unexpected): stop. Nothing unprobed is classified; everything returns to
  `RETRY` and the failure is handled as usual.
- **Every probe refused (two or more):** systemic (for example a
  client/server version mismatch). Nothing becomes `BLOCKED`, everything
  stays `RETRY`, and the pass reports `requestRejected`. The coordinator
  neither loops immediately nor schedules a timer, because no timer can fix
  this. The next real trigger tries again.
- A batch of one command refused with 400 is `BLOCKED` directly.

**`BLOCKED`** means refused by the server on its own at request level. It
is not proven permanently invalid and it is never `REJECTED`. It is out of
the automatic retry loop, never deleted, and command id, payload and local
workout data are untouched.

**Re-probe:** once per `SyncEngine`, i.e. once per app launch or owner
switch. Its first pass releases `BLOCKED` back to `RETRY`
(`releaseBlockedCommands`) and probes again.
- At the end of that pass, a released command the server did not
  acknowledge returns to `BLOCKED`, so it never silently looks resolved.
- If the server never got to judge it (paused, offline, 5xx, 401…), the
  release is repeated on a later pass of the same launch.
- A command refused again stays `BLOCKED` until the next launch. There is
  no tight retry loop.

**Dependency holds** (`src/workout/outbox-dependency.ts`, the one rule
shared by the engine and the repository). A command's dependency group is
its local workout session. `REOPEN_SET_V1` carries no session id, so it is
resolved through `local_performed_sets`. A command waits behind an
**earlier** `BLOCKED`/refused command when it may depend on it:
- **Same known session:** hold.
- **Candidate of unknown session** (malformed, or an unresolvable REOPEN):
  hold behind any earlier refusal. It is never assumed independent.
- **Refused command of unknown session:** it could belong to any session
  that already existed. Every session not *provably started after it* is
  held, meaning its START command must be positioned after the refusal.
  An unknown START position counts as "before".

Held commands are excluded before `LIMIT`, so they never consume the
selection window and independent sessions keep syncing. Order is
`created_at`, then `rowid`, so commands issued in the same millisecond keep
their issue order. A command with no refusal ahead of it is sent normally,
even if malformed, and the server decides (for example `REJECTED`).

**User-visible unresolved state.**
- **Source:** `WorkoutRepository.getUnresolvedSyncSummary()` returns
  `{blocked, waitingOnBlocked, rejected, conflicted}`, and
  `WorkoutSyncCoordinator.requestRejectedAtLastAttempt` reports the
  systemic case, which is recorded nowhere in the outbox.
- **Today shows** a calm, non-blocking line when any of these is non-zero
  or true: *"Some workout records haven't synced yet. They're saved on this
  device."* (`src/workout/unresolved-sync-notice.ts`, `app/index.tsx`).
- **What does not show it:** ordinary pending or offline commands, because
  they sync on their own.
- **No action is offered,** because no in-app retry or resolve action
  exists. The absence of the line is never presented as "all synced".
- **When it is re-read:**
  - after every settled sync pass (`onPassSettled`), which covers
    mutation, launch, foreground resume, network regain and retry;
  - on every Today reload or focus.
- **A failed read keeps the last known state.**

**Recovery limitations (known, accepted for V1):**
- `REJECTED` and `CONFLICT` are terminal: they are **never re-sent or
  recovered automatically**. The record stays on the device and keeps the
  Today notice visible. There is no manual resolve UI yet.
- A `BLOCKED` command is recovered automatically only if a re-probe on a
  later launch is accepted, for example after a server or app update.
  Until then it, and everything held behind it, stays unsynced.
- When a full batch holds a single session, only one probe is possible. A
  systemic refusal then cannot be told apart from a bad command, and that
  session's first command becomes `BLOCKED`. This is bounded (one pass per
  session, no timer), visible and re-probed on the next launch.
- After a systemic refusal, every real trigger re-probes: about one request
  per session in the batch plus one.
- While a re-probe pass is in flight, the released commands are briefly
  `RETRY`. Today reads after the pass settles.
- While anything is `BLOCKED`, pending selection reads all pending commands
  (plus each session's START) without `LIMIT`. This is negligible at real
  outbox sizes.
- Native (device) verification of CC-03 is still pending.

## Planned workout occurrence authority (V1, 2026-10-05)

```text
PLANNED WORKOUT OCCURRENCE AUTHORITY

First valid server-accepted START of a planned workout  -> CANONICAL
Later valid, distinct START of the same occurrence      -> SECONDARY
                                                           history preserved
                                                           no planned progression authority
```

**CANONICAL != "the only real workout".** CANONICAL means *the one session
that represents this planned occurrence for Plan/Today and planned
progression semantics*. A SECONDARY session, for example the same planned
workout started offline on a second device, is still legitimate historical
workout reality:
- it is accepted;
- it keeps its own session id, command ids, immutable snapshot and (if
  adjusted) its Available-Time application;
- it receives COMPLETE_SET / REOPEN_SET / FINISH normally;
- it stays in history;
- it is never deleted, rewritten or merged.

**Model.** `app.planned_workout_occurrence_claims` (migration `0017`) has
one row per (`user_id`, `planned_workout_id`), enforced by a unique index,
pointing at `canonical_workout_session_id` (unique, FK to
`workout_sessions`). The role is **derived**, never stored: CANONICAL when
`session.id == canonicalWorkoutSessionId`, SECONDARY when another session
holds the claim of the same owned planned workout, none for an unplanned
session. There is no second mutable field to disagree with the claim.
`planned_workout_id` is a plain reference, not an FK, by the same history
rule as the session snapshot. Vocabulary is `OccurrenceSessionRole`
(`@vostivo/domain`). The single implementation is
`@vostivo/progression-application`'s `planned-occurrence-authority.ts`,
shared by the API and the worker. Nothing on the wire changed.

**START.** Inside the existing START transaction, after provenance, BOLA and
Available-Time checks and the session insert, a PLANNED start runs
`INSERT ... ON CONFLICT DO NOTHING` on the claim:
- created → CANONICAL;
- otherwise the existing claim is read → SECONDARY, still `APPLIED`.

Concurrent STARTs of one occurrence serialize on the unique index. Exactly
one wins and the other becomes SECONDARY, with no error and no deadlock
(each START only locks its own session row plus that one index entry).
Database uniqueness works across API instances; there is no process-local
lock. Normal and Available-Time adjusted STARTs compete for the same claim.
Unplanned STARTs never claim, and are never grouped. Replays and
second-commandId STARTs of an existing session take the existing
idempotent path and never touch the claim. A foreign planned workout is
rejected before any claim logic.

**Stable, no automatic promotion (V1).** The claim is never updated: no
re-election by finish order, set count, client `startedAt`, UUID time or
server-visible completeness, because another device may still hold unsynced
data. There is no merging, no last-write-wins, no "most complete wins", no
deletion and no fake FINISH. Future explicit reconciliation (promotion,
merge, conflict UX) is deferred and needs its own decision.

**Reads.** `findMatchingSessions` (Plan overview, Workout Preview, the
Available-Time preview's already-started guard) resolves only through the
claim, so the canonical session is always returned, whatever the secondary's
status, set count or row order. There is no "last row wins".
`WorkoutHistoryService` (raw history) does not deduplicate: secondary
sessions remain visible there.

**Progression.**
- `ProgressionEvaluationService.evaluateAndPersist` returns the final,
  stable `NOT_CANONICAL_OCCURRENCE_SESSION` for a SECONDARY anchor. The
  worker job completes normally (`skipped`), with no decision, no
  application and no retry.
- A SECONDARY session is also excluded as prior-exposure evidence, so one
  planned occurrence is never counted twice. Either sync order yields at
  most one planned-occurrence outcome.
- Unplanned sessions have no role and keep their existing progression
  semantics unchanged.

**Local device.** Nothing is pushed to clients. A device whose local ACTIVE
session the server classified SECONDARY still resumes, logs and finishes
it. Informing the athlete is future conflict UX.

**Migration compatibility backfill.** Migration `0017` gives every existing
planned occurrence exactly one claim: the earliest *server* `created_at`
session whose snapshot `prescriptionId` is a planned workout **owned by that
same user**, with `id` as the tie-breaker. That mirrors the runtime "first
server-accepted START" rule. Other sessions are untouched and SECONDARY by
derivation. Claim ids are UUIDv7, built inline because PostgreSQL 17 has no
`uuidv7()`. The backfill is idempotent.

**Observability.** The API logs "occurrence claimed" and "accepted as
SECONDARY" with session ids only. The worker logs "progression skipped:
SECONDARY". No payloads and no secrets.

## Server schema

`app.workout_sessions`, `app.performed_exercises`, `app.performed_sets`,
`app.workout_command_receipts`, `app.workout_change_cursor`
(`packages/database/src/schema/workout.ts`). All foreign keys are
`NO ACTION` (never `CASCADE`) — matching the rest of the schema.
`prescription_snapshot` is `jsonb`: this does not violate the Load
Model's "no JSON load blob" rule, since that rule is about load *data*
(which stays in typed columns on `performed_sets`), not the opaque
versioned prescription document.

`app.workout_change_cursor` is durable but has **no consuming read/pull
endpoint yet** — deliberately deferred. Multi-device convergence (a
second device seeing a set completed on the first) is out of scope for
this slice.

## Native runtime verification (mandatory, not unit-tests-only)

Performed on a real Android emulator (Pixel 7 AVD), real SQLCipher-
encrypted local database, real local Postgres, real local API, and a real
local JWT/JWKS test issuer exercising the exact production
`SupabaseJwtVerifier` code path (a local issuer URL, not a bypass — see
IDENTITY-AUTH.md).

Two build variants were needed, for a reason worth recording: a
**debug dev-client build cannot prove the "offline, force-stop, relaunch"
step**, because it fetches its JS bundle from Metro at every cold start —
with the device's Wi-Fi/mobile-data disabled, Metro is unreachable and the
app cannot even boot. A **release build** (JS/Hermes bytecode embedded at
build time, no Metro dependency at runtime) is the only build variant that
can be genuinely offline across a process restart, so that is what this
slice's offline evidence was gathered against.

Verified, in order, fully offline (Wi-Fi and mobile data both disabled on
the device):

1. Start a workout session — local write succeeds instantly, no network
   attempted.
2. Complete a set (40kg, `PER_IMPLEMENT`, 10 reps) — local write succeeds,
   `revision = 1`.
3. Force-stop the app process, relaunch — same `WorkoutSession` id, same
   `PerformedExercise` id, same `PerformedSet` id, exact reps/load
   preserved, active session fully reconstructed from local rows alone.
4. Reopen the set (twice) — `completionState` becomes `REOPENED`,
   `completedAt` becomes `null`, revision correctly increments each time
   (1 → 2 → 3).

Then, network re-enabled:

5. Sync — all 4 queued outbox commands reach the real local API, are
   applied against real local Postgres, and the outbox reaches `SYNCED`
   for every command.
6. Canonical Postgres rows verified via `psql` to match the device state
   exactly (same ids, same revision, same `completion_state`).
7. **Replay**: the already-applied `COMPLETE_SET_V1` command was resent
   verbatim (same `commandId`) directly against the API. Result: outcome
   `DUPLICATE`, zero duplicate rows in `app.performed_sets`, and — because
   the set had since moved on to `REOPENED`/revision 3 — the stale replay
   did **not** revert that newer state. This is the concrete scenario
   ADR-0007's revision rule and the receipts table exist to guarantee.

A temporary, development-only verification screen
(`apps/mobile/app/dev-workout-verify.tsx`, deep-link-driven, logging
structured results for `adb logcat`) was used to drive this and has since
been removed, along with the temporary local JWKS test server script — as
with the SQLCipher and UUIDv7 native gates before it.

### Known dev-tooling limitations found during this verification (not product bugs)

- **`tsx watch` (the `apps/api` `dev` script) silently dropped
  implicit-type constructor injection.** `AuthGuard`'s second constructor
  parameter (`IdentityResolverService`, injected by type inference, no
  explicit `@Inject()`) resolved to `undefined` at runtime under
  `tsx watch` specifically — esbuild's decorator-metadata emission does
  not fully replicate `tsc`'s for this pattern. The compiled build
  (`pnpm build && node dist/main.js`) was unaffected (proper `tsc`-emitted
  metadata) and is what this slice's native verification actually ran
  against. **Resolved in the Post-WDI Tooling Fix Pass**: `apps/api`'s
  `dev` script now runs `tsc -b tsconfig.build.json -w` alongside
  `node --watch dist/main.js` (via `concurrently`) instead of `tsx` —
  identical compiler and emit to the production build, just watched, so
  the two paths cannot diverge again by construction. The NestJS
  constructor-injection style used throughout this codebase was always
  correct and idiomatic; the gap was in the `dev` iteration script only.
- **Metro requires `resolver.unstable_enableSymlinks = true` for this pnpm
  workspace.** `apps/mobile` had no `metro.config.js` at all; Metro's
  default resolver cannot follow the nested symlinks pnpm creates for a
  workspace package's own dependencies (e.g. `packages/domain`'s
  `uuidv7`), only the top-level workspace-package symlink itself. Added
  `apps/mobile/metro.config.js` with `watchFolders` set to the monorepo
  root and `unstable_enableSymlinks: true`. `expo-doctor` flags this
  override by design (it cannot know about the pnpm layout) — this is an
  intentional, necessary, documented deviation, not an oversight.

## Security review (spec section 56)

- Ownership always derives from `AuthenticatedActor`, never the request
  body — confirmed by code inspection and by the BOLA negative test
  (WDI-SYNC-008).
- JWT verification is unchanged from the Auth/Identity foundation —
  still `jose` + JWKS, still cryptographic, still no shared secret.
- No service-role or database credentials exist in `apps/mobile` or
  `apps/web` — confirmed via grep; the mobile sync client only ever holds
  a short-lived bearer access token.
- Server command receipts are DB-durable
  (`app.workout_command_receipts`, `command_id PRIMARY KEY`) — a restart
  or crash mid-sync cannot lose idempotency state.
- A duplicate command cannot duplicate side effects — proven via the
  receipts-table race test and the native replay test above.
- Performed reality is bound to the session's own immutable snapshot
  (Full Athlete Journey E2E Audit V1, 2026-10-17): `COMPLETE_SET_V1` is
  `REJECTED` when its `prescriptionExerciseId` is not a slot of the
  session's `prescription_snapshot`, its `exerciseRef` differs from that
  slot's (non-null) `exerciseRef`, its `prescriptionSetId` is not one of
  that slot's sets (e.g. a set Available-Time removed), an unplanned
  exercise (`prescriptionExerciseId: null`) claims a planned set, or an
  existing performed exercise is re-pointed at another slot. This extends
  the START identity rule (Temporary Equipment Slice C) to performed
  reality; the mobile client already only sends snapshot identities.
  Legacy slots without an `exerciseRef` keep the earlier behavior.
  Test: WDI-SYNC-011.
- An existing `performedSetId` can only ever be updated by its own set's
  command (CORE-FIX-01, CORE-AUDIT-01 F-01). Owning the command's session
  proves nothing about a set id that already exists elsewhere. Before this
  fix, `COMPLETE_SET_V1`'s `ON CONFLICT (id) DO UPDATE` let an athlete
  overwrite another athlete's set (even in a `COMPLETED` session) from
  their own session. Now another athlete's set is a stateless foreign-
  ownership `REJECTED` (no receipt, no cursor row, generic outcome, nothing
  about the foreign row revealed). The same athlete's set under another
  performed exercise or session is a same-owner `REJECTED` with a persisted
  receipt, before any write. The upsert re-asserts
  `performed_exercise_id = excluded.performed_exercise_id` atomically on the
  conflicting row, so a concurrent insert of the same id is never written
  into either. Tests: OWN-001..011
  (`performed-set-ownership.integration.test.ts`), including a 20-round
  real concurrent race.
- A structurally malformed prescription snapshot can no longer turn sync
  into a deterministic HTTP 500 (CORE-FIX-02, CORE-AUDIT-01 F-02).
  - **Root cause:** START checked only the snapshot's top level
    (`schemaVersion`, `prescriptionId`, `name`, `exercises` is an array).
    An unplanned START with e.g. `exercises: [null]`, an exercise without
    `sets`, or `sets: [null]` was `APPLIED` and persisted. The next
    `COMPLETE_SET_V1` for that session threw a `TypeError` while matching
    the snapshot, so the whole batch returned 500. The mobile client treats
    5xx as transient (`RETRY`) and re-sends the same oldest-first batch, so
    every later command, including other sessions, never synced. CC-03
    isolation covers only 400/413/422 and does not apply.
  - **START** now also requires every exercise to be an object with string
    `prescriptionExerciseId`, `exerciseRef` string or null, string
    `displayName`, number `order`, `substitution` absent or an object, and
    `sets` an array of objects with string `prescriptionSetId` and number
    `order`. Anything else is `REJECTED` "malformed command": no session,
    no receipt, no cursor row, no job. `setType`, `restSeconds`,
    `targetReps` and `targetLoad` are deliberately not required, so legacy
    snapshots still sync. Compatibility (SNAP-008): the only previously
    accepted shape that is now refused is an unplanned exercise with no
    `exerciseRef` key. No producer emits it, the planned path already
    refused it, and every planned set of such a session was already
    `REJECTED`.
  - **`COMPLETE_SET_V1`** reads the persisted snapshot as untrusted JSON. A
    row stored before this fix with a broken envelope gives a same-owner
    `REJECTED` with a persisted receipt. Nothing is written, and the row is
    never rewritten.
  - **Infrastructure failures** (database or transaction errors) still
    throw and return 5xx, so the client keeps retrying. No arbitrary 500 is
    converted into `REJECTED`.
  - **Unchanged:** per-command transactions, receipt semantics, the wire
    format and the mobile client.
  - **Remaining limits:**
    - Progress and progression-evidence readers still cast the persisted
      snapshot. Rows stored before this fix can still fail those reads, but
      never sync.
    - Nested set fields (`targetReps`, `targetLoad`, `setType`) are not
      validated.
    - Any other deterministic server bug that returns 500 would still stall
      the outbox. CC-03's retry policy is unchanged.
  - **Tests:** SNAP-001..008 (`snapshot-validation.integration.test.ts`,
    real HTTP pipeline plus Postgres).
- A `REJECTED` sync outcome cannot delete local workout reality — true by
  construction: `OutboxPort`'s interface has no delete-workout-data
  method at all, so `SyncEngine.applyAcknowledgement`'s `REJECTED` branch
  is structurally incapable of touching `local_performed_sets`/
  `local_performed_exercises`/`local_workout_sessions`, only the outbox
  row's own status.

## Explicitly deferred (tracked, not forgotten)

- Multi-device pull/cursor consumption (`app.workout_change_cursor` has
  no reader yet).
- Production Supabase sign-in on mobile (`DeferredSupabaseAuthTokenProvider`
  always throws; see IDENTITY-AUTH.md).
- Any polished Active Workout UI, Plan UI, Training Engine progression,
  full Program domain, coaching, subscriptions, analytics.
- RIR / rate-of-perceived-exertion logging (needs its own domain
  decision).
