# Vostivo — Loading Capability V1 Specification

**Status:** Pre-implementation domain specification — **RECONCILED**
against tech-lead final architecture review (this pass). Nothing in this
document is implemented. No runtime code, schema, migration, or
dependency changed while writing or reconciling it — see the final
report. This is the prerequisite Progression Application V1 (§8.4 of
`docs/domain/PROGRESSION-APPLICATION-V1.md`) needs for numeric
`INCREASE_LOAD` resolution.

**Answers**: *"How does Vostivo know which physical loads are actually
possible for a prescribed exercise in the athlete's current training
context?"* — from an explicit, athlete-owned `LoadingCapability`, bound to
an *exact* `exerciseRef` via an explicit binding row — never a guessed
universal percentage/increment, and never an implicit unit/basis-wide
assumption either.

---

## 0. Reconciliation note (this pass)

The first draft of this document proposed a two-tier key —
`(gymProfileId, exerciseRef | NULL, unit, basis)`, where `exerciseRef =
NULL` meant "the general capability for every exercise sharing this
unit/basis in this gym." **The tech lead rejected this**: a gym's Barbell
Bench (`KG`/`TOTAL`, `+2.5 kg`), Leg Press (`KG`/`TOTAL`, `+10 kg`), and
Cable Row (`KG`/`TOTAL`, an irregular enumerated stack) all share
`unit`/`basis` while having completely different real capabilities — a
unit/basis-wide fallback would have been exactly the disguised generic
increment the tech lead already rejected once, reintroduced one level
less obviously. This revision removes it entirely and replaces it with an
**explicit per-exercise binding**. A second correction, independent of
the first: capability resolution/snapshotting is now Apply-time-only,
never frozen at the moment a recommendation is first shown (§9).

---

## 1. Repository findings (unchanged from the first pass, re-confirmed)

Re-inspected: `docs/domain/load-model-v1.md`, `packages/domain/src/load/
{load.ts,load-resolver.ts}`, `packages/domain/src/exercise-identity.ts`,
`packages/domain/src/plan/{planned-exercise.ts,planned-set.ts}`,
`packages/domain/src/identity/athlete-profile.ts`, `CLAUDE.md`,
`docs/domain/PROGRESSION-APPLICATION-V1.md`, `packages/database/src/schema/
{plan.ts,workout.ts,identity.ts}`, `apps/api/src/auth/
identity-resolver.service.ts`. **Confirmed: zero persisted representation
of `GymProfile`/`LoadingProfile`/equipment capability exists anywhere.**
`ExerciseIdentityV1` is exactly `exerciseRef` (a plain `string`),
explicitly documented as *not* an equipment identity. No "Gym Profile" is
a locked product decision in `CLAUDE.md` — only `load-model-v1.md`'s own
conceptual, never-implemented §37/§86-90 sections name it.

**Ownership precedent** (Decision 20, resolved here): `Program.
athleteProfileId` — the entire Plan/Program hierarchy (training *context*,
as opposed to workout execution *reality*, which is `userId`-owned) is
scoped by `athleteProfileId`. `AthleteProfile` itself models a practical
1:1 relationship with `User` (one profile resolved-or-created per user,
`identity-resolver.service.ts`). `GymProfile` is training context, not
execution reality — it follows the `Program`/`athleteProfileId`
precedent, not the `WorkoutSession`/`userId` one.

---

## 2. Three concepts, kept separate (unchanged)

| Concept | Example | Where it lives |
|---|---|---|
| **A. Load value** | `{amountMilli: 40000, unit: KG, basis: PER_IMPLEMENT}` | `PlannedSet.targetLoad` (unchanged, Load Model V1). |
| **B. Loading profile / mechanism** | `FIXED_INCREMENT`, `ENUMERATED_LIST` | The `kind` discriminant on `loading_capabilities` (§7). |
| **C. Loading capability** | "this gym's dumbbells are `2 kg` apart" | The actual increment/list data on that row. |

---

## 3. V1 scope (unchanged — Load Model Stage 1 only)

Exactly `EXTERNAL_WEIGHT` / `KG,LB` / `TOTAL,PER_IMPLEMENT`. No speculative
expansion to `BODYWEIGHT`/`ASSISTANCE_WEIGHT`/`MACHINE_LEVEL`/bands.

