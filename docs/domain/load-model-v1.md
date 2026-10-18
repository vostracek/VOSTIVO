# Vostivo — Load Model & Load Resolver Specification V1

**Status:** Pre-implementation domain specification (loaded, not yet implemented)
**Scope:** Strength / Hypertrophy V1
**Primary principle:** A load value must have an explicit physical meaning.
`40` alone is never a valid training load.

This document is the canonical reference for how Vostivo represents and
resolves training load. Implementation sessions must not deviate from it
without going through the "STOP / REPORT CONFLICT / PROPOSE ADR" flow in
`CLAUDE.md`.

---

## 1. Why the Load Model exists

A naive model —

```ts
weight: number;
```

— is insufficient. The value `40 kg` could mean:

- a 40 kg dumbbell in each hand,
- 40 kg total on a barbell,
- 40 kg per side on a machine,
- +40 kg external load on a weighted pull-up,
- 40 kg of assistance on an assisted pull-up,
- 40 kg displayed on a cable stack.

These are not equivalent performances. Therefore:

```text
LOAD = VALUE + UNIT + KIND + BASIS + LOADING PROFILE
```

## 2. Core separation: Load Quantity vs. Load Meaning

`40 kg` is a _quantity_. `40 kg PER_IMPLEMENT` states that it's one
dumbbell — that's _meaning_. Vostivo always stores both.

## 3. Core Load object (conceptual)

```ts
Load {
  kind;
  amountMilli?;
  unit?;
  basis;
  loadingProfileId?;
}
```

`amountMilli` is never a floating-point business value.

## 4. Fixed-precision representation

Weight-like quantities use `amountMilli`, scale = 1000:

```text
40 kg      -> 40000 milli-kg
102.5 kg   -> 102500 milli-kg
1.25 kg    -> 1250 milli-kg
90 lb      -> 90000 milli-lb
```

## 5. Why scaled integers

Forbidden as canonical storage: `weight = 102.5` (floating point). Instead:
`amountMilli = 102500, unit = KG`. This gives exact increments,
deterministic comparisons, no floating-point rounding surprises, simple DB
constraints, simple sync, and a safe Training Engine.

## 6. Why scale 1000

Gym load doesn't need microgram precision. Thousandths of a unit mean
`0.001 kg = 1 gram` — already far more precise than real gym increments.
V1 does not use finer precision.

## 7. JavaScript representation

`amountMilli` is a validated integer `number` in TypeScript. `BigInt` is
unnecessary — realistic strength-training ranges stay well below
`Number.MAX_SAFE_INTEGER`. The database may use a plain integer with a
reasonable domain maximum.

## 8. Units (V1)

```text
KG
LB
```

Not `STONE` or `NEWTON` in Strength V1.

## 9. No forced normalization

The canonical performed value is stored in the unit of the actual
equipment. A gym with 90 lb dumbbells stores `90000 LB` — never
`40.8233 kg` just because the athlete's profile is set to metric.

## 10. Why native equipment unit wins

At the next workout the athlete needs to see `90 lb` — that's what's
written on the dumbbell, not `40.82 kg`, which they can't physically find
in the gym. A global unit preference never forces conversion of equipment
labels.

## 11. Unit conversion

Conversion is a **derived operation** — for analytics, comparison, or
display when useful. It is never a mechanism that rewrites the historical
performed value.

## 12. Load kinds (V1)

```text
EXTERNAL_WEIGHT
ADDED_BODYWEIGHT_WEIGHT
ASSISTANCE_WEIGHT
BODYWEIGHT
MACHINE_LEVEL
NON_WEIGHT_RESISTANCE
NONE
```

### 13. EXTERNAL_WEIGHT

Standard external load: Barbell Bench 100 kg, DB Bench 40 kg each, Leg
Press 160 kg displayed/loaded. `basis` clarifies what the number means.

### 14. ADDED_BODYWEIGHT_WEIGHT

Weighted Pull-Up +20 kg stores `kind = ADDED_BODYWEIGHT_WEIGHT, amount =
20000, unit = KG`.

### 15. Important rule

