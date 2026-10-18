import { and, eq } from "drizzle-orm";
import {
  plannedExercises,
  plannedSets,
  plannedWorkouts,
  programVersions,
  progressionApplicationCommands,
  progressionApplications,
  progressionDecisions,
  trainingBlocks,
  trainingCycles,
  type Database,
  type ExpectedEffectiveLoadRow,
  type LoadingCapabilitySnapshotRow,
} from "@vostivo/database";
import { createEntityId } from "@vostivo/domain";
import type { ProgressionActorV1 } from "./actor.js";
import { deriveUniformWorkingLoad, resolveEffectiveWorkingLoadForOccurrence } from "./effective-load-resolver.js";

/**
 * Progression Application V1 — Slice B (`docs/domain/
 * PROGRESSION-APPLICATION-V1.md`, ADR-0009, Accepted; implementation task
 * "Slice B — Application Workflow Persistence"). Turns a persisted
 * `INCREASE_LOAD` `progression_decisions` row into a durable, reviewable
 * `progression_applications` workflow — the state machine/idempotency/
 * concurrency foundation only. **Never** resolves a numeric next load,
 * never calls the Load Resolver, never touches Loading Capability, never
 * mutates Plan, and can never write `APPLIED` (task §2/§37/§38 — hard
 * rules). Framework-agnostic (same discipline as
 * `ProgressionEvaluationService`): a plain module of functions, no Nest,
 * callable from `apps/worker` or `apps/api` alike, though this slice wires
 * no caller at all yet (task §36 — no queue, no auto-creation from a
 * decision).
 */

export type ProgressionApplicationStatus =
  | "PENDING_REVIEW"
  | "APPLIED"
  | "KEPT_ORIGINAL"
  | "STALE"
  | "SUPERSEDED"
  | "REVOKED";

/** Slice D (task §12) — `ATHLETE` or `SYSTEM`; `COACH` deferred (task §30/§40's documented additive extension seam). */
export type ProgressionApplicationActorType = "ATHLETE" | "SYSTEM";

export interface ProgressionApplicationRecord {
  readonly id: string;
  readonly progressionDecisionId: string;
  readonly userId: string;
  readonly exerciseRef: string;
  readonly programVersionId: string;
  readonly trainingBlockId: string;
  readonly workoutOrderIndex: number;
  readonly exerciseOrderIndex: number;
  readonly effectiveFromCycleOrderIndex: number;
  readonly status: ProgressionApplicationStatus;
  readonly expectedEffectiveLoad: ExpectedEffectiveLoadRow;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly decidedAt: Date | null;
  /** Slice D (task §14) — `null` while undecided; truthfully `ATHLETE` or `SYSTEM` once decided. */
  readonly decidedByActorType: ProgressionApplicationActorType | null;
  readonly decidedBy: string | null;
  readonly supersededByApplicationId: string | null;
  // Immutable applied audit group (Slice C, task §14/§17) — all six move
  // together (`progression_applications_applied_audit_group_consistency`).
  readonly loadingCapabilityId: string | null;
  readonly loadingCapabilityRevision: number | null;
  readonly loadingCapabilitySnapshot: LoadingCapabilitySnapshotRow | null;
  readonly resolverProposedLoad: ExpectedEffectiveLoadRow | null;
  readonly appliedLoad: ExpectedEffectiveLoadRow | null;
  readonly appliedAt: Date | null;
}

export function toProgressionApplicationRecord(row: typeof progressionApplications.$inferSelect): ProgressionApplicationRecord {
  return {
    id: row.id,
    progressionDecisionId: row.progressionDecisionId,
    userId: row.userId,
    exerciseRef: row.exerciseRef,
    programVersionId: row.programVersionId,
    trainingBlockId: row.trainingBlockId,
    workoutOrderIndex: row.workoutOrderIndex,
    exerciseOrderIndex: row.exerciseOrderIndex,
    effectiveFromCycleOrderIndex: row.effectiveFromCycleOrderIndex,
    status: row.status,
    expectedEffectiveLoad: row.expectedEffectiveLoad,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    decidedAt: row.decidedAt,
    decidedByActorType: row.decidedByActorType,
    decidedBy: row.decidedBy,
    supersededByApplicationId: row.supersededByApplicationId,
    loadingCapabilityId: row.loadingCapabilityId,
    loadingCapabilityRevision: row.loadingCapabilityRevision,
    loadingCapabilitySnapshot: row.loadingCapabilitySnapshot,
    resolverProposedLoad: row.resolverProposedLoad,
    appliedLoad: row.appliedLoad,
    appliedAt: row.appliedAt,
  };
}

