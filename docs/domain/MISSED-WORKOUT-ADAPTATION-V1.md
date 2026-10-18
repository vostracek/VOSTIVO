# Vostivo — Missed Workout / Schedule Adaptation V1 Specification

**Status:**

- Slice A (pure deterministic decision policy) — **CLOSED**.
- Slice B (read-only server preview orchestration) — **CLOSED**. See §9.
- Schedule Calendar Authority V1 (prerequisite) — **CLOSED**
  (`docs/domain/SCHEDULE-CALENDAR-AUTHORITY-V1.md`).
- Slice C (durable effective schedule application) — **CLOSED**. See §10.
- Slice D (athlete Today/Plan UX + explicit Apply + one-time training
  timezone bootstrap) — **CLOSED** (tech lead confirmed Missed Workout V1
  fully closed, 2026-10-17; implemented 2026-10-07). See §11.

There is still no ProgramVersion/PlannedWorkout mutation of any kind and no
worker involvement. Slice A's deliverable is
`packages/training-engine/src/missed-workout/`.

## 1. Locked V1 rules

1. **SEQUENCE BEFORE CALENDAR.** Calendar dates are scheduling targets. They
   are not more authoritative than the authored workout sequence.
2. **A SINGLE MISSED WORKOUT IS NOT AUTOMATICALLY SKIPPED.**
3. **THE MISSED SESSION BECOMES THE NEXT SESSION.** Later unresolved
   workouts stay after it, in their exact authored relative order.
4. **DO NOT INVENT TRAINING AVAILABILITY.** Only explicit, caller-supplied
   training slots count. That rules out "tomorrow", and it rules out "today
   because the app is open". Rest days are never converted into training days.
5. **DO NOT DOUBLE-UP OR MERGE SESSIONS.** There is never more than one
   recommended next workout, with no combining and no volume compression.
6. **HISTORICAL REALITY BEATS SCHEDULE INTENT.** A later workout that
   already has a canonical session is never re-ordered behind the missed one.
7. **MULTIPLE MISSES REQUIRE REVIEW.** That's a later Return/Absence policy.
8. **HARD-DEADLINE PROGRAMS REQUIRE REVIEW.**

The policy answers **what** should happen. It never decides how this is
persisted: no date shifting, no status changes, no new ProgramVersion.

## 2. Vocabulary

- **Policy version:** `missed-workout/v1`
  (`EngineVersion {engine: "missed-workout", policy: "v1"}`).
- **Authored sequence:** `(trainingCycleOrder, workoutOrder)`. This is the
  existing explicit plan ordering (`TrainingCycle.order`, `PlannedWorkout.order`),
  never row order, display name or id order.
- **Unresolved occurrence:** the existing `PlannedWorkout.status` is
  `PLANNED` or `AVAILABLE`, and the occurrence has **no canonical session**
  (Planned Workout Occurrence Authority V1). `SKIPPED`, `RESCHEDULED` and
  `CANCELLED` keep their existing meaning, so they are already resolved and
  never resurrected.
- **Missed workout:** an unresolved occurrence whose `scheduledLocalDate` is
  strictly **before** `athleteLocalDate`. Both are explicit athlete-local ISO
  calendar dates supplied by the caller; there is no UTC-midnight guessing.
  A workout scheduled **today** is not missed. A workout with no scheduled
  date can never be missed.
- **Timeline constraint:** `FLEXIBLE | HARD_DEADLINE`. This is a pure input
  flag only. No such persisted concept exists yet, so none was added.

## 3. Input (`MissedWorkoutInputV1`)

`athleteLocalDate`, `applicableProgramVersionId` (or `null` when there is no
active plan context), `timelineConstraint`, `plannedWorkouts[]`
(`plannedWorkoutId`, `programVersionId`, `trainingCycleOrder`,
`workoutOrder`, `scheduledLocalDate` or `null`, `status`,
`canonicalSessionStatus` of `ACTIVE`, `COMPLETED` or `null`), and
`validTrainingSlots[]` (local dates).

It deliberately has **no** athlete mode: GUIDED, ADAPTIVE and EXPERT get the
same recommendation, and mode authority is a later UX/application concern.
COACHED is still an overlay. It also has **no** Available-Time priority tier,
which is an intra-session concern, **no** progression state and **no** clock.

## 4. Decision (`MissedWorkoutDecisionDataV1`)

