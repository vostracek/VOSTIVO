# Vostivo — Active Workout Core Logger V1

Scope: the real gym logging experience, replacing the temporary Active
Workout placeholder from the Plan & Workout Prescription Vertical Slice.
LOG FIRST, EXPLAIN ON DEMAND — Previous -> Today target -> Load -> Reps ->
Complete, in one row, no modal. No analytics, no Progression/Adaptation
Engine, no Athlete Memory, no Coach functionality, no exercise swapping,
no pain/discomfort workflow, no supersets, no arbitrary program editing,
no social/gamification. See `CLAUDE.md` for what this slice deliberately
excludes.

## Core UX pattern

```text
Set N
Previous    40kg x 10          (compact, restrained "-" when unavailable)
Target      8-12 reps . 40kg
Load input  [___] kg
Reps input  [___]
Complete / Reopen
```

RIR/Effort is deliberately not in the row — the architecture (a plain
input row, not a fixed-width layout) allows adding it later without a
redesign, once a validated RIR policy exists (see WDI's precedent for
omitting RIR entirely rather than inventing one).

Full-screen mode: no Today/Plan/Progress/Profile bottom navigation while
a workout is active (`app/active-workout.tsx` never renders `BottomNav`,
same as the placeholder it replaces). A dedicated header carries only
workout-level information: name, elapsed duration, compact rest timer,
Finish.

## `getActiveWorkoutSession()` is the only authoritative source

React component state is never canonical (spec section 4/42). On mount,
and after every mutation, the screen re-reads
`WorkoutApplicationService.getActiveWorkoutSession()` — the same call the
Plan slice's placeholder already used — which now also returns runtime
state (`drafts`, `restTimer`) alongside performed reality, so the UI has
one source to read rather than several independent calls. If no session
exists, a safe recovery state (a message and a "Back to Plan" button) is
shown — never fabricated workout data.

The prescription rendered is the session's own immutable
`WorkoutPrescriptionV1` snapshot (`session.prescription`) — this screen
never refetches Plan/Program data, so a later Plan edit can never alter
an active workout mid-session (the same guarantee `PLAN-005` already
proved for the snapshot itself).

## `ExerciseIdentityV1` — the narrow boundary for "Previous"

`packages/domain/src/exercise-identity.ts` — `ExerciseIdentityV1` is a
type alias (`string`), not a new concept: it names and reuses the
already-existing opaque `exerciseRef` pointer
(`PlannedExercise.exerciseRef` / `PrescribedExerciseV1.exerciseRef`),
which existed before this slice but was never populated or used for
cross-session matching.

The reason this boundary is needed at all: `PerformedExercise
.prescriptionExerciseId` identifies one specific `PlannedWorkout`'s
`PlannedExercise` row — stable within one training cycle/week, but a
**new** row (new id) every time the same exercise is scheduled in a
different cycle. There is therefore no existing stable cross-session key
to match "Bench Press this week" against "Bench Press last week" without
`exerciseRef`.

The fix, kept deliberately narrow (NOT the full Exercise Taxonomy):

- `local_performed_exercises` gains an `exercise_ref` column — a snapshot
  of `PrescribedExerciseV1.exerciseRef` taken at completion time
  (`CompleteSetInput.exerciseRef`).

**Superseded by Progression Prerequisites V1 (2026-09-09):** the line
above originally stopped at "never synced to the server (purely a local
read-model convenience, not part of the WDI wire contract)." Progression
Engine V1 needs server-side cross-session/cross-device evidence
assembly, which a local-only pointer cannot provide — `exerciseRef` is
now also denormalized onto `CompleteSetCommandV1` and persisted as a
real, synced, indexed, `NOT NULL` column on `app.performed_exercises`
(existing rows deterministically backfilled from their session's own
`prescription_snapshot`; the one row whose own snapshot had no
exerciseRef to recover was conclusively synthetic dev-verification
fixture data and was removed as an explicit one-off cleanup rather than
backfilled to null — see Exercise Ref Legacy Reconciliation, 2026-09-09).
See docs/domain/PROGRESSION-ENGINE-V1.md §25/OD-1 for the full reasoning
and `WorkoutHistoryService`
(`apps/api/src/workout/workout-history.service.ts`) for the one new
server-side capability this enables.
- The dev seed fixture (`packages/database/src/seed-dev-plan.ts`) now
  assigns a deterministic per-exercise slug (`"bench-press"`,
  `"incline-dumbbell-press"`, ...) as a stand-in identity key — explicitly
  documented as a fixture-only shim, not a real catalog assignment.