---

## 4. The critical context problem (unchanged, restated)

`athleteProfileId + exerciseRef` alone is insufficient — the same
`exerciseRef` can have different selectable loads in different gyms. A
context-aware model is required.

---

## 5. Final model: explicit exercise-to-capability binding (revised)

### 5.1 No general fallback — every resolution requires an exact, explicit binding

```
target GymProfile + exact exerciseRef
        -> an explicit binding row exists?
             YES -> that binding's LoadingCapability (validated for unit/basis, §8)
             NO  -> LOADING_CAPABILITY_UNAVAILABLE
```

**There is no `unit`/`basis`-wide, `exerciseRef = NULL`, or any other
implicit fallback.** Every exercise that is to receive a numeric
`INCREASE_LOAD` resolution must have its own explicit binding row — no
exceptions, no "close enough" match.

### 5.2 Shared physical equipment is still representable, explicitly

Several exercises MAY legitimately point their own, separate binding rows
at the **same** `LoadingCapability` row:

```
LoadingCapability A: kind=ENUMERATED_LIST, unit=KG, basis=PER_IMPLEMENT,
                      loads=[20000,22000,24000,26000,28000]

Binding: (gymProfile, "incline-db-press")  -> A
Binding: (gymProfile, "flat-db-press")     -> A
Binding: (gymProfile, "one-arm-db-row")    -> A
```

This correctly represents "these three exercises share one dumbbell
rack" **without inventing an `Equipment`/`EquipmentType`/`EquipmentFamily`/
`GymMachineCatalog` taxonomy** — the sharing is real, but it is always an
*explicit, per-exercise, athlete/product-authored decision* recorded as a
real row, never an implicit consequence of matching `unit`/`basis`. No
`ExerciseFamily`, no fuzzy matching, anywhere.

### 5.3 No equipment taxonomy in V1 (Decision 4, confirmed)

`exercise_loading_capability_bindings` **is** the V1 seam. A future,
richer equipment model (a real, named `Equipment` entity with its own
identity, separate from any one exercise) could sit *underneath*
`LoadingCapability` later — e.g. `loading_capabilities.equipment_id`
added additively — without changing anything about how
`ExerciseLoadingCapabilityBinding` or Progression Application consume it.
Not built here; not required by anything in this document.

### 5.4 One default `GymProfile` per athlete in V1 (unchanged from the first pass)

`gym_profiles` is a real table (multiple profiles representable), but V1
only ever creates exactly one, `is_default = true` (partial unique index,
same shape as `program_versions_one_active_per_program`). See §10 for the
creation lifecycle (revised, reasoned explicitly rather than copied).

---

## 6. Loading Capability identity (unchanged in shape, now purely a payload key)

`loading_capabilities` no longer carries `exerciseRef` at all — identity
is now just `(gymProfileId, unit, basis)` **plus a server-generated id**;
multiple distinct capability rows may legitimately exist for the *same*
`(gymProfileId, unit, basis)` (Barbell Bench's `+2.5` and Leg Press's
`+10` are two separate rows, both `KG`/`TOTAL`, in the same gym) — there
is no uniqueness constraint on `(gymProfileId, unit, basis)` alone. The
*binding* table is what ties a specific capability to a specific exercise
(§7.2).

---

## 7. Data model (pseudo-SQL, revised, no migration)