- `NO_CHANGE` / `NO_MISSED_WORKOUT`.
- `ROLL_FORWARD` / `SINGLE_MISSED_WORKOUT`, with:
  - `missedWorkoutId`;
  - `recommendedNextWorkoutId` (always equal to the missed id);
  - `originalNextWorkoutId` (what would have been next; displaced, not
    deleted, or `null`);
  - `sequence`: the missed workout followed by every later unresolved
    workout, in authored order;
  - `nextTrainingSlot`: the first explicit slot on or after today.
- `REVIEW_REQUIRED`, with one of:
  - `MULTIPLE_MISSED_WORKOUTS`
  - `LATER_SESSION_ALREADY_PERFORMED`
  - `AMBIGUOUS_SEQUENCE`
  - `HARD_TIMELINE_CONSTRAINT`
  - `NO_KNOWN_TRAINING_SLOT`
  - `SOURCE_CONTEXT_NOT_APPLICABLE`

  plus `missedWorkoutIds`, ordered by date then id so the order is
  deterministic even when the sequence is ambiguous, and
  `performedLaterWorkoutIds`.

The engine emits reason codes only, never user-facing prose. There is no
progression, deload, regression or Athlete Memory output: a miss is
schedule reality, not a performance signal.

## 5. Algorithm and fixed precedence

1. No missed occurrence → `NO_CHANGE`.
2. `HARD_DEADLINE` → `REVIEW_REQUIRED` `HARD_TIMELINE_CONSTRAINT`.
3. More than one missed occurrence → `MULTIPLE_MISSED_WORKOUTS`.
4. The missed occurrence isn't in the applicable ProgramVersion, or there is
   no applicable version → `SOURCE_CONTEXT_NOT_APPLICABLE`.
5. The applicable sequence is ambiguous → `AMBIGUOUS_SEQUENCE`. That means
   two occurrences share one authored position, or scheduled dates run
   backwards against the authored order.
6. A **later** occurrence already has a canonical `ACTIVE`/`COMPLETED`
   session → `LATER_SESSION_ALREADY_PERFORMED`.
7. No explicit slot on or after `athleteLocalDate` → `NO_KNOWN_TRAINING_SLOT`.
8. Otherwise → `ROLL_FORWARD`.

Only the applicable ProgramVersion's occurrences form the sequence, so another
version's occurrences never interleave with it.

## 6. Determinism and boundaries

The policy is pure: no clock reads, `Date`, randomness, id generation, DB,
network or filesystem. Input rows can arrive in any order, and the input is
never mutated. `evaluateMissedWorkout()` validates first. Malformed input is
a typed `Result.err`, never silently a decision; that covers impossible
calendar dates, unknown statuses, non-integer orders and duplicate ids.
Structurally valid but semantically unclear input is a `REVIEW_REQUIRED`.

## 7. Implementation evidence — Slice A (2026-10-06)

`packages/training-engine/src/missed-workout/`:
- `vocabulary.ts`;
- `input.ts`, which reuses the domain's `PlannedWorkoutStatus` and
  `WorkoutSessionStatus`;
- `decision-data.ts`;
- `validate-input.ts`, with strict `YYYY-MM-DD` calendar validation in pure
  arithmetic;
- `policy.ts`: `missedWorkoutPolicyV1` (the same `EnginePolicy` contract as
  Progression and Available-Time) and `evaluateMissedWorkout()`.

**Tests:** 40 in `policy.test.ts`, covering the whole tech-lead matrix:
- NO_CHANGE for future, today, canonical, resolved and unscheduled workouts
  and an empty plan;
- the ROLL_FORWARD worked example with an exact sequence and a displaced
  original next;
- no skip, merge or invented date, with explicit slot handling;
- every REVIEW reason and the fixed precedence;
- the local-date boundary;
- mode, tier, progression and memory independence;
- determinism, row-order independence and no input mutation;
- structural validation.

Freedom from infrastructure is enforced by the dependency-cruiser rule
`training-engine-must-be-infrastructure-free`.

## 8. Not in Slice A (later slices)

