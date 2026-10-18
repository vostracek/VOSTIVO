import { boolean, check, foreignKey, integer, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { appSchema, athleteProfiles } from "./identity.js";
import { plannedSetLoadBasisEnum, plannedSetLoadUnitEnum } from "./plan.js";

/**
 * Loading Capability V1 (`docs/domain/LOADING-CAPABILITY-V1.md`, ADR-0010,
 * Accepted). The prerequisite Progression Application V1 needs before it
 * can resolve a real, physically-achievable next load for `INCREASE_LOAD` —
 * see that document's own repository-findings section for why nothing
 * like this existed before this slice. All foreign keys are `NO ACTION`
 * (never `CASCADE`), matching this schema's universal "never let an
 * accidental cascading delete erase historical/configuration truth"
 * convention.
 *
 * `unit`/`basis` deliberately reuse `plannedSetLoadUnitEnum`/
 * `plannedSetLoadBasisEnum` (`plan.ts`) rather than declaring a second,
 * independently-drifting copy of the same tiny KG/LB, TOTAL/PER_IMPLEMENT
 * vocabulary — the enum's Postgres name (`planned_set_load_unit`) reads a
 * little oddly for a table that isn't about planned sets, but a locked
 * shared vocabulary drifting apart across two enum types would be a real
 * bug risk this reuse avoids entirely.
 */

/**
 * One athlete's equipment context. V1 creates exactly one, lazily, on the
 * athlete's first real capability configuration write — never merely
 * because a user authenticated (`LOADING-CAPABILITY-V1.md` §16) — but the
 * table itself already supports multiple profiles per athlete for a
 * future multi-gym feature, without a destructive migration later.
 */
export const gymProfiles = appSchema.table(
  "gym_profiles",
  {
    id: uuid("id").primaryKey(),
    athleteProfileId: uuid("athlete_profile_id")
      .notNull()
      .references(() => athleteProfiles.id),
    name: text("name").notNull().default("My Gym"),
    isDefault: boolean("is_default").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // At most one default GymProfile per athlete — a real DB-enforced
    // invariant, the same `UNIQUE INDEX ... WHERE <flag>` shape ADR-0008
    // already established for `program_versions_one_active_per_program`.
    uniqueIndex("gym_profiles_one_default_per_athlete")
      .on(table.athleteProfileId)
      .where(sql`${table.isDefault} = true`),
  ],
);

export const LOADING_CAPABILITY_KIND_VALUES = ["FIXED_INCREMENT", "ENUMERATED_LIST"] as const;
export const loadingCapabilityKindEnum = appSchema.enum(
  "loading_capability_kind",
  LOADING_CAPABILITY_KIND_VALUES,
);

/**
 * One actual selectable-load system (e.g. "this gym's barbell," "this
 * gym's dumbbell rack") — deliberately carries NO `exerciseRef`. Several
 * distinct capability rows may share the same `(gymProfileId, unit,
 * basis)` (a gym's barbell `+2.5 kg TOTAL` and its leg press `+10 kg
 * TOTAL` are two separate rows, both `KG`/`TOTAL`) — which exercise uses
 * which capability is decided exclusively by
 * `exerciseLoadingCapabilityBindings`, never inferred here.
 *
 * `revision` is the explicit, monotonic semantic-change identity
 * (`LOADING-CAPABILITY-V1.md` §7.1) — a future write path increments it on
 * any change to `kind`/`unit`/`basis`/the payload columns; `updatedAt`
 * alone is never used as concurrency/audit identity, since an
 * application's own snapshot needs to prove exactly which *semantic*
 * version of a capability it used, not merely when the row was last
 * touched.
 *
 * Ordering/uniqueness within `enumeratedLoadsMilli` ("strictly ascending,
 * no duplicates") is NOT expressed as a Postgres `CHECK` constraint —
 * Postgres forbids a subquery inside a `CHECK` expression (which is what
 * an array-uniqueness/ordering check would need, e.g. via `unnest`), and
 * this schema does not introduce a custom SQL function for the one rule
 * that would require it (no other table in this schema uses one; adding
 * the first for this alone would be disproportionate). That invariant is
 * therefore enforced at the domain/application write boundary
 * (`validateEnumeratedListLoads`, `packages/domain/src/load/
 * validate-load.ts`) and proven by a real-Postgres test that a
 * bad-ordered array bypassing that boundary via raw SQL is NOT rejected
 * by the database — a documented, accepted V1 limitation, not an
 * oversight.
 */
export const loadingCapabilities = appSchema.table(
  "loading_capabilities",
  {
    id: uuid("id").primaryKey(),
    gymProfileId: uuid("gym_profile_id")
      .notNull()
      .references(() => gymProfiles.id),
    unit: plannedSetLoadUnitEnum("unit").notNull(),
    basis: plannedSetLoadBasisEnum("basis").notNull(),
    kind: loadingCapabilityKindEnum("kind").notNull(),
    revision: integer("revision").notNull().default(1),
    /** Required iff `kind = 'FIXED_INCREMENT'`. Same fixed-precision integer representation as `ExternalWeightLoad.amountMilli` (scale 1000). */
    fixedIncrementAmountMilli: integer("fixed_increment_amount_milli"),
    /** Required iff `kind = 'ENUMERATED_LIST'`. Application-validated strictly-ascending, unique, positive integers — see the table doc comment. */
    enumeratedLoadsMilli: integer("enumerated_loads_milli").array(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // The target of exercise_loading_capability_bindings' composite FK
    // below — makes "this capability belongs to this exact gym" a real,
    // independently-referenceable fact (id is already globally unique via
    // the primary key; this adds gymProfileId alongside it).
    unique("loading_capabilities_gym_profile_id_id_unique").on(table.gymProfileId, table.id),
    check("loading_capabilities_revision_positive", sql`${table.revision} >= 1`),
    check(
      "loading_capabilities_payload_matches_kind",
      sql`(${table.kind} = 'FIXED_INCREMENT' AND ${table.fixedIncrementAmountMilli} IS NOT NULL AND ${table.enumeratedLoadsMilli} IS NULL)
          OR (${table.kind} = 'ENUMERATED_LIST' AND ${table.enumeratedLoadsMilli} IS NOT NULL AND ${table.fixedIncrementAmountMilli} IS NULL)`,
    ),
    check(
      "loading_capabilities_fixed_increment_positive",
      sql`${table.fixedIncrementAmountMilli} IS NULL OR ${table.fixedIncrementAmountMilli} > 0`,
    ),
    check(
      "loading_capabilities_enumerated_loads_nonempty",
      sql`${table.enumeratedLoadsMilli} IS NULL OR array_length(${table.enumeratedLoadsMilli}, 1) >= 1`,
    ),
  ],
);

/**
 * The V1 seam (`LOADING-CAPABILITY-V1.md` §5.3): an explicit, exact-
 * `exerciseRef` link from one programmed exercise to the one
 * `LoadingCapability` it uses in a given `GymProfile`. No fallback of any
 * kind exists — an exercise with no binding row here simply has no
 * resolvable capability. Several exercises may point at the SAME
 * `loadingCapabilityId` (representing genuinely shared equipment, e.g. a
 * dumbbell rack) — always as an explicit, separate row per exercise,
 * never an implicit consequence of matching `unit`/`basis`.
 *
 * A rebind is an `UPDATE` of `loadingCapabilityId` in place — no separate
 * binding-history table exists in V1; the audit trail for what a
 * *consumed* application actually used lives entirely in that
 * application's own immutable capability snapshot, which is sufficient
 * (`LOADING-CAPABILITY-V1.md` §7.2).
 */
export const exerciseLoadingCapabilityBindings = appSchema.table(
  "exercise_loading_capability_bindings",
  {
    id: uuid("id").primaryKey(),
    gymProfileId: uuid("gym_profile_id")
      .notNull()
      .references(() => gymProfiles.id),
    exerciseRef: text("exercise_ref").notNull(),
    // No plain single-column FK here — the composite FK below already
    // requires this to reference a real loading_capabilities.id, AND
    // additionally enforces that it belongs to the SAME gymProfileId as
    // this row (the "same-gym invariant", §below) — a second, redundant
    // single-column FK would add nothing.
    loadingCapabilityId: uuid("loading_capability_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // At most one CURRENT binding per exerciseRef per gym (Decision 3 of
    // the Loading Capability V1 final reconciliation) — this IS the
    // primary lookup index too (exact-match resolution, §above).
    uniqueIndex("exercise_loading_capability_bindings_one_per_exercise").on(
      table.gymProfileId,
      table.exerciseRef,
    ),
    // The same-gym invariant (spec §13/ADR-0010's hard acceptance
    // criterion): a binding in Gym A can never reference a capability
    // owned by Gym B. Real, DB-enforced — never merely a service-layer
    // check — by referencing loading_capabilities' own composite unique
    // constraint on (gym_profile_id, id) above.
    foreignKey({
      columns: [table.gymProfileId, table.loadingCapabilityId],
      foreignColumns: [loadingCapabilities.gymProfileId, loadingCapabilities.id],
      name: "exercise_loading_capability_bindings_same_gym_fkey",
    }),
  ],
);