- `WorkoutRepository.getPreviousExercisePerformance(exerciseRef,
  excludingSessionId)` returns the most recent OTHER session's performed
  sets for that `exerciseRef`, ordered — or `undefined` if `exerciseRef`
  is `null` or no prior performance exists. The UI shows a restrained "—"
  in that case; it never fuzzy-matches by display name and never
  fabricates a value.

If a genuinely incompatible architectural conflict had been found here,
this would have stopped for a STOP/REPORT/PROPOSE cycle — it was not:
`exerciseRef` already existed exactly for this purpose, unused.

## Draft persistence — input durability

`local_set_drafts` (mobile-only, never synced) stores in-progress
load/reps input before a set is completed — keyed by
`(workout_session_id, prescription_exercise_id, prescription_set_id)`,
which exist before any `PerformedSet` row does. A draft is cleared in the
**same transaction** as the real completion write once the athlete taps
Complete (`WorkoutRepository.completeSet()`), so it never coexists with,
or overwrites, canonical `PerformedSet` reality.

`WorkoutRepository.saveSetDraft()` is invoked two ways from `SetRow`
(`app/active-workout.tsx`): immediately on blur, and via a **~400ms
debounce** on every keystroke (`scheduleDraftFlush`/`flushDraft`) — not
per keystroke ("reasonable write efficiency," spec section 33), but short
enough to survive the process being killed abruptly while the field is
**still focused** (a real OS low-memory kill, a swipe-away, or
`am force-stop` — none of these fire a blur event). The debounce reads
from refs updated synchronously in the input's `onChangeText`, not from
React state closed over at a stale render, so it always flushes the true
latest keystroke when it fires.

**Verified natively** (final review pass): typed "8" into a reps field,
force-stopped the app ~1s later with the field still focused (no blur,
no Complete tap) — relaunched, the draft "8" was still there. Before this
fix, the same scenario (draft saved on blur only) lost the input entirely
after relaunch — confirmed as a real, reproducible gap first, then fixed.

**Known, accepted residual gap**: a kill occurring *within* the ~400ms
debounce window — typed then killed near-instantly, no pause — can still
lose the very latest keystroke(s), confirmed by the same native test with
no pause inserted. No debounce can close this without per-keystroke
writes, which the spec explicitly rules out; this trade-off is deliberate
and documented here rather than silently accepted.

Input prefill priority (`resolvePrefill()` in `app/active-workout.tsx`):

```text
1. an existing COMPLETED/REOPENED PerformedSet's actual values
2. a saved draft
3. the prescription target, only when it is a single concrete value
   (EXACT reps and/or a target load) — a RANGE's arbitrary bound is
   never used to prefill
4. Previous performance, where available
5. empty
```

## Rest timer — durable, not a ticking counter

`local_rest_timer_state` (one row per session) stores `started_at` +
`duration_seconds` only. Remaining time is always **derived**
(`computeRemainingSeconds()`, `apps/mobile/src/workout/rest-timer.ts`) as
`durationSeconds - (now - startedAt)` — never read from a decrementing
in-memory value, which is what makes it survive backgrounding and a real
process restart without desyncing (verified natively — see below).

Completing a set starts (or restarts) the timer with a duration resolved
by `resolveRestDuration()`: the just-completed `PrescribedSetV1
.restSeconds` when the prescription specifies one, otherwise the single
centralized `DEFAULT_REST_SECONDS = 90` fallback — never an invisible
magic number scattered across the UI. `+15`/`-15` adjustment
(`WorkoutRepository.adjustRestTimer()`) re-anchors `startedAt` to now and
sets `durationSeconds` to the currently-remaining time plus the delta, so
the adjustment changes exactly the *remaining* time regardless of how
much has already elapsed.

The header's ticking clock (`WorkoutHeader` in `app/active-workout.tsx`)
is isolated to its own component with its own 1-second `setInterval` —
the exercise/set list below it never re-renders on a timer tick (spec
section 41).

## `PlannedSet.restSeconds` — the one new prescription field this slice adds

`packages/domain/src/plan/planned-set.ts` gains `restSeconds: number |
null`, carried losslessly through `PrescribedSetV1.restSeconds`
(`packages/domain/src/workout/prescription.ts`) and
`WorkoutPreviewSetV1.restSeconds` (`packages/contracts`) — the same
"exactly one field, no compatibility shortcut" discipline the Plan
Contract Integrity Fix Pass established for `RepTargetV1`. Physical
storage: `planned_sets.rest_seconds`, a new nullable integer column (real
Drizzle migration `0004_natural_sleeper.sql`, generated and applied
against real local Postgres) — `null` means "not specified," not "no
rest." This is a plain authored value, the same status as
`estimatedDurationMinutes` elsewhere in this hierarchy — not a Training
Engine rest-optimization decision.

## Finish Workout — the required WDI extension

