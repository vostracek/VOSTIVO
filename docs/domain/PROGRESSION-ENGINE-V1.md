# Vostivo — Progression Engine V1 Specification

**Status:** **APPROVED by tech-lead resolution pass** (core architecture
and progression model approved; OD-1 through OD-7 resolved — see §30).
**Implementation has not started.** This remains **SPECIFICATION ONLY —
no production code, no migrations, no API routes, no mobile UI changes
were made alongside this document or its resolution pass.**
**Scope:** Strength/hypertrophy double-progression for a single prescribed
exercise slot. Reconciled against the real, currently-implemented
`packages/domain`, `packages/contracts`, `packages/database`,
`packages/training-engine`, `apps/mobile`, and `apps/api` — not designed
from memory. Every claim about "what exists today" below was verified by
reading the actual source referenced.

---

## 1. Purpose

Vostivo's core promise is "training that keeps pace with you" via the
**smallest necessary change without losing long-term direction**
(`CLAUDE.md`). Today, a plan's prescribed load/reps never change on their
own — an athlete who does the same "8–12 reps · 60 kg" every week gets no
opinion about whether to progress. The Progression Engine is the first
piece of Vostivo's promised "decision/action product, not an analytics
dashboard" (`CLAUDE.md`, Product strategy): given what actually happened
at one exercise slot, decide **NO_CHANGE**, **INCREASE_LOAD**, or
**MAINTAIN_LOAD_BUILD_REPS** — deterministically, traceably, and
conservatively.

## 2. Scope / non-goals

**In scope (V1):**

- A pure, deterministic decision function evaluating one exercise's
  comparable performance history against its current prescription.
- The warm-up/working set model needed so warm-up performance never
  contaminates progression evidence.
- The RIR/effort domain contract (representation only — no UI).
- The `EngineDecision` persistence shape (conceptual — no migration).
- The boundary contract with a Load Resolver that does not exist in code
  yet (Load Model V1 already anticipates it).

**Explicitly out of scope** (per already-locked exclusions in
`docs/architecture/ACTIVE-WORKOUT.md` / `docs/architecture/
PLAN-PRESCRIPTION.md`):

```text
Full-program adaptation          Fatigue/deload decisions
Pain/injury decisions            Exercise substitution/swap
Schedule changes                 Program generation
Athlete Memory                   Coach override UX (only its data
                                  compatibility is considered here)
Nutrition/recovery advice        RIR UI
Deload/fatigue logic             Adaptation Engine start
```

## 3. Existing locked principles this spec must not silently contradict

Read and reconciled: `CLAUDE.md`, all 8 ADRs, `docs/domain/load-model-v1.md`,
`docs/architecture/{FOUNDATION,WORKOUT-DATA-INTEGRITY,PLAN-PRESCRIPTION,
ACTIVE-WORKOUT,IDENTITY-AUTH}.md`, `docs/audits/V1-ENGINEERING-SECURITY-
BASELINE.md`, and the real code in `packages/domain`, `packages/contracts`,
`packages/database`, `packages/training-engine`, `apps/api`, `apps/mobile`.

| Locked principle | Source | How this spec honors it |
| --- | --- | --- |
| Plan != performed reality | `CLAUDE.md` | Progression never rewrites a historical `PrescribedSetV1` snapshot; it only ever proposes a **future** `PlannedSet` change (§20). |
| Historical reality is not rewritten by future plan changes | `CLAUDE.md` | Same as above — a decision is additive, applied forward only. |
| Training Engine is deterministic; version bump on behavior change | `CLAUDE.md` | §19 reuses the existing `EngineVersion{engine,policy}` contract exactly. |
| Generic last-write-wins forbidden for workout history | `CLAUDE.md` | Not applicable here (Progression reads history, never writes `PerformedSet`), noted for completeness. |
| No premature abstraction / no generic rule-engine framework | `CLAUDE.md` Working conventions | §29 proposes one explicit versioned function, not a rules engine. |
| Progression Engine chooses desired progression; Load Resolver chooses realizable load (LOAD-INV-016) | `docs/domain/load-model-v1.md` | §14 makes this the literal contract boundary — already locked, not invented here. |
| Equipment/loading context affects comparability (LOAD-INV-013) | `docs/domain/load-model-v1.md` | §10 comparable-exposure model. |
| "A progression may be demonstrated by same load+more reps, same load/reps+higher RIR, higher load+comparable reps/RIR..." (§101-102) | `docs/domain/load-model-v1.md` | §12 progression rules directly implement this, unmodified. |
| Set types `WARMUP, WORKING, BACKOFF, DROP, AMRAP, FAILURE` already named (§91-95) | `docs/domain/load-model-v1.md` | §5 adopts the same working/reserved split, using `WARM_UP` (tech-lead-directed spelling) in place of that doc's `WARMUP` — see reconciliation note below. |
| `PerformedSet` deliberately has no RIR field | `docs/architecture/WORKOUT-DATA-INTEGRITY.md` | §15 defines the future contract without adding the field now. |
| "Warm-up/drop/failure/AMRAP set types: not implemented; nothing prevents adding a set-type field later" | `docs/architecture/ACTIVE-WORKOUT.md` | This spec is exactly that later addition. |
| `PlannedExercise.role` not implemented, no vocabulary exists | `docs/architecture/PLAN-PRESCRIPTION.md` | §26 — V1 does not use program role at all. |
| `exerciseRef` local-only, "never synced to the server... not part of the WDI wire contract" | `docs/architecture/ACTIVE-WORKOUT.md` | **Real prerequisite conflict, resolved — see §25 and OD-1 (§30): approved.** |
| `packages/training-engine` depends only on `packages/domain`, no framework imports (enforced by `pnpm boundaries:check`) | `docs/architecture/FOUNDATION.md` | §29 — pure input model, no DB/HTTP inside the engine. |
| Existing `EngineDecision<Kind,Data>` / `EnginePolicy<Input,Kind,Data>` / `EngineVersion` bootstrap already in `packages/training-engine/src/decision.ts` | code | §18/§19 build directly on this — not a new envelope. |
| Deload/fatigue logic is explicitly out of every prior slice's scope | `CLAUDE.md`, every architecture doc's exclusion list | §16 makes the boundary explicit and locks it, rather than leaving it implicit. |

### Naming reconciliation (resolved by tech-lead decision, superseding the draft's original recommendation)

`docs/domain/load-model-v1.md` §91-95 writes the future set-type
vocabulary as `WARMUP` (no underscore). The draft version of this spec
adopted that spelling for consistency. **The tech-lead resolution pass
(OD-3) directs `WARM_UP` (with underscore) instead** — this spec now
uses `WARM_UP` throughout. This creates a one-word spelling divergence
from `docs/domain/load-model-v1.md`'s own prose (which is not amended by
this task); a future pass touching that document should reconcile the
spelling there to `WARM_UP` for consistency, but this is cosmetic, not a
technical contradiction, and does not block anything in this spec.

## 4. Domain terminology

| Term | Meaning |
| --- | --- |
| **Exposure** | One completed `PerformedSet` (or the set of working `PerformedSet`s for one exercise in one session) evaluated against a prescription. |
| **Comparable exposure** | A prior exposure judged similar enough to the current one to count as evidence (§10). |
| **Evidence window** | The bounded, most-recent slice of comparable exposures the engine actually inspects (§11). |
| **Decision** | The engine's deterministic output for one exercise slot: `NO_CHANGE` / `INCREASE_LOAD` / `MAINTAIN_LOAD_BUILD_REPS` (§13). |
| **Recommendation** | A decision that has not yet been applied to a future `PlannedSet` (§20). |
| **Reason code** | A finite, deterministic explanation for a decision (§17). |
| **Evidence strength** | A deterministic (non-numeric) confidence state: `INSUFFICIENT` / `SINGLE_EXPOSURE` / `SUPPORTED` / `STRONG` (§17.3). |

## 5. Warm-up / working set model

### 5.1 The minimum V1 set-type vocabulary

```ts
export const SET_TYPES_V1 = ["WARM_UP", "WORKING"] as const;
export type SetTypeV1 = (typeof SET_TYPES_V1)[number];

// Reserved for later stages — the schema/type allows them; V1 has no
// logging UI, no progression policy, and no evidence-classification rule
// beyond "excluded" for any of these (see §8's table).
export const SET_TYPES_RESERVED = ["BACKOFF", "DROP", "AMRAP", "FAILURE"] as const;
```

### 5.2 Where set type belongs — one representation, always explicit (tech-lead resolution, OD-3)

**The draft's original "nullable intent, `null` means `WORKING`" model
(the `restSeconds` pattern) is explicitly rejected for `setType` by the
tech-lead resolution.** `restSeconds` stays nullable (`null` genuinely
means "not specified," a legitimate absence). `setType` is different: a
set's type is never legitimately "absent" — it is always exactly one of
`WORKING` or `WARM_UP` (or a reserved type later), even when a plan
author didn't think about it. Persisting that as `null` and reinterpreting
it later would create two representations for the same value
(`null` *or* `"WORKING"`), which is exactly what this resolution forbids.

**One representation, everywhere, always explicit:**

```text
PlannedSet.setType            SetTypeV1  (Intent — required, NOT NULL.
                                           Defaults to WORKING at WRITE
                                           TIME when a plan author doesn't
                                           specify one — an application-
                                           layer default applied once,
                                           before persistence, never a
                                           nullable column reinterpreted
                                           at read time.)
PrescribedSetV1.setType       SetTypeV1  (snapshot — required, NOT NULL;
                                           carried through losslessly from
                                           PlannedSet, same discipline as
                                           targetReps/restSeconds already
                                           use for their own values.)
PerformedSet.setType          SetTypeV1  (Reality — required, NOT NULL;
                                           every performed set has a
                                           definite type.)
CompleteSetCommandV1.setType  SetTypeV1  (wire — required, always
                                           explicit; the server never
                                           infers set type.)
```

### 5.2.1 Migration semantics (required, explicit order)

For a future implementation, exactly in this order:

1. **Backfill** every existing `PerformedSet` (and, where present,
   `PlannedSet`) row to `WORKING` (OD-3's approved default — see
   rationale in §30).
2. **Constrain**: the persisted `setType` column becomes `NOT NULL` on
   both tables — no nullable transitional state ships as the steady
   state.
3. **Domain/contracts**: `PlannedSet`, `PrescribedSetV1`, `PerformedSet`,
   and `CompleteSetCommandV1` all type `setType` as `SetTypeV1` (never
   `SetTypeV1 | null`).
4. **New writes**: every new `PlannedSet` and every new
   `CompleteSetCommandV1` always carries an explicit value — a UI/authoring
   default of `WORKING` is applied by the calling code before the value
   is ever persisted, not left implicit in storage.

### 5.3 Converting WARM_UP ↔ WORKING

**No second logging system.** A set's type is corrected through the
**existing** reopen → recomplete flow (ADR-0007), exactly like correcting
`actualReps`/`actualLoad` today:

- `CompleteSetCommandV1` (every completion, including a recompletion)
  carries the `setType` the athlete indicated for that specific
  completion.
- `REOPEN_SET_V1` is unchanged (it only ever flips `completionState`,
  never touches `setType` itself) — recompleting afterward is what
  changes `setType`, same as it already changes `actualReps`.
- This means: yes, a user can convert a warm-up set to a working set (or
  back) by reopening and recompleting it with a different `setType` — the
  exact existing mechanism, zero new commands.

### 5.4 Revision semantics

Unchanged. `setType` is just one more field a recompletion can update,
gated by the exact same monotonic per-set `revision` rule ADR-0007
already enforces. No new conflict-resolution logic.

### 5.5 Local-first/offline/outbox path

Unchanged. `setType` travels inside the same `COMPLETE_SET_V1` command,
through the same one-transaction local write, the same outbox, the same
revision-gated server upsert. **This directly satisfies "do not create a
second unreliable logging system just for warm-up."**

### 5.6 Progression evidence treatment (the one thing that actually matters here)