export function loadsEqual(a: ExpectedEffectiveLoadRow, b: ExpectedEffectiveLoadRow): boolean {
  return a.kind === b.kind && a.amountMilli === b.amountMilli && a.unit === b.unit && a.basis === b.basis;
}

/**
 * The exhaustive Slice-B-legal transition table (task §8) — a pure,
 * directly unit-testable statement of the vocabulary this slice may
 * actually produce. `PENDING_REVIEW -> APPLIED` and anything touching
 * `APPLIED`/`REVOKED` is deliberately absent (task §2/§8's hard rule);
 * this is a documentation/testing aid, not itself the enforcement
 * mechanism — the real guard is that every mutating query below is an
 * `UPDATE ... WHERE status = 'PENDING_REVIEW'` compare-and-swap that can
 * never write a status this table doesn't list.
 */
const SLICE_B_LEGAL_TRANSITIONS: ReadonlySet<string> = new Set([
  "PENDING_REVIEW->KEPT_ORIGINAL",
  "PENDING_REVIEW->STALE",
  "PENDING_REVIEW->SUPERSEDED",
]);

export function isLegalSliceBTransition(
  from: ProgressionApplicationStatus,
  to: ProgressionApplicationStatus,
): boolean {
  return SLICE_B_LEGAL_TRANSITIONS.has(`${from}->${to}`);
}

/**
 * Resolves the uniform `WORKING`-set load for one `PlannedExercise`
 * (task §13 — "the source `PlannedExercise`'s own authored `targetLoad`,
 * uniform across its `WORKING` sets"). Returns `null` — never guesses,
 * never averages — if there are no `WORKING` sets, any of them has no
 * load at all (a bodyweight-only exercise, out of Stage-1 scope), or they
 * are not perfectly uniform (an integrity state Slice C's own
 * `reconstructPrescriptionContext` already prevents for any exercise that
 * could produce an `INCREASE_LOAD` decision — this is defense-in-depth,
 * not an expected path).
 */
async function resolveUniformWorkingLoad(
  db: Database,
  plannedExerciseId: string,
): Promise<ExpectedEffectiveLoadRow | null> {
  const sets = await db
    .select({
      loadKind: plannedSets.loadKind,
      loadAmountMilli: plannedSets.loadAmountMilli,
      loadUnit: plannedSets.loadUnit,
      loadBasis: plannedSets.loadBasis,
    })
    .from(plannedSets)
    .where(and(eq(plannedSets.plannedExerciseId, plannedExerciseId), eq(plannedSets.setType, "WORKING")));

  return deriveUniformWorkingLoad(sets);
}

interface PlanContext {
  readonly exerciseRef: string;
  readonly programVersionId: string;
  readonly trainingBlockId: string;
  readonly workoutOrderIndex: number;
  readonly exerciseOrderIndex: number;
  readonly cycleOrderIndex: number;
  readonly workingLoad: ExpectedEffectiveLoadRow;
}

/**
 * Walks `PlannedExercise -> PlannedWorkout -> TrainingCycle -> TrainingBlock
 * -> ProgramVersion` (`docs/domain/PROGRESSION-APPLICATION-V1.md` §2.4) to
 * derive the full Program Slot Identity + effective-from boundary + the
 * uniform current authored load, from an immutable
 * `sourcePrescriptionExerciseId`. Returns `null` — never a fabricated
 * identity (task §3's "if the source prescription snapshot cannot
 * reconstruct the approved progression stream identity: STOP AND
 * REPORT" — here, honestly reporting "no Plan context," §5.2 of the
 * spec) — when: the id doesn't resolve to a real `PlannedExercise`; that
 * exercise has no `exerciseRef` (a freeform, non-catalog exercise —
 * `plannedExercises.exerciseRef` is nullable); its owning `ProgramVersion`
 * is not currently `ACTIVE`; or its `WORKING`-set load cannot be uniformly
 * resolved (see `resolveUniformWorkingLoad`).
 */
