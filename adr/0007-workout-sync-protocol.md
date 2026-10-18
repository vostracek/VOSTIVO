# ADR-0007: Workout offline sync protocol — domain-aware outbox, revision-gated conflict resolution, durable idempotency

- **Status**: Accepted
- **Date**: 2026-09-03

## Context

The Workout Data Integrity vertical slice requires that a completed set
never depend on network availability, and that Athlete-authored history
never gets silently lost, duplicated, or overwritten by network retries
or out-of-order delivery — while remaining a narrow, additive slice (no
Training Engine, no Program domain, no coaching).

Three ordinary approaches were explicitly ruled out by the task
specification before this ADR was written:

- **Generic last-write-wins** (compare-and-set on a `updatedAt` timestamp):
  clocks drift, and a legitimate REOPEN arriving after a stale retried
  COMPLETE must not be silently reverted by whichever happened to have the
  later wall-clock timestamp.
- **Timestamp-only ordering** for any conflict resolution: same problem —
  device clocks are not a trustworthy total order.
- **Full event sourcing**: rejected as premature/generic infrastructure
  for a single vertical slice (`CLAUDE.md`'s "no premature abstraction"
  and "no event sourcing" working conventions).

## Decision

1. **Domain-aware outbox with exactly three command types** —
   `START_WORKOUT_SESSION_V1`, `COMPLETE_SET_V1`, `REOPEN_SET_V1`
   (`packages/domain/src/workout/outbox.ts`,
   `packages/contracts/src/workout-sync.ts`). Not a generic
   "mutation log" — each command is a real domain intent, so the server
   can apply idempotency and conflict rules specific to what the command
   actually means, rather than a generic diff/patch.

2. **Monotonically increasing per-set revision, not timestamps, resolves
   conflicts.** Every `COMPLETE_SET_V1` for a newly-created set starts at
   revision 1; every `REOPEN_SET_V1` carries `currentRevision + 1`
   computed on-device at the moment of the local mutation. The server
   applies a mutation only if `incoming.revision > stored.revision`
   (`ON CONFLICT ... DO UPDATE ... WHERE revision < excluded.revision` in
   `apps/api/src/workout/workout-command-processing.ts`). A stale/retried
   command with a lower revision is recognized as superseded and never
   reverts newer state — proven under real concurrent delivery in
   `workout-sync.integration.test.ts` (WDI-SYNC-006) and again natively
   against real Postgres during this task's mandatory device verification
   (see the final report).

3. **Durable idempotency via a receipts table, not a client-visible
   dedupe window.** `app.workout_command_receipts` has `command_id` as a
   real `PRIMARY KEY` — at-least-once delivery is safe by construction: a
   redelivered `commandId` is detected before any mutation logic runs,
   and returns the original outcome (mapped to `DUPLICATE` for the
   client) without re-executing side effects. A `DuplicateCommandRaceLoss`
   sentinel handles the race where two redeliveries reach the insert
   concurrently: the loser rolls back its transaction and re-reads the
   winner's receipt rather than either double-applying or erroring.

4. **Client mutation and outbox enqueue share one local SQLite
   transaction.** `WorkoutRepository.completeSet`/`startWorkoutSession`/
   `reopenSet` each write the local reality row and the `sync_outbox` row
   inside a single `db.transaction()` — there is no window where a set is
   marked completed locally but the command to sync it was never
   durably queued (or vice versa).

5. **Ownership is authenticated-actor-only, never request-body-derived.**
   Every mutation path in `workout-command-processing.ts` establishes
   ownership by joining from `AuthenticatedActor.userId` down to the
   target row before writing anything — the wire contracts
   (`WorkoutCommandV1`) do not even have a field for `userId`,
   `athleteProfileId`, or `role`. Verified negative (BOLA) test:
   `workout-sync.integration.test.ts` WDI-SYNC-008.

## Alternatives considered

- **CRDTs / operational transforms**: far more machinery than three
  well-understood command types need; would also make the "never
  silently revert a REOPEN" invariant harder to reason about, not easier.
- **Server-generated IDs on sync**: rejected outright by the task
  spec — a set logged offline must keep the exact ID the athlete's device
  already showed them; regenerating on sync would break the "same ID
  after force-stop/relaunch" guarantee this slice exists to prove.
- **Optimistic locking via a client-supplied `updatedAt`**: same
  clock-trust problem as last-write-wins; revision is a per-entity
  monotonic counter the client itself owns and increments, immune to
  clock skew.

## Consequences

