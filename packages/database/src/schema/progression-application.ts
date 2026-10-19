import { check, foreignKey, index, integer, jsonb, primaryKey, text, timestamp, unique, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { appSchema, users } from "./identity.js";
import { loadingCapabilities } from "./loading-capability.js";
import { programVersions, trainingBlocks } from "./plan.js";
import type { PLANNED_SET_LOAD_BASIS_VALUES, PLANNED_SET_LOAD_UNIT_VALUES } from "./plan.js";
import { progressionDecisions } from "./progression.js";

/**
 * Progression Application V1 — Slice B (`docs/domain/
 * PROGRESSION-APPLICATION-V1.md`, ADR-0009, Accepted; implementation task
 * "Slice B — Application Workflow Persistence"). Establishes the durable
 * workflow/state-machine/idempotency/concurrency foundation for turning a
 * persisted `INCREASE_LOAD` `progression_decisions` row into an
 * athlete-reviewable recommendation — deliberately WITHOUT the effective
 * Plan overlay, numeric Apply, or Loading Capability composition, all of
 * which belong to a later slice (see the deferred-fields note below). All
 * foreign keys are `NO ACTION` (never `CASCADE`), matching this schema's
 * universal "never let an accidental cascading delete erase historical
 * truth" convention.
 *
 * **Deliberately narrower than PROGRESSION-APPLICATION-V1.md §29's final
 * target schema** — this is the Slice-B implementation task's own explicit
 * instruction (§9's exact field list), not a reinterpretation of the
 * spec. Columns the final spec eventually needs but Slice B does not touch
 * at all are simply not created yet, so no premature/dead columns exist
 * that would need backfilling or ignoring later:
 *
 * - `authorityMode` / `coachingRelationshipId` (§25/§5.1 of the spec) —
 *   mode/coach wiring is explicitly out of scope for this slice (task §25).
 * - `engineDecisionType` — always `'INCREASE_LOAD'` in V1 (§10); recording
 *   it here would just duplicate a constant with no new information until
 *   a second decision type can ever create a workflow.
 * - `loadingCapabilityId` / `loadingCapabilityRevision` /
 *   `loadingCapabilitySnapshot` / `resolverProposedLoad` /
 *   `resolverOutcomeReason` / `appliedLoad` / `overrideReason` (§5.1) —
 *   the numeric Apply/capability-composition slice populates these; Slice
 *   B never resolves or writes a concrete numeric load at all (task §37).
 * - `decidedByActorType` / `revokedAt` / `revokedBy` — no `SYSTEM`
 *   (GUIDED auto-apply) or `REVOKED` path exists yet (task §7/§25); the
 *   only actor-driven transition this slice implements is `KEEP_ORIGINAL`,
 *   always by the owning athlete, so `decidedBy` alone is sufficient here.
 *
 * All of the above are additive columns for a later slice — none require
 * a destructive migration to add (task §9's own explicit design goal).
 *
 * **`status` already contains the full six-value vocabulary**
 * (`PENDING_REVIEW`/`APPLIED`/`KEPT_ORIGINAL`/`STALE`/`SUPERSEDED`/
 * `REVOKED`, task §7) even though this slice's runtime can only ever
 * write four of them — `APPLIED` and `REVOKED` exist in the persisted
 * vocabulary on purpose (task §2's hard rule) so a later slice can start
 * writing them without an enum migration, while Slice B's own service
 * layer (not a DB constraint — see the note above the table) simply never
 * produces them.
 */

export const PROGRESSION_APPLICATION_STATUS_VALUES = [
  "PENDING_REVIEW",
  "APPLIED",
  "KEPT_ORIGINAL",
  "STALE",
  "SUPERSEDED",
  "REVOKED",
] as const;
export const progressionApplicationStatusEnum = appSchema.enum(
  "progression_application_status",
  PROGRESSION_APPLICATION_STATUS_VALUES,
);

/**
 * Minimum future-compatible V1 vocabulary is `KEEP_ORIGINAL`/`APPLY`/
 * `REVOKE` (task §21); Slice C adds `APPLY` (its own numeric Apply
 * transaction is the only writer of it — task §35). `REVOKE` remains
 * deferred (added via a plain `ALTER TYPE ... ADD VALUE` when its own
 * slice is built, task §21's explicit permission), since no write path
 * for it exists yet.
 */
export const PROGRESSION_APPLICATION_COMMAND_ACTION_VALUES = ["KEEP_ORIGINAL", "APPLY"] as const;
export const progressionApplicationCommandActionEnum = appSchema.enum(
  "progression_application_command_action",
  PROGRESSION_APPLICATION_COMMAND_ACTION_VALUES,
);

/**
 * Mirrors `workoutCommandOutcomeEnum`'s `APPLIED`/`REJECTED` half exactly
 * (`workout.ts`) — `STALE` is not a distinct command outcome here the way
 * it is for a workout mutation, because a `KEEP_ORIGINAL`/`APPLY` attempt
 * that finds its application no longer actionable is, from the command's
 * own point of view, simply a rejected attempt (`REJECTED`), not a state
 * this command itself produces. Reused unchanged for `APPLY` (task §35) —
 * `APPLIED` here means "this command's requested transition durably
 * succeeded," the same meaning it already has for `KEEP_ORIGINAL`.
 */
export const PROGRESSION_APPLICATION_COMMAND_OUTCOME_VALUES = ["APPLIED", "REJECTED"] as const;
export const progressionApplicationCommandOutcomeEnum = appSchema.enum(
  "progression_application_command_outcome",
  PROGRESSION_APPLICATION_COMMAND_OUTCOME_VALUES,
);

/**
 * Task §36: a small, closed, additive vocabulary for WHY a `REJECTED`
 * command outcome happened — never a giant response blob, never exposed
 * verbatim as athlete-facing copy (a future UI layer maps each to plain
 * language). `NULL` for every `APPLIED` outcome and for a `KEEP_ORIGINAL`
 * rejection that predates this slice (backward-compatible: the column is
 * nullable, no backfill required). BOLA `NOT_FOUND` and command-identity
 * conflicts (`COMMAND_CONFLICT`) remain pure service-level outcomes, never
 * persisted here (task §36 — consistent with Slice B's own convention of
 * never persisting a receipt for an unowned/nonexistent application).
 */
export const PROGRESSION_APPLICATION_COMMAND_REJECTION_REASON_VALUES = [
  "STALE",
  "SUPERSEDED",
  "PROPOSAL_REFRESH_REQUIRED",
  "NO_CURRENT_LOAD",
  "LOADING_CAPABILITY_UNAVAILABLE",
  "LOADING_CAPABILITY_INVALID",
  "CAPABILITY_INCOMPATIBLE",
  "CURRENT_LOAD_UNSUPPORTED",
  "NO_SUITABLE_INCREMENT",
] as const;
export const progressionApplicationCommandRejectionReasonEnum = appSchema.enum(
  "progression_application_command_rejection_reason",
  PROGRESSION_APPLICATION_COMMAND_REJECTION_REASON_VALUES,
);

/**
 * Progression Application V1 — Slice D (task §12/§13/§14): GUIDED
 * introduces a real `SYSTEM` actor — an automated auto-apply, not an
 * athlete pretending on the athlete's behalf. Truthful actor audit
 * requires representing this as a real fact, never by inserting the
 * application owner's `User` id and merely *labeling* the action SYSTEM
 * (task §13's own explicit warning). `COACH` is deliberately NOT added
 * now — the enum is named generically (not `ExperienceMode`, per task
 * §12) precisely so `ALTER TYPE ... ADD VALUE 'COACH'` is a trivial,
 * additive follow-up once a real `CoachingRelationship` exists (task
 * §40), never a redesign.
 */
export const PROGRESSION_APPLICATION_ACTOR_TYPE_VALUES = ["ATHLETE", "SYSTEM"] as const;
export const progressionApplicationActorTypeEnum = appSchema.enum(
  "progression_application_actor_type",
  PROGRESSION_APPLICATION_ACTOR_TYPE_VALUES,
);

/**
 * Structurally identical to `packages/domain`'s `ExternalWeightLoad`
 * (`packages/database` intentionally does not depend on `packages/domain`,
 * same reasoning as `plan.ts`'s `TrainingFocusAreaRow`) — kept in sync by
 * a schema test. `unit`/`basis` reuse `plan.ts`'s existing value arrays
 * for the TS union rather than a third independently-drifting copy of the
 * same KG/LB, TOTAL/PER_IMPLEMENT vocabulary.
 */
export interface ExpectedEffectiveLoadRow {
  readonly kind: "EXTERNAL_WEIGHT";
  readonly amountMilli: number;
  readonly unit: (typeof PLANNED_SET_LOAD_UNIT_VALUES)[number];
  readonly basis: (typeof PLANNED_SET_LOAD_BASIS_VALUES)[number];
}

/**
 * Structurally identical to `packages/domain`'s `LoadingCapabilityV1`
 * union (same cross-package duplication convention as
 * `ExpectedEffectiveLoadRow` above) — the exact canonical resolver-input
 * capability payload (task §15), frozen at the moment of a successful
 * Apply. A later edit to the live, mutable `loading_capabilities` row can
 * never retroactively change how an already-`APPLIED` row is explained.
 */
export type LoadingCapabilitySnapshotRow =
  | {
      readonly kind: "FIXED_INCREMENT";
      readonly unit: (typeof PLANNED_SET_LOAD_UNIT_VALUES)[number];
      readonly basis: (typeof PLANNED_SET_LOAD_BASIS_VALUES)[number];
      readonly incrementAmountMilli: number;
    }
  | {
      readonly kind: "ENUMERATED_LIST";
      readonly unit: (typeof PLANNED_SET_LOAD_UNIT_VALUES)[number];
      readonly basis: (typeof PLANNED_SET_LOAD_BASIS_VALUES)[number];
      readonly loadsMilli: readonly number[];
    };

/**
 * One durable workflow per `INCREASE_LOAD` `progression_decisions` row
 * (`UNIQUE(progression_decision_id)` below — task §11, also the primary
 * idempotency boundary for workflow creation). `user_id` is always
 * re-derived from the source decision's own `userId`, never trusted from
 * a caller (task §10/§32).
 *
 * **Program Slot Identity** (`program_version_id`, `training_block_id`,
 * `workout_order_index`, `exercise_order_index`, task §5, locked by
 * `docs/domain/PROGRESSION-APPLICATION-V1.md` §2.1): deliberately
 * exercise-level, not set-level (`setOrderIndex` absent) and not
 * cycle-scoped (`trainingCycleId`/its `orderIndex` absent from the
 * identity itself) — the same programmed exercise slot repeating across
 * cycles is one continuous progression stream. The cycle the *source*
 * occurrence belongs to is instead captured separately, as the
 * `effective_from_cycle_order_index` boundary (task §6): an eventual
 * applied progression may only ever affect a future occurrence whose own
 * `TrainingCycle.orderIndex` is strictly greater than this value — never
 * a wall-clock comparison.
 *
 * **`expected_effective_load`** (task §13): the live current effective
 * load for this stream *at workflow-creation time* — in Slice B, since no
 * `APPLIED` overlay can ever exist yet, this is always the source
 * `PlannedExercise`'s own authored `WORKING`-set load (uniform across its
 * `WORKING` sets by construction — Slice C's `reconstructPrescriptionContext`
 * already requires this before an `INCREASE_LOAD` decision can exist at
 * all). Re-verified live on every revalidation/decide attempt
 * (`revalidatePendingApplication`) — a live mismatch is `STALE`, never
 * silently re-based.
 */
export const progressionApplications = appSchema.table(
  "progression_applications",
  {
    id: uuid("id").primaryKey(),
    // No plain single-column FK here (Slice B ownership-integrity gate) —
    // the composite FK below already requires this to reference a real
    // progression_decisions.id, AND additionally forces this row's own
    // userId to equal that decision's userId (the "decision/application
    // owner consistency" invariant) — a second, redundant single-column
    // FK would add nothing, same reasoning as `exercise_loading_capability_
    // bindings.loadingCapabilityId` (loading-capability.ts).
    progressionDecisionId: uuid("progression_decision_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /** Captured from the source at creation; also the exact-match slot precondition on every revalidation (spec §2.3) — not just a label. */
    exerciseRef: text("exercise_ref").notNull(),

    programVersionId: uuid("program_version_id")
      .notNull()
      .references(() => programVersions.id),
    trainingBlockId: uuid("training_block_id")
      .notNull()
      .references(() => trainingBlocks.id),
    workoutOrderIndex: integer("workout_order_index").notNull(),
    exerciseOrderIndex: integer("exercise_order_index").notNull(),

    effectiveFromCycleOrderIndex: integer("effective_from_cycle_order_index").notNull(),

    status: progressionApplicationStatusEnum("status").notNull().default("PENDING_REVIEW"),

    expectedEffectiveLoad: jsonb("expected_effective_load").notNull().$type<ExpectedEffectiveLoadRow>(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),

    /**
     * Set for every actor-driven transition — `KEEP_ORIGINAL` (Slice B),
     * athlete `APPLY` (Slice C), and now GUIDED's `SYSTEM` auto-apply
     * (Slice D, task §14, reusing existing decidedAt/decidedBy semantics
     * rather than duplicating equivalent columns — no separate `appliedBy`
     * column exists). `NULL` for the system-*detected* `STALE`/`SUPERSEDED`
     * transitions, which nobody "decided."
     *
     * **`decidedByActorType` (Slice D)**: truthfully distinguishes WHO
     * decided — `ATHLETE` (`decidedBy` is that athlete's real `User` id) or
     * `SYSTEM` (GUIDED auto-apply; `decidedBy` is `NULL` — task §13's own
     * explicit warning against inserting the application owner's `User` id
     * and merely labeling the action `SYSTEM`, which would make the audit
     * false). `NULL` together with `decidedAt`/`decidedBy` while
     * undecided.
     */
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedByActorType: progressionApplicationActorTypeEnum("decided_by_actor_type"),
    decidedBy: uuid("decided_by").references(() => users.id),

    // Immutable applied audit group (task §14/§15/§17) — populated ONLY by
    // a successful numeric Apply, together, in the same transaction that
    // sets status = 'APPLIED' (task §29 step 20-21); never touched again
    // afterward, including by a later APPLIED -> SUPERSEDED transition
    // (task §17/§19 — supersession replaces the CURRENT head, it never
    // rewrites the historical row's own explanation of what it applied).
    // All six move together — see the CHECK constraints below.
    loadingCapabilityId: uuid("loading_capability_id").references(() => loadingCapabilities.id),
    loadingCapabilityRevision: integer("loading_capability_revision"),
    loadingCapabilitySnapshot: jsonb("loading_capability_snapshot").$type<LoadingCapabilitySnapshotRow>(),
    resolverProposedLoad: jsonb("resolver_proposed_load").$type<ExpectedEffectiveLoadRow>(),
    appliedLoad: jsonb("applied_load").$type<ExpectedEffectiveLoadRow>(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),

    /**
     * Self-reference, `NO ACTION` (task §15) — set only when a newer
     * `progression_applications` row already exists for the same source
     * decision's stream at the moment this row is reconciled to
     * `SUPERSEDED`; `NULL` when the justifying decision was superseded
     * before any newer application was created (task §15 — decision
     * supersession alone is sufficient proof, no newer application row is
     * required to exist first).
     */
    supersededByApplicationId: uuid("superseded_by_application_id").references(
      (): AnyPgColumn => progressionApplications.id,
    ),
  },
  (table) => [
    // Invariant (task §11): one workflow per decision — also the DB-enforced
    // idempotency guard for concurrent ensureApplicationForDecision() calls.
    uniqueIndex("progression_applications_progression_decision_id_unique").on(table.progressionDecisionId),
    // "My pending recommendations" (task §16/§19) — the only read path this
    // slice actually has, not a speculative index.
    index("progression_applications_user_id_status_idx").on(table.userId, table.status),
    // The revalidation/staleness live-slot re-resolution query (task §18) —
    // not the eventual one-current-overlay unique index (task §27, deferred
    // below), a plain lookup index for the full history of a stream.
    index("progression_applications_slot_lookup_idx").on(
      table.programVersionId,
      table.trainingBlockId,
      table.workoutOrderIndex,
      table.exerciseOrderIndex,
    ),
    check(
      "progression_applications_effective_from_cycle_order_index_non_negative",
      sql`${table.effectiveFromCycleOrderIndex} >= 0`,
    ),
    // decidedAt/decidedByActorType are set together (KEEP_ORIGINAL, athlete
    // or system APPLY) or not at all (STALE/SUPERSEDED, system-*detected* —
    // task §26/§41's "value/state consistency" guidance). Slice D replaces
    // the old Slice-B/C `decided_at`/`decided_by` pairing (which cannot
    // express a truthful SYSTEM row, where `decided_by` is NULL but
    // `decided_at` is NOT) with this actor-type-based pairing, plus a
    // second check tying `decided_by`'s own presence to `ATHLETE`
    // specifically.
    check(
      "progression_applications_decided_at_actor_type_consistency",
      sql`(${table.decidedAt} IS NULL) = (${table.decidedByActorType} IS NULL)`,
    ),
    check(
      "progression_applications_decided_by_actor_type_consistency",
      sql`(${table.decidedByActorType} = 'ATHLETE') = (${table.decidedBy} IS NOT NULL)`,
    ),
    // Slice B ownership-integrity gate — THE central correctness constraint
    // of this migration: `progression_applications.user_id` is a persisted
    // canonical ownership field (task's own framing), so Postgres itself,
    // not merely service-level BOLA, must make it impossible to insert a
    // row whose `userId` disagrees with its own `progressionDecisionId`'s
    // real owner. References `progression_decisions`' own composite
    // `UNIQUE(id, user_id)` (`progression.ts`) — identical pattern to
    // `exercise_loading_capability_bindings`' same-gym composite FK
    // (`loading-capability.ts`). Proven by a real-Postgres negative test:
    // a raw-SQL insert with a mismatched owner is rejected by this FK.
    foreignKey({
      columns: [table.progressionDecisionId, table.userId],
      foreignColumns: [progressionDecisions.id, progressionDecisions.userId],
      name: "progression_applications_decision_owner_fkey",
    }),
    // Auth & Local Athlete Boundary V1 Slice A closure — the target of
    // `progression_application_commands`' owner-integrity composite FK
    // (`id` alone is already unique, so this can never reject a row).
    unique("progression_applications_id_user_id_unique").on(table.id, table.userId),
    // Slice C (task §4) — THE central correctness constraint of numeric
    // Apply: at most one CURRENT `APPLIED` application may exist for a
    // given (user_id, program_version_id, training_block_id,
    // workout_order_index, exercise_order_index) stream. Deliberately
    // excludes `exerciseRef` from the key (task §4's own reasoning:
    // `ProgramVersion` is immutable, so an `exerciseRef` disagreement at
    // an otherwise-matching position would mean stale/corrupt identity,
    // never a second legitimate concurrent stream — the position alone is
    // definitive) and excludes `trainingCycleId`/`setOrderIndex` (same
    // stream-identity reasoning as the plain slot-lookup index above).
    // This is the FINAL race guard for numeric Apply concurrency (task
    // §28/§55) — the `ProgramVersion` row lock serializes the read/replace
    // sequence, but this index is what actually makes a second concurrent
    // current head impossible at the database level, regardless of
    // application-layer bugs.
    uniqueIndex("progression_applications_one_current_overlay_per_stream")
      .on(table.userId, table.programVersionId, table.trainingBlockId, table.workoutOrderIndex, table.exerciseOrderIndex)
      .where(sql`${table.status} = 'APPLIED'`),
    // Applied-audit group consistency (task §18) — all six audit fields
    // are NULL together or NON-NULL together, regardless of `status`
    // (SUPERSEDED legitimately has either form — task §18's own explicit
    // "do not create a CHECK that makes either legitimate SUPERSEDED form
    // impossible").
    check(
      "progression_applications_applied_audit_group_consistency",
      sql`(${table.loadingCapabilityId} IS NULL) = (${table.loadingCapabilityRevision} IS NULL)
          AND (${table.loadingCapabilityId} IS NULL) = (${table.loadingCapabilitySnapshot} IS NULL)
          AND (${table.loadingCapabilityId} IS NULL) = (${table.resolverProposedLoad} IS NULL)
          AND (${table.loadingCapabilityId} IS NULL) = (${table.appliedLoad} IS NULL)
          AND (${table.loadingCapabilityId} IS NULL) = (${table.appliedAt} IS NULL)`,
    ),
    // PENDING_REVIEW/KEPT_ORIGINAL/STALE never carry applied audit (task
    // §18) — a one-directional implication, not paired with an `APPLIED`
    // iff, because a SUPERSEDED row that was once APPLIED must keep its
    // audit forever (task §17) even though its status is no longer
    // 'APPLIED'.
    check(
      "progression_applications_non_applied_states_audit_null",
      sql`${table.status} NOT IN ('PENDING_REVIEW', 'KEPT_ORIGINAL', 'STALE') OR ${table.appliedAt} IS NULL`,
    ),
    // The other direction: a row currently `APPLIED` must have completed
    // audit (task §18).
    check(
      "progression_applications_applied_status_requires_audit",
      sql`${table.status} != 'APPLIED' OR ${table.appliedAt} IS NOT NULL`,
    ),
  ],
);

/**
 * Domain-specific command receipt (task §20) — NOT a generic command
 * framework. Idempotency is OWNER-SCOPED (Auth & Local Athlete Boundary V1
 * Slice A closure): the primary key is `(owner_user_id, command_id)`, so a
 * retried command can never be processed twice for its owner regardless of
 * application-layer bugs or concurrent requests, while another athlete
 * reusing the same `commandId` can never replay, block or conflict with it
 * — the same rule as `workout_command_receipts` (`workout.ts`).
 * `owner_user_id` is the APPLICATION's owner, never a caller-supplied
 * value: DB-enforced by the composite FK `(application_id, owner_user_id)`
 * -> `progression_applications(id, user_id)`, and for `ATHLETE` rows the
 * actor must be that owner (CHECK — an athlete receipt is only ever written
 * after the BOLA ownership load succeeded). `SYSTEM` commands
 * (server-generated `systemCommandId`) live in the owner's namespace too.
 *
 * **`user_id` (Slice D, task §13): the ACTOR's user id, nullable** — kept
 * physically named `user_id` (task §13's own explicit permission: "if
 * preserving the existing DB column name is less destructive, keep it
 * physically named `user_id`, but update code/docs semantics clearly")
 * rather than a destructive rename; conceptually it is `actorUserId`.
 * `NOT NULL` for `ATHLETE` (the CALLER's own id, never the application
 * owner's if they differ, so a rejected/BOLA attempt's own receipt can
 * never leak who actually owns `application_id`); `NULL` for `SYSTEM` —
 * GUIDED's auto-apply has no real `User` row to reference, and inserting
 * the application owner's id here while labeling the row `SYSTEM` would
 * make the audit false (task §13's own explicit warning).
 */
export const progressionApplicationCommands = appSchema.table(
  "progression_application_commands",
  {
    commandId: uuid("command_id").notNull(),
    /** The application's canonical owner — the idempotency namespace (see the table doc comment). */
    ownerUserId: uuid("owner_user_id").notNull(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => progressionApplications.id),
    /** Conceptually `actorUserId` — see the table doc comment. `NOT NULL` iff `actorType = 'ATHLETE'`. */
    userId: uuid("user_id").references(() => users.id),
    /** Slice D (task §12) — `ATHLETE` or `SYSTEM`; defaults to `ATHLETE` only for defensive backward-compatibility with pre-Slice-D rows/callers that predate this column (this codebase's established convention, e.g. `plannedSetTypeEnum`'s own default — application code always writes this explicitly, never relying on the default as the primary mechanism). */
    actorType: progressionApplicationActorTypeEnum("actor_type").notNull().default("ATHLETE"),
    action: progressionApplicationCommandActionEnum("action").notNull(),
    outcome: progressionApplicationCommandOutcomeEnum("outcome").notNull(),
    /** Task §36 — populated iff `outcome = 'REJECTED'`; `NULL` for `APPLIED`. */
    rejectionReason: progressionApplicationCommandRejectionReasonEnum("rejection_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ name: "progression_application_commands_pkey", columns: [table.ownerUserId, table.commandId] }),
    foreignKey({
      columns: [table.applicationId, table.ownerUserId],
      foreignColumns: [progressionApplications.id, progressionApplications.userId],
      name: "progression_application_commands_application_owner_fkey",
    }),
    check(
      "progression_application_commands_athlete_actor_is_owner",
      sql`${table.actorType} <> 'ATHLETE' OR ${table.userId} = ${table.ownerUserId}`,
    ),
    index("progression_application_commands_application_id_idx").on(table.applicationId),
    check(
      "progression_application_commands_rejection_reason_consistency",
      sql`(${table.outcome} = 'REJECTED') OR ${table.rejectionReason} IS NULL`,
    ),
    // Slice D (task §13/§41) — the truthful actor-identity invariant:
    // ATHLETE always has a real user id; SYSTEM never does.
    check(
      "progression_application_commands_actor_type_user_id_consistency",
      sql`(${table.actorType} = 'ATHLETE') = (${table.userId} IS NOT NULL)`,
    ),
  ],
);