async function resolvePlanContext(db: Database, prescriptionExerciseId: string): Promise<PlanContext | null> {
  const [row] = await db
    .select({
      exerciseId: plannedExercises.id,
      exerciseRef: plannedExercises.exerciseRef,
      exerciseOrderIndex: plannedExercises.orderIndex,
      workoutOrderIndex: plannedWorkouts.orderIndex,
      cycleOrderIndex: trainingCycles.orderIndex,
      trainingBlockId: trainingBlocks.id,
      programVersionId: programVersions.id,
      programVersionStatus: programVersions.status,
    })
    .from(plannedExercises)
    .innerJoin(plannedWorkouts, eq(plannedWorkouts.id, plannedExercises.plannedWorkoutId))
    .innerJoin(trainingCycles, eq(trainingCycles.id, plannedWorkouts.trainingCycleId))
    .innerJoin(trainingBlocks, eq(trainingBlocks.id, trainingCycles.trainingBlockId))
    .innerJoin(programVersions, eq(programVersions.id, trainingBlocks.programVersionId))
    .where(eq(plannedExercises.id, prescriptionExerciseId))
    .limit(1);

  if (row === undefined || row.exerciseRef === null || row.programVersionStatus !== "ACTIVE") {
    return null;
  }

  const workingLoad = await resolveUniformWorkingLoad(db, row.exerciseId);
  if (workingLoad === null) return null;

  return {
    exerciseRef: row.exerciseRef,
    programVersionId: row.programVersionId,
    trainingBlockId: row.trainingBlockId,
    workoutOrderIndex: row.workoutOrderIndex,
    exerciseOrderIndex: row.exerciseOrderIndex,
    cycleOrderIndex: row.cycleOrderIndex,
    workingLoad,
  };
}

export type EnsureApplicationOutcome =
  | { readonly status: "CREATED"; readonly application: ProgressionApplicationRecord }
  | { readonly status: "ALREADY_EXISTS"; readonly application: ProgressionApplicationRecord }
  | { readonly status: "NOT_FOUND" }
  | { readonly status: "NOT_INCREASE_LOAD" }
  | { readonly status: "DECISION_SUPERSEDED" }
  | { readonly status: "NO_PLAN_CONTEXT" };

/**
 * Task §14's `ensureApplicationForDecision`. Idempotent and
 * concurrency-safe: the DB-enforced `UNIQUE(progression_decision_id)` is
 * the actual guard (proven by a real concurrent-insert integration test),
 * never "check then insert."
 *
 * BOLA (task §31): a decision that does not exist, or does not belong to
 * `actor`, reports identically as `NOT_FOUND` — indistinguishable from a
 * missing id, matching `ProgressionEvaluationService`'s own
 * `SOURCE_NOT_FOUND` precedent.
 */