- **Easier**: adding a fourth command type later (e.g. a future
  `DELETE_SET_V1`) is additive — no existing command's handling changes.
  The receipts table also gives a durable audit trail of every command
  ever accepted or rejected, for free.
- **Harder**: the revision counter is scoped to a single `PerformedSet`
  row; a future feature that needs cross-row ordering (e.g. reordering
  sets within an exercise) will need its own explicit scheme, not a reuse
  of this one.
- **Known gap, deliberately deferred**: `apps/mobile`'s `SyncEngine` only
  pushes commands; the pull/cursor side
  (`app.workout_change_cursor`) is durable on the server but has no
  consuming endpoint yet — multi-device convergence (Device B seeing
  Device A's completed set) is out of scope for this slice and tracked as
  a known limitation in `docs/architecture/WORKOUT-DATA-INTEGRITY.md`.

## Extension: `FINISH_WORKOUT_SESSION_V1` (Active Workout Core Logger V1)

Exactly the anticipated additive case from "Consequences" above. A fourth
command type represents workout completion — `workoutSessionId` +
`completedAt`, no revision field. Unlike `COMPLETE_SET_V1`/
`REOPEN_SET_V1`, there is nothing to compare against: setting the same
terminal `COMPLETED` state twice (even via two different `commandId`s,
e.g. a genuine retry after a lost acknowledgement) converges to identical
canonical state by construction, so no revision counter was introduced
for it. Ownership, the receipts-table idempotency, and the durable
one-transaction local write are all reused unchanged — no existing
command's handling changed. See `docs/architecture/ACTIVE-WORKOUT.md` for
the full design and native verification evidence.

## Extension: Finish causal boundary — `sessionSeq` / `finishSeq` (Active Workout Finish Causal Boundary Fix)

The Finish extension above established a one-way `ACTIVE -> COMPLETED`
transition, but neither the client nor the server gated
`COMPLETE_SET_V1`/`REOPEN_SET_V1` on that transition. That left the
protocol unable to distinguish two cases that look identical on the wire:

- a command legitimately **created before** the local Finish, delivered
  late (e.g. queued offline) — this **must** still apply, per this ADR's
  existing per-set revision semantics;
- a new Active Workout mutation logically **created after** Finish — this
  **must not** be accepted as ordinary logging against a session that has
  already ended.

Timestamps were explicitly rejected as the discriminator (clock skew,
offline clients, no ordering guarantee across devices). Instead:

- **`sessionSeq`** (positive integer) is added to `CompleteSetCommandV1`
  and `ReopenSetCommandV1`. It is a **per-session** monotonic counter —
  the same shape and purpose as this ADR's existing per-set `revision`,
  but scoped to the whole session rather than one set. It is allocated
  client-side, atomically, in the same local transaction as the mutation
  and its outbox command; a retry/redelivery of the same command reuses
  its original `sessionSeq`, never allocates a new one.
- **`finishSeq`** (non-negative integer, 0 valid) is added to
  `FinishWorkoutSessionCommandV1`. It is captured, client-side, inside the
  same local transaction as the `ACTIVE -> COMPLETED` transition, as
  "whatever `sessionSeq` was last issued for this session at that
  instant." It is the watermark: once a session is `COMPLETED`,
  `finishSeq` is never moved by a later, different `FINISH` command
  (idempotent replay of the *same* `commandId` is a no-op, as before).
- **Server gate**: `applyCompleteSet`/`applyReopenSet` first apply this
  ADR's existing ownership + per-set revision rules unchanged. Only when
  the session is already `COMPLETED` do they additionally check
  `command.sessionSeq <= session.finishSeq` (causally eligible — apply
  normally) vs. `command.sessionSeq > session.finishSeq` (a genuinely new
  post-Finish mutation — `REJECTED`). `finishSeq` never replaces or
  bypasses the per-set revision gate; it only decides whether that gate
  is consulted at all for a completed session.
- **DB-level uniqueness**: `workout_command_receipts` carries
  `(workout_session_id, session_seq)` under a partial unique index (`WHERE
  session_seq IS NOT NULL`), so sequence reuse across two different
  commands is rejected at the database, not only in TypeScript. Populated
  only once ownership (BOLA) is confirmed — never for a rejected wrong-
  owner attempt — so a hostile probe against someone else's session can
  never pre-occupy the real owner's future sequence slot.
- **Client-side terminal invariant**: `completeSet()`/`reopenSet()` check
  the session's local status inside the same transaction that would
  otherwise allocate a `sessionSeq` and write the mutation. If the session
  is already locally `COMPLETED`, they do neither — no performed-set
  mutation, no sequence allocated, no outbox command enqueued — and
  return a typed `SESSION_ALREADY_COMPLETED` outcome instead of throwing
  or silently no-op'ing. This does not depend on the UI being unmounted.
- **Threat model**: `sessionSeq`/`finishSeq` gives causal/lifecycle
  ordering that protects against stale or buggy clients and out-of-order
  delivery. It is **not** a cryptographic guarantee against a hostile
  owner modifying their own client to fabricate a low `sessionSeq` for a
  command they create after Finish — that class of tampering is bounded
  by authorization (BOLA/ownership), not by this mechanism. This ADR does
  not claim otherwise.
- **Concurrency**: sequence allocation and the Finish transition are
  serialized by the same single local SQLite transaction mechanism this
  ADR already relies on for revision allocation — there is no `await`
  inside either transaction's callback, so a "complete" and a "finish"
  initiated nearly simultaneously always resolve to one deterministic
  order: either the complete's transaction commits first (its
  `sessionSeq` is then included in `finishSeq`), or the finish's
  transaction commits first (the complete's transaction then observes
  `COMPLETED` and is rejected). There is no interleaving that lets a
  performed-set mutation commit successfully while being excluded from
  the watermark.