```text
TABLE app.gym_profiles
  id                 uuid PRIMARY KEY
  athlete_profile_id uuid NOT NULL REFERENCES app.athlete_profiles(id)  -- NO ACTION
  name               text NOT NULL DEFAULT 'My Gym'  -- athlete-editable label, not identity
  is_default         boolean NOT NULL DEFAULT true
  created_at         timestamptz NOT NULL DEFAULT now()
  updated_at         timestamptz NOT NULL DEFAULT now()

UNIQUE INDEX gym_profiles_one_default_per_athlete
  ON (athlete_profile_id) WHERE is_default = true

-- 7.1
TABLE app.loading_capabilities
  id                     uuid PRIMARY KEY
  gym_profile_id         uuid NOT NULL REFERENCES app.gym_profiles(id)  -- NO ACTION
  unit                   plan_load_unit_enum NOT NULL   -- reuse existing KG/LB enum
  basis                  plan_load_basis_enum NOT NULL  -- reuse existing TOTAL/PER_IMPLEMENT enum
  kind                   loading_capability_kind_enum NOT NULL  -- ('FIXED_INCREMENT','ENUMERATED_LIST')
  increment_amount_milli integer NULL   -- required iff kind = FIXED_INCREMENT
  loads_milli            integer[] NULL -- required iff kind = ENUMERATED_LIST; app-layer-enforced
                                         -- strictly ascending + unique at every write
  -- Decision 7: explicit monotonic revision — never rely on updated_at
  -- alone as semantic-change identity. Incremented by the (future,
  -- unimplemented) write path on ANY change to kind/unit/basis/
  -- increment_amount_milli/loads_milli.
  revision               integer NOT NULL DEFAULT 1
  created_at             timestamptz NOT NULL DEFAULT now()
  updated_at             timestamptz NOT NULL DEFAULT now()

CHECK (
  (kind = 'FIXED_INCREMENT') = (increment_amount_milli IS NOT NULL)
  AND (kind = 'ENUMERATED_LIST') = (loads_milli IS NOT NULL)
)
CHECK (increment_amount_milli IS NULL OR increment_amount_milli > 0)
CHECK (loads_milli IS NULL OR array_length(loads_milli, 1) >= 1)
CHECK (  -- uniqueness within the list is DB-enforceable; strict ascending
         -- order is an application-layer write-time invariant (documented,
         -- not practically expressible as a portable CHECK)
  loads_milli IS NULL
  OR array_length(loads_milli, 1) = (SELECT count(DISTINCT x) FROM unnest(loads_milli) x)
)

-- 7.2 — the V1 seam (§5.3): explicit, exact exerciseRef -> capability
TABLE app.exercise_loading_capability_bindings
  id                    uuid PRIMARY KEY
  gym_profile_id        uuid NOT NULL REFERENCES app.gym_profiles(id)  -- NO ACTION
  exercise_ref          text NOT NULL
  loading_capability_id uuid NOT NULL REFERENCES app.loading_capabilities(id)  -- NO ACTION
  created_at            timestamptz NOT NULL DEFAULT now()
  updated_at            timestamptz NOT NULL DEFAULT now()

UNIQUE INDEX exercise_loading_capability_bindings_one_per_exercise
  ON (gym_profile_id, exercise_ref)
  -- at most one CURRENT binding per exerciseRef per gym (Decision 3's
  -- "one exerciseRef has at most one current binding" invariant) — a
  -- rebind is an UPDATE of loading_capability_id in place, not a new row;
  -- no separate binding-history table is introduced in V1 (the audit
  -- trail lives entirely in the per-application capability snapshot,
  -- §9.2, which is sufficient — see §16's own reasoning for why binding
  -- history is not separately versioned)
```

**Same-gym invariant** (`loading_capabilities.gym_profile_id` must equal
`exercise_loading_capability_bindings.gym_profile_id` for any bound row):
not expressible as a plain Postgres `CHECK` (it spans two tables) —
enforced at the application/service-layer write path (the same kind of
invariant `progression_applications`' own cross-table preconditions
already rely on service-layer enforcement for, not a DB trigger, matching
this codebase's existing convention of preferring explicit service logic
over triggers).

**Each other non-obvious constraint explained**: the `kind`/payload CHECK
mirrors `planned_sets_load_all_or_nothing`'s existing "never a partial
representation" discipline. `loading_capabilities` rows are never
hard-deleted while any `exercise_loading_capability_bindings` row or any
`progression_applications.loading_capability_id` still references them —
plain `NO ACTION` FKs already guarantee this; "removing" equipment in
product terms means deleting/repointing the *binding*, never the
capability row an old application's audit trail may still point to.

**No migration is created by this document.** Purely additive: three new
tables, one new enum (`loading_capability_kind`), reusing the existing
`plan_load_unit`/`plan_load_basis` enums.

---

## 8. Loading Capability kinds (unchanged — both retained)