export async function ensureApplicationForDecision(
  db: Database,
  actor: ProgressionActorV1,
  progressionDecisionId: string,
): Promise<EnsureApplicationOutcome> {
  const [decision] = await db
    .select()
    .from(progressionDecisions)
    .where(eq(progressionDecisions.id, progressionDecisionId))
    .limit(1);

  if (decision === undefined || decision.userId !== actor.userId) {
    return { status: "NOT_FOUND" };
  }
  if (decision.decisionType !== "INCREASE_LOAD") {
    return { status: "NOT_INCREASE_LOAD" };
  }
  if (decision.supersededByDecisionId !== null) {
    return { status: "DECISION_SUPERSEDED" };
  }

  const planContext = await resolvePlanContext(db, decision.sourcePrescriptionExerciseId);
  if (planContext === null) {
    return { status: "NO_PLAN_CONTEXT" };
  }
  // A decision about a DIFFERENT exercise than the slot's authored one (e.g.
  // a temporary equipment substitute performed in this slot) never becomes
  // a progression application of the authored slot.
  if (planContext.exerciseRef !== decision.exerciseRef) {
    return { status: "NO_PLAN_CONTEXT" };
  }

  // Task §23 (Slice C update — Slice B's temporary "always authored"
  // rule is replaced): the current effective load AT THE SOURCE CYCLE
  // ITSELF, via the one authoritative historical resolver — never the
  // authored value directly. `targetCycleOrderIndex = planContext.
  // cycleOrderIndex` (the source occurrence's own cycle) is exactly what
  // makes the corrected-evidence same-cycle case (task §9) safe: an
  // earlier application whose `effectiveFromCycleOrderIndex` equals this
  // SAME cycle is excluded by the resolver's own strict `<` boundary, so
  // a corrected re-evaluation at this cycle can never double-count an
  // application that was itself sourced from this cycle.
  const resolution = await resolveEffectiveWorkingLoadForOccurrence(db, {
    userId: decision.userId,
    programVersionId: planContext.programVersionId,
    trainingBlockId: planContext.trainingBlockId,
    workoutOrderIndex: planContext.workoutOrderIndex,
    exerciseOrderIndex: planContext.exerciseOrderIndex,
    exerciseRef: planContext.exerciseRef,
    targetCycleOrderIndex: planContext.cycleOrderIndex,
    authoredWorkingLoad: planContext.workingLoad,
  });
  if (resolution.load === null) {
    // Unreachable in practice — resolvePlanContext already guarantees
    // planContext.workingLoad is non-null, and the resolver only ever
    // returns null when the authored fallback itself was null. Defensive,
    // never a fabricated value.
    return { status: "NO_PLAN_CONTEXT" };
  }
  const expectedEffectiveLoad = resolution.load;

  const newId = createEntityId<"ProgressionApplication">();

  return db.transaction(async (tx): Promise<EnsureApplicationOutcome> => {
    const inserted = await tx
      .insert(progressionApplications)
      .values({
        id: newId,
        progressionDecisionId: decision.id,
        userId: decision.userId,
        exerciseRef: planContext.exerciseRef,
        programVersionId: planContext.programVersionId,
        trainingBlockId: planContext.trainingBlockId,
        workoutOrderIndex: planContext.workoutOrderIndex,
        exerciseOrderIndex: planContext.exerciseOrderIndex,
        effectiveFromCycleOrderIndex: planContext.cycleOrderIndex,
        expectedEffectiveLoad,
        status: "PENDING_REVIEW",
      })
      .onConflictDoNothing({ target: progressionApplications.progressionDecisionId })
      .returning();

    if (inserted.length === 0) {
      // Idempotent no-op — either a repeated call, or the loser of a real
      // concurrent race (task §11's proof requirement).
      const [existing] = await tx
        .select()
        .from(progressionApplications)
        .where(eq(progressionApplications.progressionDecisionId, decision.id))
        .limit(1);
      if (existing === undefined) {
        throw new Error("progression_applications idempotency row not found after conflict — should be unreachable");
      }
      return { status: "ALREADY_EXISTS", application: toProgressionApplicationRecord(existing) };
    }

    const [newRow] = inserted;
    if (newRow === undefined) {
      throw new Error("progression_applications insert returned no row — should be unreachable");
    }
    return { status: "CREATED", application: toProgressionApplicationRecord(newRow) };
  });
}

export type RevalidationResult =
  | { readonly verdict: "VALID"; readonly currentEffectiveLoad: ExpectedEffectiveLoadRow }
  | { readonly verdict: "STALE" }
  | { readonly verdict: "SUPERSEDED" };

