# Vostivo — Exercise & Equipment Reference Catalog V1

**Status:**
- Exercise & Equipment Reference Catalog V1 — **CLOSED**.
- Curated Substitution Seed V1 — **IMPLEMENTED / awaiting tech-lead
  closure** (2026-10-10). See §10.

This is the prerequisite for Temporary Equipment / Gym Adaptation V1
Slice B. It is not Slice B itself: no API, no Gym Profile, no UI, no
persistence.

## 1. Locked rules

```text
EXERCISE REF IS THE CANONICAL EXERCISE IDENTITY.
EQUIPMENT IDS ARE CANONICAL PRODUCT VOCABULARY.
REQUIREMENTS ARE ALL-OF IN V1.
SUBSTITUTION EDGES ARE EXPLICIT AND DIRECTIONAL.
ROLE_EQUIVALENT IS CURATED, NEVER INFERRED.
LOAD/HISTORY ARE NOT PART OF SUBSTITUTION CATALOG DATA.
NULL/UNKNOWN EXERCISES ARE NOT AUTO-ADAPTED.
CATALOG IS REFERENCE DATA, NOT USER/GYM AVAILABILITY.
```

## 2. Architecture

- **Code-owned, version-controlled reference data.** It lives in
  `packages/domain/src/exercise-catalog/` and ships with the product, so
  every change is reviewable in Git. There is no DB table, migration, CMS,
  endpoint or remote lookup. Future admin tooling may replace this storage
  but must keep the ids stable.
- **Files:**
  - `vocabulary.ts` holds the catalog version and the shared substitution
    enums. These are defined once, in domain; `@vostivo/training-engine`
    re-exports them unchanged, so Slice A and the catalog can't drift.
  - `types.ts` holds the data shapes.
  - `catalog-data.ts` is THE catalog, deep-frozen.
  - `validate-catalog.ts` is the pure structural validator.
  - `lookup.ts` provides `createExerciseEquipmentCatalogLookup(catalog)` and
    `exerciseEquipmentCatalogV1`, with `getExerciseDefinition`,
    `getEquipmentDefinition`, `getSubstitutionEdges` and
    `resolveExerciseIdentity`.
- **Purity:** lookups are pure and deterministic. Their indexes are private
  to a closure (no global mutable map, no runtime registration), every
  returned object is frozen catalog data, and absence is `null` / `[]` /
  `UNSUPPORTED_EXERCISE_IDENTITY`, never an exception.
- **Version:** `exercise-equipment-catalog/v1`. It will take part in Slice B
  preview fingerprints.
- **Engine adapter:** `catalogEquipmentFacts(lookup, exerciseRef)`, in
  `packages/training-engine/src/equipment-adaptation/catalog-adapter.ts`.
  It sits at the engine boundary because training-engine depends on domain,
  never the reverse. It maps an exercise to either
  `{ SUPPORTED, exerciseId, requiredEquipmentIds, candidates }` or
  `UNSUPPORTED_EXERCISE_IDENTITY`.
  - Candidates come only from curated edges, ordered by priority, and carry
    the substitute's OWN equipment requirements.
  - It deliberately does NOT pre-filter by today's equipment or the
    athlete's blocks. Eligibility is decided once, inside
    `equipment-adaptation/v1`, which also produces the precise
    NO_CURATED vs NO_AVAILABLE reasons. This is why the adapter takes no
    available-equipment or blocked parameters, unlike the conceptual sketch
    in the task.

## 3. Equipment vocabulary (9 original ids + `hack-squat-machine` from the seed, §10)

Each id is one product-level, gym-independent availability constraint.
There is no "MACHINE" catch-all, no brand or model, and no gym-specific id.

| id | label | decision |
|---|---|---|
| `barbell` | Barbell (with plates) | One loadable barbell; plates are implied. A barbell without plates is not a useful V1 distinction. |
| `barbell-rack` | Barbell rack / uprights | Anything holding a barbell at height: a power or squat rack, or bench uprights. It is separate from `barbell` because a deadlift needs no rack while a squat does. |
| `flat-bench` | Flat bench | The capability "a bench usable flat". Whether an adjustable bench also provides it is availability context, not catalog data. |
| `adjustable-bench` | Adjustable (incline) bench | Incline work needs it; a flat-only bench does not provide it. |
| `dumbbells` | Dumbbells | A usable dumbbell set (load range is a LoadingCapability concern, not equipment). |
| `cable-station` | Cable station (adjustable pulley) | Face pulls and other adjustable-height cable work. |
| `lat-pulldown-station` | Lat pulldown station | Separate from `cable-station`: many gyms have one without the other, and "pulldown station taken" is a real constraint. |
| `leg-press-machine` | Leg press machine | A dedicated machine. One machine being out never implies "all machines". |
| `leg-curl-machine` | Leg curl machine | Same as above. |

