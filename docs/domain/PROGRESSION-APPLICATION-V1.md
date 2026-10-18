# Vostivo — Progression Application V1 Specification

**Status:** Pre-implementation domain specification — **RECONCILED against
tech-lead final decisions** (this pass), awaiting final tech-lead approval
of ADR-0009. Nothing in this document is implemented. No runtime code,
schema, migration, or dependency changed while writing or reconciling it —
see the final report.

**Answers**: *"What happens after Vostivo has a persisted progression
recommendation?"*

**One-sentence answer**: a persisted `progression_decisions` row is
*evidence*; it becomes a *change to future training* only when a separate,
explicit, auditable **Progression Application** — created and transitioned
according to the athlete's mode/coach authority — writes a small,
reversible, **exercise-level** effective-value **overlay** on top of the
athlete's existing, untouched Plan. Nothing about `Program`/
`ProgramVersion`/`TrainingBlock`/`TrainingCycle`/`PlannedWorkout`/
`PlannedExercise`/`PlannedSet` as *authored* ever changes; what changes is
which value those slots *effectively resolve to* for a not-yet-started
future workout, and that effective value is always resolved from the
*current effective* state of the stream, never blindly re-derived from the
original authored number.

---

## 0. Reconciliation note

This revision incorporates 32 final tech-lead decisions on top of the
initial draft. Every material change is called out inline where it
matters; §0.1 is a compact map from decision number to the section that
resolves it, for traceability.

### 0.1 Decision map

| # | Topic | Resolved in |
|---|---|---|
| 1 | ProgramVersion strategy (overlay, keep ADR-0009) | §4 (unchanged in substance) |
| 2 | Stream identity excludes `setOrderIndex`/cycle | §2 |
| 3 | Identity preconditions, first-class-ID contingency | §2.3 |
| 4 | Exercise-level application, WARM_UP excluded | §2.2, §9 |
| 5 | `effectiveFrom` boundary (program-order, not wall-clock) | §2.4 |
| 6 | Workout Start hard boundary | §23 |
| 7 | One current effective overlay per stream | §6.1, §29 |
| 8 | Resolve next load from current effective, not authored | §8.1 |
| 9 | Reject `DEFAULT_LOAD_INCREMENTS` | §8.2 |
| 10 | `LOADING_CAPABILITY_UNAVAILABLE` outcome | §8.3 |
| 11 | LoadingCapability source is a prerequisite | §8.4, Open Tech-Lead Decisions |
| 12 | `NO_CHANGE` — no application row | §10 (unchanged) |
| 13 | `MAINTAIN_LOAD_BUILD_REPS` — no application row | §9 (unchanged, closes prior open item) |
| 14 | Only `INCREASE_LOAD` creates applications | §5, §10 |
| 15 | Precise state definitions | §6 |
| 16 | Revoke/undo rule | §17 |
| 17 | GUIDED auto-apply is a separate durable job | §11 |
| 18 | GUIDED eligibility checklist | §11.1 |
| 19 | ADAPTIVE | §33 |
| 20 | EXPERT — same mechanics as ADAPTIVE | §33 |
| 21 | COACHED — overlay only, not a stored mode | §6.2, §33 |
| 22 | Staleness precondition list | §7 |
| 23 | Effective-applied-state vs. recommendation-history distinction | §7.1 |
| 24 | Structural plan change invalidates old overlay scope | §19 |
| 25 | Single effective-target resolver, WARM_UP excluded | §22 |
| 26 | Offline — unchanged local-first guarantees | §24 (unchanged) |
| 27 | Idempotency — two distinct invariants | §14 |
| 28 | Concurrency — re-read+lock+compare-and-apply | §13 |
| 29 | Audit value fields | §5.1 |
| 30 | Table review | §29 |
| 31 | Index/constraint review | §29.1 |
| 32 | ADR-0009 stays Proposed pending this reconciliation | Final report |

---

## 1. Phase 1 — Current-state architecture map (unchanged findings)

*(Findings from the initial draft stand — restated only where a later
decision depends on precision.)*

### 1.1 Hierarchy and where `targetLoad` lives

```
Program -> ProgramVersion (1 ACTIVE, DB partial unique index)
  -> TrainingBlock (ordered) -> TrainingCycle (ordered, real dates)
    -> PlannedWorkout (ordered; scheduling status only)
      -> PlannedExercise (ordered; exerciseRef opaque/nullable)
        -> PlannedSet (ordered; targetLoad + targetReps + setType, authored)
```

`targetLoad` is a real, structured column set on `PlannedSet` (Load Model
Stage 1). `WorkoutPrescriptionV1` copies it 1:1, fresh, on every
`PlanReadService` call — no cache. This remains the single most important
structural fact this document relies on.

### 1.2 No cross-occurrence identity exists; `ProgramVersion` mutation/
cloning does not exist; future cycles are not reliably materialized

Unchanged from the initial draft. See §2 for the reconciled identity
model this drives.

### 1.3 `progression_decisions.sourcePrescriptionExerciseId` is opaque text, not a FK