/**
 * Re-derives every live precondition an application's `PENDING_REVIEW`
 * state depends on (task §7/§17/§18/§24), never trusting anything cached
 * on the row itself except as the value being checked against:
 *
 * 1. the source decision is still current (not superseded by a later,
 *    corrected decision — Slice C's own `supersededByDecisionId`);
 * 2. its `ProgramVersion` is still `ACTIVE`;
 * 3. the Program Slot Identity tuple still resolves to a real
 *    `PlannedExercise` whose `exerciseRef` matches what was recorded at
 *    creation;
 * 4. the current effective load AT THIS APPLICATION'S OWN SOURCE CYCLE
 *    (`targetCycleOrderIndex = app.effectiveFromCycleOrderIndex`), via
 *    the SAME authoritative historical resolver `ensureApplicationForDecision`
 *    uses (task §24 — "must not use a separate implementation"), still
 *    equals `app.expectedEffectiveLoad` exactly.
 *
 * Deliberately excludes LoadingCapability entirely (task §17 — capability
 * changes are never Plan-identity staleness). Returns the live resolved
 * `currentEffectiveLoad` on `VALID` so the numeric Apply transaction
 * (task §29 step 7-9) can reuse it without a second resolver call.
 */
export async function computeRevalidation(db: Database, app: ProgressionApplicationRecord): Promise<RevalidationResult> {
  const [decision] = await db
    .select({ supersededByDecisionId: progressionDecisions.supersededByDecisionId })
    .from(progressionDecisions)
    .where(eq(progressionDecisions.id, app.progressionDecisionId))
    .limit(1);
  if (decision === undefined || decision.supersededByDecisionId !== null) {
    return { verdict: "SUPERSEDED" };
  }

  const [pv] = await db
    .select({ status: programVersions.status })
    .from(programVersions)
    .where(eq(programVersions.id, app.programVersionId))
    .limit(1);
  if (pv === undefined || pv.status !== "ACTIVE") {
    return { verdict: "STALE" };
  }

  const [slot] = await db
    .select({
      exerciseId: plannedExercises.id,
      exerciseRef: plannedExercises.exerciseRef,
      trainingBlockProgramVersionId: trainingBlocks.programVersionId,
    })
    .from(plannedExercises)
    .innerJoin(plannedWorkouts, eq(plannedWorkouts.id, plannedExercises.plannedWorkoutId))
    .innerJoin(trainingCycles, eq(trainingCycles.id, plannedWorkouts.trainingCycleId))
    .innerJoin(trainingBlocks, eq(trainingBlocks.id, trainingCycles.trainingBlockId))
    .where(
      and(
        eq(trainingBlocks.id, app.trainingBlockId),
        eq(plannedWorkouts.orderIndex, app.workoutOrderIndex),
        eq(plannedExercises.orderIndex, app.exerciseOrderIndex),
      ),
    )
    .limit(1);

  if (slot === undefined || slot.trainingBlockProgramVersionId !== app.programVersionId || slot.exerciseRef !== app.exerciseRef) {
    return { verdict: "STALE" };
  }

  const liveAuthoredLoad = await resolveUniformWorkingLoad(db, slot.exerciseId);
  if (liveAuthoredLoad === null) {
    return { verdict: "STALE" };
  }

  const resolution = await resolveEffectiveWorkingLoadForOccurrence(db, {
    userId: app.userId,
    programVersionId: app.programVersionId,
    trainingBlockId: app.trainingBlockId,
    workoutOrderIndex: app.workoutOrderIndex,
    exerciseOrderIndex: app.exerciseOrderIndex,
    exerciseRef: app.exerciseRef,
    targetCycleOrderIndex: app.effectiveFromCycleOrderIndex,
    authoredWorkingLoad: liveAuthoredLoad,
  });
  if (resolution.load === null || !loadsEqual(resolution.load, app.expectedEffectiveLoad)) {
    return { verdict: "STALE" };
  }

  return { verdict: "VALID", currentEffectiveLoad: resolution.load };
}

export async function loadOwnedApplication(
  db: Database,
  userId: string,
  applicationId: string,
): Promise<ProgressionApplicationRecord | null> {
  const [row] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, applicationId)).limit(1);
  if (row === undefined || row.userId !== userId) return null; // BOLA-safe: indistinguishable from missing
  return toProgressionApplicationRecord(row);
}