"Occupied" is not modelled. Availability is session or Gym Profile
context, never catalog data. Equipment availability is also separate from
LoadingCapability / `gym_profiles` (load increments); the two are not
merged.

## 4. Exercise definitions (12, every current first-party ref)

| exerciseRef | requiredEquipmentIds (ALL-OF) |
|---|---|
| `bench-press` | barbell, barbell-rack, flat-bench |
| `overhead-press` | barbell, barbell-rack |
| `lat-pulldown` | lat-pulldown-station |
| `back-squat` | barbell, barbell-rack |
| `romanian-deadlift` | barbell |
| `leg-press` | leg-press-machine |
| `barbell-row` | barbell |
| `incline-dumbbell-press` | dumbbells, adjustable-bench |
| `face-pull` | cable-station |
| `deadlift` | barbell |
| `bulgarian-split-squat` | dumbbells, flat-bench |
| `leg-curl` | leg-curl-machine |

- `[]` would mean equipment-independent. No fake "bodyweight" equipment
  exists.
- Alternative setups are not boolean expressions. A meaningfully different
  setup should be authored as a separate exercise variant (`exerciseRef`
  stays equipment-variant-specific, PROGRESSION-ENGINE-V1 §25).
- Note on `bulgarian-split-squat`: the seed loads it `PER_IMPLEMENT`
  (dumbbells), with the rear foot elevated on a bench.

## 5. Coverage

- **Discovered refs.**
  - First-party (`seed-dev-plan.ts` including SMALL_FIXTURE, plus the
    mobile Available-Time fixtures): the 12 above.
  - Test-only synthetic refs: `history-test-bench-press`,
    `bench-press-gate-002`, `bench-press-gate-003`,
    `worker-progression-overhead-press`, `incline-db-press`,
    `incline-db-press-v2`, `squat`.
- **Catalog-backed:** all 12 first-party refs. A coverage test parses the
  seed and the fixtures.
- **Unsupported / null:** the 7 test-only synthetic refs, asserted
  UNSUPPORTED by a test. They are not product exercises, and DB rows were
  not changed.
- **Exercises authored with `exerciseRef = null`:** the freeform-exercise
  path exists in the model, but no current fixture uses it. Such exercises
  are UNSUPPORTED.

## 6. Curated substitution graph

> **Superseded by §10 (Curated Substitution Seed V1).** This section
> records the state at catalog closure.

**ZERO edges are authored.**

The task allows encoding an edge without a further decision only where an
existing project artifact explicitly describes the relationship. None does:
- LOADING-CAPABILITY-V1 §12 and PROGRESSION-ENGINE-V1 §25 only say a
  swapped exercise keeps its own identity;
- no document approves any pair.

So nothing is encoded, by design (safety over coverage). The architecture
and the edge semantics are fully tested with test-local catalogs:
directionality, ordering, the validator and the adapter.

**Proposed pairs awaiting a tech-lead decision. NOT encoded, and none of
them is claimed equivalent:**

| proposed edge | proposed tier | note |
|---|---|---|
| `back-squat → leg-press` | ROLE_EQUIVALENT or ROLE_COMPATIBLE? | Quad-dominant lower-body slot; the stimulus differs (no axial load). |
| `leg-press → back-squat` | ? | Reverse direction is a separate decision. |
| `deadlift → romanian-deadlift` | ROLE_COMPATIBLE? | Same tool (barbell), so useless for equipment outages unless paired with variants. |
| `bench-press → incline-dumbbell-press` | ROLE_COMPATIBLE? | Different angle and implement. |