```ts
type FixedIncrementCapabilityV1 = {
  readonly kind: "FIXED_INCREMENT";
  readonly incrementAmountMilli: number; // integer, scale 1000
};

type EnumeratedListCapabilityV1 = {
  readonly kind: "ENUMERATED_LIST";
  readonly loadsMilli: readonly number[]; // strictly ascending, unique, integer, scale 1000
};
```

**`FIXED_INCREMENT`**: `next = current + incrementAmountMilli`. No
floating point anywhere. **`PER_IMPLEMENT` never doubles the increment** —
`40 kg each` + `2 kg each` = `42 kg each`, exactly matching the existing,
unmodified `resolveNextLoad()` behavior.

**`ENUMERATED_LIST`** (a proposed sibling resolution function,
`resolveNextLoadFromEnumeratedList(current, sortedLoadsMilli)`, alongside
`resolveNextLoad()` — not implemented here): `current.amountMilli` **must
exactly exist** in the list — if not, `CURRENT_LOAD_UNSUPPORTED`, never a
nearest-neighbor guess. If it exists but is already the maximum entry,
`NO_SUITABLE_INCREMENT`. Otherwise, `RESOLVED` with the immediate
next-higher entry. Ordering/uniqueness is enforced at write time (§7.1),
never at read time.

---

## 9. Resolution timing (revised — Apply-time-authoritative only)

### 9.1 No capability resolution is ever persisted while `PENDING_REVIEW`

The first draft of this document resolved and snapshotted a capability at
`progression_applications` *creation* time. **This is corrected**: an
`INCREASE_LOAD` `EngineDecision`/application workflow remains valid
regardless of later capability edits — workflow lifetime and immutable
applied audit are different concerns. A `PENDING_REVIEW` card's numeric
preview (ADAPTIVE/EXPERT) is computed **live, on read, every time** —
ephemeral, never stored, always reflecting the current binding/capability
state (`ProgressionApplicationService.previewResolution(...)`,
`docs/domain/PROGRESSION-APPLICATION-V1.md` §30).

### 9.2 Only the Apply transaction persists an authoritative snapshot

At the moment of a successful Apply (human-confirmed, or GUIDED's own
durable job), the live resolution is re-run **inside the same
transaction** (`docs/domain/PROGRESSION-APPLICATION-V1.md` §12) and
**snapshotted**, immutably, onto the consuming `progression_applications`
row: `loadingCapabilityId`, `loadingCapabilityRevision` (the capability's
own `revision` column at that exact moment, §7.1), and
`loadingCapabilitySnapshot` (the exact `kind`/increment-or-list/unit/
basis payload as it existed then). `loading_capabilities` rows remain
mutable afterward — an athlete correcting their gym's increment can never
retroactively change how an already-`APPLIED` application is explained,
because the *snapshot*, not the live row, is the permanent audit record
(the same discipline `progression_decisions.normalizedInputSnapshot`
already established in Slice C).

### 9.3 A capability change between preview and Apply is a refresh, never a terminal failure

If the live resolution at Apply time differs from what a human's
`expectedProposal` (captured from their last preview) claims —
**`PROPOSAL_REFRESH_REQUIRED`** (`docs/domain/PROGRESSION-APPLICATION-V1.md`
§8.5), not `STALE`. No write occurs; the *same* `PENDING_REVIEW` row is
re-shown with a fresh preview and re-confirmed. **This is never confused
with `STALE`**: the underlying `EngineDecision` and its `PlannedSet`/
`ProgramVersion` preconditions are completely unaffected by an equipment
correction — only the *numeric preview* needs refreshing. See
`PROGRESSION-APPLICATION-V1.md` §8.6 for the explicit statement that a
capability change never sets `status = 'STALE'`.

### 9.4 Capability/binding removed before Apply

If a previously-previewed binding is later removed or repointed, the live
resolution at Apply time simply comes back `LOADING_CAPABILITY_UNAVAILABLE`
— the workflow remains the same valid, reviewable recommendation; no Plan
mutation occurs; nothing is fabricated to match a preview that once
existed.

---

## 10. Application-time resolution outcomes (final vocabulary — unchanged set, now consistently Apply-time-scoped)