export type RevalidateOutcome =
  | { readonly status: "VALID"; readonly application: ProgressionApplicationRecord }
  | { readonly status: "STALE"; readonly application: ProgressionApplicationRecord }
  | { readonly status: "SUPERSEDED"; readonly application: ProgressionApplicationRecord }
  | { readonly status: "TERMINAL"; readonly application: ProgressionApplicationRecord }
  | { readonly status: "NOT_FOUND" };

/**
 * Task §18's `revalidatePendingApplication`. Never mutates an
 * already-terminal row (`TERMINAL`, reported as-is); for a live
 * `PENDING_REVIEW` row, transitions it atomically to `STALE`/`SUPERSEDED`
 * the moment a live precondition fails, via a single
 * `UPDATE ... WHERE status = 'PENDING_REVIEW'` compare-and-swap — never an
 * explicit row lock (matches this codebase's existing concurrency idiom,
 * `performed_sets`'s revision-gated `onConflictDoUpdate`/`setWhere`, not a
 * new pattern).
 */
export async function revalidatePendingApplication(
  db: Database,
  actor: ProgressionActorV1,
  applicationId: string,
): Promise<RevalidateOutcome> {
  const app = await loadOwnedApplication(db, actor.userId, applicationId);
  if (app === null) return { status: "NOT_FOUND" };
  if (app.status !== "PENDING_REVIEW") return { status: "TERMINAL", application: app };

  const revalidation = await computeRevalidation(db, app);
  if (revalidation.verdict === "VALID") return { status: "VALID", application: app };

  return db.transaction(async (tx): Promise<RevalidateOutcome> => {
    const [updated] = await tx
      .update(progressionApplications)
      .set({ status: revalidation.verdict, updatedAt: new Date() })
      .where(and(eq(progressionApplications.id, applicationId), eq(progressionApplications.status, "PENDING_REVIEW")))
      .returning();

    const finalRow = updated !== undefined ? toProgressionApplicationRecord(updated) : await loadOwnedApplication(tx, actor.userId, applicationId);
    if (finalRow === null) {
      throw new Error("progression_applications row disappeared mid-transaction — should be unreachable");
    }
    return classifyNonPendingResult(finalRow);
  });
}

function classifyNonPendingResult(app: ProgressionApplicationRecord): RevalidateOutcome {
  if (app.status === "STALE") return { status: "STALE", application: app };
  if (app.status === "SUPERSEDED") return { status: "SUPERSEDED", application: app };
  if (app.status === "PENDING_REVIEW") return { status: "VALID", application: app }; // raced back to valid-looking state; report honestly, never force
  return { status: "TERMINAL", application: app }; // KEPT_ORIGINAL (or, in a later slice, APPLIED/REVOKED) won a concurrent race
}

class KeepOriginalCommandRaceLoss extends Error {}

export type KeepOriginalOutcome =
  | { readonly status: "KEPT_ORIGINAL"; readonly application: ProgressionApplicationRecord }
  | { readonly status: "NOT_KEPT"; readonly reason: ProgressionApplicationStatus; readonly application: ProgressionApplicationRecord }
  | { readonly status: "NOT_FOUND" }
  | { readonly status: "COMMAND_CONFLICT" };

function toKeepOriginalOutcome(app: ProgressionApplicationRecord): KeepOriginalOutcome {
  if (app.status === "KEPT_ORIGINAL") return { status: "KEPT_ORIGINAL", application: app };
  return { status: "NOT_KEPT", reason: app.status, application: app };
}

export async function findCommandReceipt(
  db: Database,
  commandId: string,
): Promise<{ readonly applicationId: string; readonly action: string; readonly outcome: string } | undefined> {
  const [row] = await db
    .select({
      applicationId: progressionApplicationCommands.applicationId,
      action: progressionApplicationCommands.action,
      outcome: progressionApplicationCommands.outcome,
    })
    .from(progressionApplicationCommands)
    .where(eq(progressionApplicationCommands.commandId, commandId))
    .limit(1);
  return row;
}

export interface KeepOriginalInput {
  readonly applicationId: string;
  readonly commandId: string;
}