**Observation:** most first-party exercises have no true ROLE_EQUIVALENT
partner within the current 12. Useful automatic swaps would need NEW
catalog exercises, for example `dumbbell-bench-press` for `bench-press`,
`hack-squat` / `leg-press` variants, `seated-cable-row` for `barbell-row`,
or `lying-leg-curl` / `seated-leg-curl`. Adding exercises and their edges
is a product decision too.

## 7. Null / unknown exercises

- **Identity resolution:** `resolveExerciseIdentity(null)` returns
  `UNSUPPORTED_EXERCISE_IDENTITY / NULL_EXERCISE_REF`; an unknown ref
  returns `UNKNOWN_EXERCISE_REF`. Matching is by exact ref only, never by
  display name.
- **Rows untouched:** no DB rows were mutated, and `exerciseRef` was not
  made NOT NULL.
- **Slice B fail-closed rule (documented here, NOT implemented):** if a
  target PlannedWorkout contains any exercise whose equipment requirements
  cannot be authoritatively resolved (null or unknown identity), the
  Temporary Equipment server preview must NOT treat that exercise as
  available. V1 fails closed to REVIEW_REQUIRED with unsupported-identity
  semantics. The exact API reason mapping belongs to Slice B.

## 8. Validation (`validateExerciseEquipmentCatalog`)

The validator collects every issue in a deterministic order:
- `EMPTY_VERSION`;
- empty ids or labels;
- duplicate equipment ids or exercise refs;
- duplicate or unknown required equipment;
- unknown substitution source or target;
- a self edge;
- a priority that is not a positive integer;
- an invalid tier or prescription compatibility;
- a duplicate (source, substitute) edge;
- `AMBIGUOUS_EQUIVALENT_PRIORITY`: two automatic (ROLE_EQUIVALENT +
  PRESERVE) edges of one source sharing a priority.

The engine keeps its own AMBIGUOUS_SUBSTITUTION guard for caller-supplied
input.

## 9. Evidence

- **Domain:** `catalog.test.ts`, 20 tests covering matrix items 1–27 and 30.
- **training-engine:** `catalog-adapter.test.ts`, 6 tests covering items
  28–29, null/unknown identity, copy safety, and an end-to-end run through
  the unchanged Slice A policy.
- **Slice A:** its 34 tests still pass on the shared vocabulary.

## 10. Curated Substitution Seed V1 (2026-10-10)

These are the first tech-lead-approved curated edges, authored exactly as
decided: no inference, no AI, no name matching, and no reverse relation
unless it is listed.

### 10.1 Meaning of the tiers

- **ROLE_EQUIVALENT** (always paired with `PRESERVE_WORKING_PRESCRIPTION`):
  may be automatically RECOMMENDED for a temporary, session-only
  substitution, within Vostivo V1's ordinary strength/hypertrophy
  programming role. What stays: the working set structure, rep target or
  range, rest, Available-Time priority/minimum, and the authored slot and
  order. It is NOT biomechanical identity.
- **ROLE_COMPATIBLE** (always paired with `REQUIRES_PRESCRIPTION_CHANGE`): a
  review/manual alternative only. It is never auto-selected and never
  promoted when no equivalent exists.
- **Neither tier transfers load, history or exercise identity.** The
  catalog contains zero load conversion, percentages, previous loads,
  e1RM or history references.
- **Locks win:** a future program/coach LOCK on a PlannedExercise always
  overrides catalog equivalence. "This CAN be a temporary equivalent" is
  separate from "this programmed slot MAY be changed". Competition-lift
  specificity is not solved in the catalog, and no lock persistence is
  added here.

### 10.2 Added exercises (7) and equipment (1)

| exerciseRef | requires (ALL-OF) |
|---|---|
| `dumbbell-bench-press` | dumbbells, flat-bench |
| `seated-dumbbell-overhead-press` | dumbbells, adjustable-bench |
| `cable-lat-pulldown` | cable-station |
| `dumbbell-romanian-deadlift` | dumbbells |
| `seated-cable-row` | cable-station |
| `chest-supported-dumbbell-row` | dumbbells, adjustable-bench |
| `hack-squat` | hack-squat-machine |

New equipment id: `hack-squat-machine` (Hack Squat Machine). It is
product-level, with no brand or model.

### 10.3 ROLE_EQUIVALENT edges (14) — automatic candidates