WDI previously had no representation of workout completion — every
session it created stayed `ACTIVE` forever (`docs/architecture/
WORKOUT-DATA-INTEGRITY.md`'s "honesty note," now resolved). This slice
adds the minimum required command, following the exact same local-first,
domain-aware-outbox shape as `START_WORKOUT_SESSION_V1`/`COMPLETE_SET_V1`/
`REOPEN_SET_V1` (ADR-0007) — not a generic session PATCH:

```ts
interface FinishWorkoutSessionCommandV1 {
  type: "FINISH_WORKOUT_SESSION_V1";
  workoutSessionId: string;
  completedAt: string;
}
```

`WorkoutRepository.finishWorkoutSession()`: one local SQLite transaction
— `UPDATE local_workout_sessions SET status='COMPLETED', completed_at=...`
plus the outbox command insert — then reports success. Network is never
in the critical path. Server-side, `applyFinishWorkoutSession()`
(`apps/api/src/workout/workout-command-processing.ts`) is BOLA-checked
(session ownership via `AuthenticatedActor`, never trusted from the
payload) and reuses the receipts-table idempotency every other command
type gets — no special-case logic needed there. Finishing is a one-way,
**revision-free** transition: applying `COMPLETED` twice (even via two
different `commandId`s, e.g. a genuine retry) converges to identical
canonical state by construction, since there is nothing to compare
against — unlike `COMPLETE_SET_V1`/`REOPEN_SET_V1`, `FINISH_WORKOUT
_SESSION_V1` never touches `performed_exercises`/`performed_sets`.

**Partial completion is allowed** (spec section 27) — finishing does not
require every planned set to be complete. The mobile UI shows a
lightweight confirmation sheet only when sets remain incomplete; a fully
completed session finishes immediately. An optional "why" (time, fatigue,
pain, ...) is deliberately deferred — capturing it correctly would
introduce new, unapproved domain semantics this slice's scope does not
resolve.

**A finished session stops being "active" for free.**
`WorkoutSession.isActiveWorkoutSession()` (`packages/domain/src/workout/
workout-session.ts`) is the single pure predicate for this, and
`WorkoutRepository.readActiveSession()`'s existing `WHERE status =
'ACTIVE'` filter already implements it — `getActiveWorkoutSession()`
simply stops returning a session once `finishWorkoutSession()` completes,
with no new filtering logic required. Completed local rows are never
deleted (spec section 29) — historical reality remains queryable (e.g.
for a future session's "Previous" lookup).

`WorkoutSession.completedAt: Date | null` / `app.workout_sessions
.completed_at` (new nullable timestamp column, same migration as
`rest_seconds` above) record when.

### Post-workout summary

Computed entirely from data already available locally at the moment
Finish succeeds — workout name, elapsed duration
(`now - session.startedAt`), and completed-vs-planned working set counts.
No PR/progression recommendation is shown (none is honestly available
yet); no share CTA, no upsell, no gamification — just a route back to
Plan.

## Command ordering around Finish (final review pass)

The scenario examined: on-device, in strict causal order, `COMPLETE_SET
(revision 1)` -> `REOPEN_SET (revision 2)` -> `FINISH_WORKOUT_SESSION`.
Locally these are always correctly ordered — one shared SQLite
connection, one transaction per mutation, executed sequentially. The
question is what happens to their *sync* to the server, since
`app/active-workout.tsx` requests a sync after each mutation (since
2026-10-04 through the `WorkoutSyncCoordinator`, which serializes passes —
see WORKOUT-DATA-INTEGRITY.md "When sync runs"; originally it called
`syncPendingWorkoutCommands()` directly) **without awaiting the previous call** — so the corresponding
HTTP requests are not guaranteed to arrive at the server in the order
they were enqueued (ordinary network/scheduling variance can let a later
request's response land first).

Two things make this safe by construction, not by luck:

1. **`FINISH_WORKOUT_SESSION_V1` never touches `performed_sets`.** It
   only ever reads/writes `workout_sessions`. So no interleaving with
   `COMPLETE_SET_V1`/`REOPEN_SET_V1` (which only ever touch
   `performed_exercises`/`performed_sets`) can produce a race on the same
   row — they are disjoint by table.
2. **`applyCompleteSet`/`applyReopenSet` apply this ADR's existing
   ownership + per-set revision rules unchanged regardless of session
   status** — a session being `COMPLETED` records that the athlete
   finished; it does not by itself retroactively lock out a genuinely
   earlier local mutation whose own sync request simply took longer in
   flight. This is a deliberate reading of "historical reality is not
   rewritten" (`CLAUDE.md`) — a late-arriving, causally-earlier command is
   still accurate history and is still applied.

Verified with two real-Postgres integration tests
(`apps/api/src/workout/workout-sync.integration.test.ts`):

- **AW-SYNC-007**: `COMPLETE_SET(r1)` -> `REOPEN_SET(r2)` -> `FINISH`,
  applied in that exact order, converges to `status=COMPLETED` and the
  set left `REOPENED` at `revision=2` — Finish never reverts or touches
  the set.
- **AW-SYNC-008**: `FINISH` arrives and applies **first**, then a
  causally-earlier `COMPLETE_SET(r1)` arrives late — it still applies
  (`APPLIED`, not rejected or silently dropped), and the session's
  `COMPLETED` status is untouched by it.

This pass confirmed the existing domain-aware-outbox + revision-gating
design (ADR-0007) already tolerates this exact ordering scenario
correctly for the *given* sequence of events — it did not uncover a
defect. But it also surfaced a real gap, addressed below: at that point,
nothing in the protocol could tell "a command created before Finish,
delivered late" apart from "a brand-new command created after Finish and
sent anyway." Both looked identical on the wire, so both would have been
applied.

## The Finish causal boundary — `sessionSeq` / `finishSeq` (Active Workout Finish Causal Boundary Fix)

**The gap.** Before this fix, neither the client nor the server checked
session-completion status before creating or applying a
`COMPLETE_SET_V1`/`REOPEN_SET_V1` mutation. That is fine for a genuinely
late-but-legitimate command (AW-SYNC-008 above), but it also meant a
client that kept mutating an already-finished session — buggy, stale, or
adversarial — would sync those mutations as ordinary logging. The
protocol had no field capable of distinguishing the two cases, and
rejecting every set command once `completed_at != null` was explicitly
rejected as a fix, since that would also drop the legitimate late case.
Timestamps were rejected as the discriminator for the same reason ADR-0007
already rejects them for revision conflicts: clock skew and no cross-
device ordering guarantee.

**The mechanism**: a per-session monotonic sequence plus a Finish
watermark — the same shape as this ADR's existing per-set `revision`,
scoped to the whole session instead of one set.

- **`sessionSeq`** — every newly *created* `COMPLETE_SET_V1`/
  `REOPEN_SET_V1` command carries a positive integer, strictly monotonic
  within one session, allocated client-side (never wall-clock-derived).
  A retry/redelivery of the same command (same `commandId`) reuses its
  original `sessionSeq` — retrying never allocates a new one.
- **`finishSeq`** — carried on `FinishWorkoutSessionCommandV1`. Means:
  "the highest `sessionSeq` validly issued for this session before this
  local Finish transition." `0` is valid (no set mutation was ever
  issued). Established once, at Finish; a later, *different*
  `FINISH_WORKOUT_SESSION_V1` command (e.g. a stale offline replay from
  another device) can never move an already-established `finishSeq` —
  the server's `applyFinishWorkoutSession` is a no-op once
  `status = COMPLETED`. A duplicate delivery of the *same* `commandId`
  remains idempotent, as before.

**Local allocation (mobile)**. `local_workout_sessions` gained two
columns: `last_issued_session_seq` (`NOT NULL DEFAULT 0` — "the last
value handed out," never "the next value to hand out," to avoid the
off-by-one ambiguity that name would invite) and `finish_seq` (nullable,
set exactly once). `WorkoutRepository.completeSet()`/`reopenSet()` now,
**inside the same SQLite transaction** that reads/writes the performed
set:

1. read the session's `status` and `last_issued_session_seq`;
2. if `status` is already `COMPLETED` — **stop**: do not mutate performed
   reality, do not allocate a `sessionSeq`, do not enqueue an outbox
   command. Return a typed `{ status: "SESSION_ALREADY_COMPLETED" }`
   outcome (`CompleteSetOutcome`/`ReopenSetOutcome`) instead of throwing
   or silently no-op'ing. This is the **local terminal invariant** — it
   does not depend on the UI being unmounted, and is checked on every
   call, not just ones the screen happens to prevent;
3. otherwise, allocate `last_issued_session_seq + 1`, persist the new
   value, write the performed-set mutation, and enqueue the outbox
   command with that `sessionSeq` — all in the one transaction.

`finishWorkoutSession()` does the mirror image, also in one transaction:
verify `status = ACTIVE`, read `last_issued_session_seq` as the
about-to-be-established `finishSeq`, persist `status = COMPLETED` +
`completedAt` + `finishSeq`, enqueue the `FINISH` command carrying that
`finishSeq`. If the session is already `COMPLETED`, it returns
`{ status: "ALREADY_FINISHED" }` rather than re-finishing.
`app/active-workout.tsx`'s three call sites (`onSetCompleted`,
`onSetReopened`, `handleFinish`) all inspect the outcome and, on the
"already" branches, reload real local state instead of fabricating UI
feedback for a mutation that didn't happen.

**Server gate**. `applyCompleteSet`/`applyReopenSet` (`apps/api/src/
workout/workout-command-processing.ts`) apply ownership + this ADR's
existing per-set revision rules unchanged first. Only when the session is
already `COMPLETED` do they additionally check:

- `command.sessionSeq <= session.finishSeq` → causally eligible; apply
  per the normal revision rules (this is the AW-SYNC-008 case, now
  precisely characterized rather than merely "not rejected by accident");
- `command.sessionSeq > session.finishSeq` → a genuinely new post-Finish
  mutation; `REJECTED`.

`finishSeq` is a lifecycle gate, not a replacement for the per-set
revision gate — an eligible late command still has to win its own
`STALE`/`APPLIED`/`DUPLICATE` outcome against the target set's current
`revision`.

**DB-level uniqueness**. `workout_command_receipts` gained
`workout_session_id` and `session_seq` columns plus a partial unique
index — `UNIQUE (workout_session_id, session_seq) WHERE session_seq IS
NOT NULL` — so two different commands can never successfully claim the
same session/sequence pair, independent of any TypeScript-level check.
These two columns are populated **only once ownership (BOLA) is
confirmed** — never for a wrong-owner attempt — so a hostile probe
against someone else's session can never pre-occupy the real owner's
future sequence slot via the shared constraint. `START`/`FINISH` do not
consume a sequence slot (no strong reason for them to).

**Threat model — read this precisely.** `sessionSeq`/`finishSeq` gives
**causal/lifecycle ordering**, protecting against stale or buggy clients
and genuinely out-of-order delivery. It is explicitly **not** a
cryptographic proof against a hostile owner modifying their own client to
mint a low `sessionSeq` for a command actually created after Finish —
authorization (BOLA/ownership) remains the actual security boundary, as
it always has been in this ADR. This mechanism does not strengthen or
replace that boundary; it only gives the already-authorized owner's own
client a way to express "when" relative to its own Finish.

**Concurrency.** Sequence allocation and the Finish transition are
serialized by the same mechanism this ADR already relies on for revision
allocation: one shared SQLite connection, one `db.transaction()` callback
per mutation, executed synchronously with no `await` inside the callback.
So a `completeSet()` and a `finishWorkoutSession()` initiated nearly
simultaneously always resolve to one deterministic order — there is no
interleaving where a set mutation commits successfully while being
excluded from the watermark:

- the complete's transaction commits first → its `sessionSeq` is `<=`
  the `last_issued_session_seq` the Finish transaction reads a moment
  later, so it is included in `finishSeq`; or
- the finish's transaction commits first → the complete's transaction
  then observes `status = COMPLETED` and is rejected by the local
  terminal invariant before it allocates anything.

**Tests** (`apps/api/src/workout/workout-sync.integration.test.ts`,
real Postgres):

- **AW-ORDER-001** — `COMPLETE(seq1)` delivered *after* `FINISH
  (finishSeq=1)` — a pre-Finish command delivered late — still applies.
- **AW-ORDER-002** — documents a referential constraint independent of
  Finish: a `REOPEN_SET_V1` can never apply before its `COMPLETE_SET_V1`
  exists (the lookup join finds no owner row), so the literal delivery
  order "FINISH, REOPEN(seq2), COMPLETE(seq1)" cannot be honored as
  written; the test proves the premature REOPEN is rejected, then
  delivers COMPLETE/REOPEN in the only order that can succeed, and
  confirms no valid reality is lost.
- **AW-ORDER-005** — `sessionSeq` beyond the session's `finishSeq` is
  `REJECTED`.
- **AW-ORDER-006** — `sessionSeq` at or below `finishSeq` is eligible.
- **AW-ORDER-007** — two different commands claiming the same
  `(sessionId, sessionSeq)` — the DB-level unique index rejects the
  second; zero rows written by it.
- **AW-ORDER-008** — duplicate delivery of the same `commandId`/
  `sessionSeq` remains idempotent.

**Native verification (real Android, release build, real local
Postgres+JWKS)**: with one set completed (allocating `sessionSeq=1`) and
the session then Finished (capturing `finishSeq=1`, confirmed via `psql`
against the real session row), a `completeSet()` call and a `reopenSet()`
call were each issued through the real `WorkoutApplicationService` — the
same application boundary the screen itself calls — against that
already-`COMPLETED` session. Both returned `SESSION_ALREADY_COMPLETED`.
An outbox sync taken immediately before the attempts (draining it to
empty) and again immediately after reported `{ attempted: 0 }` for the
second sync, proving neither rejected attempt enqueued a new outbox
command. `psql` against the real Postgres instance confirmed
`workout_sessions.status = COMPLETED, finish_seq = 1` and exactly one
`COMPLETE_SET_V1` receipt with `session_seq = 1` for that session.

## Server schema

`app.workout_sessions.completed_at` (nullable timestamp) and
`app.planned_sets.rest_seconds` (nullable integer) — both added in
`packages/database/drizzle/0004_natural_sleeper.sql`, along with adding
`FINISH_WORKOUT_SESSION_V1` to the existing `workout_command_type`
Postgres enum.

The Finish Causal Boundary Fix (`packages/database/drizzle/
0005_solid_morg.sql`) added `app.workout_sessions.finish_seq` (nullable
integer — the watermark) and, on `app.workout_command_receipts`,
`workout_session_id` (nullable uuid) + `session_seq` (nullable integer)
plus a partial unique index `workout_command_receipts_session_seq_unique`
on `(workout_session_id, session_seq) WHERE session_seq IS NOT NULL`. No
new tables.

## Local SQLite schema

Five new hand-rolled migrations (`apps/mobile/src/local-database/
migrations.ts`, additive `ALTER TABLE`/`CREATE TABLE IF NOT EXISTS`,
matching this repo's existing local-migration convention — see
`docs/architecture/WORKOUT-DATA-INTEGRITY.md` for why drizzle-kit's
generated Expo bundle isn't used here):

```text
0005  local_workout_sessions.completed_at            (ALTER TABLE ADD COLUMN)
0006  local_performed_exercises.exercise_ref          (ALTER TABLE ADD COLUMN)
0007  local_set_drafts                                (CREATE TABLE)
0008  local_rest_timer_state                          (CREATE TABLE)
0009  local_workout_sessions.last_issued_session_seq  (ALTER TABLE ADD COLUMN, NOT NULL DEFAULT 0)
0010  local_workout_sessions.finish_seq               (ALTER TABLE ADD COLUMN)
```

## Application boundaries

`WorkoutApplicationService` (`apps/mobile/src/workout/
workout-application-service.ts`) gained: `finishWorkoutSession()`,
`saveSetDraft()`, `startRestTimer()`, `adjustRestTimer()`,
`getPreviousExercisePerformance()`, and `completeSet()` now also starts
the rest timer as part of the same call (the UI resolves the duration via
`resolveRestDuration()` and passes it in — the one centralized place that
prescription-vs-default fallback decision lives). The Active Workout
screen (`app/active-workout.tsx`) consumes only this service — no SQL in
the component, no direct `WorkoutRepository` import, matching the
existing WDI/Plan boundary discipline exactly.

`completeSet()`/`reopenSet()`/`finishWorkoutSession()` now return a typed
discriminated-union outcome (`CompleteSetOutcome`, `ReopenSetOutcome`,
`FinishWorkoutSessionOutcome` — `workout-repository.ts`) instead of
always succeeding: `{ status: "SESSION_ALREADY_COMPLETED" }` /
`{ status: "ALREADY_FINISHED" }` alongside the success shape. All three
`app/active-workout.tsx` call sites inspect `outcome.status` and, on the
"already" branches, reload real local state via `loadSession()` instead
of proceeding as if the mutation happened — see "The Finish causal
boundary" above.

## Design tokens — aligned to the locked foundations, not redesigned

`apps/mobile/src/design/tokens.ts`'s `background` and `textSecondary` are
corrected to the exact locked Design System Foundations named in this
slice's spec: base dark surface `#0B0D0F`, informational secondary-text
contrast floor `#8B9399` on `#0B0D0F`. Two new semantic spacing tokens
(`screenGutter: 22`, `sectionRhythm: 26`) were added because Active
Workout's layout actually needs them; the rest of the locked
4/8/12/16/20/24/32/40/48/56 scale is not speculatively named until a
screen needs it. This is a **values correction**, not a redesign — the
existing Plan/Preview screens' layouts are untouched, and this file
remains provisional implementation infrastructure, not the product
design-system source of truth. The Archivo-typeface gap remains honestly
unresolved (no font files exist in this repo to load via `expo-font`).

`formatRepTarget()`/`formatLoad()` were extracted out of the Workout
Preview screen into a shared module (`apps/mobile/src/workout/
format-target.ts`) so Preview and Active Workout render rep/load targets
through the exact same formatting logic — never two independently
maintained implementations that could quietly drift apart. Load's
`PER_IMPLEMENT` label changed from `"/side"` to `"each"` in that
extraction, matching the Load Model doc's own wording ("DB Bench 40 kg
dumbbells means 40 kg EACH") — a small incidental correctness fix, not a
redesign.

## Deferred contextual actions (explicitly, not silently)

- **Pain/discomfort**: no button exists. Implementing it correctly needs
  its own raw-observation/restriction domain workflow this slice does not
  design.
- **Exercise swap**: no button exists — belongs with the eventual
  Exercise Taxonomy/curated-substitution work, not this slice's narrow
  `ExerciseIdentityV1` shim.
- **Warm-up/drop/failure/AMRAP set types**: `WORKING`/`WARM_UP` are now
  explicit, required, end-to-end domain/wire/storage fields (Progression
  Prerequisites V1, 2026-09-09 — `PlannedSet`/`PrescribedSetV1`/
  `PerformedSet`/`CompleteSetCommandV1`), but there is still **no
  athlete-facing warm-up UI** — every real set the app logs today is
  explicitly `WORKING`, and no button exists to log anything else. Warm-up
  athlete-facing UX and warm-up *generation* remain a later, separate
  Design + implementation slice (see docs/domain/PROGRESSION-ENGINE-V1.md
  §6/§31's "Warm-up product roadmap note"). `BACKOFF`/`DROP`/`AMRAP`/
  `FAILURE` remain unimplemented, reserved concepts only.
- **Set reordering / superseding order**: no persistence beyond the
  prescription's own `order` — no drag-and-drop.
- **RIR/Effort**: no field, no UI — same precedent as WDI.

## Native Android verification (mandatory, not unit-tests-only)

Performed on a real Android emulator, real SQLCipher-encrypted local
database, real local Postgres, real local API, and a real local JWT/JWKS
test issuer — same methodology as WDI and Plan. A **release** build was
used throughout (required for the offline steps). Fixture: "Upper Body B"
(3 exercises, 10 working sets total), including "Incline Dumbbell Press" —
a genuine `PER_IMPLEMENT` load — alongside `RANGE` (8-12) rep targets on
every set.

Verified, in order:

1. Plan -> Preview ("Upper Body B") -> Start Workout — real full-screen
   Active Workout screen, no Today/Plan/Progress/Profile bottom navigation
   anywhere on screen.
2. Entered load/reps for Barbell Row Set 1 (55kg, 10 reps) and tapped
   Complete offline — immediate checkmark, rest timer started at 90s
   (the exercise's own prescribed `restSeconds`).
3. Adjusted the rest timer -15s then +15s — both confirmed correct against
   wall-clock elapsed time (e.g. 89s remaining, 24s of real time passed,
   -15s tap -> 50s shown, matching `89 - 24 - 15`).
4. Entered a draft (reps "9", not completed) on Set 2, disabled Wi-Fi and
   mobile data, force-stopped the app process, relaunched — Plan's network
   fetch failed honestly, **the Resume banner still rendered correctly**,
   and opening it showed: identical session, Set 1 still COMPLETED with
   its exact values, Set 2's uncommitted draft "9" still present in the
   reps field, and the rest timer correctly showing "Rest done" (derived
   fresh from `startedAt`+`durationSeconds` against the real elapsed wall
   time, not a frozen/reset counter) — all fully offline.
5. Completed Set 2 (draft value carried through), then reopened it, edited
   reps 9 -> 11, and recompleted — see "Real bug found and fixed" below.
6. Switched to "Incline Dumbbell Press" (`PER_IMPLEMENT`) — load field
   correctly prefilled "24" (not 48), target line read "8-12 reps · 24kg
   each". Completed Set 1 (24kg, 10 reps), reopened it, edited reps to 12,
   recompleted.
7. Tapped Finish with 8 of 10 sets still planned-incomplete — the
   partial-completion confirmation sheet appeared ("Finish with sets
   remaining?"); tapped "Finish anyway".
8. Post-workout summary rendered from real local data only: "Upper Body B",
   duration `06:02`, "1/10" sets completed — no fabricated PR/progression
   content, no share/upsell.
9. Returned to Plan: no Resume banner (session no longer active), and
   "Upper Body B" now shows a "Completed" badge — both derived correctly
   from the real `WorkoutSession` the Finish action wrote.
10. Network re-enabled: the sync that had been queued through every step
    above reached the real local API/Postgres automatically. Verified via
    `psql`:
    ```
    workout_sessions:  status=COMPLETED, completed_at set
    performed_sets:    prescription_set_id = <Incline Dumbbell Press Set 1>
                        actual_reps=12, load_amount_milli=24000,
                        load_basis=PER_IMPLEMENT, completion_state=COMPLETED,
                        revision=3
    ```
    `revision=3` is exactly right: 1 (first complete, reps=10) -> 2
    (reopen) -> 3 (recomplete, reps=12) — proving AW-MOB-004's revision
    progression against real Postgres, not just the local device.
11. **Replay**: a `FINISH_WORKOUT_SESSION_V1` command (fresh `commandId`,
    the same real `workoutSessionId`) was POSTed directly to the sync
    endpoint twice with an identical body. First: `APPLIED`. Second
    (replay): `DUPLICATE`. `psql` confirmed exactly one
    `workout_command_receipts` row and no change to `performed_sets`
    beyond the recomplete above — zero duplicate side effects.

### Real bug found and fixed during this verification

Reopening a completed set and recompleting it (spec section 35) initially
produced a **second** `local_performed_sets` row instead of updating the
existing one — `WorkoutRepository.completeSet()` was written only for
"first completion of a newly-created set" (from the original WDI slice,
which never needed a recomplete path) and unconditionally generated a
fresh `performedSetId` and hardcoded `revision = 1`. The UI's `.find()`
lookup then matched the **original**, still-`REOPENED` row (inserted
first), so the screen kept showing "Complete" instead of the checkmark
even though a real (orphaned) completion had silently happened underneath.

Fixed by giving `CompleteSetInput` an optional `performedSetId`: when the
UI passes an existing performed set's id (i.e. recompleting after a
reopen), `completeSet()` now reads that row's current revision and
**updates it in place** (`revision + 1`, new `actualReps`/`actualLoad`,
`completionState = 'COMPLETED'`) instead of inserting a second row. When
omitted, behavior is unchanged (a genuinely new set, `revision = 1`). No
server-side change was needed — `applyCompleteSet`'s existing
`onConflictDoUpdate ... WHERE revision < excluded.revision` already
upserts correctly by id; the bug was purely in the local mobile repository
never reusing the id. Verified by the `revision=3` result in step 10/11
above, and covered going forward by the same code path every native
recomplete now exercises.

## Tests

Domain (`packages/domain/src/workout/workout.test.ts`, AW-001..AW-006):
range/actual-reps/load correctness, session completion never touching
performed reality, partial completion allowed, `isActiveWorkoutSession()`.
Server (`apps/api/src/workout/workout-sync.integration.test.ts`, real
Postgres, AW-SYNC-001..006): FINISH applies/is idempotent/BOLA-safe/
converges/preserves history. AW-SYNC-007/008 (final review pass): the
exact `COMPLETE_SET(r1) -> REOPEN_SET(r2) -> FINISH` ordering, and a
late-arriving `COMPLETE_SET` after `FINISH` has already applied — see
"Command ordering around Finish" above. AW-ORDER-001/002/005/006/007/008
(Finish Causal Boundary Fix): the `sessionSeq`/`finishSeq` causal gate,
the pre-existing REOPEN-before-COMPLETE referential constraint, DB-level
sequence uniqueness, and idempotent duplicate delivery — see "The Finish
causal boundary" above. Pure mobile logic
(`apps/mobile/src/workout/rest-timer.test.ts`,
`elapsed-time.test.ts`): rest-duration resolution and remaining-time/
elapsed-time derivation from persisted timestamps (the testable core of
AW-MOB-005/006).

`WorkoutRepository` itself (and therefore AW-MOB-001/002/003/004/007/008/
009, which are fundamentally about real encrypted SQLite behavior) has no
Vitest suite, by the same precedent as WDI and Plan — it requires the real
`expo-sqlite` native module and is verified only natively (see above), not
claimed from unit tests alone.

## Security review

- `FINISH_WORKOUT_SESSION_V1` ownership always derives from
  `AuthenticatedActor.userId` via a join to the target session — never
  trusted from the command payload (same discipline as every other
  command type, ADR-0007).
- BOLA coverage: AW-SYNC-003 proves athlete B cannot finish athlete A's
  session; the attempt is REJECTED and leaves A's session state
  untouched.
- No new server-side auth-bypass surface — `FINISH_WORKOUT_SESSION_V1`
  goes through the exact same `AuthGuard` + JWT verification as every
  other sync command.
- `sessionSeq`/`finishSeq` (Finish Causal Boundary Fix) is causal/
  lifecycle ordering, not an authorization mechanism — it does not
  strengthen or replace BOLA/ownership as the security boundary, and does
  not claim to defend against a hostile owner tampering with their own
  client. See "The Finish causal boundary" above.
- Receipt-population asymmetry: `workout_command_receipts.session_seq`/
  `workout_session_id` are populated only once ownership is confirmed,
  never for a BOLA-rejected attempt — otherwise a wrong-owner probe could
  pre-occupy a legitimate future sequence slot via the shared uniqueness
  constraint.

## Explicitly deferred (tracked, not forgotten)

- Full Exercise Taxonomy (only the narrow `ExerciseIdentityV1` shim
  exists).
- Multi-device pull/cursor consumption for Previous performance (still
  local-device-only, matching WDI's existing deferred pull-sync).
- A finish "reason" (time/fatigue/pain/equipment/other).
- Live Activity / lock-screen rest timer.
- RIR/Effort logging.