/**
 * Task §19/§20/§21/§22's `KEEP_ORIGINAL` command — the only executable
 * application-layer action in Slice B. One transaction: load/verify
 * ownership -> revalidate currentness -> transition if still valid ->
 * persist the domain-specific command receipt -> commit (task §22 — never
 * a write-then-later-receipt dual-write window).
 *
 * Idempotency (task §20): `commandId` is the command receipt's primary
 * key. A repeated identical `(commandId, applicationId, action)` replays
 * the same stored outcome without re-running the mutation. The SAME
 * `commandId` reused against a different `applicationId`/action is a
 * deterministic `COMMAND_CONFLICT`, never silently accepted.
 *
 * Convergence (task §23, race C): two DIFFERENT `commandId`s both
 * requesting `KEEP_ORIGINAL` on the same application converge safely —
 * whichever arrives once the row is already `KEPT_ORIGINAL` reports
 * `KEPT_ORIGINAL` again (the target state already holds), never an error.
 */
export async function keepOriginal(db: Database, actor: ProgressionActorV1, input: KeepOriginalInput): Promise<KeepOriginalOutcome> {
  const existingReceipt = await findCommandReceipt(db, input.commandId);
  if (existingReceipt !== undefined) {
    if (existingReceipt.applicationId !== input.applicationId || existingReceipt.action !== "KEEP_ORIGINAL") {
      return { status: "COMMAND_CONFLICT" };
    }
    const app = await loadOwnedApplication(db, actor.userId, input.applicationId);
    if (app === null) return { status: "NOT_FOUND" };
    return toKeepOriginalOutcome(app);
  }

  try {
    return await db.transaction(async (tx): Promise<KeepOriginalOutcome> => {
      const app = await loadOwnedApplication(tx, actor.userId, input.applicationId);
      if (app === null) return { status: "NOT_FOUND" };

      let finalRow = app;
      if (app.status === "PENDING_REVIEW") {
        const revalidation = await computeRevalidation(tx, app);
        const targetStatus: ProgressionApplicationStatus =
          revalidation.verdict === "VALID" ? "KEPT_ORIGINAL" : revalidation.verdict;

        const setClause =
          targetStatus === "KEPT_ORIGINAL"
            ? {
                status: targetStatus,
                decidedAt: new Date(),
                decidedByActorType: "ATHLETE" as const, // KEEP_ORIGINAL is always athlete-driven — task §19/§27
                decidedBy: actor.userId,
                updatedAt: new Date(),
              }
            : { status: targetStatus, updatedAt: new Date() };

        const [updated] = await tx
          .update(progressionApplications)
          .set(setClause)
          .where(and(eq(progressionApplications.id, app.id), eq(progressionApplications.status, "PENDING_REVIEW")))
          .returning();

        const reselected = updated !== undefined ? toProgressionApplicationRecord(updated) : await loadOwnedApplication(tx, actor.userId, app.id);
        if (reselected === null) {
          throw new Error("progression_applications row disappeared mid-transaction — should be unreachable");
        }
        finalRow = reselected;
      }

      const outcome: "APPLIED" | "REJECTED" = finalRow.status === "KEPT_ORIGINAL" ? "APPLIED" : "REJECTED";

      const receiptInsert = await tx
        .insert(progressionApplicationCommands)
        .values({
          commandId: input.commandId,
          applicationId: app.id,
          userId: actor.userId,
          actorType: "ATHLETE", // KEEP_ORIGINAL is always athlete-driven — task §19/§27
          action: "KEEP_ORIGINAL",
          outcome,
        })
        .onConflictDoNothing({ target: progressionApplicationCommands.commandId })
        .returning({ commandId: progressionApplicationCommands.commandId });

      if (receiptInsert.length === 0) {
        throw new KeepOriginalCommandRaceLoss();
      }

      return toKeepOriginalOutcome(finalRow);
    });
  } catch (error) {
    if (error instanceof KeepOriginalCommandRaceLoss) {
      const winnerReceipt = await findCommandReceipt(db, input.commandId);
      if (winnerReceipt !== undefined) {
        const app = await loadOwnedApplication(db, actor.userId, input.applicationId);
        if (app === null) return { status: "NOT_FOUND" };
        return toKeepOriginalOutcome(app);
      }
    }
    throw error;
  }
}