A weighted pull-up is **not** stored as `bodyweight + 20` collapsed into
one weight number. The canonical athlete-entered load is `+20 kg
external`. Bodyweight may exist as a separate contextual snapshot.

### 16. ASSISTANCE_WEIGHT

Assisted Pull-Up, 20 kg assistance, stores `kind = ASSISTANCE_WEIGHT,
amount = 20000, unit = KG`. **Never** `-20 kg`.

### 17. Why assistance isn't negative load

A negative number creates an unclear model: `-20 -> -15` is a
progression, but the number numerically increases. Instead of a
mathematical hack, semantics are explicit: `kind = ASSISTANCE_WEIGHT`,
and **lower assistance = harder performance**.

### 18. BODYWEIGHT

Push-Up, Pull-Up, Dip — no external load. `kind = BODYWEIGHT`. A load
amount need not exist.

### 19. Bodyweight measurement

If the athlete voluntarily knows their bodyweight, a session may carry a
`bodyweightSnapshot` (e.g. 83.5 kg). It is never required — Active Workout
must not require it, and the workout functions without it.

### 20. MACHINE_LEVEL

Some machines have no meaningful kg/lb label (`Resistance Level 8`). Store
`kind = MACHINE_LEVEL, level = 8` — never `8 kg`.

### 21. NON_WEIGHT_RESISTANCE

E.g. a resistance band. V1 may represent it via a stable equipment
resistance code. Vostivo does not pretend a kilogram equivalence here.

### 22. NONE

For an exercise where load isn't relevant. This is **not** `0 kg` — `NONE`
is an explicit absence of the load dimension.

## 23. Load basis (V1)

```text
TOTAL
PER_IMPLEMENT
PER_SIDE
EXTERNAL_ADDED
ASSISTANCE
DISPLAYED_STACK
LEVEL
BODYWEIGHT_ONLY
NOT_APPLICABLE
```

### 24–26. Barbell semantics

`100 kg` bench means `kind = EXTERNAL_WEIGHT, basis = TOTAL, amount =
100000, unit = KG`.

**Barbell convention: TOTAL LOADED IMPLEMENT WEIGHT** — bar + plates. A
20 kg bar + 40 kg plates each side = 100 kg; the athlete logs `100 kg`,
never `80 kg` (plates only). A GymProfile/LoadingProfile may define a
non-standard bar mass (e.g. trap bar = 25 kg) — the Resolver accounts for
it, but the athlete always sees total implement weight.

### 27–31. Dumbbell semantics

DB Bench "40 kg dumbbells" means **40 kg EACH**. Store `kind =
EXTERNAL_WEIGHT, basis = PER_IMPLEMENT, amount = 40000 KG` — never
`80000 KG`. This matches how people normally communicate performance
("DB Bench 40 x 10" usually means one 40 kg dumbbell per hand). The
Training Engine compares `40 each -> 42 each`, never `80 -> 84`. If
derived tonnage is ever needed: `amount x implement_count x reps` — but
**derived tonnage != canonical performed load**. A single-arm DB Row is
also `PER_IMPLEMENT` — load doesn't change based on limb count; laterality
is exercise context.

### 32–36. Per-side and machine-stack semantics

A plate-loaded machine the athlete typically logs as "40 kg per side" uses
`basis = PER_SIDE, amount = 40000 KG`. The **machine/loading profile**
decides `TOTAL` vs. `PER_SIDE` — never the exercise name. A selectorized
machine stack may use `basis = DISPLAYED_STACK, amount = 70000 KG`.