**`WARM_UP` sets are real workout history but are structurally excluded
from progression evidence** — the evidence-assembly step (§29) filters to
`setType === "WORKING"` before anything reaches the engine. A warm-up set
performed at 60 kg × 5 before a 100 kg × 8 working set can never be
misread as "the athlete only did 60 kg today."

## 6. Exercise-specific warm-up

Confirmed boundary (Load Model V1 §91-95 already implies this; this spec
makes it explicit):

```text
Progression Engine   knows a set's type; excludes WARM_UP from evidence.
Warm-up generation   (recommending 20×10 / 60×5 / 80×3 / 90×1 before a
                      100 kg top set) is a separate PREPARATION/
                      PRESCRIPTION concern, not a Progression Engine
                      responsibility.
```

Warm-up generation would eventually live alongside the Load
Resolver/prescription-assembly layer (it needs the same equipment/
increment knowledge the Resolver already owns per Load Model V1 §37-47),
not inside `packages/training-engine`'s progression policy. **This spec
does not design warm-up generation** — it only guarantees the data model
never blocks adding it later, and that Progression Engine never has to
know how warm-ups are generated, only how to recognize and exclude one.

## 7. General pre-workout warm-up (mobility/preparation)

**Not modeled as a `PerformedSet` at all.** A general warm-up (mobility,
a few easy minutes, unrelated to a specific exercise's load) does not fit
"exercise + reps + load" — forcing it into `PerformedSet` would corrupt
that table's meaning (every row would need a nullable everything). V1
defers this entirely:

```text
Future concept (not implemented): a lightweight, exercise-independent
"session preparation" marker — e.g. a nullable
WorkoutSession.preparationNote or a separate, non-set-based log — decided
if/when the product actually needs it.
```

The only requirement this spec enforces now: **"warm-up exists" must no
longer be ambiguous** for exercise-specific warm-up (§5 resolves this);
general preparation is out of scope and explicitly deferred, not silently
ignored.

## 8. Set type future compatibility

| Set type | V1 status | Progression evidence policy | Why |
| --- | --- | --- | --- |
| `WORKING` | **Real, V1** | Normal evidence | The only type today's double-progression policy reasons about. |
| `WARM_UP` | **Real, V1** | Excluded entirely | §5.6. |
| `BACKOFF` | Reserved (schema allows; no V1 UI) | Excluded | A backoff set follows a heavier top set at reduced load post-fatigue — mixing it with primary working-set evidence would corrupt the double-progression comparison. Needs its own policy later. |
| `DROP` | Reserved | Excluded | Same reasoning — performed at reduced load, post-fatigue, by construction; not comparable to a straight working set. |
| `AMRAP` | Reserved | Excluded from V1 ordinary evidence; flagged as a future high-value signal | "Reps at failure" has different evaluation semantics than "did this set reach the top of a prescribed range" — needs its own evaluator, not a rename of double-progression. |
| `FAILURE` | Reserved | Excluded from V1 ordinary evidence; flagged as a future regression/fatigue signal | Same reasoning as AMRAP — a failure set is informative but not an ordinary comparable working set. |

No type is silently treated as an ordinary working set. Every reserved
type has an explicit exclusion, not an accidental fallthrough.

## 9. Current V1 available inputs vs. desired inputs

**Audited from real code, not memory:**

### 9.1 Currently available (V1, as implemented today)

```text
ExerciseIdentityV1        opaque string (packages/domain/src/exercise-identity.ts);
                           nullable on PerformedExercise/PrescribedExerciseV1
PrescribedSetV1            prescriptionSetId, order, targetReps (RepTargetV1
                            EXACT|RANGE, nullable), targetLoad
                            (ExternalWeightLoad, nullable), restSeconds
PerformedSet                actualReps, actualLoad, completionState
                            (COMPLETED|REOPENED), completedAt, revision,
                            order, prescriptionSetId (nullable)
PerformedExercise           prescriptionExerciseId (nullable), exerciseRef
                            (nullable, MOBILE-LOCAL ONLY — see §25),
                            displayName, order
ExternalWeightLoad          kind: "EXTERNAL_WEIGHT" only (Stage 1), unit
                            KG|LB, basis TOTAL|PER_IMPLEMENT, amountMilli
WorkoutSession               prescription snapshot, startedAt, status,
                            completedAt
Program hierarchy context   Program -> ProgramVersion -> TrainingBlock
                            (goal, focusAreas free text) -> TrainingCycle
                            (order, date range) -> PlannedWorkout (name,
                            focus, order, scheduledDate) — all reachable
                            by join, none of it exercise-role-aware
packages/training-engine    EngineDecision<Kind,Data>, EnginePolicy<Input,
                            Kind,Data>, EngineVersion{engine,policy},
                            formatEngineVersion, engineVersionsEqual —
                            bootstrap only, no real policy yet
```

### 9.2 Not yet available (desired, real prerequisites — see §25/§30)

```text
RIR/effort                  no field anywhere (deliberately deferred,
                            WDI/Plan/Active Workout all confirm this)
LoadingProfile/Load Resolver defined only in docs/domain/load-model-v1.md;
                            zero code exists — no GymProfile, no increment
                            data, no difficulty-direction metadata
Program role (primary/       no vocabulary exists anywhere in the domain
accessory/...)               model
Server-side cross-session    only mobile-local getPreviousExercisePerformance
performed-history read       exists (single device); no API endpoint
Set type (this spec)         proposed, not yet implemented
exerciseRef on the server    exists only opaquely inside per-session JSONB
                            prescription_snapshot; not a queryable column
                            on app.performed_exercises (§25)
```

### 9.3 Is RIR required for Progression Engine V1?

**No — optional, strongly preferred later, not a blocker.** V1's
double-progression rule (§12) is defined entirely in terms of
reps-vs-target and load-vs-prescription, which is exactly how classic
double progression already works without RIR. Missing RIR:

- Never blocks a decision (matches Load Model's "unknown load semantics
  never block basic workout logging" principle, extended here).
- Caps evidence strength at `SUPPORTED`, never `STRONG` (§17.3) — a
  deliberate, conservative, explicit penalty rather than silently
  pretending effort data doesn't matter.
- Never causes the engine to **invent** an effort value. Absence is
  absence.

This was one of the few decisions this spec recommended outright rather
than only offering options — the tech lead has confirmed it: build
without RIR now (OD-2, §30).

## 10. Comparable exposure model

### 10.1 Classification

```text
COMPARABLE               same exerciseRef AND same target (RepTargetV1
                          equal AND targetLoad equal in kind/unit/basis/
                          amount) AND same exercise order position AND
                          same working-set count AND setType = WORKING
                          AND no flagged equipment/gym change

COMPARABLE_WITH_CONTEXT  same exerciseRef AND same target, but exercise
                          order changed, OR working-set count differs,
                          OR the exercise is COMPARABLE in every other
                          respect but was logged via an unplanned/extra
                          set (no prescriptionSetId match) — usable, but
                          caps evidence strength at SUPPORTED (§17.3)

NOT_COMPARABLE           different exerciseRef, different load kind/unit/
                          basis, different target (a real prescription
                          change — see §12.11's "prescription changed"
                          rule), a flagged equipment/gym change, or
                          setType != WORKING
```

### 10.2 Factor table (from the task's checklist)

| Factor | Effect |
| --- | --- |
| Same `exerciseRef` | Required for COMPARABLE at any tier |
| Program role | Not modeled in V1 — not a factor (§26) |
| Routine/session role | Same as exercise order below |
| Exercise order | Match → COMPARABLE; changed → COMPARABLE_WITH_CONTEXT (§24) |
| Target rep range | Must match exactly → otherwise NOT_COMPARABLE (§12.11) |
| Set count | Match → COMPARABLE; mismatch → COMPARABLE_WITH_CONTEXT |
| Loading profile / equipment | Not yet modeled in code (Stage 1 only); a future equipment-change flag → NOT_COMPARABLE per LOAD-INV-013 |
| Working-set type | Must be `WORKING` → otherwise excluded entirely, not merely downgraded |
| Changed plan version | If the exercise's own target didn't change, no effect; if it did, NOT_COMPARABLE (evidence resets, §12.11) |
| Changed gym/equipment | NOT_COMPARABLE once a future equipment-context signal exists; V1 has no such signal yet (documented gap, not silently ignored) |
| Temporary substitution | A substituted exercise has a different `exerciseRef` by construction → NOT_COMPARABLE (correct default; no special-casing needed) |

Absolute identical context is deliberately **not** required (that would
make progression useless — one grip-width tweak would reset all
history); the three-tier model exists specifically to avoid that
over-strictness while never conflating genuinely different contexts.

## 11. Evidence window

```text
Most recent exposure    always inspected — this is what "did the athlete
                        reach the top of range THIS time" evaluates.
Short trend window      the 3 most recent COMPARABLE or COMPARABLE_WITH_
                        CONTEXT exposures (bounded, not "all history").
Older context           never scanned by the decision function itself —
                        older history is a Progress-tab display concern
                        (PRs, trend charts), never a progression-decision
                        input (§27's separation of PRs from progression).
```

**Why 3, not more:** large enough to distinguish a genuine pattern from
one bad day (the task's explicit requirement — "one bad exposure alone
must not be called a plateau"), small enough to stay a bounded, fast,
side-effect-free query (§29's performance note) and to match "smallest
necessary change" — nothing here claims scientific precision about the
"right" window size; 3 is the smallest number that can distinguish "a
fluke" from "a trend" at all.

- **One bad exposure** → evidence strength `SINGLE_EXPOSURE` (if it's the
  only data point) → reason `PERFORMANCE_REGRESSED_SINGLE_EXPOSURE` →
  decision `NO_CHANGE`. Never a stall/plateau signal by itself.
- **`PROGRESSION_STALLED`** (§17.2) requires **all 3** window exposures to
  show neither a top-of-range achievement nor a reps-increasing trend —
  the conservative bar the task asks for.

### 11.1 The window is not a waiting period (tech-lead clarification, OD-5)

**The 3-exposure window is NOT a mandatory minimum history before any
progression decision can occur.** §12.1/§12.2's rule is evaluated against
the **current, just-completed exposure** — if that exposure alone
independently satisfies the bar (every working set at the top of range,
or the exact count), the engine produces `INCREASE_LOAD` (or
`MAINTAIN_LOAD_BUILD_REPS`) even when zero or one prior comparable
exposure exists. Evidence strength in that case is correctly capped at
`SINGLE_EXPOSURE` (§17.3) — the decision is not blocked, only its
*confidence* is honestly reported as lower.

The window's actual job is narrower than "gatekeeping whether a decision
can fire": it exists for **trend interpretation** (§12.3/§12.5), evidence
**strength classification** (§17.3), single-exposure **noise protection**
(§12.7 — one bad exposure ≠ regression conclusion), and
`PROGRESSION_STALLED` **detection** (§17.2, which genuinely does require
the full 3-exposure window — a repeated-pattern signal cannot honestly be
claimed from fewer data points). One unusual exposure — good or bad —
must never, by itself, be read as a plateau or a trend.

## 12. Progression rules (the core algorithm)

All rules operate on the **current** prescription's target — a decision
never compares raw numbers session-to-session without first checking they
share the same intent (§12.11).

### 12.1 Successful progression evidence (`RANGE` targets)

**Requires ALL working sets mapped to a current prescribed slot
(`prescriptionSetId` matches a `WORKING` `PlannedSet` in the current,
active prescription) in the most recent comparable exposure to reach at
least `maxReps`.** One set reaching the top while others fall short is
**not** enough — a single good set among mediocre ones is not "the
athlete is ready," it is exactly the kind of one-exposure overreaction
the task explicitly warns against.

### 12.2 `EXACT` targets

An `EXACT` target (e.g. a strength day at "5 reps") has no range to build
within, so `MAINTAIN_LOAD_BUILD_REPS` **never applies** to it. Meeting
the exact rep count on every working set is direct evidence for
`INCREASE_LOAD`; falling short is `NO_CHANGE`. There is no intermediate
state.

### 12.3 Uneven sets (e.g. 12 / 11 / 9 against an 8–12 range)

Real forward progress happened (trending toward the top), but not every
set is ready → `MAINTAIN_LOAD_BUILD_REPS`, reason `REPS_PROGRESSING` —
**not** `NO_CHANGE` (that would ignore genuine improvement) and **not**
`INCREASE_LOAD` (not every set met the bar yet).

### 12.3.1 `RANGE` precedence — regression beats a partial bar touch (RANGE Precedence Fix, 2026-09-22)

**Explicit precedence, added to remove an ambiguity the initial
implementation got wrong (see the Pure Progression Engine V1 /
Progression RANGE Precedence Fix reconciliation reports for the full
incident):**

1. **Full top-of-range achieved** (§12.1 — every required working set at
   or above `maxReps`) → `INCREASE_LOAD`. This check is evaluated first
   and is unaffected by anything below it — there is no regressed slot
   left to contradict a result where every required set already cleared
   the bar.
2. **Otherwise, if the exposure is genuinely regressed** — any required
   set below `minReps` (a floor violation), or a genuine per-slot
   regression against the immediately prior comparable exposure (§12.7)
   — → `NO_CHANGE`, reason `PERFORMANCE_REGRESSED_SINGLE_EXPOSURE`. **This
   check takes precedence over step 3.** A single required set touching
   `maxReps` must never mask a genuine regression in the other required
   sets: prior `11/10/9` → current `12/9/8` has one slot improve to the
   bar, but the other two slots both regressed — the exposure as a whole
   is regressed and must read `NO_CHANGE`, never
   `MAINTAIN_LOAD_BUILD_REPS`.
3. **Otherwise, positive non-regressing progress** — any required set at
   or above `maxReps` (a partial bar touch that survived step 2's
   regression check), or a genuine per-slot improvement with no slot
   regressing (§12.3/§12.5) → `MAINTAIN_LOAD_BUILD_REPS`, reason
   `REPS_PROGRESSING`.
4. **Otherwise** → `NO_CHANGE`, reason `SINGLE_EXPOSURE_ONLY` (exactly one
   comparable exposure exists) or `PERFORMANCE_STABLE` (§12.6).

This ordering applies to `RANGE` targets only. `EXACT` targets have no
step 3 at all (§12.2/§10 — `MAINTAIN_LOAD_BUILD_REPS` never applies to
`EXACT`), so step 2's regression check is, for `EXACT`, immediately
followed by step 4 — there is nothing for it to take precedence over.

### 12.4 Load increase + rep decrease in the same exposure

Handled by anchoring to the **current prescription's own target**, not
last session's raw numbers: if the current target load is already higher
than before (because a prior recommendation was already applied) and the
athlete met the current target range at that new load, this evaluates
normally as ordinary evidence at the new baseline — it is never compared
against the pre-change numbers as if they were the same intent.

### 12.5 Same load + rep increase

Directly what `REPS_PROGRESSING` (§12.3) tracks — contributes toward an
eventual `INCREASE_LOAD` once the trend reaches the top of range.

### 12.6 Maintaining

Default outcome whenever evidence doesn't clear the `INCREASE_LOAD` bar
and doesn't show regression: `NO_CHANGE`, reason `PERFORMANCE_STABLE`.

### 12.7 Regression / repeated regression

A single below-range or below-previous exposure → `NO_CHANGE`, reason
`PERFORMANCE_REGRESSED_SINGLE_EXPOSURE`. The engine **never decreases
load on its own** — see §16 (deload boundary). Repeated regression across
the full 3-exposure window → still `NO_CHANGE`, but paired with the
`PROGRESSION_STALLED` signal (§17.2) for a future Fatigue/Adaptation
Engine to consume.

### 12.8 Partial workout / missing sets

Only sets that actually map to a current `WORKING` prescribed slot count.
Fewer completed sets than planned still evaluates on the sets that exist,
but evidence strength is capped: never `STRONG` (fewer data points), and
if **zero** working sets exist for that exercise this session →
`INSUFFICIENT_EVIDENCE`, never treated as a failure. Missing work is
never assumed to mean poor performance.

### 12.9 Extra sets

A set with **no** `prescriptionSetId` match against a current `WORKING`
slot (an athlete-added extra set) is real history but is **excluded from
V1 progression evidence** — kept simple and unambiguous rather than
inventing a partial-weight rule for freeform sets. It is never discarded
from the athlete's log, only from the evidence set.

### 12.10 Reordered exercise

Handled by the comparability tier (§10) — order-changed exposures are
`COMPARABLE_WITH_CONTEXT`, capping strength at `SUPPORTED`, never
excluded outright (§24).

### 12.11 Changed prescription

If the current `PlannedSet.targetReps`/`targetLoad` differs from what a
prior exposure was evaluated against, that prior exposure is
`NOT_COMPARABLE` to the new target — **the evidence window resets** under
the new prescription (reason `PRESCRIPTION_CHANGED_RESET`). A changed
prescription is a new intent; comparing against the old one would silently
smuggle in a stale target.

**`NO_CHANGE` remains the safe default in every ambiguous or
insufficient-evidence case — never the exception.**

## 13. Decision vocabulary — LOCKED (tech-lead resolution)

Exactly three decision types — deliberately minimal, per the task's
explicit ask to avoid vague/overlapping types, and confirmed unchanged by
the tech-lead resolution. **No `DELOAD`, `REDUCE_VOLUME`,
`CHANGE_EXERCISE`, or `PAIN_SWAP`** — none of those belong to Progression
Engine (§16, §2). No `REVIEW` type either: review-vs-auto-apply is an
authority/mode concern (§20), not a fourth kind of decision.

| Decision | Meaning | Input condition | Output | Applies to |
| --- | --- | --- | --- | --- |
| `NO_CHANGE` | No progression action is justified — insufficient, ambiguous, stable, or stalled evidence, per its reason code | Insufficient evidence, ambiguous evidence, regression, or a stable pattern with no improving trend | No prescription change proposed | `RANGE` and `EXACT` |
| `MAINTAIN_LOAD_BUILD_REPS` | Positive progression evidence exists, but the top-of-range/load-increase condition has not yet been satisfied | Reps trending up within range but not yet at the top on every working set (§12.3/§12.5) | No load change; encourages continuing at the same load | `RANGE` only (§12.2) |
| `INCREASE_LOAD` | The bounded load-increase condition has been satisfied | Every working set reached the top of the range (`RANGE`) or met the exact count (`EXACT`) in the most recent comparable exposure (§11.1 — not gated by exposure count) | A **direction-only** recommendation — never a resolved kg value (§14) | `RANGE` and `EXACT` |

## 14. Load Resolver boundary

**Already locked** (`docs/domain/load-model-v1.md`, LOAD-INV-016):

```text
Progression Engine  = should difficulty increase?  (this spec)
Load Resolver       = what exact achievable load represents that increase?
                       (docs/domain/load-model-v1.md §51-65 — NOT YET
                       IMPLEMENTED IN CODE)
```

**Consequence for V1**: since no Load Resolver exists in code yet (only
the doc), `INCREASE_LOAD`'s `data` payload in V1 carries **direction and
current state only**:

```ts
interface IncreaseLoadDataV1 {
  readonly direction: "INCREASE";
  readonly currentLoad: ExternalWeightLoad;
  readonly currentTargetReps: RepTargetV1;
}
```

It never invents a kg delta. Turning this into a new prescribed load
requires a Load Resolver call the **application layer** makes separately
(§20) — if the Resolver returns `NO_SUITABLE_INCREMENT` (Load Model V1
§349-351, already locked), the application layer downgrades the outcome
to `MAINTAIN_LOAD_BUILD_REPS` rather than ever prescribing an impossible
load. This downgrade happens **outside** the pure engine (which already
made its honest recommendation); the engine itself is never told about
equipment feasibility, keeping the two responsibilities genuinely
separate as LOAD-INV-016 requires.

**A minimal Load Resolver (at least Stage 1: `FIXED_INCREMENT`/discrete
list, matching Load Model V1 §106-108's own staged rollout) is therefore
a real prerequisite before `INCREASE_LOAD` can safely become a new
`PlannedSet` value end to end** — see §28.

## 15. RIR / effort contract

```ts
export type RirValueV1 = 0 | 1 | 2 | 3; // 3 means "3 or more" — a categorical ceiling

export interface RirV1 {
  readonly kind: "RIR";
  readonly value: RirValueV1;
}
```

- **Representation**: categorical 0/1/2/"3+", matching the product
  direction already named for Adaptive/Expert — not a continuous score.
  `3` is a bucket ("3 or more"), never normalized to a fabricated
  midpoint like `3.5`; athletes cannot reliably self-report finer than
  that.
- **Missing value semantics**: absence (`undefined`), never a fabricated
  default (never assume RIR = 2 because that's "typical").
- **Target vs performed**: mirrors the existing target/actual load
  pattern — `targetRir?: RirV1` on `PrescribedSetV1`/`PlannedSet`,
  `performedRir?: RirV1` on `PerformedSet`. Neither exists in code yet
  (§9.2) — this is the contract a future slice implements against, not a
  field added now.
- **How uncertainty affects decisions**: missing RIR caps evidence
  strength at `SUPPORTED` (§17.3), never blocks a decision, never becomes
  a fabricated data point.
- **Exclusion from medical interpretation**: RIR is a training-effort
  self-report. It is never reinterpreted by this engine as a
  fatigue/injury/medical signal — that boundary belongs, if ever, to a
  future Fatigue/Adaptation Engine (§16), and even there only as one
  corroborating input, never a diagnostic claim (see also "Safety /
  claims" near the end of this document).

## 16. Deload / fatigue boundary — REQUIRED, explicit, LOCKED

**Status: LOCKED by tech-lead resolution, unchanged from the draft.**
Progression Engine may emit evidence of repeated stalled/regressed
performance (`PROGRESSION_STALLED`, §17.2); it must never independently
decide a deload. Fatigue/Adaptation Engine is the future owner of deload
decisions because only it can weigh the broader training context this
engine deliberately does not have visibility into. There is no "Week N
automatically means deload" rule anywhere in this design, now or later.

**Deload is not a post-workout action.** A deload is a temporary
reduction in training stress across a **wider planning horizon** than one
exercise's evidence window. It is a decision that must weigh repeated
performance trend, recovery, adherence, block duration, exercise-level
problems, and program-level context all together — none of which
Progression Engine V1 has visibility into (it evaluates one exercise slot
at a time, per §12).

**This spec locks the following boundary, consistent with every prior
slice's exclusion list (`CLAUDE.md`; `docs/architecture/ACTIVE-WORKOUT.md`;
`docs/architecture/PLAN-PRESCRIPTION.md` all already exclude "Progression/
Adaptation Engine" from their own scope without further detail — this is
the first place the boundary is stated precisely):**

```text
Progression Engine   MAY emit evidence (PROGRESSION_STALLED, §17.2) that
                      repeated comparable exposures showed no improvement.
Progression Engine   MUST NOT decide "Week 5 = deload."
Progression Engine   MUST NOT independently reduce a prescribed load or
                      volume for recovery reasons.
Fatigue/Adaptation    (future, not started) is the only system with
Engine                authority to decide a deload, and only by
                      considering signals broader than one exercise's
                      recent sets.
```

`PROGRESSION_STALLED` is therefore evidence **for** a future
Fatigue/Adaptation Engine, never a trigger this engine acts on itself.
This separation is what keeps Progression Engine V1's blast radius
narrow: it can never make training harder to recover from by itself,
because it can never make it easier either — it only ever recommends
*more* difficulty, and only conservatively (§28).

## 17. Reason codes and evidence strength

### 17.1 Reason codes (finite vocabulary)

| Reason code | Meaning | Pairs with |
| --- | --- | --- |
| `TOP_OF_RANGE_ACHIEVED` | All working sets met/exceeded the top of a `RANGE`, or met an `EXACT` count | `INCREASE_LOAD` |
| `REPS_PROGRESSING` | Reps trending up but not yet at the bar on every set | `MAINTAIN_LOAD_BUILD_REPS` |
| `PERFORMANCE_STABLE` | Evidence supported, no improving or regressing trend | `NO_CHANGE` |
| `INSUFFICIENT_EVIDENCE` | Zero comparable exposures | `NO_CHANGE` |
| `SINGLE_EXPOSURE_ONLY` | Exactly one comparable exposure — not zero, but not enough to trend | `NO_CHANGE` |
| `PERFORMANCE_REGRESSED_SINGLE_EXPOSURE` | The most recent exposure alone regressed | `NO_CHANGE` |
| `NON_COMPARABLE_CONTEXT` | Nothing in history classifies as COMPARABLE/COMPARABLE_WITH_CONTEXT | `NO_CHANGE` |
| `PARTIAL_EXPOSURE` | Fewer working sets completed than prescribed | `NO_CHANGE` (or `MAINTAIN_LOAD_BUILD_REPS` if the completed subset itself shows §12.3) |
| `PRESCRIPTION_CHANGED_RESET` | Target changed since the last exposure; window reset | `NO_CHANGE` |
| `NO_SUITABLE_LOAD_INCREMENT` | Applied by the **application layer**, not the engine — downgrades an `INCREASE_LOAD` after the Load Resolver reports `NO_SUITABLE_INCREMENT` | `MAINTAIN_LOAD_BUILD_REPS` |

Every reason code maps to exactly one (or a clearly stated pair of)
decision type(s) — none are vague or overlapping, per the task's
explicit requirement.

### 17.2 `PROGRESSION_STALLED` — a signal, not a decision

`PROGRESSION_STALLED` is **evidence metadata attached to a `NO_CHANGE`
decision**, emitted only when all 3 evidence-window exposures show
neither improvement nor a top-of-range result (§11). It is a candidate
input for a **future** Fatigue/Adaptation Engine (§16) — Progression
Engine V1 never acts on it itself.

### 17.3 Evidence strength (deterministic state, not a numeric score)

```ts
export type EvidenceStrengthV1 = "INSUFFICIENT" | "SINGLE_EXPOSURE" | "SUPPORTED" | "STRONG";
```

| State | Condition |
| --- | --- |
| `INSUFFICIENT` | Zero comparable exposures |
| `SINGLE_EXPOSURE` | Exactly one comparable exposure |
| `SUPPORTED` | 2+ comparable exposures agree in direction, OR the window includes any `COMPARABLE_WITH_CONTEXT` exposure, OR RIR is missing anywhere in the window |
| `STRONG` | The full 3-exposure window is purely `COMPARABLE` (not `_WITH_CONTEXT`), agrees in direction, and RIR (when a target exists) corroborates |

No 0–100 score — a numeric confidence value here would be false
precision the underlying evidence cannot support (the task's explicit
instruction).

## 18. EngineDecision persistence proposal (conceptual — no migration)

Builds directly on the existing `EngineDecision<Kind, Data>` /
`EnginePolicy<Input, Kind, Data>` / `EngineVersion` types already in
`packages/training-engine/src/decision.ts` — **not a new envelope**.

```ts
// packages/training-engine/src/progression/decision.ts (proposed)
interface ProgressionDecisionDataV1 {
  readonly decisionType: "NO_CHANGE" | "INCREASE_LOAD" | "MAINTAIN_LOAD_BUILD_REPS";
  readonly reasonCode: ReasonCodeV1;
  readonly evidenceStrength: EvidenceStrengthV1;
  readonly progressionStalled: boolean; // §17.2 signal, independent of decisionType
  readonly recommendedChange: IncreaseLoadDataV1 | null; // §14 — direction only
}
// EngineDecision<"progression", ProgressionDecisionDataV1> IS the in-memory
// decision shape; persistence adds identity/audit fields around it:
```

| Field | Why it exists / invariant it protects |
| --- | --- |
| `decisionId` | Stable identity for audit/override tracking (§21, coach override). |
| `athleteProfileId` | Ownership — same BOLA discipline as every other Vostivo entity. |
| `engineVersion` (`EngineVersion`) | Reused as-is — "why did Vostivo recommend this on this date" (§19). |
| `exerciseRef` | What this decision is about — the stable cross-session key (§25). |
| `sourcePrescriptionExerciseId` / `sourcePrescriptionSetId` | Traceability to the exact prescription evaluated. |
| `evidenceExposureRefs: { performedSetId, revisionEvaluated }[]` | Snapshot references, **not** a live re-derivable query — protects determinism (§19): if a set is later corrected, the old decision's explanation still points at exactly what it actually saw. |
| `decisionType`, `reasonCode`, `evidenceStrength`, `progressionStalled`, `recommendedChange` | The engine's actual output — see above. |
| `createdAt` | When evaluated. |
| `appliedAt: Date \| null` | **Recommendation != applied adaptation** (`CLAUDE.md`) — null until something (a mode's auto-apply, or an athlete/coach action) actually turns this into a new `PlannedSet` value. Never implied by `decisionType` alone. |
| `supersededByDecisionId: string \| null` | Set when a later decision is produced after this one's evidence changed (§22) — the old record is never deleted or mutated, only marked superseded. |

**Table name (proposed, not created):** `app.progression_decisions` —
domain-specific, not a generic shared `engine_decisions` table (matches
`CLAUDE.md`'s "no generic ... framework" convention; a future deload
decision type would get its own table when that engine is actually
built, not a shared polymorphic one now).

## 19. Determinism and engine versioning

**Locked principle, reused unmodified** (`CLAUDE.md`): "same input + same
engine/policy version = same output, always." This spec adds nothing new
to that contract — it only specifies what "same input" must mean for
progression specifically:

- The exact `(performedSetId, revision)` pairs referenced in
  `evidenceExposureRefs` (§18), plus the exact prescription target
  evaluated, together fully determine the output. **Current live DB
  state is never the input** — only the snapshot a decision was actually
  computed from.
- If a referenced `PerformedSet` is later corrected (a new `revision`),
  re-running the same decision function against the *old* snapshot still
  produces the *same* answer — determinism is about the snapshot, not
  about "the truth changing" (which is expected and handled by
  superseding, §22, not by breaking determinism).
- **Engine versioning** reuses `EngineVersion { engine: string; policy:
  string }` and `formatEngineVersion`/`engineVersionsEqual`
  (`packages/training-engine/src/engine-version.ts`) completely
  unmodified. A behavior change that could alter output for existing
  input requires a `policy` (or `engine`) bump — never an in-place
  mutation of what an existing version means. This is exactly how
  `packages/training-engine`'s bootstrap test
  (`index.test.ts`'s `echoPolicy`) already demonstrates the contract; the
  progression policy is simply the first *real* policy to use it.
- **No event sourcing.** A small, explicit, snapshot-referencing decision
  record (§18) is sufficient to answer "why did Vostivo recommend this on
  this date" — replaying an event log is not needed and is explicitly
  against `CLAUDE.md`'s "no event sourcing" convention.

## 20. Applying a progression — workflow, the first-implementation boundary, and long-term mode/authority semantics

### 20.1 First-implementation boundary — locked by tech-lead resolution (OD-4)

**The first Progression Engine implementation stops at persistence.** It
must **not** mutate `ProgramVersion`, `PlannedSet`, or any other future
Plan state automatically — not in any mode, including `GUIDED`.

```text
performance evidence (§9-§12)
  -> pure evaluateProgression() call (§29)
  -> persist a traceable EngineDecision (§18), appliedAt = null
  -> STOP
```

Recommendation != applied adaptation (`CLAUDE.md`) — the first
implementation produces and stores the decision and nothing more. A
**separate, later "Progression Application V1" specification** (§31,
slice D) must reconcile *how* a recommendation becomes a real prescription
change with the existing immutable/effectively-immutable `ProgramVersion`
architecture (ADR-0008: a `ProgramVersion` is effectively immutable once
`ACTIVE`; a structural change creates a new version, it does not mutate
the current one in place). This spec does not decide that mechanism now.

### 20.2 Plan immutability — explicit clarification

- The current Progression Engine implementation (this spec's scope) may
  **not** mutate an existing `ACTIVE` `ProgramVersion` in place, for any
  reason, in any mode.
- Historical `PrescribedSetV1` snapshots and `PerformedSet` reality remain
  immutable **except** through their already-approved revision/correction
  semantics (ADR-0007's reopen→recomplete flow, §22 of this document) —
  Progression Engine introduces no new way to alter either.
- Everything below this point in §20 (the `GUIDED`/`ADAPTIVE`/`EXPERT`/
  `COACHED` table) describes **long-term target authority semantics**,
  useful for designing the eventual Progression Application V1 slice —
  **none of it is implemented by the first Progression Engine slice**,
  which only ever reaches the `STOP` in §20.1.

### 20.3 Long-term mode/authority semantics (not implemented yet — target design only)

The **algorithm is identical** across modes — only who sees/approves/
applies differs, per the task's explicit instruction ("who
sees/approves/overrides more than different physiology"):

| Mode | Long-term target behavior (Progression Application V1, not this slice) |
| --- | --- |
| `GUIDED` | Bounded routine progression may auto-apply **once the application mechanism is implemented and safe** (a real Load Resolver, a defined `ProgramVersion`-update mechanism, both still future work). |
| `ADAPTIVE` | An actual `INCREASE_LOAD` recommendation is reviewable — the review UX itself is **not designed here**, only the fact that a reviewable recommendation must exist as data before it's applied. |
| `EXPERT` | Engine recommendation is visible, but application remains under explicit athlete control by default. |
| `COACHED` (overlay, per `CLAUDE.md`'s future `CoachingRelationship`) | Engine recommendation remains available, but coach authority/override takes precedence by default. |

No new approval UX is invented in this task — only the authority
semantics a future Progression Application V1 slice will need to
respect. This table is carried forward unresolved-in-detail into that
future spec, not decided here.

## 21. Coach override future compatibility

`EngineDecision` already carries what a future audit needs without any
Coach Web implementation: `decisionId`, `decisionType`/`reasonCode`
(what the engine recommended), `appliedAt` (whether/when it was actually
applied), and room for a future `overriddenBy`/`overrideReason` pair to
be added **additively** later (not designed now — the point is only that
nothing here prevents it). "Engine recommended X, coach chose Y" is
representable without inventing Coach Web today.

## 22. Reopened / edited sets

The engine reads the **latest canonical** `PerformedSet` state at
evaluation time (never a cached/stale copy). Each `EngineDecision`
records exactly which `(performedSetId, revision)` pairs it evaluated
(§18). If a referenced set is later reopened and recompleted with
different values:

- The **old** decision is never silently mutated or deleted — it remains
  the accurate historical record of what was recommended and why, given
  what was known then.
- The **next natural evaluation trigger** for that exercise (its next
  performance, not a real-time invalidation listener — "smallest
  necessary change," no new background job) produces a **fresh**
  decision from current evidence and marks the old one
  `supersededByDecisionId`.

An old recommendation is never left silently authoritative forever, but
V1 does not need real-time recomputation to guarantee that.

## 23. Out-of-order logging

Active Workout intentionally allows logging sets out of timestamp order.
Evidence selection uses **canonical `prescriptionSetId`/`order` identity,
never `completedAt` ordering** — the same discipline the sync protocol
already uses for revision conflicts (never timestamps). This is stated
explicitly so a future implementer does not accidentally sort evidence by
wall-clock time.

## 24. Exercise order context

Handled as a comparability-tier factor (§10), not a hard exclusion:
matching order → `COMPARABLE`; a changed order → `COMPARABLE_WITH_CONTEXT`
(caps strength at `SUPPORTED`). This avoids overfitting to exact session
structure while still not pretending "bench press first" and "bench press
third" are guaranteed-identical performance conditions.

## 25. Exercise identity

`exerciseRef` (`ExerciseIdentityV1`, an opaque string) is **sufficient
for V1** as long as the existing authoring convention holds: one ref per
truly distinct movement+equipment variant (confirmed in the real seed
fixture — `"bench-press"` and `"incline-dumbbell-press"` are already
distinct refs for distinct movements). Nothing in today's domain model
would stop an author from carelessly reusing one ref for Barbell Bench
and Dumbbell Bench, since no Exercise Taxonomy or equipment-binding
exists yet — this spec does **not** build that taxonomy, but flags the
convention explicitly: **exerciseRef must remain equipment-variant-
specific until a real Exercise Taxonomy exists.** A future
`ExerciseFamily`/role-aware-substitution model is out of scope here.

**Real prerequisite gap found by inspecting the actual server code**
(not assumed): `exerciseRef` exists server-side **only** opaquely inside
each session's immutable `prescription_snapshot` JSONB blob
(`app.workout_sessions`) — `app.performed_exercises` has **no**
`exercise_ref` column, and `CompleteSetCommandV1` does not carry
`exerciseRef` as a denormalized field (only
`exerciseDisplayName`/`exerciseOrder` are denormalized onto it today).
`docs/architecture/ACTIVE-WORKOUT.md` states this was a **deliberate**
scoping decision for Active Workout Core Logger V1: exerciseRef was added
to mobile's **local** SQLite only, explicitly "never synced to the
server... not part of the WDI wire contract" — because that slice only
needed single-device "Previous performance."

**Consequence**: efficient server-side cross-session comparable-exposure
lookup — the operation Progression Engine performs constantly — is not
possible today without either (a) unpacking every session's JSONB
snapshot per query (inefficient, unindexed), or (b) extending
`CompleteSetCommandV1` and `app.performed_exercises` with a synced,
queryable `exerciseRef`, mirroring exactly what mobile's local schema
already does. This is **additive to the wire contract** (the same kind of
safe addition ADR-0007 already anticipated for `sessionSeq`), but it does
revise a previously-stated scoping boundary in `ACTIVE-WORKOUT.md` — per
`CLAUDE.md`'s mandatory conflict-reporting rule, this is flagged, not
silently assumed. **See OD-1 (§30): approved as proposed.**

## 26. Program role

No role vocabulary exists in the approved domain model
(`PlannedExercise.role` was explicitly deferred in
`docs/architecture/PLAN-PRESCRIPTION.md`). **Progression Engine V1 does
not use program role as an input at all** — every exercise is evaluated
uniformly. A future `PlannedExercise.role` (e.g.
`PRIMARY`/`ACCESSORY`/`MAINTENANCE`) enabling role-aware progression
aggressiveness is a deferred enhancement, not designed here (inventing an
unapproved taxonomy now would violate the same "no silent decisions"
principle this spec is trying to model).

**Extensibility (tech-lead resolution, OD-7):** nothing in §29's pure
input model or the `EngineVersion`/policy versioning scheme (§19)
prevents a **future policy version** from accepting an additional,
optional role input alongside the exact same evidence/decision
vocabulary — a role-aware policy would simply be `{ engine:
"progression", policy: "v2" }` (or later) consuming a wider
`ProgressionEvaluationInput`, never a breaking change to V1's shape or
decisions. This confirms the architecture stays extensible without
requiring a role model to be built now.

## 27. Rep targets and records/PRs

Rep targets are covered fully in §12.1 (`RANGE`) and §12.2 (`EXACT`). No
silent conversion of a `RANGE` back to a single integer anywhere in this
design — the engine consumes `RepTargetV1` directly, matching the Plan
Contract Integrity Fix Pass's "exactly one authoritative rep-target
field, never a lossy collapse" discipline.

**Records/PRs are explicitly not the progression algorithm.** A new 1RM
estimate, tonnage record, or single-set rep PR may be genuinely
interesting **Progress-tab** evidence, but a PR does not, by itself,
trigger `INCREASE_LOAD` — only the full evidence-window rule (§12) does.
One exceptional set is not different, for progression purposes, from any
other single comparable exposure (§11's "one bad exposure" symmetry
applies equally to one *great* exposure).

## 28. Load change limits — LOCKED (tech-lead resolution, unchanged from the draft)

- **Maximum one Load-Resolver-determined increment per progression
  event** — never a multi-step jump from one exceptional session.
- No percentage-based logic (Load Model V1 keeps this explicitly out of
  scope too).
- The engine itself never computes or guesses an increment — it only
  ever says "increase" (§14). The **application layer**, after calling
  the (future) Load Resolver, downgrades to `MAINTAIN_LOAD_BUILD_REPS`
  with reason `NO_SUITABLE_LOAD_INCREMENT` if no valid increment exists
  (§17.1) — the engine can never end up recommending a physically
  impossible load, by construction, because it never sees equipment
  feasibility at all.

## 29. Training Engine package boundary and pure input model

`packages/training-engine` **depends only on `packages/domain`, never a
framework or vendor SDK** — enforced by `pnpm boundaries:check`
(`docs/architecture/FOUNDATION.md`), not merely documented. This is
unchanged by this spec; progression is implemented **within** that
existing constraint, not as an exception to it.

**Proposed location**: `packages/training-engine/src/progression/` (new
subfolder). **Public boundary**: reuse the existing `EnginePolicy<Input,
Kind, Data>` contract exactly —

```ts
const progressionPolicyV1: EnginePolicy<
  ProgressionEvaluationInput,
  "progression",
  ProgressionDecisionDataV1
> = {
  version: { engine: "progression", policy: "v1" },
  decide(input) { /* §12's rules, pure, no I/O */ },
};
```

**`ProgressionEvaluationInput` is fully normalized** — the current
prescription's target (`RepTargetV1`, `ExternalWeightLoad`, `setType`),
and a pre-classified, pre-bounded list of comparable exposures (each
already tagged `COMPARABLE`/`COMPARABLE_WITH_CONTEXT` per §10, already
filtered to `setType === "WORKING"` per §5.6, already limited to the
evidence window per §11). **The engine never queries anything itself.**

**Assembling that input — querying Postgres, classifying comparability,
bounding the window, filtering by set type — is an application-layer job**
(`apps/api`, alongside the existing canonical-Postgres access in
`apps/api/src/workout/workout-command-processing.ts`, since training
history is server-canonical per `CLAUDE.md` — not `apps/mobile`'s local
SQLite, which is explicitly single-device). This is not a new pattern:
`packages/domain/src/plan/prescription-builder.ts`'s
`createWorkoutPrescriptionFromPlannedWorkout` is already pure and already
consumes pre-fetched rows rather than querying live — progression's
assembly/pure-engine split follows the exact same, already-proven shape.

**Expected query shape** — the last **N** `WORKING` `PerformedSet` rows
for a given athlete + `exerciseRef`, ordered by canonical prescription
identity/order — not the athlete's entire training history. **Implementation
correction (Progression Prerequisites V1, 2026-09-09):** ownership for
workout execution history is actually `app.workout_sessions.user_id`, not
`athleteProfileId` — every existing WDI command handler already keys BOLA
checks on `userId` (`workout-command-processing.ts`), never
`athleteProfileId` (which owns the separate Plan/Program hierarchy only).
`WorkoutHistoryService.getRecentWorkingExposures()`
(`apps/api/src/workout/workout-history.service.ts`) is keyed on `userId`
accordingly — this is additive clarification found by inspecting the real
schema, not a reopened decision. This is bounded and cheap **once
`exerciseRef` is a real, indexed column on `app.performed_exercises`**
(§25, OD-1 — implemented, with real EXPLAIN ANALYZE before/after evidence
justifying the index, not added speculatively) — without that
prerequisite, the equivalent query would
require scanning JSONB snapshots across all of an athlete's sessions,
which does not scale and is explicitly not proposed here.

## 30. Resolved tech-lead decisions (supersedes the draft's "Open tech-lead decisions")

Every decision below was reviewed and resolved by the tech lead. The
core architecture and progression model are **approved**. This section
is a record of what was decided and, where relevant, what changed from
the original draft — it is not a re-opening of the questions.

### OD-1: `exerciseRef` — RESOLVED: APPROVED AS PROPOSED

`exerciseRef` becomes synchronized, queryable canonical server workout
reality (§25 — `app.performed_exercises.exercise_ref`,
`CompleteSetCommandV1.exerciseRef`). Progression Engine V1 compares the
**exact same** `exerciseRef` only — no fuzzy matching.

**Explicitly not required as a prerequisite** (confirmed, not
introduced): `ExerciseFamily`, exercise-substitution equivalence, muscle
taxonomy, or movement taxonomy. None of those are needed for §25's exact-
match comparison, and none are added by this spec.

**Index policy**: the later implementation must provide an efficient
server-side query path for `athleteProfileId + exerciseRef` (§29's
expected query shape), and must prove any new index requirement from the
**actual** query shape at implementation time — no index is speculated or
added in this specification task (§29 already states this; reaffirmed
here as resolved, not merely proposed).

### OD-2: RIR — RESOLVED: APPROVED AS PROPOSED

RIR is **optional** for Progression Engine V1 (§9.3, §15). The engine is
fully deterministic without it. When RIR is absent: effort is never
fabricated, progression evaluation is still permitted, and evidence
strength never exceeds `SUPPORTED` (§17.3). RIR remains an important
follow-up product/domain slice — not implemented now.

### OD-3: Set type / warm-up migration — RESOLVED: APPROVED WITH MODIFICATION

V1-real set types are exactly `WORKING` and `WARM_UP` — **spelling
corrected from the draft's `WARMUP` to `WARM_UP`** throughout this
document (§5, see the naming-reconciliation note in §3).

Existing historical `PlannedSet`/prescription/`PerformedSet` data is
safely classified as `WORKING`, because the currently-implemented product
had no warm-up-logging capability at all when that data was created.

**Modification from the draft**: nullable `setType` with `null =
WORKING` as a steady-state model is **rejected**. §5.2/§5.2.1 now specify
one representation only — `setType` is `NOT NULL` everywhere it's
persisted, defaulted to `WORKING` explicitly at write time (never
inferred from absence at read time), with the required migration order:
(1) backfill existing data to `WORKING`, (2) constrain to `NOT NULL`,
(3) domain/contracts type it as non-nullable `SetTypeV1`, (4) every new
write carries an explicit value.

Warm-up sets remain real workout history, use the existing
local-first/offline/revision/outbox path unchanged (§5.3-§5.5), are
structurally excluded from ordinary Progression Engine evidence (§5.6),
and can later be changed through the existing reopen/recomplete edit
semantics (§5.3) — no second logging system. General warm-up content and
warm-up generation are **not** implemented by this task (§6, §7 — see
also the Warm-up Product Roadmap Note below).

### OD-4: Mode / authority — RESOLVED: APPROVED WITH AN IMPLEMENTATION BOUNDARY

Long-term target authority semantics (§20.3) are confirmed as originally
proposed: `GUIDED` may eventually auto-apply once the application
mechanism is safe; `ADAPTIVE` reviews an `INCREASE_LOAD` recommendation;
`EXPERT` keeps application under explicit athlete control by default;
`COACHED` gives coach authority precedence by default.

**The binding constraint for the first implementation** (§20.1, §20.2):
it must **not** mutate `ProgramVersion`, `PlannedSet`, or any future Plan
state automatically, in any mode. The workflow stops at persisting a
traceable `EngineDecision` (§18) with `appliedAt = null`. A separate,
later **Progression Application V1** specification (§31, slice D) must
reconcile application with the existing immutable/effectively-immutable
`ProgramVersion` architecture (ADR-0008) — not decided here. Historical
prescription snapshots and `PerformedSet` reality remain immutable except
through their already-approved revision/correction semantics (§22).

### OD-5: Evidence window — RESOLVED: APPROVED WITH CLARIFICATION

3 most recent comparable exposures remains the V1 bounded evidence
window (§11). **Clarified explicitly** (§11.1): this is **not** a
mandatory waiting period — a complete current exposure that
independently satisfies §12.1/§12.2's bar produces a bounded
`INCREASE_LOAD` (or `MAINTAIN_LOAD_BUILD_REPS`) recommendation even with
fewer than 3 (including zero) prior historical exposures, at
`SINGLE_EXPOSURE` evidence strength. The 3-exposure window's actual job
is trend interpretation, evidence-strength classification, single-session
noise protection, and `PROGRESSION_STALLED` detection — the last of which
genuinely does require the full window (§17.2). One unusual exposure must
never, by itself, create a stall/plateau signal.

### OD-6: Stalled signal — RESOLVED: APPROVED AS PROPOSED

`PROGRESSION_STALLED` is retained in V1 as deterministic evidence
metadata attached to `NO_CHANGE` (§17.2). It is explicitly **not** a
progression decision, not a deload, not a volume reduction, and not a
medical/fatigue diagnosis (§16, §27's safety language). It exists solely
as future input for a Fatigue/Adaptation Engine that does not yet exist.

### OD-7: Program role — RESOLVED: APPROVED AS PROPOSED

No program-role taxonomy is required for Progression Engine V1 (§26).
The V1 algorithm operates from exact `exerciseRef`, prescription
identity, `RepTargetV1`, working-set reality, load, and comparable
exposure context alone — no role taxonomy is invented now. The
architecture remains extensible: a future policy version can accept
program role as an additional input without changing V1's shape or
decisions (§26's extensibility note, §19's versioning contract).

### Decision vocabulary and load limit — RESOLVED: LOCKED, UNCHANGED

`NO_CHANGE` / `MAINTAIN_LOAD_BUILD_REPS` / `INCREASE_LOAD` remains the
complete V1 vocabulary (§13) — no `DELOAD`, `REDUCE_VOLUME`,
`CHANGE_EXERCISE`, or `PAIN_SWAP`. The load-change limit (§28) is
retained unchanged: maximum one Load-Resolver-determined increment per
progression event, no percentage-based logic, and no impossible load may
ever be prescribed when the Resolver reports no valid increment.

## 31. Implementation slices (sequencing — none started by this task)

The tech lead has approved the architecture; **none of the following
slices are implemented by this specification task.**

```text
A. Progression prerequisites
   - exerciseRef server synchronization/queryability (OD-1, §25)
   - explicit WORKING/WARM_UP setType through domain/contracts/storage/
     sync (OD-3, §5)
   - migration/backfill (§5.2.1, "Migration considerations" below)
   - minimum Load Resolver prerequisite (§14, Load Model V1 Stage 1)

B. Pure Progression Engine V1
   - normalized input (§29's ProgressionEvaluationInput)
   - deterministic policy (§12's rules, as an EnginePolicy, §19)
   - reason codes/evidence strength (§17)
   - comprehensive domain tests (§30's PROG-* test matrix)

C. EngineDecision persistence / application-layer evidence assembly
   - server canonical history (§29 — apps/api, not mobile-local SQLite)
   - bounded exposure query (§29's expected query shape)
   - decision persistence (§18 — app.progression_decisions)
   - superseding corrected evidence (§22)
   - NO Plan mutation yet (§20.1's STOP boundary)

D. Progression Application V1 — LATER, SEPARATE SPECIFICATION
   - future prescription mutation/ProgramVersion-update mechanism
   - mode/authority (§20.3's long-term target table, resolved-in-outline
     only, not in mechanism)
   - Guided auto-application
   - Adaptive/Expert/Coached behavior
```

Do not implement any of A-D as part of this or any other in-progress
task without explicit separate approval to begin that slice.

### Warm-up product roadmap note

The data model supports `WARM_UP` starting in slice A. Actual
athlete-facing warm-up UX and recommended exercise-specific warm-up
*generation* remain separate product/design work, not part of any
Progression Engine slice (§6). Progression Engine must be — and, by
construction, is — correct regardless of whether a `WARM_UP` set
originated from a future recommendation engine or from ordinary
manual/planned logging: it only ever inspects `setType`, never how a set
came to have that type. General pre-workout preparation (§7) remains
entirely separate from exercise-specific warm-up sets and is not
addressed by slice A.

## Slice C implementation evidence (Progression EngineDecision Persistence & Evidence Integration V1, 2026-09-22)

Slice B (Pure Progression Engine V1) closed unmodified — `progressionPolicyV1`'s
behavior was not changed by this slice, only invoked. This section records what
was actually built, not a new specification — slice A/B rules above are not
reopened.

**Table**: `app.progression_decisions` (`packages/database/src/schema/
progression.ts`) — a domain-specific table, not a generic
`engine_decisions` table (§21 of the implementation task). Ownership is
`userId` only, matching every other WDI table (`workout_sessions`,
`workout_command_receipts`) — no `athleteProfileId` column; nothing in
this slice needs Plan/Program ownership.

**Audit reproducibility (§19)**: `performed_sets` is upserted in place
(`workout-command-processing.ts`), so a corrected revision overwrites the
row a decision's evidence refs would otherwise point at — historical
revision values are NOT independently queryable. Every persisted decision
therefore carries the exact `normalizedInputSnapshot` (the literal
`ProgressionEvaluationInput` passed to `evaluateProgression()`) alongside
`evidenceRefs: {performedSetId, revisionEvaluated}[]` — the snapshot makes
"what exact evidence did progression/v1 see" answerable without depending
on mutable current set rows; the refs provide traceability back to
canonical source records. This is a small, bounded, domain-specific
document per decision, not event sourcing.

**Idempotency/audit identity (§25/§26)**: `evidenceFingerprint` is a
SHA-256 (Node's `crypto`, in `apps/api`, never inside
`packages/training-engine`) over a canonically-key-sorted serialization
tagged `fingerprintSchema: "progression-evaluation-v1"` (a distinct
application-identity version, never conflated with `progression/v1`'s
policy version — §9 of the identity-gate task) of `{engine, policy,
userId, sourceWorkoutSessionId, sourcePerformedExerciseId,
sourcePrescriptionExerciseId, normalizedInputSnapshot, evidenceRefs}`,
enforced by a real Postgres unique index.

**Corrected 2026-09-23 (Slice C identity gate)**: the original payload
hashed only `{engine, policy, userId, normalizedInputSnapshot}`.
`normalizedInputSnapshot` (`ProgressionEvaluationInput`) carries only
`prescriptionSetId`/`actualReps` *values*, never `performedSetId`,
`revision`, or source session/exercise identity (by design — the pure
engine doesn't need them). Two real gaps followed: (1) a revision-only
correction (reopen → recomplete with byte-identical `actualReps`/
`actualLoad`) produced the same fingerprint, so no new decision was
created despite a genuine new historical correction event; (2) two
structurally distinct source exposures with semantically identical
normalized values collapsed onto the same fingerprint. Both are closed by
hashing the full evaluation identity (source identity + every
`evidenceRefs` entry, sorted by `performedSetId` for a stable canonical
order) alongside the snapshot — `ProgressionEvaluationInput` itself is
unchanged; this is application-layer identity composition only. Proven by
dedicated fingerprint unit tests (cases A-D) and two new real-Postgres
integration tests (identity gate §6/§7) — idempotent/concurrent-identical
behavior (still one persisted row, DB-enforced) was re-verified unchanged.

**Supersession (§23/§24)** is scoped to the same source exposure
(`sourcePerformedExerciseId`) — a corrected set revision produces a new
decision with a different fingerprint; the previously-active decision for
that exact exposure is linked via `supersededByDecisionId` in the same
transaction, never rewritten. Cross-session supersession (a later
session's decision superseding an earlier session's, for the same
`exerciseRef`) is NOT implemented — nothing in the approved spec or the
Slice C task asked for that chain; "the latest decision for `userId` +
`exerciseRef`" remains an ordinary `ORDER BY createdAt DESC` query for
whichever future slice needs it.

**Evidence assembly (§7/§8/§10/§13/§14)**: `ProgressionEvaluationService`
(originally `apps/api/src/workout/progression-evaluation.service.ts`; moved
unmodified to `packages/progression-application/src/progression-evaluation.service.ts`
by the Orchestration V1 shared-runtime extraction below) anchors to one
exact `(workoutSessionId, performedExerciseId)` pair, requires the source
session to be `COMPLETED`, and reconstructs the immutable prescription
context that governed it from that session's own `prescription_snapshot`
— never today's live Plan. Comparability classification (now
`packages/progression-application/src/progression-evidence.ts`)
implements exactly §10.1's
three deterministic factors (exact target match, exercise order, prescribed
working-set count, unmatched/extra sets) — no equipment/gym-change signal
exists in V1, so it is never a factor (§10.2's documented gap, unchanged).
`WorkoutHistoryService.getRecentWorkingExposures()` (Slice A) is reused
unmodified apart from one additive field
(`prescriptionExerciseId`) needed to look up each historical exposure's
own governing snapshot.

One real edge case, resolved conservatively rather than guessed: `PlannedSet`/
`PrescribedSetV1.targetReps`/`targetLoad` are technically per-SET, but the
engine's `ProgressionPrescriptionContextV1` needs one uniform target per
exercise slot. Every prescription this project actually authors uses a
uniform target across an exercise's working sets; if a real prescription
were ever heterogeneous, `reconstructPrescriptionContext()` returns `null`
(cannot deterministically reconstruct) rather than averaging or picking a
value — for the anchor this aborts evaluation (`NO_PRESCRIPTION_CONTEXT`);
for a historical candidate it simply excludes that one exposure.

**Orchestration (§28)**: at Slice C's own close, deliberately NOT wired to
any automatic trigger — no FINISH-path integration, no job queue.
`ProgressionEvaluationService` was proven correct end-to-end by direct
real-Postgres integration tests only, called directly, never in the
request path. **This is now superseded — see "Progression Evaluation
Orchestration V1 implementation evidence" below, which wires the real
durable trigger this section originally deferred.**

**No public endpoint (§37)**: no controller exists for this service,
matching `WorkoutHistoryService`'s own precedent exactly.

**BOLA (§9/§38)**: ownership is re-derived from the real
`workout_sessions.user_id` for every evaluation call — never trusted from
the caller beyond `AuthenticatedActor.userId`. A mismatched or
nonexistent anchor reports identically (`SOURCE_NOT_FOUND`), never
distinguishing "exists but isn't yours."

## Progression Evaluation Orchestration V1 implementation evidence (2026-09-23)

Closes the gap Slice C's "Orchestration (§28)" section deliberately left
open. Slices A/B/C are not reopened — `evaluateProgression()`,
`ProgressionEvaluationService.evaluateAndPersist()`, and the
`progression_decisions` persistence/idempotency/supersession behavior are
all unchanged; this section wires a durable, asynchronous trigger to code
already proven correct, and reuses that exact code, never reimplements it.

**Installed queue stack**: `pg-boss@12.32.0` (deliberately pinned one patch
behind latest `12.33.6`, published the same day this task started — a
same-day-fresh package tripped pnpm's `minimumReleaseAgeExclude`
supply-chain policy; re-pinned to the 9-day-old `12.32.0` instead of
accepting the bypass). Verified, not assumed: its first-party Drizzle
adapter (`fromDrizzle(tx, sql)`, `pg-boss/dist/adapters/drizzle.js`)
genuinely participates in an existing `drizzle-orm` transaction when passed
as the per-call `db` option to `.send()` — proven empirically against real
Postgres (commit → job visible; rollback → job absent) before any
production code was written, and again as a permanent test
(`packages/progression-application/src/progression-queue.integration.test.ts`).

**Durable trigger / transactional enqueue**: `enqueueProgressionEvaluateSession()`
(`packages/progression-application/src/progression-queue.ts`) is called
from inside `workout-command-processing.ts`'s existing `db.transaction(...)`
block, using the SAME `tx` the canonical mutation, the command receipt, and
the change-cursor row already commit through — never a second connection,
never a post-commit `.send()`. The job either commits atomically with the
mutation or never exists at all.

**Trigger events** (exactly, not "on every command"):
- `FINISH_WORKOUT_SESSION_V1`'s genuine `ACTIVE` → `COMPLETED` transition
  (never a no-op duplicate FINISH against an already-`COMPLETED` session —
  the Finish watermark, and the job, are each established exactly once).
- `COMPLETE_SET_V1` / `REOPEN_SET_V1` applied (`outcome === "APPLIED"`)
  against a session that is ALREADY `COMPLETED` — the Finish causal
  boundary's own "late-but-causally-valid correction" allowance
  (`sessionSeq <= finishSeq`, ADR-0007). A mutation against a still-`ACTIVE`
  session never enqueues — the whole session is evaluated once, at FINISH,
  covering every exercise, not per completed set while still in progress.
- A `REJECTED`/`STALE` outcome, or a rejected post-Finish mutation attempt
  (`sessionSeq` beyond `finishSeq`), never enqueues.

Proven directly (not just "no exception was thrown") by
`apps/api/src/workout/workout-sync.integration.test.ts`'s "Progression
Evaluation Orchestration V1" describe block — real Postgres + real pg-boss,
asserting the exact job count and payload for each of the above cases,
including a genuinely-BOLA-rejected FINISH and a duplicate-commandId
replay.

**Job model**: one queue, `progression-evaluate-session-v1`
(`PROGRESSION_EVALUATE_SESSION_QUEUE_V1`), session-level granularity — one
job per triggering event, payload `{workoutSessionId, triggerCommandId}`
(`progressionEvaluateSessionJobPayloadV1Schema`, zod-validated on both ends).
Deliberately minimal and non-sensitive: no `userId`, no evidence snapshot —
a job payload is not a trusted caller any more than an HTTP request body
would be (§9/§38's BOLA discipline extended to the queue). The worker
enumerates every performed exercise for the session itself, rather than
the producer needing to know which exercises are progression-eligible
(that classification already lives entirely inside
`ProgressionEvaluationService` — duplicating it at the enqueue site would
be a second, driftable copy of engine-adjacent logic).

**Worker execution**: `apps/worker/src/progression-evaluate-session.job.ts`
is the ONLY place in this codebase that calls
`ProgressionEvaluationService.evaluateAndPersist` — the athlete-facing
workout logging path in `apps/api` never evaluates progression inline,
exactly as Slice C's own "Orchestration" section required stay true. On
each job: re-reads the canonical `workout_sessions` row (never trusts the
payload for `userId` or session state), confirms `COMPLETED`, loads every
`performed_exercises` row for the session in stable `orderIndex` order, and
calls `evaluateAndPersist({userId: session.userId}, {workoutSessionId,
performedExerciseId})` once per exercise. A `SOURCE_NOT_FOUND`/
`SOURCE_SESSION_NOT_COMPLETED` result (should be structurally impossible,
since the job is only ever enqueued for a session just observed
`COMPLETED`) and an `ENGINE_VALIDATION_FAILED` result are logged and
skipped — never retried (identical evidence reproduces the identical
result) and never fail the whole job (each exercise is independent).

**Shared runtime boundary**: `ProgressionEvaluationService`,
`WorkoutHistoryService`, `progression-evidence.ts`, and
`progression-fingerprint.ts` moved, unmodified in behavior, from
`apps/api/src/workout/` to the new package
`packages/progression-application` — the "small extraction into an
appropriate shared server-side application module" the orchestration task
anticipated once a second runtime consumer (`apps/worker`) genuinely
existed.

**Framework-boundary cleanup (2026-09-23, follow-up gate)**: an initial
version of this extraction kept the two classes' original `@Injectable()`/
`@Inject()` NestJS decorators and had the package eagerly import
`reflect-metadata` so either runtime could construct them. A tech-lead
review correctly rejected this as unnecessary framework coupling — "worker
does not use the Nest container" is not the same as "this package has no
Nest dependency." Both decorators, the `PROGRESSION_DATABASE` DI token they
existed solely to support, `@nestjs/common`, and `reflect-metadata` were
all removed. `packages/progression-application` is now genuinely
framework-agnostic server application logic: plain classes with explicit
constructor dependencies (`constructor(private readonly db: Database)`,
`constructor(private readonly db: Database, private readonly
workoutHistoryService: WorkoutHistoryService)`), no decorators, no
metadata-reflection requirement of any kind. `apps/worker` constructs them
directly with `new`, unchanged. `apps/api`'s `WorkoutModule` is the ONE
place that adapts them into Nest DI, via an explicit `useFactory` provider
per class (`{ provide: WorkoutHistoryService, useFactory: (db) => new
WorkoutHistoryService(db), inject: [DATABASE] }`, and equivalently for
`ProgressionEvaluationService`) — the same `useFactory` pattern this
codebase already used for `AUTH_TOKEN_VERIFIER`. Verified, not assumed: a
full dependency-cruiser reachability scan of every resolved module
`packages/progression-application` imports (transitively, through
`@vostivo/database`/`@vostivo/domain`/`@vostivo/training-engine` too)
contains zero `@nestjs/*` modules and zero `apps/api`/`apps/worker` paths —
enforced by two new `dependency-cruiser` rules
(`progression-application-must-not-depend-on-nestjs`,
`progression-application-must-not-depend-on-apps`), alongside the
pre-existing `worker-must-not-depend-on-api`.

**Queue job identity clarification**: `triggerCommandId` in the job payload
is carried for observability/audit correlation ONLY — it is never used as a
pg-boss job id, `singletonKey`, or any other deduplication key.
`enqueueProgressionEvaluateSession()` calls a plain `.send()` with no
identity/throttle options, so a session that receives two genuine triggers
in quick succession (e.g. FINISH followed immediately by a late correction)
legitimately gets two separate job rows — this is intentional, not an
oversight: correctness never depends on queue-level deduplication, only on
Slice C's DB-unique-constraint-enforced `evidenceFingerprint`, which is
what actually makes redundant/duplicate evaluation attempts converge to one
persisted decision. No permanent per-session singleton exists or is
planned — a session must remain able to receive further correction-
triggered jobs for as long as late corrections remain causally valid.

**Retry / crash behavior**: the queue's retry policy
(`PROGRESSION_EVALUATE_SESSION_QUEUE_OPTIONS`) is 8 retries with
exponential backoff (capped at 5 minutes) and a 5-minute `expireInSeconds`,
configured once on the queue itself (idempotently re-asserted at both the
API producer's and the worker's own startup, and permanently by
`packages/database/src/bootstrap-pgboss.ts`) — not repeated per `.send()`
call. A worker crash mid-job leaves the job `active` until
`expireInSeconds` elapses, then pg-boss retries it; a retried (or
duplicated) job re-derives everything fresh from canonical Postgres state
and calls the same idempotent `evaluateAndPersist` (DB-enforced
`evidenceFingerprint` uniqueness) — safe to run twice, proven by a
dedicated real-Postgres idempotency test
(`apps/worker/src/progression-evaluate-session.job.integration.test.ts`).
Retries exhausted → the job moves to `progression-evaluate-session-v1-dlq`
(dead letter); no automatic dead-letter reprocessing exists (explicitly out
of this task's scope).

**Queue database privileges**: `packages/database/src/bootstrap-pgboss.ts`
mirrors `bootstrap-roles.ts`'s shape exactly — pg-boss's own real DDL
migration (`new PgBoss({migrate: true}).start()`), run once by the
admin/migration role, then a DML-only grant (`SELECT`/`INSERT`/`UPDATE`/
`DELETE` on tables, `USAGE`/`SELECT` on sequences, `EXECUTE` on pg-boss's
helper functions, plus matching `ALTER DEFAULT PRIVILEGES` for a future
pg-boss version's new objects) to the same least-privilege `vostivo_api`
role every other runtime connection already uses — never any
CREATE/DROP/ALTER privilege. Both `apps/api`'s producer and
`apps/worker`'s consumer connect as `vostivo_api`.

**Late correction behavior**: a reopen → recomplete cycle delivered AFTER
FINISH (still causally valid per `sessionSeq <= finishSeq`) enqueues its
own re-evaluation job independently of the original FINISH-triggered one —
proven directly, including the case where a `REOPEN_SET_V1` alone (no
recomplete ever arriving) still schedules re-evaluation, since the athlete
may only have meant to reopen a set, not necessarily recomplete it.

**Not implemented / explicitly out of scope for this task**: Progression
Application V1 (no `PlannedSet`/`ProgramVersion` mutation, `appliedAt`
still always `null`), a public progression HTTP endpoint, dead-letter
reprocessing, RIR, warm-up UX, fatigue/adaptation, deload, and coach
workflow — unchanged from Slice C's own boundary.

## Migration considerations

**Implementation status (corrected 2026-09-23 — Slice C identity gate):**
this section originally opened with "No DB migration is created by this
task," written when this whole document was specification-only. That
sentence is now false and is corrected here rather than left
contradicting the real implemented state: migrations 0006-0008 (Slice A —
`setType`, `exercise_ref`) and **migration 0009 (Slice C —
`app.progression_decisions`, a pure `CREATE TABLE`, no existing data
touched, non-destructive)** all exist and are applied. Both the current
dev DB and a fresh-DB migration chain (0000→0009) were proven for
migration 0009 — see "Slice C implementation evidence" above for the
full detail; this paragraph exists only so this section stops
contradicting it. The bullets below remain an accurate historical record
of the Slice A migration reasoning at spec-writing time, already
corrected in place once (see the "Implementation correction" callouts
inline) — they are not re-litigated here.

- `PerformedSet.setType` and `PlannedSet.setType` both become `NOT NULL`
  (§5.2, §5.2.1 — the tech-lead resolution rejects a nullable
  transitional state) — every existing row on both tables needs a
  backfill value. **OD-3 resolves this to `WORKING`** (see §30) as the
  only value defensible from actual historical logging behavior; this is
  evaluated explicitly, not assumed.
- `app.performed_exercises.exercise_ref` (OD-1) would be `NULL`-backfilled
  for historical rows (consistent with the existing "no reliable
  cross-session identity" `null` semantics `ExerciseIdentityV1` already
  defines) — never fabricated from a display-name guess.

  **Implementation correction (Exercise Ref Legacy Reconciliation,
  2026-09-09):** this projection was superseded. `null`-backfill was never
  actually needed — 13/14 pre-existing rows recovered an exact
  `exerciseRef` from their own session's immutable `prescription_snapshot`
  (Progression Prerequisites V1). The 1 row that could not be recovered
  (its own snapshot already had a null ref) was investigated and found to
  be conclusively synthetic native-verification fixture data — a
  throwaway single-session test identity with zero real command receipts
  — and was removed as a one-off dev-data cleanup, not backfilled to
  null. `app.performed_exercises.exercise_ref` is therefore `NOT NULL`
  end-to-end (domain, contract, DTO completeness check, Postgres schema):
  canonical server workout reality never carries a permanent "unknown
  exercise" identity. This does not change OD-1's outcome (still exact
  `exerciseRef` matching only, no fuzzy fallback) — it only means the
  nullable steady state this note anticipated was avoided rather than
  shipped.

## Test matrix (implementation-time reference)

Grouped by domain invariant, not exhaustively enumerated per input
combination — the task explicitly asks to focus on decision boundaries,
not generate hundreds of redundant cases.

| # | Case | Expected |
| --- | --- | --- |
| PROG-001 | No comparable exposures at all | `NO_CHANGE` / `INSUFFICIENT_EVIDENCE` / `INSUFFICIENT` |
| PROG-002 | Exactly one comparable exposure, top of range met | `INCREASE_LOAD` / `TOP_OF_RANGE_ACHIEVED` / `SINGLE_EXPOSURE` — **corrected 2026-09-22** (Pure Progression Engine V1 reconciliation): this row previously read `NO_CHANGE`/`SINGLE_EXPOSURE_ONLY`, which directly contradicted §11.1, OD-5, and Worked Example 11 (all three: a single qualifying exposure independently satisfies the bar regardless of prior history). The row was stale pre-resolution text; §11.1/OD-5/Worked Example 11 govern, and the implemented policy already matches them. |
| PROG-003 | Same load, reps increasing across window, not yet at top | `MAINTAIN_LOAD_BUILD_REPS` / `REPS_PROGRESSING` |
| PROG-004 | All working sets reach top of `RANGE` this exposure, window supports it | `INCREASE_LOAD` / `TOP_OF_RANGE_ACHIEVED` |
| PROG-005 | Uneven sets (e.g. 12/11/9 vs 8–12) | `MAINTAIN_LOAD_BUILD_REPS` / `REPS_PROGRESSING`, never `INCREASE_LOAD` |
| PROG-006 | One bad exposure only | `NO_CHANGE` / `PERFORMANCE_REGRESSED_SINGLE_EXPOSURE` |
| PROG-007 | Regression across all 3 window exposures | `NO_CHANGE` + `progressionStalled: true` |
| PROG-008 | Partial workout (some prescribed sets skipped) | Evidence capped, never `STRONG`; `NO_CHANGE` if zero working sets |
| PROG-009 | Warm-up set present alongside working sets | Warm-up excluded entirely from evidence |
| PROG-010 | Mixed warm-up + working, working sets alone meet the bar | `INCREASE_LOAD` (warm-up presence has zero effect) |
| PROG-011 | A referenced set is later reopened/corrected | Old decision unchanged; next evaluation supersedes it (§22) |
| PROG-012 | Sets logged out of timestamp order | Evidence keyed by prescription identity, unaffected by log order |
| PROG-013 | `RANGE` target evaluation | Per §12.1 |
| PROG-014 | `EXACT` target evaluation | Per §12.2 — never `MAINTAIN_LOAD_BUILD_REPS` |
| PROG-015 | Different `exerciseRef` in history | `NOT_COMPARABLE`, excluded |
| PROG-016 | Exercise order changed since last exposure | `COMPARABLE_WITH_CONTEXT`, strength capped at `SUPPORTED` |
| PROG-017 | A valid load increment exists (application-layer Resolver call) | `INCREASE_LOAD` carries direction only; Resolver produces the real value downstream |
| PROG-018 | No valid load increment exists | Downgraded to `MAINTAIN_LOAD_BUILD_REPS` / `NO_SUITABLE_LOAD_INCREMENT` (application layer) |
| PROG-019 | `LB` history vs. `KG` current target | `NOT_COMPARABLE` unless a deterministic conversion+equipment-context rule exists (none in V1 — excluded, not guessed) |
| PROG-020 | `PER_IMPLEMENT` load exposure history | Compared per-implement, never summed (LOAD-INV-005, unchanged) |
| PROG-021 | RIR missing throughout | Evidence strength never exceeds `SUPPORTED` |
| PROG-022 | RIR present and corroborating in all 3 exposures | Evidence can reach `STRONG` |
| PROG-023 | Same input, same engine/policy version evaluated twice | Byte-identical `EngineDecision` (§19) |
| PROG-024 | Engine/policy version bumped | New decisions may differ; historical decisions remain interpretable via their stored `engineVersion` |
| PROG-025 | Prescription changed since last exposure | Evidence window resets, `PRESCRIPTION_CHANGED_RESET` |
| PROG-026 | Extra (unplanned) set logged | Excluded from evidence, still retained as history |
| PROG-027 | Repeated regression across the window | `NO_CHANGE` + `progressionStalled: true`, never a deload decision (§16) |
| PROG-028 | Single first-ever exposure independently satisfies the bar, zero prior history | `INCREASE_LOAD` / `TOP_OF_RANGE_ACHIEVED` / `SINGLE_EXPOSURE` — not gated by the 3-exposure window (§11.1) |
| PROG-029 | Zero performed sets exist yet for the exercise (nothing to evaluate) | `NO_CHANGE` / `INSUFFICIENT_EVIDENCE` / `INSUFFICIENT` — distinct from PROG-028 |

## Worked examples

Each example: **Input → Evidence → Decision → Reason → What does NOT
happen.**

1. **Basic hypertrophy progression.** Bench Press, target 8–12 @ 60 kg.
   Last 3 exposures: 12/12/12, 12/12/11, 12/12/12 (all `COMPARABLE`,
   `WORKING`, and — making the `STRONG` result explicit — RIR recorded
   and corroborating on every set). → `INCREASE_LOAD`,
   `TOP_OF_RANGE_ACHIEVED`, `STRONG`. **Corrected 2026-09-22** (Pure
   Progression Engine V1 reconciliation): the original wording did not
   mention RIR at all, which made it read as though a no-RIR window could
   reach `STRONG` — that contradicts §9.3 and §17.3's `SUPPORTED` row,
   both of which unconditionally cap strength at `SUPPORTED` when RIR is
   missing anywhere in the window. Without RIR, this same 3-exposure
   evidence is `SUPPORTED`, not `STRONG` (see the implementation's own
   test suite for both variants). **Does not** happen: no invented new kg
   value — direction only.

2. **`NO_CHANGE` — no performed set exists yet at all.** The exercise was
   just prescribed; nothing has been performed for it yet, so there is no
   current exposure to evaluate at all (not even one). →`NO_CHANGE`,
   `INSUFFICIENT_EVIDENCE`, `INSUFFICIENT`. **Does not** happen: no
   assumption that this is a regression or a plateau. **Contrast with
   Example 11** — this is genuinely zero exposures, not one exposure with
   no prior history.

3. **Uneven reps.** Target 8–12 @ 100 kg, most recent: 12/11/9. →
   `MAINTAIN_LOAD_BUILD_REPS`, `REPS_PROGRESSING`, `SUPPORTED`. **Does
   not** happen: load does not increase because not every set hit 12.

3a. **A partial bar touch must not mask a real regression (§12.3.1, added
    2026-09-22).** Target 8–12 @ 60 kg, prior comparable exposure 11/10/9,
    current exposure 12/9/8. The first required set improved and touched
    the top of the range, but the other two required sets both regressed
    against the prior exposure. → `NO_CHANGE`,
    `PERFORMANCE_REGRESSED_SINGLE_EXPOSURE`, `SUPPORTED`. **Does not**
    happen: `MAINTAIN_LOAD_BUILD_REPS` is never produced here merely
    because one set incidentally touched `maxReps` — §12.3.1's precedence
    rule evaluates the regression first.

4. **Single poor workout.** History was 10/10/10 (target 8-12) for two
   exposures, then a third exposure comes in at 6/6/5 (illness, poor
   sleep, unknown). → `NO_CHANGE`,
   `PERFORMANCE_REGRESSED_SINGLE_EXPOSURE`, `SUPPORTED` (based on the
   two good prior exposures, but the most recent gates the decision to
   `NO_CHANGE`). **Does not** happen: no load decrease, no deload
   triggered.

5. **Repeated poor workouts.** Three consecutive comparable exposures all
   below range or flat. → `NO_CHANGE` with `progressionStalled: true`.
   **Does not** happen: Progression Engine does **not** decide a deload —
   it only emits the signal (§16/§17.2).

6. **Warm-up exclusion.** Exposure: WARM_UP 20×10, WARM_UP 40×5, WORKING
   60×10, WORKING 60×10, WORKING 60×10 (target 8–12 @ 60 kg; all working
   sets hit 10, not the top of 12) → evidence only from the 3 `WORKING`
   sets; since 10 < 12 → `NO_CHANGE`/`PERFORMANCE_STABLE` unless prior
   trend already showed improvement (then `MAINTAIN_LOAD_BUILD_REPS`).
   **Does not** happen: the two warm-up sets are never averaged into the
   evidence.

7. **Partial workout.** Planned 4 sets, athlete completed 2 (both hit top
   of range), then stopped. → Evidence exists but capped at
   `SINGLE_EXPOSURE`/`SUPPORTED` (never `STRONG`), likely
   `MAINTAIN_LOAD_BUILD_REPS` or `NO_CHANGE` depending on prior window,
   never an immediate `INCREASE_LOAD` from a partial session alone unless
   the window already independently supported it. **Does not** happen:
   the 2 missing sets are never counted as failures.

8. **Exact-rep strength target.** Target: 5 reps exact @ 120 kg, 3
   consecutive exposures all hit 5/5/5, RIR recorded and corroborating on
   every set. → `INCREASE_LOAD`, `TOP_OF_RANGE_ACHIEVED`, `STRONG`.
   **Corrected 2026-09-22**, same reasoning as Worked Example 1: without
   RIR, this evidence is `SUPPORTED`, not `STRONG` (§9.3/§17.3). **Does
   not** happen: `MAINTAIN_LOAD_BUILD_REPS` is never produced for an
   `EXACT` target (§12.2).

9. **Equipment increment limitation.** Engine recommends `INCREASE_LOAD`
   on a dumbbell exercise; application layer calls the (future) Load
   Resolver, which returns `NO_SUITABLE_INCREMENT` (gym jumps 40→45 kg,
   too large). → Application layer downgrades the outcome to
   `MAINTAIN_LOAD_BUILD_REPS`, reason `NO_SUITABLE_LOAD_INCREMENT`.
   **Does not** happen: Vostivo never prescribes 45 kg as if it were a
   normal small increment.

10. **Changed exercise context.** Bench Press moved from exercise order 1
    to order 3 this cycle; performance is otherwise identical to before.
    → Evidence still counts, but classified `COMPARABLE_WITH_CONTEXT`,
    capping strength at `SUPPORTED` even if all sets hit the top. →
    likely still `INCREASE_LOAD` if otherwise clearly met, just with
    `SUPPORTED` rather than `STRONG` evidence. **Does not** happen: the
    order change does not silently invalidate otherwise-clear evidence,
    nor does it get ignored.

11. **First-ever exposure already satisfies the bar (OD-5).** An athlete's
    very first logged exposure for a new exercise, target 8–12 @ 40 kg,
    hits 12/12/12 on every working set. Zero prior comparable exposures
    exist. → `INCREASE_LOAD`, `TOP_OF_RANGE_ACHIEVED`,
    `SINGLE_EXPOSURE`. **Does not** happen: the engine does **not** wait
    for a 3-exposure history before recommending anything — it only
    reports honestly reduced confidence (`SINGLE_EXPOSURE`, not
    `STRONG`) rather than withholding the decision.

## Safety / claims

The Progression Engine is a **training decision-support** feature, not a
medical or diagnostic one. It:

- Never diagnoses, never claims injury, overtraining, or muscle growth
  from workout data alone.
- Never hides uncertainty — every decision carries an explicit
  `evidenceStrength`; "we don't know yet" is a first-class, visible
  state, never silently smoothed over.
- Uses only: performance, training evidence, trend, tolerance,
  progression — never clinical language.

## Failure mode

If the engine cannot make a safe decision for any reason (malformed
input, an assembly-layer bug producing an empty/inconsistent evidence
set, an unexpected exercise state), the only acceptable outputs are
`NO_CHANGE` with `INSUFFICIENT_EVIDENCE`, or a thrown error the
**application layer** catches and treats as `NO_CHANGE` — engine failure
must **never** block workout logging, which is a locked architectural
principle unrelated to this engine's own correctness (`CLAUDE.md`,
Load Model V1 §106's "LOG REALITY FIRST").

## Deferred items (explicit, not silently dropped)

```text
Load Resolver implementation (Load Model V1 §51-65)      not built
Warm-up generation / prescription-time recommendation     not designed
General pre-workout preparation logging                   not designed
RIR UI                                                     not built
Program role / exercise-role vocabulary                    not designed
BACKOFF / DROP / AMRAP / FAILURE evidence policies          not designed
Fatigue / Adaptation Engine (deload decisions)              not started
Coach override UX                                          not designed
Real-time decision invalidation (vs. next-trigger recompute) not built
Cross-gym/cross-unit comparability (LB vs KG history)       not built
```

---

*This document is a specification, not an implementation. No production
code, database migration, API route, or mobile UI was changed as part of
producing it.*


## Planned Workout Occurrence Authority V1 (2026-10-05)

For a planned occurrence, only its CANONICAL session drives planned
progression. `evaluateAndPersist` returns `NOT_CANONICAL_OCCURRENCE_SESSION`
for a SECONDARY anchor: a final skip, never retried, with no decision and no
application. A SECONDARY session is also excluded from prior-exposure
evidence, so one planned occurrence is never counted twice. Unplanned
sessions are unaffected. This is not a new progression policy: the engine
and its version are unchanged. See `docs/architecture/
WORKOUT-DATA-INTEGRITY.md`.