| source | substitute | priority |
|---|---|---|
| bench-press | dumbbell-bench-press | 1 |
| dumbbell-bench-press | bench-press | 1 |
| overhead-press | seated-dumbbell-overhead-press | 1 |
| seated-dumbbell-overhead-press | overhead-press | 1 |
| lat-pulldown | cable-lat-pulldown | 1 |
| cable-lat-pulldown | lat-pulldown | 1 |
| romanian-deadlift | dumbbell-romanian-deadlift | 1 |
| dumbbell-romanian-deadlift | romanian-deadlift | 1 |
| barbell-row | seated-cable-row | 1 |
| barbell-row | chest-supported-dumbbell-row | 2 |
| seated-cable-row | chest-supported-dumbbell-row | 1 |
| seated-cable-row | barbell-row | 2 |
| chest-supported-dumbbell-row | seated-cable-row | 1 |
| chest-supported-dumbbell-row | barbell-row | 2 |

### 10.4 ROLE_COMPATIBLE edges (8) — never automatic

| source | substitute | priority |
|---|---|---|
| back-squat | hack-squat | 1 |
| back-squat | leg-press | 2 |
| leg-press | hack-squat | 1 |
| leg-press | back-squat | 2 |
| hack-squat | leg-press | 1 |
| hack-squat | back-squat | 2 |
| deadlift | romanian-deadlift | 1 |
| bench-press | incline-dumbbell-press | 10 (after its equivalent) |

**Explicitly NOT ROLE_EQUIVALENT** (asserted by a test): back-squat ↔
leg-press, back-squat ↔ hack-squat, leg-press ↔ hack-squat,
deadlift ↔ romanian-deadlift, bench-press ↔ incline-dumbbell-press.

### 10.5 Coverage

- **First-party original exercises:** 12, all catalog-backed.
- **New catalog exercises:** 7.
- **Automatic (ROLE_EQUIVALENT) substitutes:** bench-press,
  overhead-press, lat-pulldown, romanian-deadlift, barbell-row, plus the
  7 new exercises except `hack-squat`.
- **Only ROLE_COMPATIBLE (never automatic):** back-squat, leg-press,
  hack-squat, deadlift.
- **No curated substitutes at all:** face-pull, leg-curl,
  incline-dumbbell-press, bulgarian-split-squat.

This is deliberately not 100% coverage; safety beats coverage.

### 10.6 Flat vs adjustable bench

`flat-bench` and `adjustable-bench` remain separate canonical ids, and the
requirement syntax stays exact ALL-OF ids.

**Future availability-context rule (not implemented):** an adjustable
bench MAY satisfy a `flat-bench` requirement only when the context builder
explicitly exposes that capability, for example by listing both ids as
available. Until then, exact ids are authoritative. The catalog does no
capability expansion, and Slice A is unchanged.

### 10.7 Version discipline

The version stays `exercise-equipment-catalog/v1`. This seed completes the
initial product data before any persisted equipment preview or application
uses the version, so there is no bump.

Once the catalog version takes part in persisted preview or application
semantics (Slice B onward), any future incompatible catalog change
(removed or renamed ids, changed requirements, changed edge tier,
priority or compatibility) requires a version bump.

### 10.8 Evidence

- **Domain `catalog.test.ts`** (24 tests): the new exercises and equipment
  resolve exactly; the catalog has exactly the approved edge set with no
  synthesized reverses; the forbidden equivalences are absent; candidates
  come back in priority order (bench-press, barbell-row, back-squat); and
  the exercises without substitutes stay without any.
- **training-engine `seed-scenarios.test.ts`** (12 tests): the real
  catalog run through the unchanged policy.
  - Automatic replacements:
    - bench → DB bench;
    - RDL → DB RDL;
    - lat-pulldown → cable lat pulldown;
    - barbell row → seated cable row (priority 1), or → chest-supported
      DB row when there is no cable (priority 2);
    - OHP → seated DB OHP.
  - REVIEW_REQUIRED instead of a swap:
    - the incline press is never auto-selected;
    - back-squat with a hack squat machine available;
    - deadlift;
    - leg-curl and face-pull (no curated substitute).
  - No load in the decision, distinct identities, and a whole-session
    in-place diff.
- **The validator is unchanged and not weakened.** It passes on the seeded
  catalog.