**Warning**: `70 kg` on Machine A does not necessarily equal `70 kg` on
Machine B — pulley ratios and mechanisms differ. Vostivo does not treat
different machines as automatically performance-equivalent. Performance
comparability may require agreement on exercise + loading profile +
equipment instance/profile (e.g. "Cable Row 70 kg, Gym A" vs. "Cable Row
70 kg, Gym B" may have lower comparison confidence).

## 37. LoadingProfile

Describes **how a specific resistance is set and progressed**. Contains
conceptually: profile type, load kind, basis, native unit, difficulty
direction, increment strategy, minimum, maximum, equipment semantics.

## 38. LoadingProfile types (V1 foundation)

```text
FIXED_INCREMENT
DISCRETE_LIST
PLATE_LOADED_BAR
PLATE_LOADED_PER_SIDE
BODYWEIGHT_EXTERNAL
ASSISTANCE
LEVEL
MANUAL
```

### 39. FIXED_INCREMENT

E.g. machine stack `20, 25, 30, 35, 40 kg`, `increment = 5 kg`. Resolver:
`70 -> 75`.

### 40–41. DISCRETE_LIST

E.g. dumbbells `30, 32, 34, 36, 38, 40, 42, 44`. The Resolver does not
guess an arithmetic progression — it uses the actual available list.
`40 -> 42`. One gym might have `30, 32.5, 35, 37.5, 40`; another `30, 32,
34, 36`. The Engine must respect the reality of the specific gym.

### 42–43. PLATE_LOADED_BAR

The Resolver knows bar mass and available plates, and finds the nearest
achievable symmetric load. E.g. bar = 20 kg, plates `1.25, 2.5, 5, 10, 15,
20, 25` -> smallest ordinary progression is `+2.5 kg` (+1.25 each side).
**The Resolver never invents plates** — if the gym has no 0.5 kg plates,
Vostivo must never prescribe `101 kg` from `100 kg`.

### 44. PLATE_LOADED_PER_SIDE

The Resolver adds an achievable plate quantity per side. E.g. `40 kg/side

- 1.25 each side -> 41.25 kg/side`. The UI keeps per-side semantics
  visible.

### 45. BODYWEIGHT_EXTERNAL

E.g. Weighted Dip/Pull-Up. The profile resolves external load (`+10, +15,
+20 kg`). Bodyweight is not added into the displayed target.

### 46. ASSISTANCE

E.g. assisted pull-up machine `30, 25, 20, 15 kg` assistance. Direction:
`LOWER_IS_HARDER`. The Resolver seeks `20 -> 15` for progression, never
`20 -> 25`.

### 47. LEVEL

E.g. `Level 7 -> Level 8`, only if the specific equipment profile declares
`HIGHER_IS_HARDER`.

## 48–50. Difficulty direction

Every LoadingProfile must explicitly declare:

```text
HIGHER_IS_HARDER   (e.g. weight)
LOWER_IS_HARDER    (e.g. assistance)
NON_ORDERED        (e.g. band color without an ordered resistance model)
```

The Training Engine must never have a bare rule like
`if (today.load > previous.load) performanceImproved = true` — it must
respect LoadingProfile semantics.

## 51–62. Load Resolver

**Responsibility**: given the desired progression and available equipment,
what load can the athlete actually use?

**Input** (conceptual): current load, desired action, LoadingProfile,
GymProfile/equipment, exercise context, unit context.

**Desired actions (V1)**: `INCREASE`, `DECREASE`, `MAINTAIN`,
`NEAREST_VALID`.

**Output**: `ResolvedLoad`, `delta`, `reasonCode`, `loadingProfile`,
`wasRounded`, `confidence`.

**Examples**:

- Barbell: `Bench 100 kg INCREASE` (barbell profile) -> `102.5 kg`, reason
  `NEXT_AVAILABLE_LOAD`.
- Dumbbells: `DB Press 40 kg each, available [40,42,44], INCREASE` ->
  `42 kg each`.
- Assistance: `Assisted Pull-Up 20 kg assistance, available
[30,25,20,15,10], INCREASE_DIFFICULTY` -> `15 kg assistance`.

**No impossible target**: the Progression Engine may decide "increase" —
the Load Resolver determines the exact achievable value per equipment
reality.

**Important separation**:

```text
Progression Engine  = should difficulty increase?
Load Resolver       = what exact achievable load represents that increase?
```

These are two distinct responsibilities.

**When the increment is too large**: e.g. current DB 40 kg, next available
45 kg = +12.5%, possibly too big a jump. The output must not automatically
be `45 kg`.

**Resolver may return no acceptable increase**: `NO_SUITABLE_LOAD_INCREMENT`
— the Progression Engine may then increase the rep target, maintain load,
or change progression strategy.

**The Resolver is not a progression authority** — it never decides "the
user deserves more weight," only feasibility.

## 63. Rounding

Converting `90 lb -> kg` may produce a decimal, but the actual prescribed
gym load is always rounded according to the **target LoadingProfile** —
never an arbitrary "round to 0.5."

## 64–65. Cross-unit gym change

An athlete who normally uses 90 lb dumbbells and visits a kg-only gym: the
Resolver may (1) convert the performance reference, (2) find the nearest
appropriate available kg load, (3) show an adaptation explanation. E.g.
previous `90 lb each` (~40.8 kg), available `40, 42 kg` — the
Engine/Resolver decides based on progression context, not simple
mathematical nearest-value alone. **The historical record still says
90 lb** — never `40.823 kg`.

## 66–70. Target vs. performed, corrections, and profile immutability

`PlannedSet` has a target load; `PerformedSet` has the actual load — one
must never automatically overwrite the other. Example: plan `102.5 kg`,
athlete actually does `100 kg`; history records `100 kg`, and the engine
still knows `target = 102.5, actual = 100`.

Athletes may correct history (e.g. `100 -> 105 kg`) — load semantics stay
the same; a correction must never silently change `TOTAL` to `PER_SIDE`
without an explicit equipment/load interpretation change.

**LoadingProfile immutability**: a LoadingProfile used by a historical
workout must not be mutated in a way that changes the meaning of that
history. If gym configuration fundamentally changes semantics, a **new**
LoadingProfile/version is created instead (e.g. old Machine Press
`DISPLAYED_STACK, 5kg increments` — when the gym buys a new machine, the
historical profile is not swapped out; a new equipment/loading profile is
created).

## 71–73. Conceptual shapes

```ts
// PlannedSet
LoadTarget {
  kind; amountMilli?; unit?; basis; loadingProfileId?;
}

// PerformedSet
PerformedLoad {
  kind; amountMilli?; unit?; basis; loadingProfileId?; equipmentInstanceId?;
}

// Optional, for bodyweight-related movements
bodyweightSnapshot?: { amountMilli; unit; }
```

## 74–76. Database direction

`performed_sets` will **not** receive a plain `weight REAL` column.
Instead, physical schema represents load semantics explicitly (conceptual
column set — exact normalized schema comes during implementation):

```text
load_kind
load_amount_milli
load_unit
load_basis
loading_profile_id
equipment_instance_id?
bodyweight_amount_milli?
bodyweight_unit?
```

**Nullable field rules** (examples):

- External weight: `amount` required, `unit` required.
- Bodyweight: `amount` NULL, `unit` NULL (unless a bodyweight snapshot
  separately exists).
- Machine level: `level` required, weight amount NULL.

Application + DB CHECK constraints enforce valid combinations.

**No JSON load blob** — core load semantics are never a generic JSONB
`{"whatever": "40kg somehow"}`. Load is core training-domain data and gets
a structured representation.

## 77–86. API transport, display, and comparability

API sends an explicit typed object, e.g.:

```json
{ "kind": "EXTERNAL_WEIGHT", "amountMilli": 40000, "unit": "KG", "basis": "PER_IMPLEMENT" }
```

never `{ "weight": 40 }`.

**Display layer** converts `40000 + KG + PER_IMPLEMENT` to `40 kg each`;
weighted pull-up displays as `+20 kg`; assistance as `20 kg assistance`.
Barbell normally just shows `100 kg` (no need to clutter the UI with
"total" unless context is ambiguous — semantics remain stored explicitly).
A `PER_SIDE` equipment profile should make that visible in the UI: `40 kg
/ side`.

**Active Workout "Previous"** (e.g. `40 x 10 @2`) must use the same
loading semantics as the current exercise. If the equipment context
changed significantly, the UI/engine must not pretend the comparison is
perfectly equivalent.

**Comparable exposure** requires relevant agreement in: exercise, load
kind, load basis, loading profile/equipment context, and
unit-convertibility where relevant. Same amount != same stimulus — 70 kg
cable row on Machine A and Machine B are not automatically identical
performance evidence.

## 86–90. Gym Profile, defaults, and learning from correction

A `GymProfile` can contain: equipment instance, loading profile, native
unit, available load options, increments. Onboarding does not require
cataloguing every plate — a standard gym profile provides sensible
defaults, and the athlete can correct equipment increments when Vostivo
proposes an impossible target.

If the Resolver repeatedly proposes e.g. `42 kg dumbbell` and the athlete
says the gym actually jumps `40 -> 45`, Vostivo updates the **GymEquipment
configuration** — not Athlete Memory. Equipment fact **!=** behavioral
memory.

**`MANUAL` load**: some uncommon equipment can't be accurately modeled;
`MANUAL` lets the athlete enter an explicit resistance representation
without pretending the Load Resolver fully understands it (engine
confidence may be reduced).

**Never block logging.** Unknown equipment is never a reason to prevent
workout logging. Primary rule: **LOG REALITY FIRST** — intelligence
degrades gracefully.

## 91–95. Set types, supersets, and exercise-vs-equipment ownership

Load semantics are independent of set type (`WARMUP, WORKING, BACKOFF,
DROP, AMRAP, FAILURE`) — a drop set can still be
`EXTERNAL_WEIGHT/PER_IMPLEMENT`. Warm-up plate math may eventually use the
Load Resolver, but it's not a V1 core requirement. Supersets need no
special Load Model — each PerformedExercise/Set retains its own
LoadingProfile.

An exercise may _suggest_ default semantics (`Dumbbell Bench ->
PER_IMPLEMENT`), but actual resolved semantics can come from the
specific equipment/gym profile. **The exercise does not own increments**
— `Dumbbell Bench increment = 2kg` is a bad model; the increment belongs
to the available dumbbells / LoadingProfile, not the exercise.

## 96–98. Units, precision, and history across units

`AthleteProfile` unit setting (`METRIC`/`IMPERIAL`) is a display/default
preference — it never rewrites native equipment units. The Engine may
compare `100 kg` to `220 lb` only through deterministic conversion and
appropriate equipment-context confidence — it never modifies raw values.
UI normally displays natural gym precision (`100 kg, 102.5 kg, 40 lb`),
not `102.500 kg` — storage precision is not UI precision.

## 99–100. Validation bounds and zero semantics

V1 must reject nonsensical canonical values: negative `EXTERNAL_WEIGHT`,
negative `ASSISTANCE_WEIGHT`, `NaN`, `Infinity`, a fractional machine level
where the profile requires an integer. Exact max bounds are an
implementation-policy detail. `0 kg EXTERNAL_WEIGHT` may be valid in rare
equipment contexts — but `BODYWEIGHT` must never be encoded as `0 kg`;
meaning is explicit.

## 101–102. Progression evidence

A progression may be demonstrated by: same load + more reps; same
load/reps + higher RIR; higher valid load + comparable reps/RIR; less
assistance; higher equipment level — depending on LoadingProfile. The
Load Model does not define performance alone — the Performance Evaluator
also considers reps, RIR/effort, set consistency, exercise order, program
role, and context.

## 103–105. Load Resolver reason codes

```text
EXACT_TARGET_AVAILABLE
NEXT_AVAILABLE_LOAD
PREVIOUS_AVAILABLE_LOAD
ROUNDED_TO_EQUIPMENT
NO_SUITABLE_INCREMENT
EQUIPMENT_CHANGED
UNIT_CONVERSION_REQUIRED
MANUAL_SELECTION_REQUIRED
```

The Resolver must explain rounding (e.g. "42 kg is the next available
dumbbell in this gym" when the ideal was 41 kg). The Resolver's output is
a recommendation/target — it never silently modifies the athlete's logged
actual value.

## 106–108. First implementation scope (staged)

The Workout Data Integrity Slice does **not** need the entire advanced
Resolver. Initial implementation supports: `EXTERNAL_WEIGHT`, `KG`/`LB`,
`TOTAL`, `PER_IMPLEMENT`, `FIXED_INCREMENT`/simple discrete options — plus
an architecture that allows the other kinds. Rationale: the spec defines
complete V1 semantics, but the first slice should prove correct
persistence, sync, and crash recovery before implementing advanced plate
arithmetic.

```text
Stage 1  external load, total/per implement, kg/lb
Stage 2  discrete gym increments
Stage 3  barbell plates, per-side machines
Stage 4  bodyweight + added load, assistance
Stage 5  levels/manual/non-weight resistance
```

The architecture supports all five from the beginning.

**Implementation status (Progression Prerequisites V1, 2026-09-09):** the
Load Resolver itself (§51-65) is now implemented for Stage 1 only —
`resolveNextLoad()` (`packages/domain/src/load/load-resolver.ts`), a
pure, deterministic `FIXED_INCREMENT` resolver taking an explicit,
caller-supplied increment capability (never a persisted `GymProfile` —
that remains future work). `DISCRETE_LIST`/`PLATE_LOADED_BAR`/
`PLATE_LOADED_PER_SIDE`/bodyweight/assistance/level resolution (Stages
2-5) are not implemented. Placed in `packages/domain` (not
`packages/training-engine`) since Load Model ownership already lives
there entirely — see the Resolver module's own doc comment for the full
placement reasoning.

## 109. Load Model invariants — LOCKED

| ID           | Invariant                                                                              |
| ------------ | -------------------------------------------------------------------------------------- |
| LOAD-INV-001 | A numeric load without semantics is invalid.                                           |
| LOAD-INV-002 | Canonical weight-like values use fixed-precision scaled integers.                      |
| LOAD-INV-003 | Canonical historical load preserves the actual equipment unit.                         |
| LOAD-INV-004 | Global unit preference does not rewrite historical equipment values.                   |
| LOAD-INV-005 | Dumbbell pair load is stored per implement, not summed.                                |
| LOAD-INV-006 | Standard barbell load is stored as total loaded implement weight.                      |
| LOAD-INV-007 | Per-side equipment explicitly stores PER_SIDE semantics.                               |
| LOAD-INV-008 | Weighted bodyweight movements store external added weight separately.                  |
| LOAD-INV-009 | Assistance is a positive assistance amount, never negative load.                       |
| LOAD-INV-010 | Assistance profiles use LOWER_IS_HARDER semantics.                                     |
| LOAD-INV-011 | Bodyweight movement is not represented as zero kilograms.                              |
| LOAD-INV-012 | Machine level is not falsely represented as kilograms.                                 |
| LOAD-INV-013 | Equipment/loading context affects performance comparability.                           |
| LOAD-INV-014 | Exercise identity does not own gym increments.                                         |
| LOAD-INV-015 | LoadingProfile controls achievable loads.                                              |
| LOAD-INV-016 | Progression Engine chooses desired progression; Load Resolver chooses realizable load. |
| LOAD-INV-017 | Resolver may return NO_SUITABLE_INCREMENT.                                             |
| LOAD-INV-018 | Target load never overwrites performed load.                                           |
| LOAD-INV-019 | Historical LoadingProfile meaning remains reconstructable.                             |
| LOAD-INV-020 | Unknown load semantics never block basic workout logging.                              |

These invariants are locked. An implementation session that finds itself
needing to violate one must STOP and follow the conflict-reporting flow in
`CLAUDE.md` — not work around it silently.

## 110. Data-model gate

All of the following are marked **READY** by this specification: fixed
precision, KG/LB semantics, barbell semantics, dumbbell semantics,
per-side semantics, bodyweight semantics, weighted bodyweight, assistance,
machine stack, machine levels, equipment comparability, Load Resolver
responsibility, first vertical-slice subset.

## 111. Next implementation gate

Before the Workout Data Integrity Vertical Slice can begin:

**REQUIRED**: Native SQLCipher runtime verification.

> As of the last Foundation Fix Pass, this is **NOT RUN** — the
> development machine has the necessary Android SDK/NDK/emulator tooling,
> but disk space is critically low (~7 GB free / 97% full) while other
> unrelated projects' containers run on the same machine. See
> `docs/architecture/FOUNDATION.md` for the full explanation and the exact
> command to run once adequate disk space is available.

Then: **WORKOUT DATA INTEGRITY VERTICAL SLICE**. The first real product
implementation must prove:

```text
planned data
  -> session snapshot
  -> performed exercise
  -> performed sets
  -> local encrypted SQLite
  -> app crash/restart
  -> offline completion
  -> outbox
  -> server sync
  -> PostgreSQL canonical history
```

with no data loss and no duplicate side effects.