**New finding, required by this reconciliation**: `progression_decisions.
sourcePrescriptionExerciseId` is stored as `text`, deliberately **not** a
foreign key ("the opaque prescription-snapshot exercise id the decision
was evaluated against — not a FK, same reasoning as `performed_exercises.
prescription_exercise_id`" — `packages/database/src/schema/progression.ts`).
When the source workout's prescription came from Plan,
`prescriptionExerciseId` equals a real `PlannedExercise.id` (`prescription-
builder.ts` copies it 1:1). When it did not (an ad-hoc/manually-authored
prescription with no Plan backing — always structurally possible in this
system), it resolves to nothing. **This is a real, expected, non-error
case**: a decision with no resolvable Plan context can never produce a
Progression Application, by construction — see §5.2's `NO_PLAN_CONTEXT`
outcome.

---

## 2. Phase 2 — Program Slot Identity (final)

### 2.1 Final identity — exercise-level, not set-level, not cycle-scoped

```
{ programVersionId, trainingBlockId, workoutOrderIndex, exerciseOrderIndex }
```

**`setOrderIndex` is explicitly excluded.** **`trainingCycleId`/cycle
`orderIndex` is explicitly excluded from the identity itself** (it is used
separately, as the `effectiveFrom` boundary — §2.4 — never as part of
"which stream this is").

**Why cycle is excluded from identity**: the whole point of the identity
is to represent *one recurring programmed exercise slot that repeats
across cycles* ("Upper A / Bench Press / exercise slot 1" in week 1 is the
*same stream* as week 2's occurrence of the same slot). Including a cycle
identifier in the key would make every week's occurrence a *different*
stream — exactly the opposite of what "progression stream" means.

**Why `setOrderIndex` is excluded** (Decision 4): the Progression Engine's
own evaluation is exercise-level, not set-level — `evaluateProgression()`
consumes one `ProgressionEvaluationInput` per exercise exposure, and
`reconstructPrescriptionContext()` (Slice C, unchanged) already *requires*
a single uniform `targetReps`/`targetLoad` across every prescribed
`WORKING` set of that exercise, returning `null` (aborting evaluation
entirely, `NO_PRESCRIPTION_CONTEXT`) if the working sets are
heterogeneous. **Consequence**: by construction, every `INCREASE_LOAD`
decision that exists at all was evaluated against an exercise whose
`WORKING` sets already shared one target load. There is never a
legitimate case in V1 where "the same exercise's three working sets" need
three different progression streams — modeling one per set would invent a
distinction the engine itself never produces evidence for. See §2.2 for
exactly which `PlannedSet` rows an application affects.

### 2.2 Set-level effect of an exercise-level application

One applied resolved load affects **every eligible `WORKING` `PlannedSet`**
under the matching `PlannedExercise` at each eligible future occurrence.
**`WARM_UP` `PlannedSet` rows never receive the overlay, ever** — the
resolution function (§22/§25) checks `setType` and returns the authored
value unchanged for any non-`WORKING` set, unconditionally.

**Heterogeneous working-set target loads**: if a *future* occurrence's
`PlannedExercise` is found to have `WORKING` sets with genuinely different
authored `targetLoad` values (a state the *source* exercise could never
have been in per §2.1, but a *different*, independently-authored future
occurrence theoretically could be, since nothing enforces cross-occurrence
uniformity structurally) — the application service does **not guess**.
This is treated as a slot-level precondition failure for that specific
occurrence only (skip it, do not invent a value, do not partially apply to
only some of its sets) — outside ordinary V1 automatic progression, exactly
as instructed. Every other eligible occurrence is unaffected by this one
occurrence's exclusion.

### 2.3 Required identity preconditions (Decision 3) — exhaustive

A derived positional match is trusted **only** while *all* of the
following hold, for a given target occurrence:

- same `programVersionId` (still `status = 'ACTIVE'` at the moment of the
  check — a version change is caught here automatically, §7/§19),
- same `trainingBlockId`,
- same `workoutOrderIndex`,
- same `exerciseOrderIndex`,
- the target occurrence's actual `PlannedExercise.exerciseRef` **exactly**
  equals the application's own recorded `exerciseRef` (captured from the
  source at creation time) — a mismatch means the slot has been
  restructured (an exercise swap) and the match is refused,
- the `ProgramVersion`'s structure has not otherwise changed in a way that
  would make the tuple meaningless (covered by the version-still-ACTIVE
  check above, since any structural change is defined, per ADR-0008, to
  require a new `ProgramVersion`).

**Never crossed automatically**: another `ProgramVersion`, another
`TrainingBlock`, a different `exerciseRef`, or a structural exercise
replacement. **No `ExerciseFamily`/fuzzy identity exists or is introduced
in V1** — a failed precondition simply excludes that occurrence; it is
never "resolved" by approximate matching.

**Forward-looking contingency, not a present blocker**: this positional
scheme is safe *precisely because* no program-generation mechanism exists
today to violate it (§1.2) — there is nothing yet that could produce a
future cycle whose workout/exercise ordering diverges from its
neighbors in a way this scheme would mis-happen to match anyway (a
structural mismatch simply yields zero matching rows, never an *incorrect*
match — see §2.1's exercise-uniformity argument and §28's failure-mode
table). **This is recorded here as an explicit constraint that any future
program-generation/materialization feature must satisfy**: it must keep
`orderIndex` layout consistent for what a human would recognize as "the
same slot" across a block's repeated cycles. **If a future implementation
session building that feature finds it cannot honor this constraint, THAT
is the trigger to introduce a first-class, persisted Program Slot ID
column** (on `PlannedExercise` or equivalent) **— not a license to fall
back to fuzzy/`exerciseRef`-only matching.** This is flagged as a real,
open architectural dependency (§43's risk table), not silently assumed
away.

### 2.4 `effectiveFrom` boundary (Decision 5) — program-order, never wall-clock

Every application row persists **`effectiveFromCycleOrderIndex`**: the
`TrainingCycle.orderIndex` of the cycle containing the *source* performed
exposure's `PlannedWorkout` (resolved via `PlannedExercise ->
PlannedWorkout -> TrainingCycle`, the same walk used to derive the tuple
itself). **An eligible target occurrence is one whose own
`TrainingCycle.orderIndex` is strictly greater than
`effectiveFromCycleOrderIndex`** — never a wall-clock date comparison, and
never the source cycle itself.

This directly satisfies the required invariant: an application from
source workout S applies only to the next eligible future occurrence(s)
of the same stream *after* S, expressed entirely in canonical program
order (cycle sequence within a block), never in calendar time — a cycle's
`startDate`/`endDate` remain purely a scheduling/display concern (§1.1),
irrelevant to this ordering.

**Explicitly excluded by this boundary alone** (no extra rule needed):
the source workout itself (`orderIndex` not `>` itself); any past cycle
(`orderIndex <=` the boundary is excluded structurally); a completed
workout (excluded twice over — WDI-PROG-APP-001, and because a completed
workout's cycle is never a *future* cycle relative to its own source); any
`PlannedWorkout` whose own `WorkoutSession` has already started (checked
separately, §3, since "future cycle" alone doesn't guarantee "not yet
started" for a workout the athlete started early/out of order).

---

## 3. Phase 3 — Application scope (the V1 cutoff, restated with §2's identity)

**Absolutely never touched, no exceptions (WDI-PROG-APP-001)**: a completed
`WorkoutSession`; a started `WorkoutSession`; any `PerformedSet`/
`PerformedExercise`; any `WorkoutSession.prescriptionSnapshot`.

**In scope**: `PlannedSet` rows (WORKING only, §2.2) matching the source's
slot identity (§2.1), where the target `PlannedWorkout`'s
`TrainingCycle.orderIndex > effectiveFromCycleOrderIndex` (§2.4), within
the same `TrainingBlock` and the currently-`ACTIVE` `ProgramVersion`
(§2.3), whose `PlannedWorkout.status` is `PLANNED` or `AVAILABLE`, and
which has **no matching `WorkoutSession` at all yet** (checked the same
way `PlanReadService.findMatchingSessions` already does).

**Explicitly out of scope** (unchanged from the initial draft, table
preserved for completeness): not-yet-materialized future cycles (§1.2 —
nothing to write yet; forward-compat note unchanged: the tuple-keyed
overlay is independently discoverable by a future materialization
process, §2.3's contingency note applies), rescheduled/cancelled/skipped
workouts, an already-snapshotted workout, another slot in the same week,
later `TrainingBlock`s (§19), a future `ProgramVersion`.

---

## 4. Phase 4 — ProgramVersion immutability strategy (APPROVED, unchanged in substance)

**Decision 1 confirms**: routine progression must not create a new
`ProgramVersion`. `ProgramVersion` remains authored/structural intent;
Progression Application is an effective-value overlay; authored
`PlannedSet` data and historical `WorkoutPrescriptionV1` snapshots remain
unchanged; Plan/Preview/Start resolve through one boundary (§22/§23). The
full Option A/B/C/D analysis from the initial draft is preserved
unmodified below (§4.1-§4.5) — no part of it is reopened; it already
reached exactly this conclusion.

### 4.1 Option A — new `ProgramVersion` per applied routine progression — REJECTED

No clone mechanism exists; would explode `versionNumber` per single-set
bump; contradicts "smallest necessary change"; rollback of one change
would revert every other bundled change. (Full detail preserved from
initial draft — unchanged.)

### 4.2 Option B — RECOMMENDED — effective-value overlay, consulted at read time

Preserves `ProgramVersion` structural immutability exactly; reuses the
`progression_decisions` create-then-supersede pattern already proven in
Slice C; low DB complexity; trivial rollback; no version explosion.

### 4.3 Option C — resolve only at workout-start time — REJECTED (collapses into B)

Would leave Plan/Preview stale before Start — violates §22's required
consistency; resolving on every read is cheap at this traffic volume
(§37), so this is not a genuinely distinct option.

### 4.4 Option D

No better repository-native alternative was found; Option B *is* the
repository-native choice (direct generalization of Slice C's own proven
pattern).

### 4.5 Recommendation

**Option B, confirmed by Decision 1.** No contradiction with any locked
decision. ADR-0009 (§39) captures this, Status: Proposed pending this
reconciliation's own final report recommendation.

---

## 5. Phase 5 — Progression Application domain model (reconciled)

**Decision 14 confirms**: only `INCREASE_LOAD` produces a
`progression_applications` row in V1 (§9/§10 for why the other two never
do). Decision != Application is unchanged and structurally enforced
(`progression_decisions` gains no new column or write from this feature).

### 5.1 Fields (reconciled — renamed/added per Decisions 5, 8, 29)

| Field | Why (updated) |
|---|---|
| `id` | Row identity. |
| `progressionDecisionId` | FK to the evidence; `UNIQUE` (Decision 27 — one workflow per decision). |
| `userId` | Re-derived server-side from the decision's own `userId`, never trusted from a request (§25). |
| `exerciseRef` | Captured from the source at creation; also the exact-match precondition (§2.3) — not just a label. |
| **Slot identity** (§2.1): `programVersionId`, `trainingBlockId`, `workoutOrderIndex`, `exerciseOrderIndex` | The stream — `setOrderIndex` deliberately absent (§2.1). |
| **`effectiveFromCycleOrderIndex`** (§2.4) | *New in this reconciliation.* The program-order boundary — never a timestamp. |
| `authorityMode` | `GUIDED`/`ADAPTIVE`/`EXPERT` at creation time — never `COACHED` (Decision 21, same locked precedent as `experienceMode` itself). |
| `coachingRelationshipId` | Nullable; set only when an active coach overlay governs the decide-transition (mechanism pending, §Open Tech-Lead Decisions). |
| `status` | §6's six states. |
| `engineDecisionType` | Always `'INCREASE_LOAD'` in V1 (Decision 14) — kept as an explicit, self-describing column rather than an implicit assumption, and forward-compatible if a future slice ever creates an application from a different decision type. **Direction only, never a numeric value** — the pure engine never proposes a number (§8). |
| **`expectedEffectiveLoad`** | *New/renamed in this reconciliation (was only prose before).* The effective load (§22) this application expects to still be true at decide/apply time — the staleness precondition (§7), re-verified inside the same transaction as any state-changing write. Distinct from `resolverProposedLoad`: this is the *input* to resolution; that is the *output*. |
| `loadingCapabilityId` / `loadingCapabilityRevision` / `loadingCapabilitySnapshot` | *Resolved by `docs/domain/LOADING-CAPABILITY-V1.md`, revised — populated ONLY at the moment of a successful Apply, never at creation (§8.1.1).* `NULL` throughout `PENDING_REVIEW`/`KEPT_ORIGINAL`/`STALE`/`SUPERSEDED`. Once set (on `APPLIED`), immutable forever — the exact `LoadingCapability` row, its monotonic `revision` at that moment, and a snapshot of its payload, so a later edit to the live (mutable) capability row can never retroactively change how this application is explained (same discipline as `progression_decisions.normalizedInputSnapshot`). |
| `resolverProposedLoad` | The Load Resolver's output, `null` if unresolved (§8.3/§8.4 — `LOADING_CAPABILITY_UNAVAILABLE`, `NO_CURRENT_LOAD`, `CURRENT_LOAD_UNSUPPORTED`, `CAPABILITY_INCOMPATIBLE`, or `NO_SUITABLE_INCREMENT`). |
| `resolverOutcomeReason` | *New.* Populated whenever `resolverProposedLoad IS NULL` — one of the five codes above — so the UI/audit can distinguish "no attempt yet" from "attempted, could not resolve," and exactly which reason. |
| `appliedLoad` | The value actually written to the overlay; equals `resolverProposedLoad` unless overridden (§15/§29). `NOT NULL` iff `status IN ('APPLIED','REVOKED')` (§29.1). |
| `overrideReason` | Nullable free text, never analytics-visible (§27). |
| `createdAt` | — |
| `decidedAt` | Nullable while `PENDING_REVIEW`. |
| **`decidedByActorType`** | *New in this reconciliation (Decision 29).* `SYSTEM \| ATHLETE \| COACH` — an explicit type, not merely inferred from whether `decidedBy` is null. |
| `decidedBy` | Nullable `userId`; `NULL` only when `decidedByActorType = 'SYSTEM'` (GUIDED auto-apply). |
| `supersededByApplicationId` | Self-reference, `NO ACTION` — set only when a *different application* becomes the current overlay for the same stream (§6.1/§7.1 — never set merely because the justifying *decision* was superseded; see §7.1's crucial distinction). |
| `revokedAt` / `revokedBy` | Set only on `REVOKED` (§17). `appliedLoad` is retained, not cleared, on revoke — the historical record of what *was* applied stays intact. |

**Deliberately still excluded**: a generic `metadata jsonb`; a
`gymProfileId`/`loadingProfileId` column (§8.4 — the capability source
itself is a pending prerequisite, not yet a real persisted concept to
reference); a free-form audit-trail array (no event sourcing).

### 5.2 `NO_PLAN_CONTEXT` — the honest non-error outcome (§1.3)

`createFromDecision(decision)` first resolves the decision's
`sourcePrescriptionExerciseId` against a real `PlannedExercise` row. If
none is found (an ad-hoc, non-Plan-backed prescription — a legitimate,
expected state, §1.3) or the resolved `PlannedExercise`'s owning
`ProgramVersion` is not currently `ACTIVE`, the outcome is
`NO_PLAN_CONTEXT`: **no `progression_applications` row is created at
all.** This is not a failure — most decisions from an ad-hoc logged
exercise will legitimately hit this every time, forever, and that is
correct.

---

## 6. Phase 6 — Application state machine (reconciled, precise per-state semantics — Decision 15)

```
CREATED (a decision resolves to a real PlannedExercise, §5.2, and
         PENDING_REVIEW is the row's very first observable state)
   |
   v
PENDING_REVIEW ----------------------> STALE       (§7 breaks before a
   |     |                                           decision is made)
   |     |
   |     +-----------------------> SUPERSEDED  (a newer APPLICATION reaches
   |                                             APPLIED for the same stream
   |                                             before this one is decided
   |                                             — NOT merely because the
   |                                             justifying decision itself
   |                                             was superseded, §7.1)
   |
   +-------------------------> KEPT_ORIGINAL   (terminal — §16)
   |
   +-------------------------> APPLIED
                                   |
                                   +----> REVOKED     (§17 — only before any
                                   |                    affected session starts)
                                   |
                                   +----> SUPERSEDED  (a DIFFERENT, later
                                            application becomes the current
                                            overlay for the same stream —
                                            §6.1/§7.1; this row is NOT
                                            reverted, its overlay effect is
                                            simply no longer "current")
```

### 6.1 Precise definitions (Decision 15, verbatim distinctions enforced)

- **`PENDING_REVIEW`**: a valid, unapplied `INCREASE_LOAD` application
  awaiting authorized action (human, or the system for GUIDED).
- **`APPLIED`**: its resolved value **became the current effective future
  overlay** for its stream — enforced by the one-current-overlay
  invariant (§7.1/§29.1), never merely "a human clicked apply" without
  that invariant actually holding.
- **`KEPT_ORIGINAL`**: an authorized actor explicitly chose not to apply
  this recommendation. Terminal. Never re-surfaced as pending (§16).
- **`STALE`**: this application can no longer safely apply because its
  expected plan/precondition state changed (§7) — detected before any
  decide/apply action succeeded.
- **`SUPERSEDED`**: a newer **application** (not merely a newer decision,
  §7.1) became authoritative for the same progression stream, before or
  instead of this one taking effect.
- **`REVOKED`**: an already-`APPLIED` overlay was explicitly withdrawn,
  **only** while doing so does not require rewriting historical workout
  reality (§17).

These six are never used interchangeably; §29.1's constraints enforce the
distinction at the database level, not merely by convention.

### 6.2 `COACHED` is never a stored state or mode (Decision 21)

`experience_mode`/`authorityMode` never contains `'COACHED'` — identical
to the already-locked `EXPERIENCE_MODES` precedent
(`packages/domain/src/identity/athlete-profile.ts`). A coach's authority is
expressed by `coachingRelationshipId` being set on an application whose
*base* `authorityMode` is one of `GUIDED`/`ADAPTIVE`/`EXPERT` — never a
fourth enum value.

---

## 7. Phase 7 — Staleness preconditions (Decision 22 — exhaustive)

Re-derived and re-verified, inside the same transaction as any
state-changing write, **never trusted from the client** (the client
supplies only its own action + idempotency key, §14):

```
user ownership                          (actor.userId == decision.userId)
active ProgramVersion                   (programVersionId still status='ACTIVE')
TrainingBlock                           (still exists — NO ACTION FKs, never deleted)
progression stream identity             (§2.1 tuple still resolves to a real slot)
exerciseRef                             (exact match, §2.3)
expected current effective load         (expectedEffectiveLoad == live §22 resolution)
decision still current / not superseded (progression_decisions.supersededByDecisionId IS NULL)
target occurrence eligibility           (§3's scope filter, re-checked live)
mode/coach authority                    (§25)
entitlement where applicable            (existing Pro-gate convention, §18)
```

Any failure -> `STALE` (if not yet decided) or a rejected decide-attempt
(if raced at the exact moment of a write) — never a forced write.

**`LoadingCapability` resolution is deliberately NOT in this list**
(revised — see §8.6): a capability being unavailable, or a human's
previewed proposal having gone stale, never sets `status = 'STALE'` — it
produces `LOADING_CAPABILITY_UNAVAILABLE` or `PROPOSAL_REFRESH_REQUIRED`
instead, both non-terminal, both leaving the underlying recommendation
fully valid and reviewable.

### 7.1 Effective applied state vs. recommendation history (Decision 23 — critical)

**These are two separate concerns and must never be conflated**:

- **Recommendation history** = the immutable sequence of
  `progression_decisions` rows for a source exposure (Slice C, unchanged),
  including its own supersession chain (D1 -> D2 for corrected evidence).
- **Effective applied Plan state** = whichever `progression_applications`
  row currently holds the one-current-overlay slot for a stream (§29.1).

**A newer decision alone never silently changes the effective applied
state.** Concretely:

| Scenario | Effect on the already-`APPLIED` overlay |
|---|---|
| A new `NO_CHANGE` decision lands after an increase was applied | **No change.** The overlay stays exactly as applied. `NO_CHANGE` never creates an application (§10) and never reverts one. |
| A new `MAINTAIN_LOAD_BUILD_REPS` decision lands after an increase was applied | **No change**, same reasoning (§9). |
| A new `INCREASE_LOAD` decision lands after an increase was applied | A **new** application is created; its `expectedEffectiveLoad` is the *current* overlay's `appliedLoad` (§8.1 — never the original authored value). If/when *this new* application reaches `APPLIED`, it becomes the new current overlay and the *old* application transitions to `SUPERSEDED` — an explicit forward action, never an automatic reversion triggered by the mere existence of a new decision. |
| Corrected evidence supersedes the original decision (D1 -> D2, Slice C) | The **decision** record reflects this (`D1.supersededByDecisionId = D2.id`), exactly as Slice C already does. **The already-`APPLIED` application tied to D1 is untouched** — it does not transition to `SUPERSEDED` or anything else merely because its justifying decision was later revised. Its `status` remains `APPLIED` until a genuine forward application/revoke/structural plan change replaces it. (If D1's application was still `PENDING_REVIEW`, *that* case is different and unchanged from the initial draft: an undecided application does transition to `SUPERSEDED` when its own justifying decision is superseded, since nothing has taken effect yet to protect — Example F, §34.) |

**Do not silently roll back an applied load simply because a later
recommendation says `NO_CHANGE`.** This is the single most important rule
in this section.

---

## 8. Phase 8 — Load Resolver composition (substantially revised)

### 8.1 Resolve from the CURRENT EFFECTIVE load, never the authored base (Decision 8)

When `createFromDecision()` builds an application row for a new
`INCREASE_LOAD` decision, the value passed as `current` to
`resolveNextLoad(current, capability)` is **the live result of §22's
resolution function for this stream right now** — i.e., the current
`APPLIED` overlay's `appliedLoad` if one exists for this stream, otherwise
the source `PlannedExercise`'s own authored `targetLoad` (uniform across
its `WORKING` sets, §2.1). This value is also stored as
`expectedEffectiveLoad` (§5.1) and **re-verified live at decide/apply
time** — if the live effective value has moved on since creation (a
concurrent application, a revoke, anything), the write is refused as
`STALE` (§7), never silently re-based on whatever the authored column
still says.

**Worked chain** (Example C, §34): authored `100 kg` -> Application A
resolves and applies `102.5 kg` (current overlay = `102.5`) -> a later
completed workout (itself snapshotted at `102.5 kg` per §23) produces a
new `INCREASE_LOAD` decision -> Application B's `current` input to
`resolveNextLoad` is `102.5 kg`, **not** `100 kg` -> resolves to
`105 kg`. No accidental reset ever occurs, because the resolution
boundary (§22) is the *only* place "current" is ever read from, for
*both* Plan display and Application creation.

### 8.1.1 Resolution is Apply-time-authoritative only (revised — was: frozen at creation)

**Revised**: the initial version of this section resolved the capability
once at `progression_applications` creation time and treated any later
capability change as terminal staleness. **This is now corrected**: an
`INCREASE_LOAD` `EngineDecision` and its application workflow remain valid
even while the athlete's `LoadingCapability` configuration changes —
Progression Application workflow lifetime and immutable applied audit are
two different concerns, and conflating them made ordinary equipment
corrections needlessly destructive to a still-good recommendation.

**Final model**: no capability resolution is ever persisted while an
application is `PENDING_REVIEW`. A `PENDING_REVIEW` card's numeric
preview (for ADAPTIVE/EXPERT UI) is computed **fresh, on read, every
time** — ephemeral, never stored, never authoritative, always reflecting
the *live* binding/capability state. Only the **Apply transaction itself**
(human-confirmed, or GUIDED's own durable job) resolves and **persists**
the authoritative `loadingCapabilityId`/`loadingCapabilityRevision`/
`loadingCapabilitySnapshot`/`resolverProposedLoad`/`appliedLoad` —
immutable from that moment on (§21 of the loading-capability follow-up).
See §8.5 for exactly how a human-confirmed Apply protects against acting
on a proposal the athlete never actually saw.

### 8.2 No generic `DEFAULT_LOAD_INCREMENTS` (Decision 9 — reverses the initial draft)

**The initial draft's proposal of a global, unit/basis-keyed default
increment table is withdrawn.** It would have silently assumed all
`KG`/`TOTAL` equipment (a barbell, a machine, a different machine) shares
one increment, and all `PER_IMPLEMENT` dumbbells share another — exactly
the kind of equipment-reality guess `docs/domain/load-model-v1.md`
already forbids (`DISCRETE_LIST`'s own §40-41: *"One gym might have `30,
32.5, 35, 37.5, 40`; another `30, 32, 34, 36`. The Engine must respect the
reality of the specific gym."*). Numeric auto-application now **requires**
a valid, explicit, *specific* `LoadingCapability` (§8.4) — the
Progression Engine-direction vs. Load-Resolver-feasibility boundary
(`load-model-v1.md` §51-62, `LOAD-INV-016`) is preserved exactly, never
blurred by a convenient global assumption.

### 8.3 `LOADING_CAPABILITY_UNAVAILABLE` — the consistent, single behavior (Decision 10, name aligned with the Loading Capability follow-up)

A first-class outcome: a `resolverOutcomeReason` value (§5.1) alongside a
`resolverProposedLoad` of `NULL`. **Exactly one consistent persistence/
state behavior**:

- The `progression_decisions` row remains fully valid and untouched — the
  engine's `INCREASE_LOAD` recommendation is never invalidated by a
  resolution failure downstream.
- The application row is still created and lands in `PENDING_REVIEW`. No
  resolver fields are persisted for a merely-previewed outcome (§8.1.1) —
  the *live*, ephemeral preview simply comes back empty/unavailable on
  read.
- **No overlay is ever written for this outcome.**
- **GUIDED never auto-applies it** — its durable job's own live resolution
  attempt comes back unavailable, so the eligibility check (§11.1) fails
  and the row sits in `PENDING_REVIEW` indefinitely (or until it becomes
  `STALE`/`SUPERSEDED` through the normal, capability-*unrelated*
  mechanisms, §8.6) — functionally "no automatic action was taken."
- **ADAPTIVE/EXPERT** may still surface the row without a numeric preview
  (a UI/product choice, out of scope here); the *only* way such a row can
  ever reach `APPLIED` is through an explicit, human-supplied
  `overrideLoad` (§15/§30) — the system itself never guesses one.

### 8.4 LoadingCapability source — explicit binding model (revised)

**Superseded, and now revised again, by
`docs/domain/LOADING-CAPABILITY-V1.md` and
`adr/0010-loading-capability-architecture.md` (Status: Proposed).** The
architecture is: a `GymProfile` (one default per athlete, §Open-Decisions
of that document for the exact creation lifecycle) plus an **explicit
per-exercise binding** — `exercise_loading_capability_bindings
(gymProfileId, exerciseRef) -> loadingCapabilityId` — to a
`LoadingCapability` (`FIXED_INCREMENT` or `ENUMERATED_LIST`).

**The initial version of this section proposed a `unit`/`basis`-wide
`exerciseRef = NULL` "general" fallback. This has been REJECTED and
removed** — a gym's Barbell Bench, Leg Press, and Cable Row can all share
`KG`/`TOTAL` while having *completely different* real increments; a
unit/basis-wide fallback would have been exactly the kind of disguised
generic increment the tech lead already rejected once (§8.2), reintroduced
one level less obviously. **V1 resolution is now**:

```
target GymProfile + exact exerciseRef
        -> explicit binding exists?
             YES -> that binding's LoadingCapability
             NO  -> LOADING_CAPABILITY_UNAVAILABLE (§8.3)
```

**No fallback of any kind.** A capability *may* still be legitimately
shared by several exercises — e.g. Incline DB Press, Flat DB Press, and
One-Arm DB Row all pointing their own explicit binding at the *same*
`LoadingCapability` row (representing "this gym's one dumbbell rack") —
but that sharing is always an **explicit, per-exercise decision recorded
as a real row**, never an implicit unit/basis-wide assumption. This
requires no equipment taxonomy: the binding *is* the V1 seam a future,
richer equipment model could sit behind without changing this document's
own semantics.

### 8.5 Human-confirmed Apply never silently receives a different number than was shown (Decision 12)

`decide()` (§30) accepts an optional `expectedProposal:
{loadingCapabilityId, loadingCapabilityRevision, resolverProposedLoad}` —
populated by the client from whatever live preview (§8.1.1) it most
recently fetched, **never treated as the resolver's actual input**, only
as a race-detection precondition. Inside the Apply transaction, the
service resolves the *live* value and compares it against
`expectedProposal`:

- **Match**: proceed — persist the authoritative snapshot and apply
  atomically (§12).
- **Mismatch** (the athlete's gym capability changed between the last
  preview fetch and the Apply tap): return **`PROPOSAL_REFRESH_REQUIRED`**
  — a non-terminal outcome. **No database write occurs.** The underlying
  `EngineDecision` is not touched, no second `progression_applications`
  row is created (`UNIQUE(progressionDecisionId)`, §14, is never at risk —
  this is the *same* row, still `PENDING_REVIEW`), and the UI simply
  re-fetches the now-current live preview and asks the athlete to confirm
  again.

**GUIDED never supplies `expectedProposal`** — there is no human preview
to protect, so its durable job always resolves and applies live in one
step (§11/§13).

### 8.6 Capability changes are never `STALE` (Decision 14 — explicit distinction)

**`STALE` is reserved exclusively for genuine Plan/Application
preconditions no longer holding** (§7's own list: `ProgramVersion`
changed, `TrainingBlock`/stream identity no longer resolves, `exerciseRef`
changed, the decision itself was superseded before this application acted,
the target occurrence is no longer eligible, or the *Plan's own*
`expectedEffectiveLoad` changed through some other authoritative
mechanism). **A `LoadingCapability` revision change, or a capability/
binding becoming unavailable, is never one of these** — the `EngineDecision`
and the application workflow remain entirely valid; only the *numeric
resolution* is affected, handled by §8.3 (`LOADING_CAPABILITY_UNAVAILABLE`,
non-terminal, re-attempted on the next live read) or §8.5
(`PROPOSAL_REFRESH_REQUIRED`, non-terminal, re-confirmed by the same
human). Neither ever moves `status` to `STALE`.

**Capability/binding removed before Apply** (Decision 15): if a
previously-previewed binding is later removed (or repointed), the live
resolution simply comes back `LOADING_CAPABILITY_UNAVAILABLE` — the
workflow remains the same valid, reviewable recommendation; no Plan
mutation occurs; nothing is fabricated to match a preview that once
existed. `LoadingCapability` rows themselves are never hard-deleted once
referenced by any `progression_applications.loadingCapabilityId` (a plain
`NO ACTION` FK already prevents it) — "removing" equipment in product
terms means deleting or repointing the *binding*, never destroying a
capability row an old application's audit trail still points to.

---

## 9. Phase 9 — `MAINTAIN_LOAD_BUILD_REPS` (Decision 13 — closes the prior open item)

**Confirmed, no longer open**: no `progression_applications` row is ever
created for this decision type, including no inert row for UI
convenience. The existing `RANGE` `targetReps` already represents the
build-reps target; nothing needs to change on any future `PlannedSet`. A
future UI reads the un-superseded `progression_decisions` row directly.
Never create fake application history for a decision that never applied
anything.

---

## 10. Phase 10 — `NO_CHANGE` (Decision 12 — unchanged)

No application row, no Plan mutation, ever. `progressionStalled = true`
remains evidence reserved verbatim for a future Fatigue/Adaptation
Engine — never translated into a load reduction or deload here.

---

## 11. Phase 11 — GUIDED auto-apply orchestration (Decision 17 — resolved)

**Confirmed, resolved tech-lead decision, no longer merely a
recommendation**: GUIDED auto-application is a **separate durable job**
from progression evaluation. `ProgressionEvaluationService`/
`progression-evaluate-session-v1` are **never** extended to mutate future
Plan state inline — evaluation success and application success remain two
separate durable facts, and application retry must never recompute or
rewrite the original `EngineDecision`.

```
new EngineDecision persisted (unchanged evaluation pipeline)
        v
eligible for GUIDED auto-application? (§11.1)
        v
durable application job (a distinct pg-boss queue; exact name decided at
                          implementation time — e.g. conceptually
                          progression-auto-apply-v1)
        v
ProgressionApplicationService.decide(SYSTEM actor, ...)
        v
re-read canonical authority/plan state  ->  staleness check (§7)  ->
Load Resolver (§8)  ->  atomic application transaction (§12)
```

### 11.1 GUIDED eligibility (Decision 18 — exhaustive, all required)

```
decision.decisionType == 'INCREASE_LOAD'
AND canonical AthleteProfile.experienceMode == 'GUIDED' (server re-read, never client-claimed)
AND no active CoachingRelationship overrides authority for this stream
AND decision is not superseded, application (if pre-existing) is not stale/superseded
AND expectedProgramVersionId/trainingBlockId/slot/exerciseRef still match live state
AND expectedEffectiveLoad still matches the live §22 resolution
AND a valid LoadingCapability resolves (§8.4) AND resolveNextLoad returns RESOLVED
AND the target future occurrence(s) are still eligible and none has started
AND entitlement/product rules permit smart application (existing convention, §18/Phase-18-of-original-draft)
```

**If any condition is false: do not silently mutate.** The job records a
deterministic non-applied outcome (the application row stays
`PENDING_REVIEW`, possibly with `resolverOutcomeReason` set) — never a
partial or guessed write.

---

## 12. Phase 12 — Transaction boundary (unchanged, restated with §7.1's precision)

**Invariant WDI-PROG-APP-002** (unchanged): no committed state ever shows
`APPLIED` without a corresponding current overlay, or vice versa. One
Postgres transaction:

**Expanded per Decision 11** — capability resolution is now part of this
same authoritative transaction, never a separate earlier step:

```
BEGIN
  1.  SELECT ... FOR UPDATE the application row (row lock, §13/§28)
  2.  verify status is still decidable
  3.  re-verify every §7 precondition inside THIS transaction (user
      ownership, ProgramVersion, TrainingBlock, stream identity,
      exerciseRef, expectedEffectiveLoad, decision currency, target
      occurrence eligibility, mode/coach authority, entitlement)
  4.  resolve the target GymProfile (the athlete's default, §5.3 of
      LOADING-CAPABILITY-V1.md)
  5.  resolve the exact-exerciseRef binding (§8.4 — no fallback)
  6.  load the bound LoadingCapability's current row + revision
  7.  verify unit/basis compatibility (CAPABILITY_INCOMPATIBLE if not)
  8.  call the Load Resolver (FIXED_INCREMENT or ENUMERATED_LIST, §8 of
      LOADING-CAPABILITY-V1.md)
  9.  IF a human-supplied expectedProposal was given (§8.5): compare it
      against steps 4-8's live result — mismatch -> PROPOSAL_REFRESH_REQUIRED,
      ROLLBACK, no write at all
  10. persist the authoritative loadingCapabilityId/Revision/Snapshot +
      resolverProposedLoad + appliedLoad onto this application row
  11. retire/supersede the current overlay for this stream, if one exists
      (set its supersededByApplicationId to this application's id)
  12. write this application's effective value as the new current overlay
      (enforced by §29.1's partial unique index — steps 11 and 12 happen
      in the same transaction, so the index is never violated even
      momentarily)
  13. update this application row: status = APPLIED, decidedAt,
      decidedByActorType, decidedBy
COMMIT
```

Steps 4-9 are skipped entirely for a *manual* override
(`MODIFY_AND_APPLY`, §15) — the human-supplied `overrideLoad` is used
directly as `appliedLoad`, while `resolverProposedLoad`/
`loadingCapability*` are still populated from steps 4-8 wherever they
succeed, purely for audit ("here is what the resolver would have said,
and here is what the human chose instead").

**Clarifying step 4** (per §7.1/§6.1): "retiring the current overlay" for
a *previously-`APPLIED`* application means setting *that* application's
own `supersededByApplicationId` — its own `status` value itself does not
need a dedicated "no longer current" state distinct from `APPLIED`,
because §29.1's partial unique index (`WHERE status='APPLIED' AND
supersededByApplicationId IS NULL`) is what actually defines
"current" — an `APPLIED` row with `supersededByApplicationId` set is,
by construction, no longer the current overlay, without needing a
seventh state. (This keeps the state count at exactly six, per Decision
14/15's own instruction not to invent more states than needed — see
§29.1 for the exact constraint.)

---

## 13. Phase 13 — Concurrency (Decision 28 — re-read+lock+compare-and-apply, never split)

Every decide/apply/revoke path is **one** transaction that reads,
locks, re-verifies, and writes — never "read state, commit, later write
application" as two separate correctness transactions.

| Race | Protection |
|---|---|
| Athlete Apply vs. a newer decision | The newer decision's own application creation does not itself touch the row lock; but the *older* application's own decide-attempt re-checks `expectedEffectiveLoad`/decision-currency (§7) inside its transaction — if a newer decision has already produced its own application that reached `APPLIED` first, the older one's live precondition check fails, `STALE`. |
| Athlete Apply vs. manual plan change | No such edit path exists today (§1.2) — the general mechanism (§7) is what would catch it the day one exists, with zero new code needed here. |
| GUIDED auto-apply vs. a correction | Whichever transaction's row lock (step 1, §12) commits first wins; the loser's own re-check (step 3) fails and it no-ops — never a double-apply. |
| Future coach action vs. athlete action | Authorization (§25) is checked *before* the row lock is even attempted — once coach authority is active for a stream, an athlete-originated `decide()` is rejected outright, not merely raced. |
| Two duplicate Apply requests | §14's idempotency key + unique constraints — the second is a no-op replay, never a second transaction attempt at all. |

---

## 14. Phase 14 — Idempotency (Decision 27 — two distinct invariants, not one)

Reused, not reinvented — the same discipline as `workout_command_receipts`/
`progression_decisions.evidenceFingerprint`: a real DB constraint is the
guard, never "check then insert."

1. **One workflow per decision**: `UNIQUE(progression_decisions_id)` on
   `progression_applications` — creating twice for the same decision is a
   no-op after the first (Decision 27 confirms this model stays).
2. **One current effective overlay per stream** (a *separate* invariant —
   §7.1/§29.1's partial unique index): protects the *effective Plan
   state*, independent of how many historical applications/decisions exist
   for that stream over time.
3. **Decide-transition replay safety**: the caller supplies its own
   client-generated idempotency key, recorded via a small unique
   constraint on `(applicationId, decisionKey)` — the same convention as
   every WDI command's `commandId`. A replayed identical `decide()` call
   returns the already-committed result, never a second side effect.

No generic command platform is proposed — this is the existing pattern,
applied twice, for two genuinely different things it needs to guard.

---

## 15. Phase 15 — Manual override (unchanged, field names updated per §5.1)

Three distinct values, never conflated: `engineDecisionType` (direction
only — always `INCREASE_LOAD` here, never a number), `resolverProposedLoad`
(the default achievable value, or `NULL`, §8.3), `appliedLoad` (what was
actually written — differs from `resolverProposedLoad` only on human
override, with `overrideReason` set). The original `progression_decisions`
row is never rewritten regardless of any override — evaluated output stays
immutable evidence.

---

## 16. Phase 16 — "Keep original" (unchanged)

Terminal, permanent, never deleted. "Pending recommendations" reads filter
`status = 'PENDING_REVIEW'` only — `KEPT_ORIGINAL` is excluded forever for
that decision, by construction. Fresh evidence from a later workout is
completely independent and may still create a brand-new application.

---

## 17. Phase 17 — Reversal / undo (Decision 16 — confirmed)

1. **Not yet consumed by any started session**: explicit revert allowed —
   `APPLIED -> REVOKED`, same transaction shape as Apply. `appliedLoad` is
   **retained** (not cleared) for audit; the stream's effective value
   falls back to whichever overlay is now current (an earlier still-valid
   `APPLIED` row not superseded by this one, or the original authored
   value if none).
2. **Already snapshotted by Start Workout**: **never** rewrite that
   session. Any correction is expressed as a **new forward application**
   affecting only later eligible occurrences — never a rewrite of
   history. No time-travel machinery is built.

---

## 18. Phase 18 — Subscription / entitlement (unchanged)

No new entitlement concept. "Subscription != entitlement. Pro expiration
must never delete history" applies verbatim; the overlay and applied Plan
state remain fully readable regardless of later entitlement changes;
whether a *new* application may be created/decided while entitlement has
lapsed follows the existing Pro-gate convention for any other mutation,
not a special exception invented here.

---

## 19. Phase 19 — Program completion / block boundary (Decision 24 — confirmed, made explicit)

A routine application's scope never crosses a `TrainingBlock` boundary —
a direct, free consequence of §2.1's identity including `trainingBlockId`.
**Explicitly, per Decision 24**: a new `ProgramVersion` or any
incompatible structural plan edit **invalidates the old stream's overlay
scope for the new structure** — old application history is retained
exactly as it was, but nothing is automatically migrated into the new
`ProgramVersion`; the new version begins from its own authored/effective
state, unaffected by any prior overlay. A future Adaptation/program-
generation feature may explicitly choose to carry values forward, but
that is out of scope here unless separately specified.

---

## 20. Phase 20 — Exercise swaps (unchanged, now stated via §2.3)

§2.3's `exerciseRef` exact-match precondition directly produces this
behavior: a swapped exercise at the matching slot fails the precondition
and the write is refused (`STALE`) — never a fuzzy `ExerciseFamily`
mapping, because none is checked or exists.

---

## 21. Phase 21 — Multi-gym / equipment context (updated — `GymProfile` now specified)

`GymProfile`/`LoadingCapability` are now specified (`docs/domain/
LOADING-CAPABILITY-V1.md`, ADR-0010), but **V1 only ever creates exactly
one default `GymProfile` per athlete** — so there is still no *current*
case where Gym A vs. Gym B produce different numeric outcomes; the
question is real but not yet reachable. Resolution already happens live,
at Apply time (§8.1.1/§12), never frozen earlier — so the future
extension to a real second `GymProfile` is purely "resolve against
*which* gym profile governs this occurrence" (an additional lookup step),
not a redesign of the resolution timing this document already
establishes.

---

## 22. Phase 22 — The single effective-target resolver (Decision 25 — exact signature, WARM_UP explicit)

```ts
function resolveEffectivePlannedSetTarget(
  authored: Pick<PlannedSet, "targetLoad" | "targetReps" | "setType">,
  activeOverlay: { readonly appliedLoad: ExternalWeightLoad } | null, // the
    // stream's current APPLIED, non-superseded overlay (§29.1), or null
): { targetLoad: ExternalWeightLoad | null; targetReps: RepTargetV1 | null };
```

**`WARM_UP` sets never receive the overlay**: if `authored.setType !==
"WORKING"`, the function returns `authored`'s own values unconditionally,
regardless of whether an active overlay exists for the exercise (§2.2).

`PlanReadService.getCurrentPlanOverview()`, `PlanReadService.
getWorkoutPreview()`, and `createWorkoutPrescriptionFromPlannedWorkout()`
(the WDI snapshot boundary, §23) **all resolve through this one
function** — no controller, no UI, and no alternate merge logic anywhere
else is permitted to reimplement this decision. `PlanReadService` fetches
the (small, indexed, §29.1) set of active overlays for the streams it is
about to render in the same batch it already fetches `PlannedSet` rows —
no N+1.

---

## 23. Phase 23 — Workout Start is the hard boundary (Decision 6 — restated as an explicit hard invariant)

**`startWorkoutSession()` resolves every `PlannedSet` through §22 before
building `WorkoutPrescriptionV1`, and from that exact moment the
resulting `WorkoutSession.prescriptionSnapshot` is permanently and
unconditionally independent of any future Plan or overlay change.**

This holds **even if**, after that moment: the recommendation that
justified the applied value changes; the application is later revoked;
a coach edits the future plan; a newer, different progression decision
exists. **None of these ever alter an already-created snapshot.** Before
Start, the effective Plan may still legitimately change per every rule
above; at Start, it freezes into historical/runtime reality; after Start,
no later Progression Application of any kind may touch it. This is a hard
invariant, not a default that can be special-cased away by a future
feature.

---

## 24. Phase 24 — Offline impact (unchanged)

Local-first Active Workout guarantees are not weakened. A stale cached
Plan while offline still allows logging — "never block workout logging
simply because intelligence is stale" holds because this feature has no
write path into the mobile local-first pipeline at all. Once Start has
snapshotted the locally-available prescription (§23), that session is
valid reality regardless of what the server later concludes; a later sync
may detect a stale-plan *context* for *future* reads, but must never
rewrite an active/completed session. Carrying resolved (overlay-merged)
values into whatever future Plan-cache/sync mechanism exists is flagged
as a dependency of that future work, not solved here.

---

## 25. Phase 25 — Security / authorization (unchanged, restated against §7's exhaustive list)

Every value in §7's staleness-precondition list that also doubles as an
authorization input (`userId`, `authorityMode`, coach status, entitlement)
is re-derived server-side, never trusted from the client — the client
supplies only its own action + idempotency key (§14). BOLA negative
cases: athlete A deciding athlete B's application (indistinguishable
rejection from not-found); a client-supplied `authorityMode` ignored in
favor of the server's own current `AthleteProfile.experienceMode` read;
a client-supplied coach claim rejected — coach authority is re-derived
from a real, active `CoachingRelationship` + permission scope (mechanism
pending, §Open Tech-Lead Decisions; the *rule* is locked regardless of
when the lookup is built).

---

## 26. Phase 26 — Auditability (unchanged, table updated for renamed fields)

| Question | Answered by |
|---|---|
| Which `EngineDecision`? | `progressionDecisionId` |
| What did the Resolver propose? | `resolverProposedLoad` (or `resolverOutcomeReason` if none) |
| Who applied it? | `decidedByActorType` + `decidedBy` |
| What value was actually applied? | `appliedLoad` |
| What future scope? | The slot tuple + `effectiveFromCycleOrderIndex` |
| What plan version was current? | `programVersionId` |
| Superseded/reverted? | `status` + `supersededByApplicationId` / `revokedAt` |
| Which workout first consumed it? | Derived query, not a stored pointer (same reasoning ADR-0008 already used for "active version") |

---

## 27. Phase 27 — Observability (unchanged, one event renamed)

```
progression_application.created
progression_application.applied
progression_application.kept_original
progression_application.stale
progression_application.load_capability_unavailable   // renamed from resolver_unavailable
progression_application.authorization_rejected
progression_application.transaction_failed
```

No sensitive free text, no full snapshots, no analytics implementation
proposed.

---

## 28. Phase 28 — Failure modes (final vocabulary — reconciled against the requested list)

| Code | Detect | Result | Retryable? | User-visible future behavior | Audit |
|---|---|---|---|---|---|
| `NO_PLAN_CONTEXT` | §5.2 — decision's prescription id doesn't resolve to a real, active `PlannedExercise` | No application row created at all | N/A | Nothing — this decision was never Plan-backed | Decision alone remains evidence |
| `STALE_PROGRAM_VERSION` | §7 — `programVersionId` no longer `ACTIVE` | `STALE` | No | Recommendation shown as no longer actionable | Recorded |
| `STALE_BLOCK` | §19 — target no longer resolves within the expected `TrainingBlock` | `STALE` | No | Same | Recorded |
| `STALE_SLOT` | §2.3 — tuple no longer resolves to any occurrence | No write for that occurrence; not a hard error if other occurrences still match | N/A | That occurrence unaffected; others proceed | Recorded |
| `EXERCISE_CHANGED` | §2.3/§20 — `exerciseRef` mismatch | `STALE` for that occurrence | No | Old exercise's progression never leaks onto the new one | Recorded |
| `EXPECTED_LOAD_CHANGED` | §8.1 — live effective load != `expectedEffectiveLoad` | `STALE` | No | No accidental re-basing | Recorded |
| `TARGET_WORKOUT_ALREADY_STARTED` | §3/§23 — a session now exists for that occurrence | Excluded/`STALE` for that occurrence | No | Started session's snapshot untouched | Recorded |
| `DECISION_SUPERSEDED` | Slice C's own D1->D2 | `SUPERSEDED` (only if this application was still `PENDING_REVIEW`, §7.1) | No | Old recommendation marked historical | Recorded |
| `NO_CURRENT_LOAD` | LOADING-CAPABILITY-V1.md §10 — no current effective target to increase from | Non-terminal, never `STALE` (§8.6) — no overlay write | Yes, re-attempted on next live read | No impossible prescription ever shown | Recorded |
| `LOADING_CAPABILITY_UNAVAILABLE` | §8.3/§8.4 — no explicit binding for this exerciseRef in this gym | Non-terminal, never `STALE` (§8.6); GUIDED simply never applies; no overlay write | Yes, re-attempted on next live read (e.g. after a binding is added) | No impossible prescription ever shown | Recorded |
| `CURRENT_LOAD_UNSUPPORTED` | LOADING-CAPABILITY-V1.md §10 — current value not representable by the bound capability | Same as above | Yes | No rounding guess ever shown | Recorded |
| `CAPABILITY_INCOMPATIBLE` | §20/LOADING-CAPABILITY-V1.md §10 — unit/basis mismatch | Same as above | Yes (once the binding/capability is corrected) | Never silently converted | Recorded |
| `NO_SUITABLE_INCREMENT` | `resolveNextLoad`/its enumerated-list sibling returns this even with a valid, compatible capability | Same as above | No (a genuinely higher load doesn't exist yet) | Same | Recorded |
| `PROPOSAL_REFRESH_REQUIRED` | §8.5 — the live resolution no longer matches the human's `expectedProposal` | Non-terminal, no write, same `PENDING_REVIEW` row (no new application, `UNIQUE(progressionDecisionId)` never at risk) | Yes — the same decide() call, after the UI re-previews | The athlete/coach is shown the refreshed number and asked to re-confirm — never silently applied | Recorded (as an attempt, not a state change) |
| `UNAUTHORIZED` | §25 — BOLA | Rejected | No | Indistinguishable from not-found | Recorded (rejection only) |
| `COACH_AUTHORITY_REQUIRED` | §25/§33 — an athlete attempts to decide a coach-owned stream | Rejected | No | Same rejection shape as `UNAUTHORIZED` | Recorded |
| `DUPLICATE_COMMAND` | §14's idempotency key | No-op, returns existing result | N/A (already succeeded) | No double-application | Existing row is the record |
| `CONCURRENT_UPDATE` | §13 row lock + re-check | Loser sees non-decidable status / `STALE` | No | Whichever authorized transition won is shown | Recorded |
| `ENTITLEMENT_CHANGED` | Existing Pro-gate convention | Gated like any other Pro-gated write; existing applied state never destroyed | Depends on entitlement semantics elsewhere | History/overlay stays readable regardless (§18) | Recorded |

Internal codes above are never exposed verbatim as athlete-facing copy —
a future UI layer maps each to a plain-language message; that mapping is
out of scope here.

---

## 29. Phase 29 — Proposed data model (reconciled — pseudo-SQL, no migration)

```text
TABLE app.progression_applications
  id                            uuid PRIMARY KEY
  progression_decision_id       uuid NOT NULL UNIQUE
                                REFERENCES app.progression_decisions(id)  -- NO ACTION
  user_id                       uuid NOT NULL REFERENCES app.users(id)   -- NO ACTION
  exercise_ref                  text NOT NULL

  -- Program Slot Identity (§2.1) — exercise-level, no setOrderIndex, no cycle
  program_version_id            uuid NOT NULL REFERENCES app.program_versions(id)  -- NO ACTION
  training_block_id             uuid NOT NULL REFERENCES app.training_blocks(id)   -- NO ACTION
  workout_order_index           integer NOT NULL
  exercise_order_index          integer NOT NULL

  -- effectiveFrom boundary (§2.4) — program order, never a timestamp
  effective_from_cycle_order_index integer NOT NULL

  authority_mode                progression_application_authority_mode_enum NOT NULL
                                 -- ('GUIDED','ADAPTIVE','EXPERT') -- never 'COACHED'
  coaching_relationship_id      uuid NULL

  status                        progression_application_status_enum NOT NULL DEFAULT 'PENDING_REVIEW'
                                 -- ('PENDING_REVIEW','APPLIED','KEPT_ORIGINAL','STALE','SUPERSEDED','REVOKED')

  engine_decision_type          text NOT NULL DEFAULT 'INCREASE_LOAD'  -- direction only, never numeric (§14)
  expected_effective_load       jsonb NOT NULL   -- ExternalWeightLoad; the §7/§8.1 precondition input
  -- Populated ONLY at a successful Apply (§8.1.1/§8.5) — NULL for every
  -- other state, immutable once set (never re-resolved for an already
  -- APPLIED row, even if the live capability later changes, §8.6).
  loading_capability_id         uuid NULL REFERENCES app.loading_capabilities(id)  -- NO ACTION (§8.4, LOADING-CAPABILITY-V1.md §9.2)
  loading_capability_revision   integer NULL     -- the capability's own monotonic revision at Apply time (LOADING-CAPABILITY-V1.md §revision)
  loading_capability_snapshot   jsonb NULL       -- {kind, incrementAmountMilli|loadsMilli, unit, basis} exactly as it existed at Apply time
  resolver_proposed_load        jsonb NULL       -- ExternalWeightLoad, or NULL (§8.3)
  resolver_outcome_reason       text NULL        -- e.g. 'LOADING_CAPABILITY_UNAVAILABLE' (§28); NULL iff resolver_proposed_load IS NOT NULL
  applied_load                  jsonb NULL       -- ExternalWeightLoad; NOT NULL iff status IN ('APPLIED','REVOKED')
  override_reason               text NULL

  created_at                    timestamptz NOT NULL DEFAULT now()
  decided_at                    timestamptz NULL
  decided_by_actor_type         progression_application_actor_type_enum NULL  -- ('SYSTEM','ATHLETE','COACH')
  decided_by                    uuid NULL REFERENCES app.users(id)  -- NULL only when decided_by_actor_type = 'SYSTEM'
  revoked_at                    timestamptz NULL
  revoked_by                    uuid NULL REFERENCES app.users(id)
  superseded_by_application_id  uuid NULL REFERENCES app.progression_applications(id)  -- self-ref, NO ACTION
```

### 29.1 Constraints and indexes (Decision 31 — reasoned, not speculative)

```text
-- Invariant 1 (§14.1): one workflow per decision.
UNIQUE (progression_decision_id)   -- already declared inline above

-- Invariant 2 (§7.1/§14.2, THE central correctness constraint of this
-- feature): at most one CURRENT effective APPLIED overlay per stream.
-- "Current" = APPLIED and not yet superseded by a later application.
-- Mirrors program_versions_one_active_per_program (ADR-0008) exactly.
UNIQUE INDEX progression_applications_one_current_overlay_per_stream
  ON (program_version_id, training_block_id, workout_order_index, exercise_order_index)
  WHERE status = 'APPLIED' AND superseded_by_application_id IS NULL

-- Value/state consistency (Decision 31's explicit examples):
CHECK (  -- APPLIED requires an actual applied load; REVOKED retains its
         -- historical one; every other state has none.
  (status IN ('APPLIED','REVOKED')) = (applied_load IS NOT NULL)
)
CHECK (  -- resolver_outcome_reason exists exactly when resolution failed
  (resolver_proposed_load IS NULL) = (resolver_outcome_reason IS NOT NULL)
  OR status = 'PENDING_REVIEW'  -- a not-yet-attempted PENDING row may have neither
)
CHECK (  -- decided_by is present iff a human actor decided
  (decided_by_actor_type = 'SYSTEM') = (decided_by IS NULL)
)

-- Read paths this feature actually has (no speculative indexes):
INDEX progression_applications_user_id_status_idx ON (user_id, status)
  -- "my pending recommendations" (§16)
INDEX progression_applications_slot_lookup_idx
  ON (program_version_id, training_block_id, workout_order_index, exercise_order_index)
  -- superseded by the partial unique index above for the CURRENT case, but
  -- a plain (non-partial) index is also needed to look up the FULL history
  -- for a stream (e.g. §26's audit queries), which the partial index alone
  -- cannot serve efficiently.
```

**`KEPT_ORIGINAL` masquerading as an active overlay is structurally
impossible**: the partial unique index's `WHERE status = 'APPLIED'`
clause excludes every other state by construction — no separate rule is
needed to prevent it.

**No `gym_profile_id`/`loading_profile_id` column** — the capability
source itself is a pending prerequisite (§8.4), not yet a referenceable
persisted concept.

**No migration is created by this document.** Purely additive: one table,
three new enum types (`authority_mode`, `status`, `actor_type`) — no
existing table altered.

---

## 30. Phase 30 — Service API design (field/parameter names reconciled)

```ts
interface ProgressionApplicationService {
  createFromDecision(
    decision: PersistedProgressionDecision,
  ): Promise<CreateApplicationOutcome>;
  // CREATED | ALREADY_EXISTS (§14.1) | NO_PLAN_CONTEXT (§5.2) | NO_TARGET_SLOT (§3/§28)

  /**
   * Ephemeral, read-only, never persisted (§8.1.1) — the live numeric
   * preview an ADAPTIVE/EXPERT UI shows before Apply. Safe to call
   * repeatedly; each call re-resolves the current binding/capability
   * fresh.
   */
  previewResolution(
    actor: AuthenticatedActor,
    applicationId: string,
  ): Promise<PreviewOutcome>;
  // { resolverProposedLoad, loadingCapabilityId, loadingCapabilityRevision }
  // | LOADING_CAPABILITY_UNAVAILABLE | NO_CURRENT_LOAD | ...

  decide(
    actor: AuthenticatedActor,
    applicationId: string,
    outcome: "APPLY" | "KEEP_ORIGINAL" | "MODIFY_AND_APPLY",
    input: {
      readonly overrideLoad?: ExternalWeightLoad;
      readonly overrideReason?: string;
      /** From the client's most recent previewResolution() call — a race
       * guard only, never trusted as the resolver's actual input (§8.5). */
      readonly expectedProposal?: {
        readonly loadingCapabilityId: string;
        readonly loadingCapabilityRevision: number;
        readonly resolverProposedLoad: ExternalWeightLoad;
      };
    },
    idempotencyKey: string,
  ): Promise<DecideOutcome>;
  // APPLIED | KEPT_ORIGINAL | STALE | ALREADY_DECIDED
  // | LOADING_CAPABILITY_UNAVAILABLE | NO_CURRENT_LOAD
  // | CURRENT_LOAD_UNSUPPORTED | CAPABILITY_INCOMPATIBLE | NO_SUITABLE_INCREMENT
  // | PROPOSAL_REFRESH_REQUIRED (§8.5 — ADAPTIVE/EXPERT only, non-terminal)
  // | UNAUTHORIZED | COACH_AUTHORITY_REQUIRED

  revoke(actor: AuthenticatedActor, applicationId: string): Promise<RevokeOutcome>;
  // REVOKED | REJECTED_ALREADY_CONSUMED (§17 case 2) | UNAUTHORIZED
}
```

Explicit Result-shaped outcomes throughout, never thrown exceptions for
expected states (Slice C's own precedent). `createFromDecision`, `decide`,
and `revoke` each own exactly one Postgres transaction (§12) — never spans
multiple commits. `previewResolution` performs no write at all and needs
no transaction.

---

## 31. Phase 31 — Job / command orchestration (see §11, unchanged conclusion)

Evaluation and application remain two separate durable units, confirmed
(Decision 17). No shared retry/backoff coupling; an application failure
never affects an already-persisted decision.

---

## 32. Phase 32 — UI contracts (DTO, updated field names)

```ts
interface ProgressionApplicationCardV1 {
  readonly applicationId: string;
  readonly exerciseRef: string;
  readonly decisionType: "INCREASE_LOAD";
  readonly reasonCode: string;
  readonly currentLoad: ExternalWeightLoad;             // expectedEffectiveLoad
  readonly recommendedLoad: ExternalWeightLoad | null;  // resolverProposedLoad
  readonly resolverOutcomeReason: string | null;        // e.g. LOADING_CAPABILITY_UNAVAILABLE
  readonly status: ProgressionApplicationStatus;
  readonly authorityMode: "GUIDED" | "ADAPTIVE" | "EXPERT";
  readonly isCoachOwned: boolean;
  readonly allowedActions: readonly ("APPLY" | "KEEP_ORIGINAL" | "MODIFY_AND_APPLY" | "REVOKE")[];
  readonly appliedLoad: ExternalWeightLoad | null;
  readonly decidedAt: string | null;
}
```

`allowedActions` computed server-side from `status` + the caller's real
authority — never client-guessed.

---

## 33. Phase 33 — Mode x Decision matrix (Decisions 19-21 confirmed)

| Mode | `NO_CHANGE` | `MAINTAIN_LOAD_BUILD_REPS` | `INCREASE_LOAD` |
|---|---|---|---|
| **GUIDED** | No application (§10). | No application (§9). | Application created and auto-`APPLIED` by the separate durable job (§11), full eligibility checklist (§11.1), full staleness/idempotency. Plan mutation: yes. User action: none. |
| **ADAPTIVE** | Same. | Same. | Application created `PENDING_REVIEW`. Athlete: Apply / Keep original. **No silent auto-apply** (Decision 19). `decide()` performs the identical full server-side precondition set as every other path. |
| **EXPERT** | Same. | Same. | `PENDING_REVIEW`, **same mechanical `decide()` service as ADAPTIVE** (Decision 20 — persistence mechanics are never forked by mode; only UI prominence/default framing differs). |
| **COACHED overlay** (on any base mode, `coachingRelationshipId` set — mechanism pending) | Same as base. | Same as base. | `PENDING_REVIEW`; the coach is the authorized `decide()` actor (`decidedByActorType='COACH'`); athlete cannot silently override (§25/`COACH_AUTHORITY_REQUIRED`, §28). **GUIDED/ADAPTIVE/EXPERT implementation is never blocked by `CoachingRelationship`'s absence** (Decision 21) — this row is simply inert until that feature exists; a future active relationship must be able to cleanly take over authority for a stream without any change to the mechanics above. |

---

## 34. Phase 34 — Worked examples (reconciled A-J, replacing the initial draft's A-H)

**A — GUIDED ordinary increase**: authored `100 kg` -> `INCREASE_LOAD` ->
capability says `+2.5` -> `resolveNextLoad(100, +2.5) = 102.5` -> the
separate durable job applies it -> the next eligible occurrence
(`effectiveFromCycleOrderIndex`-bounded, §2.4) resolves to `102.5 kg`
before it is ever started.

**B — Same evidence, no LoadingCapability**: `INCREASE_LOAD` -> application
created `PENDING_REVIEW` -> GUIDED's auto-apply job's live resolution
attempt (§8.1.1/§12) finds no explicit binding for this exerciseRef ->
`LOADING_CAPABILITY_UNAVAILABLE`, no fields persisted, no write -> **no
guessed change is ever written**, and GUIDED simply retries on the next
evaluation cycle rather than being permanently blocked; ADAPTIVE/EXPERT's
own live preview (`previewResolution`, §30) comes back the same way and
may still show the recommendation without a number.

**K — Proposal refresh race (ADAPTIVE/EXPERT)**: UI calls
`previewResolution` and shows "100 -> 102.5" -> the athlete corrects their
gym's dumbbell increment (a genuinely separate, legitimate action) before
tapping Apply -> the live capability's `revision` is now higher and
resolves to "100 -> 105" -> the athlete taps Apply, submitting
`expectedProposal = {..., resolverProposedLoad: 102.5}` -> the Apply
transaction's live re-resolution (§12 step 9) finds `105 != 102.5` ->
**`PROPOSAL_REFRESH_REQUIRED`, no write occurs** -> the UI re-previews
("100 -> 105"), the athlete confirms again -> this second `decide()` call
now includes the *new* `expectedProposal = {..., 105}`, matches the live
resolution, and applies `105` -> **the same `progression_decisions` row
and the same `progression_applications` row throughout** — no duplicate
workflow was ever created, and the underlying `EngineDecision` was never
touched by the capability correction in between.

**C — Application chain**: first application `100 -> 102.5` (current
overlay = `102.5`) -> a later completed workout (itself snapshotted at
`102.5`, §23) produces a new `INCREASE_LOAD` -> the new application's
`current` input is `102.5`, **not** `100` -> resolves to `105` (§8.1).

**D — `NO_CHANGE` after an applied increase never reverts it**: overlay is
`102.5` (`APPLIED`) -> a later workout produces `NO_CHANGE` -> **no
application is created, and the `102.5` overlay is untouched** (§7.1) —
it does not silently fall back to the authored `100`.

**E — Source workout is completed**: the source session and its
`prescriptionSnapshot` are never touched by anything in this document —
WDI-PROG-APP-001 — regardless of what application is later created from
its evidence.

**F — Future workout already started**: an application resolves for a
slot whose next occurrence's `WorkoutSession` starts a moment before the
Apply transaction commits -> §7's live re-check finds a session now
exists for that occurrence -> that specific occurrence's write is
refused; any *other* future occurrence in the same block still resolves
normally; the started session's snapshot is never touched. A subsequent
**revoke** of an already-`APPLIED` overlay likewise can never alter that
started session's snapshot (§17 case 2, §23).

**G — New `ProgramVersion`**: a new version is (hypothetically) activated
-> its `PlannedSet`s belong to a different `programVersionId` -> the old
overlay's stream identity (§2.1) simply never matches anything in the new
version -> no leak, no automatic migration (§19/Decision 24) -> old
application history remains exactly as it was.

**H — Two simultaneous application attempts**: two `decide(APPLY)` calls
race for the same stream (e.g. one from a stale client retry, one fresh)
-> §12/§13's row-lock-then-recheck-then-write sequence and §29.1's
partial unique index guarantee exactly one becomes/remains the current
overlay — the other's transaction sees a non-decidable state or a
constraint conflict and reports the deterministic existing result, never
two "current" overlays.

**I — Exercise-level effect across sets**: an exercise has 3 `WORKING`
`PlannedSet`s (uniform authored load, §2.1) and 1 `WARM_UP` set -> the
applied `102.5 kg` overlay affects `resolveEffectivePlannedSetTarget()`'s
output for all 3 `WORKING` sets identically -> the `WARM_UP` set's
authored value is returned completely unchanged, unconditionally (§2.2/
§22).

**J — Adaptive Keep original**: `INCREASE_LOAD` -> `PENDING_REVIEW` ->
athlete `decide(KEEP_ORIGINAL)` -> `status = KEPT_ORIGINAL`, **no current
overlay is created or changed** -> the decision and this application both
remain permanently queryable, never re-surfaced as pending (§16).

---

## 35. Phase 35 — Test strategy (updated for reconciled invariants)

**Pure domain**: `resolveEffectivePlannedSetTarget()` — authored-only,
overlay-present, and the `WARM_UP`-never-overlaid case explicitly (§2.2/
§22); the state-machine legal-transition table including the §7.1
distinction (a superseded *decision* must NOT transition an `APPLIED`
application, only a superseded *decision* on a still-`PENDING_REVIEW`
application does).

**Real Postgres**: `UNIQUE(progression_decision_id)` concurrent-insert
race (Slice C's own proven shape); the one-current-overlay-per-stream
partial unique index under concurrent Apply attempts (§29.1, Example H);
the full transaction invariant (§12) under a forced mid-transaction
failure; §3's scope filter against real fixtures including a
not-yet-materialized future cycle (zero matches, not an error) and a
deliberately-heterogeneous future occurrence (§2.2's skip-don't-guess
case).

**Concurrency**: Example H reproduced as a real concurrent-request
integration test; athlete-vs-coach race once `CoachingRelationship`
exists; auto-apply vs. a newly-superseding decision.

**Authorization/BOLA**: cross-user `decide()`; forged `authorityMode`;
forged coach claim.

**Load Resolver composition**: a covered capability -> `RESOLVED`; no
capability -> `LOADING_CAPABILITY_UNAVAILABLE`, no write (Example B); a
unit/basis mismatch never silently coerced.

**Idempotency**: both invariants from §14 independently — one workflow
per decision, and a replayed `decide()` call.

**`ProgramVersion`/Plan immutability**: zero writes to any `plan.ts`-schema
table from this feature, asserted as a real regression test (Slice C's own
"never mutates Program/ProgramVersion/PlannedSet" precedent).

**Prescription snapshot**: `startWorkoutSession()` bakes in the resolved
value when an overlay is active; a *later* overlay change never affects
an already-created snapshot (§23, Example F's second half).

**Orchestration/job**: GUIDED's application job independently retryable
from evaluation's own job; §11.1's full eligibility checklist, each
condition's failure independently tested.

---

## 36. Phase 36 — Migration strategy (unchanged)

Purely additive: one table, three enum types. No existing table altered,
no backfill. Ordering: after the current head migration. Same
rollback-wrapped-transaction/throwaway-container proof methodology as
every prior migration in this project. No expand/contract cycle needed.

---

## 37. Phase 37 — Performance / scale (unchanged)

Tiny traffic relative to workout logging. Indexes as specified in §29.1,
each justified by a real read path this feature has (no speculative
indexes, per Decision 31). No Redis/cache/materialized view justified by
anything found in this repository.

---

## 38. Phase 38 — Threat model delta (unchanged, one row added)

Adds to the initial draft's table: **coach-authority-required rejection
must be indistinguishable, from the outside, from an ordinary
`UNAUTHORIZED` rejection** — never leaking "this stream has an active
coach relationship" to an unauthorized caller as a side channel.

---

## 39. Phase 39 — ADR need (Decision 32)

ADR-0009 remains **Proposed** through this reconciliation, exactly as
instructed. See the final report for the explicit recommendation on
whether it is now ready for `Accepted`.

---

## 40. Document outputs (this task)

1. `docs/domain/PROGRESSION-APPLICATION-V1.md` (this file, reconciled).
2. `adr/0009-progression-application-architecture.md` (reconciled,
   Status remains **Proposed**).
3. `CLAUDE.md` — status line updated to reflect reconciliation (see final
   report); no spec content duplicated there.

---

## 41. Repository consistency review (re-run for this reconciliation)

Re-read: `packages/database/src/schema/plan.ts`,
`packages/database/src/schema/progression.ts` (confirmed
`sourcePrescriptionExerciseId` is `text`, not a FK — §1.3, new finding
this pass), `docs/domain/load-model-v1.md` (re-inspected for §8.4's
`GymEquipment configuration` finding), `adr/0008-plan-program-hierarchy.md`,
`CLAUDE.md`. No contradiction introduced; every invariant this document
relies on remains exactly as locked. No locked document was rewritten.

### Open Tech-Lead Decisions (reduced from 4 to 1, per the Loading Capability V1 follow-up)

**Resolved by the prior reconciliation** (no longer open): GUIDED
orchestration shape (Decision 17 — separate durable job, confirmed);
`MAINTAIN_LOAD_BUILD_REPS` inert row (Decision 13 — no, confirmed);
generic `DEFAULT_LOAD_INCREMENTS` (Decision 9 — rejected outright).

**Resolved by this pass**: **LoadingCapability persistence/source** —
fully specified in `docs/domain/LOADING-CAPABILITY-V1.md` and
`adr/0010-loading-capability-architecture.md` (Status: Proposed). §8.4
above now references the approved contract directly rather than marking
it as unresolved.

**Still genuinely open**:

1. **`CoachingRelationship` implementation/permission mechanics** (§6.2/
   §25/§33) — the precedence *rule* is locked; the concrete lookup does
   not exist. GUIDED/ADAPTIVE/EXPERT (the large majority of V1 usage), and
   the entire Loading Capability architecture, are fully specified
   independent of this.

---

## 42. Implementation plan (reconciled sequence — not started)

- **Application Slice A** — schema prerequisites: `progression_applications`
  table + three enums (migration, additive only), the pure
  `resolveEffectivePlannedSetTarget()` function (with its `WARM_UP` case)
  and its unit tests. **The LoadingCapability persistence prerequisite
  (§8.4), if ready, is scoped and built here too** — otherwise Slice A
  proceeds without it and Slice C is blocked until it lands separately.
- **Application Slice B** — `ProgressionApplicationService`: `createFromDecision`,
  `decide`, `revoke`; the full state machine (§6); both idempotency
  invariants (§14); the full transaction/concurrency behavior (§12/§13);
  real Postgres tests; no HTTP surface, no auto-apply yet.
- **Application Slice C** — Load Resolver composition: wire `decide(APPLY)`
  through `resolveNextLoad()` with a real capability source (blocked on
  §8.4's prerequisite); `LOADING_CAPABILITY_UNAVAILABLE`'s full path; full
  composition tests.
- **Application Slice D** — mode behavior: the ADAPTIVE/EXPERT authenticated
  endpoint (one shared service call, per Decision 20); the GUIDED
  auto-apply durable job and its full §11.1 eligibility checklist; full
  mode-matrix behavioral tests (§33).
- **Application Slice E** — Plan/prescription read integration: wire
  `PlanReadService`/`prescription-builder.ts`/`startWorkoutSession()`
  through §22; the Plan/Preview/Snapshot consistency tests; §23's hard-
  boundary tests.
- **Application Slice F** — full integration gate: the complete negative
  test suite (§35's authorization/concurrency/staleness matrix) against
  real Postgres, all ten worked examples (§34) reproduced as real
  integration tests.

**Coached mechanics** (the coach-authorized `decide()` path) may land in a
later slice once `CoachingRelationship` exists — Slices A-F above are not
blocked by its absence, per Decision 21.

---

## 43. Risk classification (updated)

| Area | Risk | Why |
|---|---|---|
| `ProgramVersion` immutability | **LOW** | Never touched by this feature; structurally preserved. |
| Positional stream identity under immutable `ProgramVersion` | **LOW-MEDIUM** | Safe today (nothing exists to violate the `orderIndex`-stability convention it relies on) but depends on a *future* program-generation feature honoring an unenforced convention — explicitly flagged as a constraint that feature must satisfy (§2.3), with a clear first-class-ID escape hatch if it can't. |
| Future prescription consistency (Plan/Preview/Snapshot) | **MEDIUM** | Closed by routing all three through one function (§22); the residual risk is a future fourth read path forgetting to call it. |
| Stale application writes | **LOW** | Precondition-then-write inside one transaction, proven pattern reused. |
| **LoadingCapability persistence** | **MEDIUM** (downgraded from HIGH — now fully specified, `docs/domain/LOADING-CAPABILITY-V1.md`/ADR-0010) | A real prerequisite feature still needs to be built (Slice A) before it ships; blocks all *numeric* auto-application until then, but no longer an unresolved design question — does not block the overlay architecture itself. |
| Coach authority | **HIGH** | `CoachingRelationship` does not exist; precedence rule locked, mechanism pending. |
| Offline stale Plan | **LOW** | No new mechanism; existing local-first guarantees untouched. |
| Concurrency | **LOW-MEDIUM** | Standard row-lock + partial-unique-index patterns already proven elsewhere; the only genuinely new race (athlete vs. coach) is gated behind the coach-authority dependency above. |
| Auditability | **LOW** | Fully answerable from §5.1/§26 without event sourcing. |
| Cross-cutting: future-cycle materialization | **HIGH** | Pre-existing gap (§1.2), not this feature's own — limits real-world usefulness (few future occurrences to apply to) until production-generation exists, but never a correctness risk (silent no-match, never an incorrect match). |

---

## 44. Interview notes (unchanged in substance, one point sharpened)

- Recommendation vs. application: separates "is this evidence-based
  conclusion true" (must be safe to compute unconditionally) from "is
  this actually allowed to change someone's future training" (the only
  place authority is ever checked).
- Historical immutability: the log's entire value proposition.
- Stale-write prevention: precondition-then-write in one transaction,
  generalized from `performed_sets`' own revision gating — **now
  explicitly reading the CURRENT EFFECTIVE state, never the original
  authored value, as the precondition's own baseline** (§8.1) — this is
  the sharpened point from this reconciliation: "current" always means
  "what the overlay says right now," never "what was originally
  authored," anywhere in this feature.
- Idempotency: two separate real unique constraints for two separate
  guarantees, never "check then insert."
- `ProgramVersion` preservation: a second, separate table is *consulted*,
  never merged into the authored one.
- Clean Architecture boundaries: the merge function stays pure
  (`packages/domain`); the service (transaction, authorization,
  idempotency) lives at the shared, framework-agnostic application layer
  this codebase just finished proving out for Orchestration V1.

---

## 45. Implementation evidence — Slice B (2026-09-23)

**Slice B only** — the durable workflow/state-machine/idempotency/
concurrency foundation. **Not** implemented by this slice (deliberately,
per the Slice-B implementation task's own explicit scope): the effective
Plan overlay, numeric Apply, Loading Capability composition/resolution,
`authorityMode`/coach mechanics, GUIDED auto-apply, any public API, any
mobile change. `APPLIED` and `REVOKED` exist in the persisted `status`
vocabulary but are structurally unreachable through this slice's own
service layer — see below.

**Schema** (`packages/database/src/schema/progression-application.ts`,
migration `0011_fearless_ironclad.sql`, purely additive — verified via
grep, not estimated): 3 `CREATE TYPE` (`progression_application_status`,
`progression_application_command_action`,
`progression_application_command_outcome`), 2 `CREATE TABLE`
(`progression_applications`, `progression_application_commands`), 8
`ALTER TABLE` (FK additions), 4 `CREATE INDEX`/`CREATE UNIQUE INDEX`.
Deliberately narrower than this document's own §29/§5.1 final target —
`authorityMode`/`coachingRelationshipId`/`engineDecisionType`/
`loadingCapabilityId`/`loadingCapabilityRevision`/
`loadingCapabilitySnapshot`/`resolverProposedLoad`/
`resolverOutcomeReason`/`appliedLoad`/`overrideReason`/
`decidedByActorType`/`revokedAt`/`revokedBy` are all absent, per the
Slice-B task's own explicit field list (§9) — every one of them is a
purely additive column for a later slice, none require a destructive
migration. The eventual `progression_applications_one_current_overlay_
per_stream` partial unique index (§29.1) is deliberately deferred (the
task's own §27 explicitly permits this): no row can reach `APPLIED`
through Slice B's service layer, so the index would enforce nothing yet.

**Workflow creation** (`ensureApplicationForDecision`,
`packages/progression-application/src/progression-application.ts`):
loads the decision, verifies ownership (BOLA-safe `NOT_FOUND`, matching
`ProgressionEvaluationService`'s own precedent), verifies
`decisionType === 'INCREASE_LOAD'` and not already superseded, walks
`PlannedExercise -> PlannedWorkout -> TrainingCycle -> TrainingBlock ->
ProgramVersion` to derive the Program Slot Identity + effective-from
boundary + the uniform `WORKING`-set authored load, then inserts under a
DB-enforced `UNIQUE(progression_decision_id)` (`onConflictDoNothing` +
reselect — never "check then insert," proven by a real concurrent-insert
test, 8 simultaneous callers -> exactly 1 row).

**Program Slot Identity**: exactly the locked §2.1 tuple
(`programVersionId`, `trainingBlockId`, `workoutOrderIndex`,
`exerciseOrderIndex`) plus `exerciseRef`, `setOrderIndex` absent, cycle
absent from identity but its `orderIndex` persisted separately as
`effectiveFromCycleOrderIndex` — proven by a real-Postgres test seeding
the SAME workout/exercise slot in two different `TrainingCycle`s: both
decisions produce the identical stream tuple with two different
`effectiveFromCycleOrderIndex` values.

**Expected effective load** (§13): since no `APPLIED` overlay can exist
in Slice B, this is always, honestly, the source `PlannedExercise`'s own
uniform `WORKING`-set authored load (never a fabricated "resolved"
value) — no STOP condition was hit here; the future effective-overlay
resolver was never required to answer this truthfully in Slice B.

**State machine**: implemented — `PENDING_REVIEW -> KEPT_ORIGINAL`,
`PENDING_REVIEW -> STALE`, `PENDING_REVIEW -> SUPERSEDED`, all via a
compare-and-swap `UPDATE ... WHERE status = 'PENDING_REVIEW'` (no
explicit row lock — this codebase's existing idiom, `performed_sets`'
revision-gated `onConflictDoUpdate`/`setWhere`). Intentionally
unavailable: `PENDING_REVIEW -> APPLIED`, anything touching `APPLIED`/
`REVOKED` — proven absent both by an exhaustive pure unit test over the
full 6x6 transition matrix (`isLegalSliceBTransition`, exactly 3 legal
cells) and by a real-Postgres assertion that no row this slice's service
ever touches carries `status IN ('APPLIED', 'REVOKED')`.

**Idempotency** (`keepOriginal`'s `KEEP_ORIGINAL` command): a
domain-specific `progression_application_commands` receipt,
`command_id` as the primary key (identical pattern to
`workout_command_receipts`) — the actual idempotency guard, never
"check then insert." Same `commandId` + same `(applicationId, action)`
replays the stored outcome; the same `commandId` reused against a
different `applicationId` is a deterministic `COMMAND_CONFLICT`.

**Concurrency** (task §23, real Postgres, no mocks): two identical
`commandId`s racing on `KEEP_ORIGINAL` converge to one row/one outcome
(the loser's transaction rolls back on the receipt-insert conflict,
mirroring `workout-command-processing.ts`'s own `DuplicateCommandRaceLoss`
pattern); two *different* `commandId`s both requesting `KEEP_ORIGINAL`
converge safely to the same terminal state with two distinct receipt
rows, never corruption; a stale-vs-keep race (the live Plan slot
invalidated immediately before 6 concurrent `KEEP_ORIGINAL` attempts) is
fully deterministic — every attempt loses, the row lands on `STALE`,
never `KEPT_ORIGINAL`.

**Staleness** (`revalidatePendingApplication`/the internal
`computeRevalidation`): re-derives, live, every call: decision currency
(`supersededByDecisionId IS NULL`), `ProgramVersion.status = 'ACTIVE'`,
and a fresh re-resolution of the slot tuple (exerciseRef match + uniform
`WORKING`-set load match) — any mismatch is `STALE`. LoadingCapability is
never consulted (§17, unchanged). Proven for both a `ProgramVersion`
status flip and a live exercise/load change at the recorded slot.
Terminal states never revert — a second `revalidatePendingApplication`
call on an already-transitioned row reports `TERMINAL`, never re-derives.

**Supersession** (task §15): a Slice-C-style `progression_decisions`
`D1 -> D2` supersession (simulated directly, since this slice does not
call the real engine) transitions D1's still-`PENDING_REVIEW`
application to `SUPERSEDED` on the next revalidation/decide attempt —
proven without D2 ever having its own application row, exactly as §15
requires (decision supersession alone is sufficient proof). A
`SUPERSEDED` application is then provably non-actionable: a subsequent
`KEEP_ORIGINAL` attempt is rejected (`NOT_KEPT`/`SUPERSEDED`), never
silently succeeds.

**Ownership/BOLA**: `userId` is always re-derived from the source
decision, never trusted from a caller; a decision/application belonging
to a different actor reports identically as `NOT_FOUND`/rejects, proven
by a dedicated cross-actor test (`ensureApplicationForDecision` against
another athlete's decision).

**Migration**: proven both against the existing dev database and a
fresh throwaway container (0000 -> 0011) — clean in both. Constraint-name
identifier truncation (Postgres's standard 63-char limit, several
multi-table FK names collide with the limit) was checked for accidental
collisions across the two new tables' 12 constraints — none found. No
new grant statements were required: `vostivo_api` automatically inherited
full DML on both new tables via the pre-existing `ALTER DEFAULT
PRIVILEGES` mechanism, verified directly; the runtime role's continued
lack of DDL privilege was independently re-confirmed (a live `CREATE
TABLE` attempt as `vostivo_api` still fails with `42501`).

**Test counts**: 8 pure unit tests (`progression-application.test.ts`,
the transition-matrix vocabulary) + 17 real-Postgres integration tests
(`progression-application.integration.test.ts`, task §34's matrix) — 42
total in `packages/progression-application` including the pre-existing
Loading Capability (22) and pg-boss (3) suites, zero regression.

**Regression**: full monorepo `lint`/`typecheck`/`test`/`build`/
`boundaries:check` green; the existing Loading Capability, Progression
Evaluation Orchestration, and Plan real-Postgres integration suites were
all re-run and remain green — no regression.

---

## 46. Slice B ownership-integrity gate (2026-09-23)

**Finding**: the schema as originally shipped in §45 did **not** make
`progression_applications.user_id == progression_decisions.user_id` (for
the referenced `progression_decision_id`) a real database invariant —
each column had only its own independent single-column FK
(`progression_decision_id -> progression_decisions.id`, `user_id ->
users.id`), so nothing at the database level prevented a row whose
`user_id` disagreed with its own source decision's real owner. Service-
level BOLA (`ensureApplicationForDecision`'s ownership check) was the
*only* boundary — exactly the gap this gate closes.

**Fix** (migration `0012_bitter_rafael_vega.sql` — corrected wording, task
§60: this migration is **not** literally "purely additive DDL," since it
`DROP`s the old single-column `progression_decision_id` FK before adding
the composite one; it is non-destructive **data-wise** — no column, row,
or table is ever dropped, only a constraint definition is replaced):
`progression_decisions` gained `UNIQUE(id, user_id)`;
`progression_applications`' single-column `progression_decision_id` FK
was replaced with a composite `FOREIGN KEY (progression_decision_id,
user_id) REFERENCES progression_decisions(id, user_id)` — identical
pattern to
`exercise_loading_capability_bindings`' same-gym composite FK
(`loading-capability.ts`, ADR-0010). The plain single-column FK was
dropped rather than kept alongside the composite one (task's own "do not
retain redundant constraints without reason") — the composite FK already
implies `progression_decision_id` references a real row, since `id`
remains part of the unique key it targets.

**Migration-generation pitfall found and fixed**: `drizzle-kit generate`
initially ordered the composite-FK-add statement *before* the
`UNIQUE(id, user_id)`-add statement it depends on (cross-file declaration
order, not dependency order) — Postgres correctly rejected this
("there is no unique constraint matching given keys"), the migration
transaction rolled back cleanly (verified: the original FK was still
present afterward, no partial state), and the two statements were
manually reordered in the generated `.sql` file before it was ever
successfully applied to any environment — not a rewrite of an
already-applied migration.

**Negative raw-SQL proof** (`PROG-APP-B-OWNERSHIP`,
`progression-application.integration.test.ts`): decision `D` created for
athlete A; a raw `db.insert(progressionApplications)` with every other
field valid but `userId` set to athlete B is rejected by real Postgres —
`SQLSTATE 23503`, `constraint_name: "progression_applications_decision_
owner_fkey"` — never a service/mock rejection. The row was never
persisted (re-selected count: 0).

**Positive proof**: the existing `PROG-APP-B-001`/`004`/`005` tests
(ordinary same-owner creation, duplicate, and 8-way concurrent creation)
were re-run unchanged after the migration and still pass — no regression
to normal workflow creation.

**Command actor/owner semantics** (task §7, report only — no redesign):
`progression_application_commands.user_id` was already documented
(§45's own schema doc comment) as "the CALLER's own id (never the
application owner's, if they differ)" — an **actor** field, not an
owner-equality field. In Slice B's actual code path (`keepOriginal`) it
always equals the application owner today only because `keepOriginal`
itself requires `actor.userId === application.userId` before any
mutation proceeds (there is no coach path yet) — that is current
*service behavior*, not a schema guarantee. **No
`command.user_id == application.user_id` constraint was added**, per
this gate's own explicit instruction — doing so would foreclose a future
legitimate case where `application.userId` (the athlete) and the
command's actor (a coach) differ.

**Expected-effective-load Slice-C handoff rule (confirmed, no runtime
change)**: Slice B's `expectedEffectiveLoad` is truthfully the source
`PlannedExercise`'s authored `WORKING`-set load *only because* no
`APPLIED` overlay can exist yet (§13/§8.1). This is not a permanent rule.
**Once Slice C introduces real `APPLIED` overlays,
`ensureApplicationForDecision` (and `computeRevalidation`) MUST derive/
revalidate `expectedEffectiveLoad` through the authoritative
effective-target resolver (§22) instead** — checking for a current
`APPLIED` overlay for the stream first, falling back to the authored
value only when none exists — exactly as §8.1's original design already
specifies. Continuing to read only the authored value after overlays
exist would silently re-base every subsequent recommendation on stale
data. Not implemented by this gate.

**Effective-from semantics (confirmed, no runtime change)**:
`effectiveFromCycleOrderIndex` stores the **source** occurrence's
`TrainingCycle.orderIndex` exactly as persisted (§2.4/§6). A future
overlay-scope filter must select only target occurrences where
`targetCycle.orderIndex > effectiveFromCycleOrderIndex` — **strictly
greater, never `>=`** — so the source occurrence itself is structurally
excluded by the comparison alone, never by a separate special case. Not
implemented by this gate (Slice B never reads this value for filtering,
only writes it).

**Migration**: proven both against the existing dev DB (0011 -> 0012,
after the reordering fix) and a fresh throwaway container (0000 -> 0012)
— clean in both, identical final constraint graph. No new grants
required (unchanged from §45's proof — no new tables were created by
this migration).

**Regression**: full monorepo `lint`/`typecheck`/`test`/`build`/
`boundaries:check` green after this gate; the existing Loading
Capability, Progression Evaluation Orchestration, and Plan real-Postgres
integration suites were all re-run and remain green — no regression.
`packages/progression-application` real-Postgres suite: 43/43 (up from
42, the one new `PROG-APP-B-OWNERSHIP` test).

---

## 47. Implementation evidence — Slice C (2026-09-24)

**Application row IS the overlay** (task §2/§3): no second "plan
overrides" table exists. `progression_applications` gained six additive
audit columns (`loading_capability_id`/`_revision`/`_snapshot`,
`resolver_proposed_load`, `applied_load`, `applied_at`) — populated
together, only by a successful numeric Apply, never touched again
afterward. `ProgramVersion`/`PlannedExercise`/`PlannedSet` are never
written by any Slice-C code path — proven directly in every Apply test by
re-selecting the authored `planned_sets` row afterward.

**Migration** `0013_skinny_skreet.sql` — genuinely purely additive: 1
`CREATE TYPE` (`progression_application_command_rejection_reason`), 1
`ALTER TYPE ... ADD VALUE` (`'APPLY'`), 6 `ADD COLUMN`, 1 FK `ADD
CONSTRAINT`, 1 `CREATE UNIQUE INDEX`, 3 CHECK `ADD CONSTRAINT`. Proven
both against the existing dev DB (0012 -> 0013) and a fresh throwaway
container (0000 -> 0013) — identical final constraint count (17) both
ways. No new grants required (existing tables' default privileges already
cover new columns).

**Current-overlay invariant** (task §4): partial unique index
`progression_applications_one_current_overlay_per_stream` on `(user_id,
program_version_id, training_block_id, workout_order_index,
exercise_order_index) WHERE status = 'APPLIED'` — deliberately excludes
`exerciseRef` (an immutable `ProgramVersion`'s slot can never legitimately
disagree with itself on `exerciseRef`) and `trainingCycleId`/
`setOrderIndex` (same stream-identity reasoning as Slice B). This is the
**final** DB-level race guard (task §28); the `ProgramVersion` row lock is
the serialization mechanism, this index is the correctness backstop.

**Historical effective resolver** (`resolveEffectiveWorkingLoadForOccurrence`,
`packages/progression-application/src/effective-load-resolver.ts`, task
§5-§7): considers every row that was ever `appliedAt IS NOT NULL`
(regardless of *current* `status`, task §6/§48's pending-superseded vs.
applied-superseded distinction), filtered to the exact stream + exact
`exerciseRef`, with `effectiveFromCycleOrderIndex` **strictly** less than
the target cycle, `status IN ('APPLIED','SUPERSEDED')` (never `REVOKED` —
task §13, unsupported). Deterministic tie-break: greatest
`effectiveFromCycleOrderIndex`, then `appliedAt`, then `id` (UUIDv7,
genuinely time-ordered). Falls back to the caller-supplied authored value
only when no eligible row exists — never fabricated.

**Source-cycle baseline** (task §23/§24): `ensureApplicationForDecision`
now calls this resolver with `targetCycleOrderIndex =
planContext.cycleOrderIndex` (the SOURCE occurrence's own cycle) instead
of Slice B's temporary "always authored" rule; `computeRevalidation` calls
the identical resolver with `targetCycleOrderIndex =
app.effectiveFromCycleOrderIndex`, never a separate implementation — a
live mismatch is `STALE`, exactly as Slice B's expected-load check already
was, just now resolver-backed instead of authored-only.

**Corrected-evidence proof** (task §9, `PROG-APP-C-HISTORICAL`): a
same-cycle corrected decision (D1 superseded by D2, both sourced from
cycle 2) computes `expectedEffectiveLoad` at cycle 2 as 102.5 (from cycle
1's application), never 105 (which would require *cycle 2's own*
application counting toward its own baseline — excluded by the resolver's
strict `<` boundary: `2 < 2` is false). No accidental double-progression.

**Proposal resolution** (`resolveApplicationProposal`,
`computeResolverProposal` shared by both the read-only preview and the
Apply transaction): canonical chain `userId -> AthleteProfile -> default
GymProfile (read-only, never created — task §25) -> exact exerciseRef
binding -> LoadingCapability -> resolveNextLoadFromCapability()`
(`@vostivo/domain`, never re-implemented). Outcomes mapped 1:1:
`MALFORMED_CAPABILITY -> LOADING_CAPABILITY_INVALID`;
`UNIT_MISMATCH`/`BASIS_MISMATCH`/`OVERFLOW -> CAPABILITY_INCOMPATIBLE`;
`CURRENT_LOAD_UNSUPPORTED`/`NO_SUITABLE_INCREMENT` pass through unchanged.
No default GymProfile or no binding both map to
`LOADING_CAPABILITY_UNAVAILABLE`, application remains `PENDING_REVIEW`
(task §41 — a resolution failure never invalidates the `progression_decisions`
evidence).

**Numeric Apply transaction** (`applyProgression`,
`packages/progression-application/src/progression-application-apply.ts`):
one `db.transaction()`, task §29's order (inspect receipt -> load app ->
`SELECT program_versions ... FOR UPDATE` -> re-read app -> re-check
receipt -> verify `PENDING_REVIEW` -> revalidate (reusing
`computeRevalidation`) -> resolve+lock capability
(`resolveBoundCapabilityForUpdate`, `FOR UPDATE`) -> compare every
supplied proposal precondition (`PROPOSAL_REFRESH_REQUIRED` on mismatch)
-> call the pure resolver -> **supersede the old current head FIRST, then
write the new row `APPLIED`** (this exact order is load-bearing: the
partial unique index is checked per-statement, so the reverse order would
transiently self-violate it) -> persist the `APPLY` command receipt ->
commit.

**A genuine concurrency bug was found and fixed during this slice's own
test-writing** (task §57's own required proof surfaced it): the
`ProgramVersion` lock only serializes concurrent *Apply* transactions
against each other — it does **not** serialize against `keepOriginal`,
which never touches `program_versions`. A concurrent `KEEP_ORIGINAL` can
commit in the window between Apply's own mid-transaction read (still
`PENDING_REVIEW`) and its final write, after Apply has already superseded
the old head *in that same, still-open transaction*. The original code
treated this as "structurally unreachable" and threw a plain `Error`,
which would have left the ENTIRE transaction to roll back correctly (an
accidental correct behavior) — but reported it to the caller as an
unhandled exception instead of the correct `KEPT_ORIGINAL` outcome. Fixed
by a dedicated `ApplyLostToConcurrentDecision` exception that still forces
the same full rollback (proving §30's "no partial supersession" guarantee
holds even for this real race, not just an artificial one), then
re-derives and persists the correct outcome against the post-rollback
state in a fresh transaction. Proven by `PROG-APP-C-038` and the dedicated
rollback proof `PROG-APP-C-030` (which uses this exact real race, with a
genuine pre-existing `APPLIED` head to supersede, rather than artificial
fault injection — this codebase's own convention never adds test-only
branches to production code).

**LoadingCapability audit** (task §15/§17): `loadingCapabilityId`/
`loadingCapabilityRevision`/`loadingCapabilitySnapshot` are the exact id,
monotonic revision, and payload of the capability *actually used by the
resolver call that produced this row's `appliedLoad`* — frozen at that
instant via the `FOR UPDATE` lock (task §27/§56), immutable forever after,
proven unaffected by a concurrent `updateLoadingCapabilityPayload` call
racing against the same Apply (`PROG-APP-C-039`).

**Application replacement**: old current head -> `SUPERSEDED` +
`supersededByApplicationId` set, its own audit fields left completely
untouched (proven byte-for-byte via `PROG-APP-C-017`); new row ->
`APPLIED`, becoming the sole partial-unique-index-enforced current head.

**Idempotency**: `APPLY` added to the existing `progression_application_commands`
action vocabulary; same `commandId` + same `(applicationId, action)`
replays; a reused `commandId` against a different `applicationId` is
`COMMAND_CONFLICT` — identical mechanism to `KEEP_ORIGINAL`, no new
infrastructure. A new nullable `rejection_reason` column (9-value closed
enum, task §36) lets a replayed `REJECTED` outcome report why, without
storing free text or full snapshots.

**Concurrency proofs** (all real Postgres, task §54-§59): same-application
concurrent Apply converges to one success (`PROG-APP-C-036`); Apply vs.
`KEEP_ORIGINAL` resolves to exactly one terminal state
(`PROG-APP-C-038`/`030`); a concurrent capability revision update never
produces a mismatched audit (`PROG-APP-C-039`, Postgres's own row locking
naturally serializes the two, no new lock primitive needed); Plan becoming
stale before Apply's lock rejects cleanly with no partial supersession
(`PROG-APP-C-040`).

**Plan integration** (task §45/§64): `PlanReadService.getWorkoutPreview()`
(`apps/api/src/plan/plan-read.service.ts`) is the **only** current
repository server path that produces an effective planned load — `Plan`
(`getCurrentPlanOverview`) has no per-exercise load field at all (verified
by inspecting `PlanSessionSummaryV1`), and Workout Start has no
independent server-side prescription-building path: the mobile client
submits `WorkoutPreviewV1.prescription` verbatim as its Start snapshot
(`apps/mobile/src/plan/plan-application-service.ts`). Wiring the resolver
into this ONE method therefore transitively covers both Preview and
Start — proven end-to-end by `PLAN-APPLIED-PREVIEW`
(`apps/api/src/plan/plan.integration.test.ts`): the source occurrence's
own Preview is unaffected by its own application (task §7/§9's strict
`<`), a later occurrence's Preview AND its embedded Start prescription
both show the applied value, and the authored `planned_sets` row is never
mutated. `WARM_UP` sets are never touched — the override applies only
when `setType === 'WORKING'` (`toDomainLoad`'s own new parameter).

**Workout Start's hard snapshot boundary** (task §46): proven directly
(`PROG-APP-C-WORKOUT-START`) — a `workout_sessions.prescriptionSnapshot`
written before an Apply remains byte-identical after a later Apply
changes the future effective load. This holds structurally, not just
empirically: no Slice-C code path ever writes to `workout_sessions` at
all.

**BOLA** (task §52): actor B cannot resolve or apply actor A's
application (`PROG-APP-C-043`) — identical `NOT_FOUND` convention as
Slice B. The capability-ownership chain (task §53) is always re-derived
from the application's own canonical `userId`, never from a
caller-supplied capability/gym id.

**Test counts**: `packages/progression-application` — 41 pure unit tests
(8 new: the transition-matrix — unchanged from Slice B) + 61 real-Postgres
integration tests (18 new in `progression-application-apply.integration.test.ts`,
plus the pre-existing 21 Slice-B/ownership + 19 Loading Capability + 3
pg-boss). `apps/api` — 74 real-Postgres integration tests (1 new,
`PLAN-APPLIED-PREVIEW`), 29 unit tests (unchanged).

**Regression**: full monorepo `lint`/`typecheck`/`test`/`build`/
`boundaries:check` green; existing Loading Capability, Progression
Evaluation Orchestration, and Plan real-Postgres suites re-run and
unaffected.

**Runtime intentionally NOT implemented**: GUIDED auto-apply job, coach
approval/permissions, `REVOKE`, manual human load override (Slice C's
`appliedLoad` always equals `resolverProposedLoad`, task §16), any public
athlete-facing API or UI, mode-policy branching inside the numeric
mechanics (task §67).

---

## 48. Final binding-concurrency gate (2026-09-24)

**Verified, not merely inferred** (task's own explicit demand — the
`LoadingCapability` row being locked does not, by itself, prove the
`exercise_loading_capability_bindings` row is also locked; these are two
separate mutable relational objects): a rollback-wrapped real-Postgres
probe held `resolveBoundCapabilityForUpdate`'s existing joined `SELECT
b.*, c.* FROM exercise_loading_capability_bindings b INNER JOIN
loading_capabilities c ... FOR UPDATE` open in one transaction and
attempted a concurrent raw `UPDATE` of the SAME binding row from a second
connection — it blocked for the full duration, proving Postgres's
standard `SELECT ... FOR UPDATE` behavior over a join (lock rows from
**every** table referenced in the join, not only one side) already
locks the exact binding row, with **no code or schema change required**.

**Canonical lock order actually exercised** (task §3), unchanged from
§29's transaction, since the existing single joined query already
satisfies it in one atomic step: `ProgramVersion FOR UPDATE` -> canonical
application re-read/revalidation -> resolve default `GymProfile`
(read-only) -> `exercise_loading_capability_bindings` row `FOR UPDATE` +
`loading_capabilities` row `FOR UPDATE` (the one joined statement,
guaranteeing both rows are locked together, never one without the other)
-> re-derive/validate the proposal -> commit.

**Binding-rebind race proof** (`PROG-APP-C-BINDING-RACE`, real Postgres,
no mocks): exerciseRef `bench-press` initially bound to Capability A
(`FIXED_INCREMENT +2.5kg`, authored 100kg -> proposal 102.5kg, captured via
`resolveApplicationProposal` before the race as the athlete's own
"confirmed proposal," per task §32). Racing `applyProgression(...,
{expectedProposal: {expectedLoadingCapabilityId: A, expectedResolverProposedLoad:
102.5}})` against a direct raw-SQL rebind of the SAME binding row to
Capability B (`FIXED_INCREMENT +5kg`, no canonical binding-write service
exists yet — task §6 explicitly permits a raw SQL rebind here) produces
exactly one of the two valid outcomes on every run:

- **Outcome A** (Apply's `FOR UPDATE` wins first): Apply proceeds with
  Capability A, audit records A/revision 1/102.5kg applied; the rebind
  blocks and only proceeds after Apply's transaction commits.
- **Outcome B** (the rebind commits first): Apply's own re-derivation
  inside its locked transaction sees Capability B, computing 105kg — which
  disagrees with the caller's confirmed 102.5kg precondition ->
  `PROPOSAL_REFRESH_REQUIRED`, application remains `PENDING_REVIEW`, no
  audit written, no overlay mutation.

No invalid outcome (a mismatched audit, a silently-applied stale
proposal, a crash, or a partial mutation) is possible in either case —
proven directly by re-selecting both the application row and the final
binding row after the race.

**Existing races reconfirmed green, unchanged**: `PROG-APP-C-039`
(capability payload/revision race — still valid and still required per
task §7, since it proves the OTHER mutable object, the capability
payload itself, independently of the binding), `PROG-APP-C-036` (same-app
concurrent Apply), `PROG-APP-C-038`/`030` (Apply vs `KEEP_ORIGINAL`,
`ApplyLostToConcurrentDecision` accepted unchanged per task §10),
`PROG-APP-C-040` (stale vs Apply), `PROG-APP-B-017` (decision supersession
interaction), Plan Preview integration (`PLAN-APPLIED-PREVIEW`), Workout
Start snapshot (`PROG-APP-C-WORKOUT-START`).

**No schema change, no migration** — this gate is transaction-lock
correctness only, proven against the existing, unmodified schema.

**No other architecture changed**: historical resolver semantics,
current-head partial unique index, `effectiveFrom` semantics, source-cycle
baseline, audit schema, Workout Start behavior, Plan integration,
command-receipt model, and mode policy are all untouched. `REVOKE` and
`GUIDED` remain unimplemented.

---

## 49. Implementation evidence — Slice D (2026-09-24)

**Mode authority** (`resolveProgressionAuthority`,
`packages/progression-application/src/progression-authority.ts`, task
§0/§3): pure, deterministic, no DB/`LoadingCapability`/subscription
logic. `GUIDED -> SYSTEM_AUTO_APPLY`; `ADAPTIVE`/`EXPERT ->
ATHLETE_REVIEW` (identical mechanical authority — task §38, no
`EXPERT`-specific branch anywhere). Canonical source: `athlete_profiles.
experience_mode` (verified — this is the same column `AthleteProfile`
already persists; no second mode source was created, task §2).
**Current mode wins (task §4)**: authority is re-derived FRESH, from this
one canonical column, at the exact moment the dispatch job runs — never
from the job payload, the `EngineDecision`'s own normalized input, or any
`progression_applications` field. Proven both directions
(`PROG-APP-D-020`): GUIDED->ADAPTIVE before dispatch executes prevents
auto-apply; ADAPTIVE->GUIDED before dispatch executes causes it.

**Durable orchestration** (task §5/§6/§7/§31): a SEPARATE queue,
`progression-application-dispatch-v1`
(`packages/progression-application/src/progression-application-dispatch-queue.ts`),
never `progression-evaluate-session-v1` itself — the evaluation worker
never mutates the effective Plan. `processProgressionEvaluateSessionJob`
(`apps/worker`) now enqueues one dispatch job, with a `systemCommandId`
generated once at enqueue time, for every `PERSISTED` decision whose
current `decisionType === 'INCREASE_LOAD'` — for both a newly-created AND
an idempotently-retrieved decision (never only "new"), which is exactly
what closes task §7 scenario A's crash gap: a retried evaluation job
naturally reaches the enqueue call again. `NO_CHANGE`/
`MAINTAIN_LOAD_BUILD_REPS` never enqueue anything (`PROG-APP-D-006`).
Duplicates are explicitly allowed, never suppressed by a pg-boss
singleton (task §7) — correctness comes entirely from the pre-existing
DB idempotency (`UNIQUE(progression_decision_id)`, the command-receipt
model, the state machine, the current-overlay partial unique index),
proven directly: 5 concurrent dispatch jobs for the SAME decision
converge to exactly one workflow and exactly one effective `APPLIED`
outcome (`PROG-APP-D-008`).

**GUIDED system auto-apply** (`processProgressionApplicationDispatchJob`,
`apps/worker/src/progression-application-dispatch.job.ts`, calling
`applySystemProgression`, `packages/progression-application/src/
progression-application-apply.ts`, task §10/§11/§43): reuses the EXACT
SAME mechanical transaction core as the athlete Apply path
(`applyProgressionCore`, an internal function both `applyProgression` and
`applySystemProgression` delegate to — never copy-pasted, task §43's own
explicit requirement) — identical locks, capability resolver, audit,
overlay mutation, and idempotency. The only difference is the actor
discriminant: `SYSTEM` never supplies (or accepts) a human proposal
precondition (task §11 — it resolves canonical truth fresh inside the
locked transaction rather than confirming a previously-seen value) and
never borrows the application owner's `userId`.

**GUIDED domain failure** (task §17/§18, `PROG-APP-D-011`): a missing
capability binding leaves the application `PENDING_REVIEW` with a durable
`REJECTED`/`LOADING_CAPABILITY_UNAVAILABLE` `SYSTEM` command receipt — the
job completes normally (no thrown exception, no retry). The
`progression_decisions` evidence is never rewritten, never converted to
`NO_CHANGE`, never marked stale by this failure alone.

**System actor audit** (task §12/§13/§14, migration
`0014_good_boomerang.sql`): a new `progression_application_actor_type`
enum (`ATHLETE`/`SYSTEM` — deliberately NOT named `ExperienceMode`, task
§12, so `ALTER TYPE ... ADD VALUE 'COACH'` is trivial and additive once a
real `CoachingRelationship` exists, task §30/§40). `progression_
application_commands.user_id` (kept physically named, conceptually
`actorUserId`, task §13) is now nullable with a new `actor_type` column
(`NOT NULL DEFAULT 'ATHLETE'`) and a CHECK tying them together:
`(actor_type = 'ATHLETE') = (user_id IS NOT NULL)`.
`progression_applications` gained `decided_by_actor_type`, replacing the
old `decided_at`/`decided_by` pairing CHECK (which could not express a
truthful `SYSTEM` row, where `decided_by` is `NULL` but `decided_at` is
not) with two new checks tying `decided_at`/`decided_by_actor_type`/
`decided_by` together correctly for both actor kinds. **Never borrows the
application owner's `userId` and labels it `SYSTEM`** (task §13's own
explicit warning) — verified directly: a successful GUIDED apply's row
has `decided_by_actor_type = 'SYSTEM'` and `decided_by IS NULL`
(`PROG-APP-D-036`).

**Existing data preserved** (task §42): the migration backfills every
pre-existing decided `progression_applications` row (and every
pre-existing command receipt, via the new column's own `DEFAULT
'ATHLETE'`) as `ATHLETE` — verified directly against the one real
pre-Slice-D row in the dev database, both before and after migration.

**ADAPTIVE/EXPERT review** (task §19/§37/§38): dispatch ensures the
workflow exists and leaves it exactly `PENDING_REVIEW` — never calls
`applySystemProgression` — proven identically for both modes
(`PROG-APP-D-013`); the athlete then explicitly Apply/Keep-Original
through the pre-existing, unmodified Slice-B/C athlete paths.

**Athlete API contracts** (task §21/§22/§23, `packages/contracts/src/
progression-application.ts`, `apps/api/src/progression/`): `GET
/api/v1/progression/applications/pending`, `GET .../:id/proposal`, `POST
.../:id/apply`, `POST .../:id/keep-original`. `ProgressionReviewService`
re-derives current mode authority fresh on every mode-gated call (never
cached, never client-supplied); `GET pending` internally uses the
mode-agnostic `listPendingProgressionApplications` primitive but only
ever returns actionable items when authority is `ATHLETE_REVIEW` — a
GUIDED athlete's list is always empty even when a real `PENDING_REVIEW`
row exists from a failed system apply (task §28, proven,
`PROG-API-D-001`). `POST apply`/`POST keep-original` reject with
`MODE_ACTION_NOT_ALLOWED` (mapped to HTTP 409) when current authority is
`SYSTEM_AUTO_APPLY` — proven including the exact mode-change race (task
§25): a proposal read while `ADAPTIVE`, mode flipped to `GUIDED`, then
`POST apply` with that now-stale proposal is rejected before ever
touching the application (`PROG-API-D-003`). BOLA proven for all four
routes' underlying service calls (`PROG-API-D-002`/`005`) — `NOT_FOUND`
mapped to HTTP 404.

**Domain rejection vs. transient retry** (task §8): the dispatch job
NEVER throws for a domain outcome (missing capability, `STALE`,
already-decided, no Plan context, ...) — every one of these is a normal
return value, and pg-boss marks the job complete on the first attempt.
The queue's retry/backoff configuration
(`PROGRESSION_APPLICATION_DISPATCH_QUEUE_OPTIONS`) is only ever exercised
by a genuinely thrown DB/infrastructure error.

**Entitlement boundary (task §1, documented, not implemented)**: Smart
Progression's commercial entitlement is an OUTER access gate, deliberately
NOT built in this slice — no RevenueCat/billing/subscription table, no
temporary fake entitlement provider. `packages/progression-application`
and `packages/domain` import none of that. **This is a release
prerequisite, not yet implemented**: before paid/public beta, a canonical
entitlement gate must be added OUTSIDE this feature's own mechanics/
orchestration boundary (e.g. at the dispatch-enqueue or API-authorization
edge) to control WHETHER orchestration may dispatch/execute Smart
Progression at all — it will never change the progression mathematics
themselves.

**Coach boundary (task §30, deferred, seam documented)**: no
`CoachingRelationship` placeholder, no fake coach user, no `COACHED`
enum value, no coach route. The actor-type enum is generic
(`progression_application_actor_type`, not `ExperienceMode`) specifically
so a future `COACH` value is a trivial additive `ALTER TYPE ... ADD
VALUE`, and the eventual authority model is documented as "base mode
policy + an active `CoachingRelationship` overlay" — never a fourth
persisted `ExperienceMode`.

**Migration**: `0014_good_boomerang.sql` proven both against the existing
dev DB (0013 -> 0014, including the real backfill of one pre-existing
row) and a fresh throwaway container (0000 -> 0014) — clean both ways.
No new grants required.

**Test counts**: `packages/progression-application` — 45 pure unit tests
(4 new: the authority-policy matrix) + 62 real-Postgres integration tests
(unchanged from Slice C's binding gate — Slice D added no new tests to
this package directly, since its own new behavior lives in `apps/worker`/
`apps/api`). `apps/worker` — 13 real-Postgres integration tests (7 new:
the dispatch job's own GUIDED/ADAPTIVE/EXPERT/duplicate/mode-race proofs).
`apps/api` — 79 real-Postgres integration tests (5 new: `ProgressionReviewService`'s
own pending/proposal/apply/keep-original/BOLA/mode-gate proofs), 29 unit
tests (unchanged).

**Regression**: full monorepo `lint`/`typecheck`/`test`/`build`/
`boundaries:check` green; all prior real-Postgres suites (Loading
Capability, Progression Evaluation Orchestration, Plan, Slice B/C
progression) re-run and remain green — no regression.

**Runtime intentionally NOT implemented**: `CoachingRelationship`/coach
authority, `REVOKE`, manual load override, billing/RevenueCat/subscription
management, mobile UI, Today/Plan adaptation screens, multi-gym switching
UX. Mobile untouched — no SQLite migration, no network integration.

## 50. Slice D — Final Durability / Crash-Window Gate (2026-09-24)

Narrow evidence gate: the architecture described in §49 was already
APPROVED and is unchanged by this section — nothing here alters mode
policy, progression mechanics, or the dispatch pipeline's shape. This
section instead documents WHICH parts of the crash-window guarantee were
empirically proven via real fault injection (real Postgres + real
pg-boss, `apps/worker/src/progression-evaluate-session.job.integration.
test.ts`, describe block "Slice D — Final Durability / Crash-Window
Gate"), as distinct from what is simply true by direct code inspection.

**Evaluation handler ordering (proven by code inspection, task §3)**:
`processProgressionEvaluateSessionJob` (`apps/worker/src/
progression-evaluate-session.job.ts`) calls
`await enqueueProgressionApplicationDispatch(boss, ...)` synchronously,
inside the per-exercise loop, before the function's own final `return`.
`apps/worker/src/main.ts` awaits this function inside `boss.work(...)`
with no surrounding try/catch, so an uncaught throw from the enqueue call
propagates all the way to pg-boss's own job machinery, which will not ack
the job and will retry it per
`PROGRESSION_EVALUATE_SESSION_QUEUE_OPTIONS`. The required invariant
("evaluation handler must not successfully complete before dispatch
enqueue has successfully returned") already held in the real code — no
redesign was needed.

**Crash Window A — before dispatch exists (empirically fault-injection
tested, `PROG-APP-D-DUR-A`)**: a narrow test-only seam wraps the real,
started `PgBoss` instance in a `Proxy` that intercepts only `.send()`,
failing it once (simulating a transient failure strictly after the
`EngineDecision` has already committed but before the dispatch job is
successfully inserted) and delegating every other call/property — bound
back to the real underlying instance, never the proxy, so pg-boss's own
private class fields keep working — straight to the real `boss`. No
production code changed for this. Observed: the first job invocation
rejects with the injected error and exactly one `progression_decisions`
row exists (the `EngineDecision`, `INCREASE_LOAD`); the retried invocation
(fault already consumed) succeeds, reuses the SAME decision row (same
`id`, evidence/fingerprint idempotency — not a duplicate), and a real
dispatch job for that exact `progressionDecisionId` is now durably present
in pg-boss (`boss.fetch` against the real queue). Running that dispatch
(`processProgressionApplicationDispatchJob`) then produces exactly one
`progression_applications` workflow — no lost recommendation.

**Crash Window B — after dispatch exists, before evaluation ack
(empirically fault-injection tested, `PROG-APP-D-DUR-B`)**: a two-exercise
session lets the same `.send()`-failure seam target the SECOND call
specifically, so the FIRST exercise's dispatch job is successfully
inserted before the whole job throws on the second exercise's enqueue.
Observed: both `EngineDecision` rows persist (evaluation never rolls back
what it already committed); on retry, the first exercise's decision is
found idempotently and its enqueue call is reached again — producing a
SECOND, independently-enqueued dispatch job for the exact same decision
(verified: at least 2 real jobs for that `progressionDecisionId`) — while
the second exercise's job enqueues for the first time. Running BOTH of the
first exercise's duplicate dispatch jobs concurrently (each against its
own fresh DB client, mirroring `PROG-APP-D-008`'s own proven-reliable
concurrency pattern) converges to exactly one `progression_applications`
row with exactly one effective `APPLIED` outcome — no double progression,
no corruption. (The single-decision, single-`Promise.all` duplicate-
dispatch convergence shape itself — including the ADAPTIVE/EXPERT
"exactly one `PENDING_REVIEW`" case, `PROG-APP-D-DUR-ADAPTIVE-DUP` — was
already proven directly against `processProgressionApplicationDispatchJob`
in `apps/worker/src/progression-application-dispatch.job.integration.
test.ts`, alongside the pre-existing GUIDED case `PROG-APP-D-008`.)

**EngineDecision identity**: both crash windows directly assert the
retried/duplicate path's `progression_decisions.id` is byte-identical to
the originally-persisted row's `id` — never a second row — confirming
`evaluateAndPersist`'s evidence-fingerprint idempotency is what closes
this crash gap, not job-level deduplication.

**System command identity (empirically proven, `PROG-APP-D-DUR-C`)**: a
single dispatch job's `systemCommandId` is generated once, at enqueue
time, and lives inside the job's own persisted payload. Proven directly
against real pg-boss retry mechanics: the real job is fetched, its
`data.systemCommandId` recorded, then `boss.fail(...)` forces it into
retry/backoff (`PROGRESSION_APPLICATION_DISPATCH_QUEUE_OPTIONS`'s real
`retryBackoff`/`retryDelayMax`, not a simulated clock); once the backoff
delay elapses and the SAME job id becomes fetchable again, its
`data.systemCommandId` is unchanged. Crash Window B separately confirms
the complementary half of task §15: two INDEPENDENTLY enqueued duplicate
dispatch jobs for the same decision legitimately carry two DIFFERENT
`systemCommandId`s, and correctness (proven by the same test) never
depends on them matching.

**Domain rejection still does not retry (re-confirmed, unchanged
`PROG-APP-D-011`)**: re-run as part of this gate's regression pass with no
code changes — GUIDED + missing capability still leaves the application
`PENDING_REVIEW` with a durable `REJECTED`/`LOADING_CAPABILITY_UNAVAILABLE`
receipt, and the job returns normally (never throws), so pg-boss marks it
complete on the first attempt. This is a genuinely different code path
from the transient-failure windows above (a normal return value vs. an
uncaught exception), and both were exercised in this gate's run.

**Deferred: Guided capability-change re-dispatch (documented only, task
§10 — NOT implemented, NOT a Slice-D blocker)**: if GUIDED auto-apply is
rejected because the athlete's current `LoadingCapability`
configuration is unavailable/invalid (`LOADING_CAPABILITY_UNAVAILABLE`),
the resulting `progression_applications` row remains `PENDING_REVIEW`
indefinitely — Slice D has no mechanism that automatically re-dispatches
that application when the athlete later fixes their `GymProfile`/exercise
binding/`LoadingCapability` configuration. Before user-facing Guided
capability configuration is considered feature-complete, a later product
slice must define an explicit configuration-change event and a
re-dispatch (or athlete-visible surfacing) mechanism for applications
stuck in this state. Until then, such an application is only ever
resolved by the athlete manually reviewing it — but as documented in §49,
a GUIDED athlete's `GET pending` list is deliberately always empty, so
today this state is not even athlete-visible. This is an accepted, scoped
gap, not a defect in what Slice D was asked to deliver.

**Schema/migration**: NONE. This gate was a pure orchestration
evidence/test task, exactly as scoped — no `packages/database` schema
changes were needed or made.

**Test counts**: `apps/worker` gained 4 new real-Postgres integration
tests — `PROG-APP-D-DUR-A`, `PROG-APP-D-DUR-B`, `PROG-APP-D-DUR-C`
(`progression-evaluate-session.job.integration.test.ts`) and
`PROG-APP-D-DUR-ADAPTIVE-DUP`
(`progression-application-dispatch.job.integration.test.ts`), bringing
`apps/worker`'s real-Postgres integration total to 17.

**Regression**: full monorepo `lint`/`typecheck`/`test`/`build`/
`boundaries:check` green; real-Postgres integration suites for
`@vostivo/worker` (17), `@vostivo/progression-application` (62), and
`@vostivo/api` (79) all re-run and green — no regression.

**Process status**: Slice D is implemented and verified, including this
durability gate. Formal closure/sign-off remains the tech lead's own call
— see `CLAUDE.md`.
