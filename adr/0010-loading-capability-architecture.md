# ADR-0010: Loading Capability V1 — GymProfile + explicit exercise-to-capability binding

- **Status**: Accepted
- **Date**: 2026-09-23

**Reconciliation note (2026-09-23):** this ADR's first draft proposed a
two-tier `(gymProfileId, exerciseRef | NULL, unit, basis)` key, where a
`NULL` `exerciseRef` meant "the general capability for every exercise
sharing this unit/basis in this gym." The tech lead rejected this as an
unsafe unit/basis-wide fallback — a gym's barbell bench, leg press, and
cable row can share `KG`/`TOTAL` while having completely different real
capabilities, so a general fallback would have reintroduced the same
disguised generic-increment problem already rejected once. This revision
replaces it with an explicit per-exercise binding table (Decision below).

**Acceptance note (2026-09-23):** ACCEPTED. Four points specifically
confirmed by tech-lead final review: (1) the explicit
`exercise_loading_capability_bindings` table, exact-`exerciseRef`-only, is
approved — no general unit/basis fallback of any kind; (2) Apply-time-
authoritative resolution is approved — no capability resolution or
snapshot is ever persisted while a recommendation is merely
`PENDING_REVIEW`; (3) mutable `LoadingCapability` rows + an explicit
monotonic `revision` counter + an immutable per-application snapshot is
approved as sufficient auditability, over a separate capability-versioning
table; (4) the same-gym binding invariant is required to be a real
Postgres-enforced constraint, not service-layer-only discipline. Slice A
(Loading Capability Foundation V1 — schema, pure domain model, migration)
is approved to begin implementation on this basis.

## Context

Progression Application V1 (ADR-0009, Accepted) needs an explicit,
physically-real "next achievable load" for `INCREASE_LOAD`. No persisted
`GymProfile`/`LoadingProfile`/equipment-capability data exists anywhere in
this repository. `athleteProfileId + exerciseRef` alone is insufficient —
the same exercise can have different selectable loads in different gyms.
`ExerciseIdentityV1`/`exerciseRef` is, by its own doc comment, deliberately
not an equipment identity.

## Decision

Introduce three new, additive tables:

- `app.gym_profiles` — one row per athlete's equipment context; exactly
  one `is_default = true` row per athlete in V1 (a real DB partial unique
  index, mirroring `program_versions_one_active_per_program`), created
  lazily on the athlete's first real capability configuration (not
  bundled into identity resolution — see the specification document's
  §16 for the reasoned lifecycle choice).
- `app.loading_capabilities` — keyed by `(gymProfileId, unit, basis)` as
  a payload, with **no** identity role for `exerciseRef` at all; multiple
  distinct capability rows may exist for the same `(gymProfileId, unit,
  basis)` (a gym's barbell and its leg press are two separate rows, both
  `KG`/`TOTAL`). Each row carries a `kind` (`FIXED_INCREMENT` or
  `ENUMERATED_LIST`), its payload, and a monotonic `revision` integer
  (incremented on any resolver-relevant change — never `updated_at` alone
  as the semantic-change identity).
- `app.exercise_loading_capability_bindings` — the explicit link: `(gym_
  profile_id, exercise_ref)` unique, pointing at exactly one
  `loading_capability_id`. **This is the entire mechanism for "which
  exercise uses which physical capability."** No fallback of any kind
  exists — an exercise with no binding row simply resolves to
  `LOADING_CAPABILITY_UNAVAILABLE`.

Several exercises may point their own, separate binding rows at the same
`LoadingCapability` (representing genuinely shared equipment, e.g. a
dumbbell rack used by several exercises) — this is always an explicit,
per-exercise decision recorded as a real row, never an implicit
consequence of matching `unit`/`basis`.

Capability resolution is **Apply-time-authoritative only**: no resolution
is ever persisted while an application is `PENDING_REVIEW` (a
human-facing preview is computed live, on read, never stored); only a
successful Apply transaction resolves and snapshots
(`loadingCapabilityId`, `loadingCapabilityRevision`,
`loadingCapabilitySnapshot`) the capability actually used, immutably,
onto the consuming `progression_applications` row. A capability change
between a shown preview and a human's confirmed Apply produces a
non-terminal `PROPOSAL_REFRESH_REQUIRED` outcome (re-preview, re-confirm,
same workflow row) — never a silent re-resolution to a different number,
and never a terminal `STALE` (see `docs/domain/PROGRESSION-APPLICATION-V1.md`
§8.5/§8.6 for the full mechanics).

## Alternatives considered

- **A unit/basis-wide `exerciseRef = NULL` general fallback** (the first
  draft's own proposal): rejected — see the reconciliation note above.
- **Per-athlete + `exerciseRef` only** (no gym/equipment context at all):
  rejected — the original insufficiency this ADR exists to fix.
- **A fully separate, named equipment/loading-profile entity with an
  exercise-to-equipment mapping ("full Option C")**: not adopted — the
  explicit binding table already achieves equipment reuse (§5.2 of the
  specification) without a third concept; a future named-equipment entity
  remains a strictly additive extension underneath `LoadingCapability`
  (e.g. an optional `equipment_id` column), not a dead end.
- **A generic `DEFAULT_LOAD_INCREMENTS` fallback keyed only by unit/basis**:
  rejected (unchanged from the first draft's own reasoning).
- **A separate immutable capability-versioning table**: rejected —
  mutable rows + a `revision` counter + a per-application snapshot (§9.2
  of the specification) is sufficient, mirroring Slice C's own simpler,
  already-proven choice for an equivalent problem.
- **Resolving/snapshotting the capability at `progression_applications`
  creation time** (the first draft's own proposal): rejected — conflated
  workflow lifetime with immutable applied audit, and would have made an
  ordinary equipment correction needlessly destructive to an otherwise
  still-valid recommendation. Apply-time-only resolution, with a
  non-terminal refresh outcome for the human-review race, replaces it.

## Consequences

Easier: numeric `INCREASE_LOAD` resolution is built on an explicit,
unambiguous, athlete-owned data source, never a guess at any granularity;
shared equipment is representable without an equipment taxonomy;
correcting a wrong increment mid-review never destroys an otherwise-valid,
still-pending recommendation; an already-`APPLIED` progression remains
fully explainable forever regardless of later capability edits.

Harder: every exercise an athlete wants numeric auto-progression for needs
its own explicit binding row — there is no shortcut, so early real-world
usage will frequently hit `LOADING_CAPABILITY_UNAVAILABLE` until bindings
are populated (by an athlete, or a future opt-in preset) one exercise at a
time; "the same physical equipment" is still represented only implicitly
(several bindings pointing at one capability row), never as a first-class,
nameable object, until a future equipment-pool entity is built underneath
this one. Apply-time-only resolution means the Apply transaction itself
does more work (binding lookup, capability load, unit/basis check, resolve,
proposal-match check) than a pre-resolved value would — an accepted cost
given this traffic's own tiny volume (`docs/domain/
PROGRESSION-APPLICATION-V1.md` §37).