Five terminal-for-this-attempt (but never workflow-terminal) codes, plus
one race-specific outcome owned by Progression Application itself
(`PROPOSAL_REFRESH_REQUIRED`, §9.3 — listed there, not here, since it is
about a *human's stale preview*, not the capability data itself):

| Code | When |
|---|---|
| `NO_CURRENT_LOAD` | The current effective target (`PROGRESSION-APPLICATION-V1.md` §22) is `null` — nothing to increase from. |
| `LOADING_CAPABILITY_UNAVAILABLE` | No explicit binding exists for this exact `(gymProfileId, exerciseRef)` (§5.1). |
| `CURRENT_LOAD_UNSUPPORTED` | A bound capability exists, but `current`'s exact `amountMilli` isn't in its `ENUMERATED_LIST` (§8). Never rounds. |
| `CAPABILITY_INCOMPATIBLE` | The bound capability's `(unit, basis)` doesn't exactly match the current load's own (§11). Never converted. |
| `NO_SUITABLE_INCREMENT` | A compatible, representable capability exists, but no higher value is available. |

None of these is ever a hard, permanent failure for the underlying
recommendation — every one is re-attempted fresh on the next live
resolution (a new preview, a corrected binding, or GUIDED's next
evaluation cycle), per §9.3/§9.4.

---

## 11. Unit / basis validation (unchanged)

Exact match required. No `KG`<->`LB` conversion, no `TOTAL`<->
`PER_IMPLEMENT` reinterpretation, ever — matching `resolveNextLoad()`'s
own existing `INVALID_CAPABILITY` behavior exactly.

---

## 12. Exercise substitution (unchanged, now via the binding table directly)

A swapped exercise simply has (or doesn't have) its own independent
binding — Progression Application's own stream identity already refuses
to cross an `exerciseRef` change (`PROGRESSION-APPLICATION-V1.md` §2.3/
§20) before capability is even consulted for the new exercise. No
carry-over of the old exercise's binding is possible or attempted.

---

## 13. Prescription snapshot (unchanged)

`WorkoutPrescriptionV1` snapshots none of this. Active Workout logs
arbitrary real load offline regardless of any capability/binding
configuration existing at all.

---

## 14. Standard full-gym presets and future onboarding (unchanged in substance)

No system-guessed universal default. A future `STANDARD_FULL_GYM` preset
remains compatible with this architecture *only* as an explicit,
athlete-consented action that writes real `loading_capabilities` +
`exercise_loading_capability_bindings` rows the athlete opted into — never
a silent default. Until configured, most exercises correctly and honestly
resolve to `LOADING_CAPABILITY_UNAVAILABLE` — safe, expected V1 behavior.
Athlete-observed learning (future) always requires explicit confirmation
before writing a real row. Coach configuration (future) is additive, not
required here.

---

## 15. Relationships and BOLA (updated for the binding table)

```
AthleteProfile (1) -> GymProfile (1 default in V1, N schema-capable)
GymProfile (1) -> LoadingCapability (N)
GymProfile (1) -> ExerciseLoadingCapabilityBinding (N, one per exerciseRef)
ExerciseLoadingCapabilityBinding -> LoadingCapability (same gym, enforced
                                     at the service layer, §7)
Progression Application -> resolves via (athlete's default GymProfile, the
                            source's own exerciseRef) -> binding -> capability
```

Every read/write on all three new tables is scoped through
`athleteProfileId`, re-derived server-side — never trusted from a request.
A client may select/edit only its own athlete's rows. The resolver never
accepts a client-supplied capability value as authoritative — it always
re-reads the athlete's own persisted binding/capability server-side, at
Apply time (§9.2). Coach write access remains gated behind the same
not-yet-built `CoachingRelationship` permission scope as every other
coach-authority question in this feature set.

---

## 16. GymProfile creation lifecycle (Decision 19 — reasoned recommendation, not a copy-paste of AthleteProfile's own trigger)

**Three options evaluated**:

- **A — alongside `AthleteProfile` identity creation**: every athlete
  would get a `GymProfile` row the moment they're identified, even if they
  never configure any equipment or ever intend to use numeric progression.
  Rejected: creates a meaningless row for the (likely common, at least
  initially) athlete who never configures a capability — `GymProfile`
  itself isn't "genuinely required before any capability exists," only
  *when* the first capability is created.
- **B — lazily, on first equipment/capability configuration** (chosen):
  the default `GymProfile` is resolved-or-created (the same idempotent
  *mechanism* as `AthleteProfile`'s own resolution, `identity-resolver.
  service.ts`'s `resolveOrCreateIdentity` — reused for its pattern, not
  blindly copied wholesale) at the exact moment the athlete's first
  `LoadingCapability`/binding write happens — whatever future settings/
  onboarding surface performs that write is responsible for triggering
  this resolve-or-create call first. No meaningless rows for an athlete
  who never configures anything.
- **C — during Plan/onboarding setup**: rejected — real Plan/Program
  generation doesn't exist yet (`PROGRESSION-APPLICATION-V1.md` §1.2's own
  finding); coupling `GymProfile` creation to a feature that isn't built
  would be a worse, more fragile dependency than Option B's narrower
  trigger.

**Recommendation: B.** The *mechanism* (idempotent resolve-or-create) is
reused from the existing identity precedent; the *trigger point* is
deliberately different and narrower — the first real capability write,
not identity resolution itself.

---

## 17. Migration path (unchanged — additive only)

Three new tables, one new enum, reusing two existing enums. No existing
table altered. No historical workout data touched, no `ProgramVersion`
touched, no mobile SQLite migration.

---

## 18. Security delta (updated for three tables)

| Threat | Control |
|---|---|
| BOLA — read/write another athlete's `GymProfile`/`LoadingCapability`/binding | Ownership re-derived server-side via `athleteProfileId`, never a request parameter. |
| Forged capability/binding id during Apply | The resolver always re-reads the athlete's own persisted binding/capability server-side at Apply time (§9.2) — never accepts a client-supplied value as authoritative. |
| Cross-athlete `GymProfile` reference | Same BOLA control. |
| Tampered unit/basis | `CAPABILITY_INCOMPATIBLE` (§11) — never coerced. |
| Manual override abuse | A separate, already-audited path (`PROGRESSION-APPLICATION-V1.md` §15), never confused with or able to rewrite the resolver's own recorded recommendation. |
| Coach permission (future) | Gated behind a real, active `CoachingRelationship` + permission scope — not built here. |

---

## 19. Performance (unchanged)

Tiny data volume — indexed relational lookups (the unique indexes in §7
double as the lookup path). No cache, no Redis, no new infrastructure.

---

## 20. Worked examples (revised set — explicit binding, Apply-time resolution)

**A — Shared dumbbell rack**: Capability A (`ENUMERATED_LIST`,
`[20,22,24,26]`); bindings `Incline DB Press -> A`, `Flat DB Press -> A`.
Both correctly resolve `24 -> 26` via their own independent bindings to
the same capability.

**B — Same unit/basis, different equipment, no collision**: Bench's
binding points at Capability B (`FIXED_INCREMENT +2.5 KG TOTAL`); Leg
Press's binding points at Capability C (`FIXED_INCREMENT +10 KG TOTAL`) —
two entirely separate rows, no shared fallback, despite identical
`unit`/`basis`.

**C — Missing binding**: an exercise exists in the Plan but has no
`exercise_loading_capability_bindings` row in the athlete's `GymProfile`
-> `LOADING_CAPABILITY_UNAVAILABLE` -> no overlay write; the
recommendation remains valid, reviewable evidence.

**D — Capability corrected before an ADAPTIVE Apply**: UI previews
`100 -> 102.5` -> the athlete corrects the bound capability's increment to
`+5` (a new `revision`) before tapping Apply -> the Apply transaction's
live re-resolution finds `100 -> 105`, which doesn't match the submitted
`expectedProposal` (`102.5`) -> **`PROPOSAL_REFRESH_REQUIRED`**, no write
-> UI re-previews `100 -> 105` -> athlete confirms again -> `105` is
applied. **Same `progression_decisions` row, same `progression_applications`
row, throughout** (`PROGRESSION-APPLICATION-V1.md` Example K).

**E — GUIDED**: the durable job resolves live at the moment it runs
(current binding/capability, `+5` in this example) -> `105` -> snapshots
`loadingCapabilityId`/`revision`/payload -> applies atomically. No
separate preview step exists for GUIDED at all.

**F — Capability changed AFTER Apply**: an already-`APPLIED` application's
audit stays exactly `revision 3, snapshot +2.5, resolverProposedLoad
102.5` forever, even though the *live* capability may now be `revision 4,
+5` — history never changes.

**G — Binding removed/repointed before Apply**: live resolution now
returns `LOADING_CAPABILITY_UNAVAILABLE` -> no Plan mutation -> the
recommendation remains valid evidence; nothing is fabricated to match a
preview that once existed.

**H — Enumerated current value absent**: list `[20,22,24]`, current `23`
-> `CURRENT_LOAD_UNSUPPORTED` -> no rounding.

---

## 21. Test strategy delta (revised for the binding model + Apply-time resolution)

Domain: `ENUMERATED_LIST` resolver sibling (ordering/uniqueness/missing-
current/top-of-list); `FIXED_INCREMENT`'s existing behavior unmodified.

Database: BOLA on all three tables; the same-gym invariant (service-layer
enforced) rejecting a cross-gym binding attempt; `exercise_loading_
capability_bindings`' one-per-exercise unique index under concurrent
writes; `loading_capabilities.revision` incrementing correctly on every
resolver-relevant field change.

Application composition: every §10 outcome code independently reachable;
the `PROPOSAL_REFRESH_REQUIRED` race (Example D) as a real concurrent-edit
integration test; GUIDED's live-at-apply-time resolution (Example E);
`APPLIED` snapshot immutability across a later capability edit (Example
F); a shared-capability scenario (Example A) proving no duplication is
required for correctness.

Cross-cutting: KG/LB and TOTAL/PER_IMPLEMENT mismatch, never converted;
integer-only arithmetic throughout; PER_IMPLEMENT never doubled.

Not implemented now.

---

## Open decisions (genuine only)

1. **Whether/when a real multi-`GymProfile` UX is built**, and how
   Progression Application would then select *which* profile governs a
   given occurrence. Not reachable in V1 (§5.4 — exactly one profile per
   athlete by construction).
2. **`CoachingRelationship` mechanics** — unchanged, pre-existing,
   doesn't block the athlete-only path.

No other open items — the explicit binding model, the revision counter,
the Apply-time-only resolution/snapshot discipline, the
`PROPOSAL_REFRESH_REQUIRED` race handling, and the default-`GymProfile`
lazy-creation lifecycle are all fully specified.

---

## Implementation evidence — Loading Capability Foundation V1 (2026-09-23)

Slice A only (foundation — schema, pure domain model, lookup/write
primitives). Progression Application's own Apply workflow, PENDING_REVIEW,
the effective-target resolver, GUIDED auto-apply, and coach mechanics are
**not** implemented by this slice — see Progression Application V1's own
implementation plan.

**Pure domain** (`packages/domain/src/load/`): `resolveNextLoadFromEnumeratedList()`
and the unified `resolveNextLoadFromCapability()` dispatcher added
alongside the pre-existing, unmodified `resolveNextLoad()`/
`LoadIncrementCapability` (zero regression — every prior test stays
green). `LoadResolutionResult` gained one additive variant,
`CURRENT_LOAD_UNSUPPORTED`. `validateEnumeratedListLoads()`
(`validate-load.ts`) is the actual "strictly ascending, unique, positive"
enforcement boundary — see below for why Postgres itself cannot express
it.

**Schema** (`packages/database/src/schema/loading-capability.ts`, migration
`0010_harsh_lake.sql`, purely additive). Exact statement counts, verified
directly against the migration file (not estimated): **1** `CREATE TYPE`
(`app.loading_capability_kind`), **3** `CREATE TABLE` (`gym_profiles`,
`loading_capabilities`, `exercise_loading_capability_bindings`), **4**
`ALTER TABLE` (foreign-key additions), **2** `CREATE UNIQUE INDEX` (0
plain `CREATE INDEX`). `loading_capabilities` carries payload only (no
`exerciseRef`); `exercise_loading_capability_bindings` is the V1 seam.
Real, DB-enforced invariants proven against actual Postgres, not
simulated: at most one default `GymProfile` per athlete (partial unique
index); the same-gym binding invariant via a genuine composite foreign key
(`(gym_profile_id, loading_capability_id) REFERENCES
loading_capabilities(gym_profile_id, id)`) — a cross-gym bind attempt is
rejected by Postgres itself. **Documented, accepted limitation**: strictly-
ascending/unique ordering within `enumerated_loads_milli` is NOT a
Postgres `CHECK` constraint (Postgres forbids a subquery inside one, which
that rule would need, and no custom SQL function was introduced for this
single rule) — it is enforced only at the domain/write-boundary layer,
proven by a real-Postgres test showing a malformed array bypassing that
layer via raw SQL is *not* rejected by the database.

**Fail-closed defense-in-depth (evidence-gate finding, 2026-09-23)**: the
above limitation means malformed `enumerated_loads_milli` data can reach
the read path if something ever bypasses the write boundary. Empirical
testing found that `resolveNextLoadFromEnumeratedList()` did **not**
originally fail closed in that case — given the malformed list `[20000,
24000, 22000]` with a current load of `24000`, it returned `RESOLVED` with
`22000`, a value *lower* than current, because it indexed positionally
into the array without checking whether the array was actually ordered.
This was fixed: the resolver now re-validates `loadsMilli` with the same
`validateEnumeratedListLoads()` used at the write boundary, on every call,
before ever indexing into it, returning a new `INVALID_CAPABILITY` reason,
`MALFORMED_CAPABILITY`, if that validation fails — no sorting, no repair,
no exception. This means a malformed persisted `ENUMERATED_LIST` can never
produce a resolved load, even though Postgres itself still does not (and,
per the limitation above, cannot) enforce the ordering/uniqueness rule.
Proven by three new pure-domain unit tests
(`packages/domain/src/load/load-resolver.test.ts`,
`LOADCAP-LR-012`/`013`/`014`) and one real-Postgres end-to-end integration
test (`LOADCAP-016c`, below) that inserts malformed data via raw SQL,
binds it, resolves it through `resolveBoundCapability()`, and feeds that
straight into `resolveNextLoadFromCapability()`.

**Server-side primitives** (`packages/progression-application/src/{gym-profile,
loading-capability-lookup,loading-capability-write}.ts`, framework-agnostic,
no Nest): `getOrCreateDefaultGymProfileForAthlete()` (idempotent,
concurrency-proven via a real simultaneous-call test — the DB partial
unique index is the actual race guard, not application logic),
`resolveBoundCapability()` (exact-`exerciseRef`-only, no fallback — its
output feeds `resolveNextLoadFromCapability()` directly with no hidden
DB/framework knowledge, proven by a dedicated boundary test),
`createLoadingCapability()`/`updateLoadingCapabilityPayload()` (the latter
increments `revision`, never relies on `updatedAt`)/`bindExerciseToCapability()`.

**Least privilege**: no new grant statements were needed at all — the
three new tables automatically inherited `SELECT/INSERT/UPDATE/DELETE` for
`vostivo_api` via the pre-existing `ALTER DEFAULT PRIVILEGES` mechanism
(`bootstrap-roles.ts`), verified directly against Postgres on both the
existing dev database and a fresh throwaway container (0000→0010).

**Real Postgres integration tests**: 19 `it()` blocks
(`packages/progression-application/src/loading-capability.integration.test.ts`,
covering 22 distinct numbered acceptance-criteria labels since three
blocks each verify two related items in one transaction:
`LOADCAP-006/018`, `LOADCAP-007/018`, `LOADCAP-014/015`) covering every
item in the required test matrix — default-gym uniqueness and
concurrency, FIXED_INCREMENT/ENUMERATED_LIST round-trips, multiple
capabilities coexisting per gym, binding uniqueness and shared-capability
reuse, the cross-gym same-gym-invariant negative proof, a full BOLA
composition proof (actor A can never resolve actor B's capability),
revision incrementing, the payload-kind CHECK constraint, the documented
ordering-enforcement limitation at the database level (`LOADCAP-016b`,
both the rejecting and the bypassing case), its full end-to-end
fail-closed consequence at the resolver level (`LOADCAP-016c`, above), the
`NOT NULL exerciseRef` constraint, and the domain-to-lookup composition
seam.

**Regression**: full monorepo `lint`/`typecheck`/`test`/`build`/
`boundaries:check` green; all pre-existing progression/workout/
orchestration integration tests re-verified green after the migration —
no regression.