Persistence and rescheduling semantics, real training-slot sourcing (the
athlete's schedule and availability), the API, a Today card or Plan diff,
athlete "Keep schedule"/apply choices, mode authority, coach review,
notifications, Return After Break / multiple misses, pain and equipment, and
any ProgramVersion change.

## 9. Slice B — server preview orchestration (2026-10-06)

REAL PLAN -> server clock + explicit athlete training time zone -> athlete
local date -> ACTIVE ProgramVersion -> current TrainingBlock -> canonical
occurrence state -> authored training slots -> `missed-workout/v1` (the
unmodified Slice A engine, the only implementation of the policy) ->
read-only preview.

### 9.1 Locked rules (tech lead)

```text
TRAINING TIMEZONE IS EXPLICIT ATHLETE SCHEDULING CONTEXT
NO SILENT UTC FALLBACK
AUTHORED FUTURE WORKOUT DATES ARE V1 TRAINING SLOTS
APP OPENING DOES NOT CREATE A TRAINING SLOT
CURRENT TRAINING BLOCK IS THE POLICY WINDOW
PREVIEW IS READ ONLY
FUTURE ROLL_FORWARD APPLICATION WILL USE AN EFFECTIVE SCHEDULE/SEQUENCE
  OVERLAY, NOT MASS-MUTATE PROGRAMVERSION DATES
ALL ATHLETE MODES WILL REQUIRE EXPLICIT APPLICATION
```

### 9.2 Training time zone

- `app.athlete_profiles.training_time_zone` (migration 0018): nullable
  `text`, **no default, no backfill** — existing and newly provisioned
  athletes stay `NULL` until the athlete explicitly sets it. It is the
  athlete's *training* zone: it does not follow travel or the device zone
  and is never overwritten automatically.
- Validation and local-date derivation: `normalizeTrainingTimeZone` /
  `resolveAthleteLocalDate` (`packages/domain/src/schedule/`) — a real IANA
  id via `Intl` (canonical id stored); UTC offsets such as `+02:00` are
  rejected even though `Intl` accepts them. DST-correct (tested around the
  2026 Europe/Prague transitions).
- Set explicitly via `PUT /api/v1/me/training-time-zone
  { trainingTimeZone }` (400 `INVALID_TRAINING_TIME_ZONE`); exposed as
  `MeResponse.trainingTimeZone`. The dev plan seed writes
  `TRAINING_TIME_ZONE` (default `Europe/Prague`).
- Missing (or unusable stored) zone -> 409
  `TRAINING_TIME_ZONE_REQUIRED`. Never a UTC fallback.

### 9.3 Scope and sources

- Clock: an injected server `Clock` (`apps/api/src/common/clock.ts`);
  the request carries **no** date, slot, id or timeline (empty DTO +
  `forbidNonWhitelisted` -> any field is 400).
- Plan: the athlete's single ACTIVE program's ACTIVE ProgramVersion. No
  active version -> `NO_CHANGE`. More than one ACTIVE program -> 409
  `CURRENT_TRAINING_BLOCK_UNRESOLVED`.
- Current block: exactly the one block owning a cycle whose
  `[startDate, endDate]` contains the athlete's local date (all of that
  block's cycles form the sequence). Two blocks claiming today, or today
  between blocks / after the plan -> 409 `CURRENT_TRAINING_BLOCK_UNRESOLVED`
  (never a nearest-block guess). Plan not started yet -> `NO_CHANGE`.
  Superseded/draft versions, archived programs, earlier and later blocks
  never contribute occurrences.
- Canonical execution state: Planned Workout Occurrence Authority claims
  only (`findCanonicalOccurrenceSessions`) — an unclaimed or SECONDARY
  session never resolves an occurrence.
- Training slots: every authored date on/after the local date of an
  UNRESOLVED occurrence (PLANNED/AVAILABLE, no canonical session) of the
  current block; deduplicated, ascending. A date stays a slot even if its
  own workout is displaced by the roll-forward. A cancelled/skipped/
  rescheduled-only or already-performed date is not a slot; neither is a
  rest day or "the app is open today".
- Timeline: production is always `FLEXIBLE` (no persisted deadline concept
  exists). `HARD_DEADLINE` is reachable only through the service's
  internal options seam, for tests.

### 9.4 API

`POST /api/v1/plan/missed-workout-preview` (empty body, 200).
Errors: 401 unauthenticated, 404 no athlete profile, 409
`TRAINING_TIME_ZONE_REQUIRED` / `CURRENT_TRAINING_BLOCK_UNRESOLVED`.
Response `MissedWorkoutPreviewResponseV1`:

- common: `policyVersion`, `athleteLocalDate`, `trainingTimeZone`,
  `result`, `reasonCode`, `previewFingerprint`;
- `ROLL_FORWARD`: `missedWorkout`, `recommendedNextWorkout`,
  `originalNextWorkout` (nullable), `nextTrainingSlot`,
  `upcomingSequence[{plannedWorkoutId, displayName,
  authoredScheduledLocalDate}]`;
- `REVIEW_REQUIRED`: `missedWorkoutIds`, `performedLaterWorkoutIds`;
- `NO_CHANGE`: `NO_MISSED_WORKOUT`.

`previewFingerprint` = SHA-256 of `canonicalStringify` over: fingerprint
schema (`missed-workout-preview-v1`), policy version, athlete profile id,
time zone, local date, ProgramVersion id, TrainingBlock id, timeline, the
authored-order occurrences (id, order, date, status, canonical session
status), the derived slots and the decision. A stale-input guard for a
future application step — not an authorization token. Display names are
presentation only and not part of it.

### 9.5 Read only

Only SELECTs. Proven against real Postgres for every outcome (ROLL_FORWARD,
REVIEW_REQUIRED, NO_CHANGE, HARD_DEADLINE, 409): program, version, block,
cycle, planned workout (status/date), session, claim, decision and
application rows are byte-for-byte unchanged.

### 9.6 Implementation evidence

- Pure: `apps/api/src/plan/missed-workout-preview.ts` (current-block
  resolution, slot derivation, engine input, fingerprint, response
  mapping) — 23 unit tests; `packages/domain/src/schedule/` — 20 tests.
- Service: `apps/api/src/plan/missed-workout-preview.service.ts`.
- Real Postgres: `missed-workout-preview.integration.test.ts`
  (MWP-001..042), including the locked Europe/Prague fixture (clock
  2026-10-07T08:00Z -> ROLL_FORWARD: missed Upper A, original next Lower A,
  slot 2026-10-07), UTC-vs-Prague and New York local-date boundaries, BOLA,
  the PUT time zone round-trip and a newly provisioned NULL zone.
- Controller tests: auth, empty-body enforcement, 409 mapping, PUT
  validation.

### 9.7 Today/Plan UTC "today" — resolved by Schedule Calendar Authority V1

Found in Slice B: `PlanReadService` derived "today" from the server's UTC
date and fell back to a "nearest" cycle. That is now resolved. Today, Plan,
Workout Preview and this preview all use one authority:
`docs/domain/SCHEDULE-CALENDAR-AUTHORITY-V1.md`.

Effects on this preview:
- **Behavior:** the same as before, except that it now also fails closed
  (409 `CURRENT_TRAINING_BLOCK_UNRESOLVED`) when:
  - two cycles of one block overlap today;
  - a second ACTIVE program exists that has no ACTIVE version.
  Neither was covered or intended by Slice B.
- **Fingerprint inputs:** unchanged.

### 9.8 Not in Slice B

Application of a ROLL_FORWARD (the effective schedule/sequence overlay),
any Today card or Plan diff, mobile UI, a time-zone settings screen,
coach review, notifications, multiple-miss / return-after-break policy,
and any ProgramVersion mutation.

Slice B's fingerprint schema `missed-workout-preview-v1` became
`missed-workout-preview-v2` in Slice C (§10.6).

## 10. Slice C — durable effective schedule application (2026-10-07)

### 10.1 Locked rules

```text
AUTHORED SCHEDULE IS IMMUTABLE.
EFFECTIVE SCHEDULE IS AN OVERLAY.
UNKNOWN AVAILABILITY REMAINS UNSCHEDULED.
A CARRYOVER WORKOUT IS NOT SKIPPED.
TODAY USES EFFECTIVE SCHEDULE.
OCCURRENCE IDENTITY DOES NOT CHANGE WHEN SCHEDULE CHANGES.
PREVIEW FINGERPRINT IS A STALE/IDEMPOTENCY GUARD, NOT AUTH.
```

Every adaptation keeps four questions separately answerable:
1. **What was authored?** `planned_workouts.scheduled_date`, never changed.
2. **What is effective now?** Authored dates, overridden by the block's
   single ACTIVE application.
3. **Why did it change?** The application's `reason_code`, missed workout,
   original next workout, local date and zone.
4. **Which application caused it?** The ACTIVE application row and its
   supersession chain.

### 10.2 Locked example

Authored: Mon A · Wed B · Fri C · next Mon D. A is missed. The known slots
are Wed, Fri and next Mon.

| Workout | Authored | Effective |
|---|---|---|
| A | Mon | Wed |
| B | Wed | Fri |
| C | Fri | next Mon |
| D | next Mon | `NULL` (carryover) |

- D stays in sequence with no effective date until a later explicit
  scheduling context resolves it.
- No date is invented, no recurrence or cadence is inferred, and no rest
  day is converted.
- One roll-forward of one missed workout always leaves exactly as many
  carryovers as slots it consumed from the past.

### 10.3 Persistence (migration 0019, purely additive)

**`app.missed_workout_schedule_applications`** has one immutable row per
applied ROLL_FORWARD:
- context: athlete profile, ProgramVersion, TrainingBlock, `missed-workout/v1`,
  the approved preview fingerprint, the athlete's local date and training
  time zone;
- decision: missed workout and its due date, original next workout, reason
  code;
- audit: `applied_by_user_id`, `applied_at`;
- lifecycle: status `ACTIVE` / `SUPERSEDED`, `supersedes_application_id`,
  `superseded_at`.

DB-enforced invariants:
- **One ACTIVE per (athlete profile, block):** a partial unique index.
- **Idempotency:** UNIQUE (athlete profile, block, fingerprint).
- **Status consistency:** a CHECK that `superseded_at` is set exactly when
  the status is `SUPERSEDED`.

**`app.missed_workout_schedule_assignments`** holds the application's
complete effective-date snapshot: position, planned workout, authored
date, effective date (`NULL` = carryover) and kind:
- `ROLL_FORWARD`: this decision's sequence;
- `RETAINED`: an effective date carried unchanged from the superseded
  application.

Unique keys are (application, workout) and (application, position).

Rows are never deleted. The only update ever made is ACTIVE → SUPERSEDED,
in the same transaction that inserts the successor. Identifiers longer
than 63 characters are truncated by Postgres, as with this repo's earlier
long constraint names. The dev plan seed's wipe now also removes an
athlete's overlay rows.

### 10.4 Effective schedule resolver

- **Pure:** `resolveEffectiveSchedule(authored, activeAssignments)` and
  `assignRollForwardSlots(sequence, slots)` in
  `packages/domain/src/schedule/effective-schedule.ts`.
- **Server loader:** `apps/api/src/schedule/effective-schedule-source.ts`.
  It only ever reads the ACTIVE application owned by the same athlete
  profile, so another athlete's rows are invisible.
- **Output per workout:**
  - `authoredScheduledLocalDate` and `effectiveScheduledLocalDate`;
  - `scheduleSource` (`AUTHORED` / `ADAPTED`);
  - `isCarryover`.
- **Without an active application:** effective = authored.
- **Supersession is never stacked.** The ACTIVE snapshot is complete:
  - ROLL_FORWARD rows come from the new decision;
  - every other effective date of the previous ACTIVE snapshot is RETAINED.

  So a completed A stays on its effective Wednesday after a later B
  roll-forward; it is not reverted to authored Monday.

### 10.5 Assignment algorithm

- The sequence is `preview.upcomingSequence`: the missed workout, then
  later unresolved workouts in authored order.
- The slots are exactly the `validTrainingSlots` of the re-derived preview
  input.
- `sequence[i]` takes `slots[i]`; everything beyond the slots is `NULL`.
- Workouts already ACTIVE/COMPLETED are never part of the sequence and are
  never moved.
- The preview exposes this as `upcomingSequence[].proposedScheduledLocalDate`,
  plus `effectiveScheduledLocalDate` for the current state (both additive).

### 10.6 Preview after application

- The policy input now uses EFFECTIVE dates (authored order is unchanged).
  Known slots are the effective dates of unresolved workouts on or after
  today, so a carryover establishes no slot.
- On Wednesday after the apply the result is `NO_CHANGE`, because A is
  effectively today. On Thursday A is missed on its effective Wednesday,
  never on authored Monday.
- The fingerprint schema is now `missed-workout-preview-v2`. It adds the
  active application id and the authored dates on top of the effective
  occurrence state, so any change to the overlay changes the fingerprint.

### 10.7 Apply — `POST /api/v1/plan/missed-workout-apply`

**Request:** `{ previewFingerprint }`, a lowercase 64-character hex string.
Any other field returns 400. One transaction runs these steps:

1. Lock the actor's athlete profile row `FOR UPDATE`. This serializes all
   applies of one athlete. A missing or mismatched profile returns 404.
2. **Idempotency:** if an application with this fingerprint already exists
   for this athlete, return it unchanged (status `ACTIVE` or, honestly,
   `SUPERSEDED`).
3. **Re-derive** with the same code as the preview
   (`deriveMissedWorkoutSource`):
   - require an explicit timezone (409 `TRAINING_TIME_ZONE_REQUIRED`; the
     legacy UTC fallback is never accepted);
   - require `IN_CURRENT_BLOCK` (`GAP` / `AFTER_PLAN` / ambiguity → 409
     `CURRENT_TRAINING_BLOCK_UNRESOLVED`);
   - load the effective schedule and the canonical occurrence state.
4. **Fingerprint check:** recompute it; any mismatch returns 409
   `MISSED_WORKOUT_PREVIEW_STALE`. A newer recommendation is never applied
   instead.
5. **Applicability:** a result other than `ROLL_FORWARD` returns 409
   `{ message: "MISSED_WORKOUT_NOT_APPLICABLE", reasonCode }`.
6. **Supersede:** mark the previous ACTIVE application `SUPERSEDED`.
7. **Persist:** insert the new application and its complete assignment
   snapshot, then commit.

**Response:** `MissedWorkoutApplyResponseV1`, built only from persisted
rows, so a first apply and a retry are identical:
- application (policy, fingerprint, status, `appliedAt`);
- `ROLL_FORWARD`;
- `missedWorkout`;
- `effectiveAssignments` (this application's sequence);
- `carryoverWorkoutIds`.

**Concurrency (proven against real Postgres):**
- Two concurrent applies of the same fingerprint produce one application,
  identical responses and no duplicate assignments.
- Concurrent applies of two different valid previews: exactly one wins;
  the other is STALE, because the winner's new ACTIVE id changes the
  fingerprint.

**What apply writes:** only the two overlay tables. It creates no session,
set, claim, receipt, progression decision or application, pg-boss job or
Athlete Memory.

### 10.8 Today / Plan / Workout Preview

- **Plan/Today (`GET /plan/current`):** shows every workout of the
  displayed block whose EFFECTIVE date falls in the displayed cycle's
  range, plus the block's carryovers and the cycle's own unscheduled
  workouts. The authored cycle doesn't matter: a workout missed in an
  earlier cycle and rolled into this one shows here, as `TODAY` when due.
- **`PlanSessionSummaryV1` contract:**
  - `scheduledDate` is now the effective date;
  - additive fields: `authoredScheduledDate` and `scheduleSource`
    (`AUTHORED` / `ADAPTED`);
  - a carryover is `scheduleSource: "ADAPTED"` with `scheduledDate: null`.
    It is never SKIPPED or CANCELLED, and `PlannedWorkout.status` is never
    mutated.
- **`daysPerWeek`:** stays the authored count of the displayed cycle.
- **Workout Preview `displayStatus`:** uses the effective date.
- **Identity:** the moved workout keeps its own `plannedWorkoutId` and
  prescription id, so a later START claims that same occurrence.

### 10.9 Evidence

- **Domain:** `effective-schedule.test.ts`.
- **Pure API unit tests:** `missed-workout-preview.test.ts`, with overlay
  cases.
- **Controller tests:**
  - auth;
  - malformed, empty and missing fingerprint;
  - 14 kinds of forbidden client data;
  - 409 mapping, including the `NOT_APPLICABLE` reason code;
  - 404.
- **Real Postgres, `missed-workout-apply.integration.test.ts` (MWA-001..024, 27 cases):**
  - the locked example and the audit trail;
  - immutability of the authored plan;
  - zero reality artifacts;
  - idempotency;
  - both concurrency races;
  - every stale cause and not-applicable;
  - BOLA and 404;
  - the null timezone;
  - GAP, AFTER_PLAN and ambiguity;
  - the effective preview;
  - Today on Wednesday showing A, and the earlier-cycle case;
  - workout identity;
  - row order;
  - repeated reads;
  - foreign rows;
  - DB constraints;
  - supersession.

  The suite was run 5 times in a row, all green.
- **Slice B suite:** 44/44 still passing.

### 10.10 Slice D manual fixture requirements (not started)

- **Database:** `vostivo_manual` needs migrations 0018 and 0019 (via
  `pnpm --filter @vostivo/database db:manual:reset`, then re-provision
  the athlete).
- **Athlete:**
  - an ACTIVE program with exactly one ACTIVE program;
  - an explicit `trainingTimeZone` (the dev seed writes `TRAINING_TIME_ZONE`,
    default `Europe/Prague`).
- **Schedule:** the device date must fall inside a seeded cycle
  (`IN_CURRENT_BLOCK`), with exactly ONE unresolved workout dated strictly
  before the athlete-local today and later workouts dated on or after
  today.
- **Seed limitation:** the dev seed places cycles from the UTC date
  (`seed-dev-plan.ts`), so near local midnight its "today" can differ from
  Prague by a day. Seed in the daytime, or author explicit dates.
- **Missed workout:** the seed currently authors only the current cycle's
  workouts, so the missed one has to be created by seeding with a past
  date, or by waiting a day without training.
- **No sessions yet:** no ACTIVE/COMPLETED canonical session may exist for
  the missed workout or any later workout.

### 10.11 Not in Slice C

Mobile UX (an Apply or Keep-schedule button, a missed-workout Today card,
a Plan visual diff), a timezone settings UI, notifications, Block
Complete, Return After Break / multiple misses, a way to schedule a
carryover, invented recurring slots, mass date shifting, ProgramVersion
mutation, workout merging and double sessions.

## 11. Slice D — athlete Today / Plan UX (2026-10-07)

Principle: Vostivo does not punish a missed workout; it keeps the program
in order instead of silently skipping it. The copy is calm decision
support:
- no guilt, streak or alarm language;
- no red styling;
- signal lime appears only on the primary action / CTA text.

### 11.1 Architecture (mobile, `apps/mobile/src/missed-workout/`)

- **Pure rules** in `missed-workout-flow.ts`:
  - the state model;
  - Today card derivation;
  - the changes-only diff;
  - day labels relative to the SERVER's `athleteLocalDate` (never the
    device date);
  - the narrow reason copy.
- **Framework-free controller** `missed-workout-controller.ts` holds all
  network and business rules, mirroring `AvailableTimeFlowController`.
- **Dumb views:** `missed-workout-card.tsx` and
  `missed-workout-review-sheet.tsx` (the RN built-in Modal, no new
  dependency).
- **HTTP:** `missed-workout-api-client.ts`.
- **Plan row presentation:** `src/plan/plan-session-schedule.ts`.
- **Ports:** wired in `plan-runtime.ts`.
- **States:** `IDLE`, `ROLL_FORWARD` (with `reviewOpen`, apply
  `idle`/`applying`/`failed`, and `planChanged`), `REVIEW_REQUIRED`,
  `TIMEZONE_REQUIRED`, `DISMISSED`, `PREVIEW_ERROR`.

### 11.2 Today

- **Placement:** a compact card below the Workout Hero. It never replaces
  the Hero's primary action.
- **ROLL_FORWARD:** "PLAN UPDATE · You missed {name} · Keep your training
  sequence intact by doing {name} next. · Review update". The name comes
  from the server.
- **REVIEW_REQUIRED** (no Apply anywhere): "Plan needs review · Your
  schedule changed enough that Vostivo won't adjust it automatically ·
  View plan".
  - Optional reason line, only for MULTIPLE_MISSED_WORKOUTS,
    LATER_SESSION_ALREADY_PERFORMED and NO_KNOWN_TRAINING_SLOT.
  - Never a raw code.
- **TIMEZONE_REQUIRED:** "Set your training timezone to adjust missed
  workouts. · Try again". This retries the bootstrap explicitly. It is
  never full-screen and never fatal.
- **Loading:** the preview is fetched independently of the overview.
  - Its failure degrades quietly (no card) and never touches the Hero.
  - A reload never blanks an already shown state (no flash).
- **After Apply:** a rolled-forward workout in the Hero shows "Originally
  Monday" as quiet context.

### 11.3 Review surface

One sheet:
- the title "Keep your plan in sequence";
- **Missed:** name + day;
- **Recommended next:** name + "Today";
- **Schedule changes**, changes only: new day ← "from" the CURRENT
  effective day. Unchanged items are hidden;
- **Needs a training day:** carryovers. Never a date;
- "Your original program stays unchanged."

Actions:
- **Apply update** is the primary action.
- **Not now** closes the sheet and hides the card until the next Today
  refresh. It sends no request and persists nothing, so the card may
  return while it still applies.
- There is no "Keep schedule" in V1, because no durable "accept skipping"
  decision exists.

### 11.4 Apply

- **Request:** only `{ previewFingerprint }`, the fingerprint of the
  preview on screen, sent to `POST /plan/missed-workout-apply`.
- **NO AUTO-APPLY:** not on load, refresh, timezone bootstrap or app open,
  and not for GUIDED. Every mode uses the same flow and needs an explicit
  "Apply update". COACHED is unaffected; `experience_mode` is unchanged.
- **Success:** close the review and re-read Today/Plan (the server's
  EFFECTIVE schedule). It never starts a workout.
  - Today then shows the rolled-forward workout with the ordinary Start
    Workout.
  - Starting uses the existing path with the original PlannedWorkout id.
- **409 STALE / NOT_APPLICABLE / CURRENT_TRAINING_BLOCK_UNRESOLVED:**
  re-read the preview. The same apply is never re-sent.
  - New ROLL_FORWARD: the review stays open with "Plan changed. The
    recommendation was updated. Review it again." It needs a fresh
    explicit Apply and the new fingerprint is never auto-applied.
  - NO_CHANGE: the card disappears.
  - REVIEW_REQUIRED: the calm review state.
  - Today/Plan are refreshed.
- **409 TRAINING_TIME_ZONE_REQUIRED:** the timezone state.
- **Offline / 5xx:** the preview stays open with "Couldn't update the plan
  right now." and the actions **Retry** (the same explicit Apply) and
  **Not now**. Nothing is changed locally; there is no optimistic Plan
  mutation, because schedule Apply needs server validation, unlike
  workout logging.

### 11.5 Plan

- **Placement:** rows already sit on their EFFECTIVE date (server).
- **Adapted row:**
  - a subtle neutral "Adjusted" badge;
  - "Originally Monday" as secondary caption.
- **Carryover:** stays visible with the caption "Needs a training day".
  - Never Skipped/Cancelled/Missed; no date is invented.
- **Normal authored rows:** unchanged and clean.
- **Plan structure:** not redesigned.

### 11.6 One-time training timezone bootstrap (`src/profile/`)

`TrainingTimeZoneBootstrapper` runs at most once per app process, before
Today's first preview:
1. `GET /me`.
2. If `trainingTimeZone` is null, read the device zone via the JS runtime's
   `Intl`. No native module, no location permission, no IP or geolocation.
3. Validate it as an IANA id: offsets, `GMT±N` and `Etc/GMT±N` are never
   sent; `UTC` is allowed.
4. `PUT /me/training-time-zone`, then `GET /me` again.

Rules:
- **SET ONCE, NOT TRACKED:** a non-null zone is never overwritten, so travel
  never moves the training day. A manual Profile override is future work.
- **Failure:** logged (DEV-only, technical text only). Ordinary Today/Plan
  keep working via LEGACY_UTC_FALLBACK, and the adaptation shows the
  retryable TIMEZONE_REQUIRED state.

### 11.7 Available-Time interoperability

After Apply, Today's workout is the rolled-forward one. "Adjust time"
previews and adjusted-starts that workout's OWN PlannedWorkout id: there is
no synthetic workout and no special session type. The occurrence claim
belongs to the same id.

### 11.8 Evidence

- **Mobile:**
  - `missed-workout-flow.test.ts` and `missed-workout-controller.test.ts`
    (Today card tests 1–18 and the timezone-required state);
  - `training-time-zone-bootstrap.test.ts` (tests 19–26);
  - `plan-session-schedule.test.ts` (tests 27–32).
- **API real Postgres, `missed-workout-cross-feature.integration.test.ts`:**
  - X-034/035: the ordinary START of the rolled-forward workout through
    the REAL sync path claims its own id;
  - X-036/037: Available-Time preview + adjusted START VERIFIED on it;
  - X-038: no progression artifacts and no session from Apply.
- **Not separately proven here:** active-workout recovery. Schedule
  adaptation touches no local workout state or outbox.

### 11.9 Known limitations

- The device zone comes from Hermes `Intl`. On a device that reports
  `UTC`, the training zone becomes UTC, which is valid but may not match
  the athlete. Correcting it needs the future Profile override.
- DEV-only logging (no production log sink exists yet).
- "Not now" lasts until the next Today refresh, including returning to
  Today from Plan. That is by design: nothing is persisted.
- A carryover can't be scheduled from the app yet.