See `docs/architecture/ACTIVE-WORKOUT.md`'s "Command ordering around
Finish" section for the full design, the `AW-ORDER-*` test list, and
native verification evidence.

## Extension: optional `availableTimeApplication` on `START_WORKOUT_SESSION_V1` (Available-Time Adaptation V1 Slice C)

This is an additive, optional field within V1. It follows the same precedent as `setType`/`exerciseRef`/
`sessionSeq`, and it adds no new command type and no START V2. It is
present only when the athlete explicitly chose "Start adjusted workout"
from an `ADJUST_SESSION` preview. In that case `prescription` is already the
adjusted (retained-sets-only) snapshot, and the field is the immutable
`AvailableTimeApplicationV1` (TODAY_ONLY provenance). An ordinary START
payload is byte-for-byte unchanged, and every pre-existing command remains
processable.

The local START stays one transaction: session row, snapshot, application
JSON and outbox command. The server keeps its existing receipt idempotency,
`commandId`/UUIDv7 rules and session-sequence semantics, and adds two
separate steps inside the same START transaction:

- **Integrity, which can reject.** The snapshot must be exactly the claimed
  retained sets. The planned workout must be owned by the athlete. The source
  ProgramVersion must be that workout's. Every exercise and set id must be
  that workout's own. A violation means `REJECTED` and nothing is persisted,
  the same as any BOLA failure.
- **Verification, before any write.** `available-time/v1` is re-run over
  the owned source. A proven contradiction (fingerprint, result kind,
  durations or exact diff) is `REJECTED` like any integrity failure.
  Otherwise the application row is written with `VERIFIED` (exact and
  current), `STALE` (exact but no longer current) or `UNVERIFIED` (owned
  source genuinely not re-evaluable). UNVERIFIED is never a fallback for
  mismatching data. A stale preview never discards the locally started
  workout.

Closure patch: **every** START, ordinary or adjusted, now has its claimed
Plan provenance checked before any write (`resolveStartProvenance`). A
planned `prescriptionId` must be the athlete's own, with only its own
planned exercise/set identities. An unplanned one may carry no planned
identity. Violations return a uniform reason-less `REJECTED`. Multi-device
starts of one planned occurrence remain an explicit unresolved V1 item
(see the spec §18).

See `docs/domain/AVAILABLE-TIME-ADAPTATION-V1.md` §18.

## Extension: planned workout occurrence authority (Planned Workout Occurrence Authority V1)

There is no wire change. Two legitimate offline STARTs of the same owned
planned workout, with distinct `workoutSessionId`s, are **both** `APPLIED`.
The first one the server accepts claims the occurrence
(`app.planned_workout_occurrence_claims`, a unique (user, planned workout)
row written in the START transaction with `ON CONFLICT DO NOTHING`) and is
CANONICAL. The other is SECONDARY by derivation. There is deliberately no
unique constraint on sessions and no rejection, since that would discard
real offline workout history.

The claim is stable in V1: no promotion, no merge, no last-write-wins.
Plan/Today and planned progression read only the canonical session. Command
idempotency, receipts, `sessionSeq`/`finishSeq` and session lifecycle are
unchanged, and a SECONDARY session accepts every later command normally.
See `docs/architecture/WORKOUT-DATA-INTEGRITY.md`.
