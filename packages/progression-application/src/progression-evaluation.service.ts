import { and, eq, inArray, ne, sql } from "drizzle-orm";
import {
  performedExercises,
  performedSets,
  progressionDecisions,
  workoutSessions,
  type Database,
} from "@vostivo/database";
import { resolveOccurrenceSessionRoles } from "./planned-occurrence-authority.js";
import { createEntityId, type WorkoutPrescriptionV1 } from "@vostivo/domain";
import {
  evaluateProgression,
  type ProgressionDecisionDataV1,
  type ProgressionEvaluationInput,
  type ProgressionExposureV1,
  type ProgressionExposureWorkingSetV1,
} from "@vostivo/training-engine";
import type { ProgressionActorV1 } from "./actor.js";
import { classifyComparability, reconstructPrescriptionContext } from "./progression-evidence.js";
import { computeEvidenceFingerprint, type ProgressionEvidenceRefV1 } from "./progression-fingerprint.js";
import type { WorkoutHistoryService, PerformedSetExposureV1 } from "./workout-history.service.js";

/**
 * Progression EngineDecision Persistence & Evidence Integration V1
 * (docs/domain/PROGRESSION-ENGINE-V1.md §18/§19/§29, implementation task
 * Slice C). Connects the approved pure `evaluateProgression()`
 * (`packages/training-engine`) to real canonical server workout history,
 * and persists the exact auditable decision. Stops exactly where §20.1
 * requires: `appliedAt` is always `null`, no `ProgramVersion`/`PlannedSet`
 * mutation, no Load Resolver call (§31 — `INCREASE_LOAD` stays
 * direction-only).
 *
 * Called only from `apps/worker`'s job handler (Progression Evaluation
 * Orchestration V1) — never inline in `apps/api`'s request path.
 * Engine/evidence failure must never block workout logging (§30/§28); the
 * safest way to guarantee that is to not be in that request path at all.
 * No public HTTP endpoint exists for this service (§37).
 *
 * Framework-agnostic (Orchestration V1 framework-boundary cleanup): a
 * plain class with explicit constructor dependencies, no Nest decorators,
 * no `reflect-metadata` requirement — `apps/worker` constructs it directly
 * with `new`, and `apps/api` adapts it into its own Nest DI via an
 * explicit `useFactory` provider (`workout.module.ts`), never by decorating
 * the class itself.
 */

/** The bounded engine evidence window (§18 of the implementation task) — never more than the anchor plus 2 prior comparable exposures. */
const MAX_PRIOR_COMPARABLE_EXPOSURES = 2;

/**
 * A small, bounded overfetch (§8) so NOT_COMPARABLE/unreconstructible
 * candidates can be skipped while still finding up to
 * `MAX_PRIOR_COMPARABLE_EXPOSURES` real comparable ones. Not an unbounded
 * history scan — comfortably covers several recent sessions' worth of
 * working sets for one exercise (matching
 * `WorkoutHistoryService.DEFAULT_HISTORY_LIMIT`'s own reasoning, scaled
 * down since this caller only ever needs a handful of exposures, not 40).
 */
const HISTORY_OVERFETCH_LIMIT = 24;

const ENGINE_VERSION = { engine: "progression", policy: "v1" } as const;

export type ProgressionEvaluationOutcome =
  | { readonly status: "PERSISTED"; readonly decision: PersistedProgressionDecision; readonly wasNewlyCreated: boolean }
  | { readonly status: "SOURCE_NOT_FOUND" }
  | { readonly status: "SOURCE_SESSION_NOT_COMPLETED" }
  /**
   * Planned Workout Occurrence Authority V1: the anchor session is a
   * SECONDARY session of a claimed planned occurrence (e.g. a second device
   * started the same planned workout offline). It stays real history, but
   * only the CANONICAL session drives planned progression — a deliberate,
   * final skip, never a retryable failure.
   */
  | { readonly status: "NOT_CANONICAL_OCCURRENCE_SESSION" }
  /**
   * Temporary Equipment / Gym Adaptation V1 Slice C: the anchor exercise was
   * a TODAY_ONLY equipment SUBSTITUTE. Its history belongs to the substitute
   * (real reality), but a substitute must not drive — or count as — the
   * authored exercise's planned progression. A deliberate, final skip.
   */
  | { readonly status: "TEMPORARY_SUBSTITUTION_NOT_EVALUATED" }
  | { readonly status: "NO_PRESCRIPTION_CONTEXT" }
  | { readonly status: "ENGINE_VALIDATION_FAILED"; readonly reason: string };

export interface PersistedProgressionDecision {
  readonly id: string;
  readonly userId: string;
  readonly exerciseRef: string;
  readonly sourceWorkoutSessionId: string;
  readonly sourcePerformedExerciseId: string;
  readonly sourcePrescriptionExerciseId: string;
  readonly engine: string;
  readonly policy: string;
  readonly data: ProgressionDecisionDataV1;
  readonly normalizedInputSnapshot: ProgressionEvaluationInput;
  readonly evidenceRefs: readonly ProgressionEvidenceRefV1[];
  readonly evidenceFingerprint: string;
  readonly createdAt: Date;
  readonly appliedAt: Date | null;
  readonly supersededByDecisionId: string | null;
}

interface AssembledExposure {
  readonly engineExposure: ProgressionExposureV1;
  readonly evidenceRefs: readonly ProgressionEvidenceRefV1[];
}

export class ProgressionEvaluationService {
  constructor(
    private readonly db: Database,
    private readonly workoutHistoryService: WorkoutHistoryService,
  ) {}

  /**
   * Evaluates progression for one exact canonical exposure — one
   * `workoutSessionId` + `performedExerciseId` pair (§5: never
   * `ExerciseFamily`/fuzzy matching; one exercise slot at a time) — and
   * persists the resulting decision. Idempotent for identical evidence
   * (§25/§27): repeated or concurrent calls with unchanged evidence return
   * the SAME persisted row, never a duplicate.
   */
  async evaluateAndPersist(
    actor: ProgressionActorV1,
    anchor: { readonly workoutSessionId: string; readonly performedExerciseId: string },
  ): Promise<ProgressionEvaluationOutcome> {
    const [anchorRow] = await this.db
      .select({
        exerciseRef: performedExercises.exerciseRef,
        exerciseOrder: performedExercises.orderIndex,
        prescriptionExerciseId: performedExercises.prescriptionExerciseId,
        sessionId: workoutSessions.id,
        sessionUserId: workoutSessions.userId,
        sessionStatus: workoutSessions.status,
        prescriptionSnapshot: workoutSessions.prescriptionSnapshot,
      })
      .from(performedExercises)
      .innerJoin(workoutSessions, eq(workoutSessions.id, performedExercises.workoutSessionId))
      .where(
        and(
          eq(performedExercises.id, anchor.performedExerciseId),
          eq(performedExercises.workoutSessionId, anchor.workoutSessionId),
        ),
      )
      .limit(1);

    // BOLA (§9/§38): ownership never trusted from the caller beyond the
    // ProgressionActorV1 itself. A mismatched or missing row reports
    // identically (SOURCE_NOT_FOUND) — never distinguishing "exists but
    // isn't yours" from "doesn't exist" to an untrusted caller.
    if (anchorRow === undefined || anchorRow.sessionUserId !== actor.userId) {
      return { status: "SOURCE_NOT_FOUND" };
    }
    if (anchorRow.sessionStatus !== "COMPLETED") {
      return { status: "SOURCE_SESSION_NOT_COMPLETED" };
    }
    const anchorRole = (
      await resolveOccurrenceSessionRoles(this.db, actor.userId, [{ id: anchorRow.sessionId, prescriptionSnapshot: anchorRow.prescriptionSnapshot }])
    ).get(anchorRow.sessionId);
    if (anchorRole === "SECONDARY") {
      return { status: "NOT_CANONICAL_OCCURRENCE_SESSION" };
    }

    const anchorSnapshot = anchorRow.prescriptionSnapshot as WorkoutPrescriptionV1;
    const anchorSnapshotExercise = anchorSnapshot.exercises.find((exercise) => exercise.prescriptionExerciseId === anchorRow.prescriptionExerciseId);
    if (anchorSnapshotExercise?.substitution !== undefined) {
      return { status: "TEMPORARY_SUBSTITUTION_NOT_EVALUATED" };
    }
    const anchorContext = reconstructPrescriptionContext(anchorSnapshot, anchorRow.prescriptionExerciseId);
    if (anchorContext === null) {
      return { status: "NO_PRESCRIPTION_CONTEXT" };
    }

    const anchorSetRows = await this.db
      .select({
        id: performedSets.id,
        prescriptionSetId: performedSets.prescriptionSetId,
        setType: performedSets.setType,
        completionState: performedSets.completionState,
        actualReps: performedSets.actualReps,
        revision: performedSets.revision,
      })
      .from(performedSets)
      .where(eq(performedSets.performedExerciseId, anchor.performedExerciseId));

    const anchorWorking = anchorSetRows.filter((s) => s.setType === "WORKING" && s.completionState === "COMPLETED");
    const anchorExposure: AssembledExposure = {
      engineExposure: {
        comparability: "COMPARABLE",
        exerciseRef: anchorRow.exerciseRef,
        workingSets: anchorWorking.map(
          (s): ProgressionExposureWorkingSetV1 => ({
            prescriptionSetId: s.prescriptionSetId,
            setType: "WORKING",
            actualReps: s.actualReps,
          }),
        ),
      },
      evidenceRefs: anchorWorking.map((s) => ({ performedSetId: s.id, revisionEvaluated: s.revision })),
    };

    const { exposures: priorExposures, excludedByPrescriptionChange } = await this.assemblePriorExposures(
      actor,
      anchorRow.exerciseRef,
      anchor.performedExerciseId,
      { exerciseOrder: anchorRow.exerciseOrder, context: anchorContext },
    );

    const engineInput: ProgressionEvaluationInput = {
      prescription: {
        exerciseRef: anchorRow.exerciseRef,
        prescriptionExerciseId: anchorRow.prescriptionExerciseId ?? "",
        targetReps: anchorContext.targetReps,
        targetLoad: anchorContext.targetLoad,
        prescribedWorkingSetIds: anchorContext.prescribedWorkingSetIds,
      },
      exposures: [anchorExposure.engineExposure, ...priorExposures.map((e) => e.engineExposure)],
      ...(excludedByPrescriptionChange ? { priorExposuresExcludedByPrescriptionChange: true } : {}),
    };

    const evaluation = evaluateProgression(engineInput);
    if (!evaluation.ok) {
      return { status: "ENGINE_VALIDATION_FAILED", reason: evaluation.error.reason };
    }
    const decision = evaluation.value;

    const evidenceRefs: readonly ProgressionEvidenceRefV1[] = [
      ...anchorExposure.evidenceRefs,
      ...priorExposures.flatMap((e) => e.evidenceRefs),
    ];

    const evidenceFingerprint = computeEvidenceFingerprint({
      engine: decision.version.engine,
      policy: decision.version.policy,
      userId: actor.userId,
      sourceWorkoutSessionId: anchor.workoutSessionId,
      sourcePerformedExerciseId: anchor.performedExerciseId,
      sourcePrescriptionExerciseId: anchorRow.prescriptionExerciseId ?? "",
      normalizedInputSnapshot: engineInput,
      evidenceRefs,
    });

    const persisted = await this.persist({
      userId: actor.userId,
      exerciseRef: anchorRow.exerciseRef,
      sourceWorkoutSessionId: anchor.workoutSessionId,
      sourcePerformedExerciseId: anchor.performedExerciseId,
      sourcePrescriptionExerciseId: anchorRow.prescriptionExerciseId ?? "",
      data: decision.data,
      normalizedInputSnapshot: engineInput,
      evidenceRefs,
      evidenceFingerprint,
    });

    return persisted;
  }

  /**
   * §8/§10/§18 — fetches a bounded candidate buffer via the existing
   * `WorkoutHistoryService`, groups the flat set-rows it returns into real
   * exposures (§4: one exposure = the WORKING sets for one exercise in one
   * session), classifies each against the anchor, and keeps at most
   * `MAX_PRIOR_COMPARABLE_EXPOSURES` COMPARABLE/COMPARABLE_WITH_CONTEXT
   * ones, most-recent-first. NOT_COMPARABLE candidates are skipped
   * entirely — never passed to the engine, never counted toward the
   * budget.
   */
  private async assemblePriorExposures(
    actor: ProgressionActorV1,
    exerciseRef: string,
    excludeAnchorPerformedExerciseId: string,
    anchor: { readonly exerciseOrder: number; readonly context: NonNullable<ReturnType<typeof reconstructPrescriptionContext>> },
  ): Promise<{ readonly exposures: readonly AssembledExposure[]; readonly excludedByPrescriptionChange: boolean }> {
    const rawRows = await this.workoutHistoryService.getRecentWorkingExposures(actor, exerciseRef, HISTORY_OVERFETCH_LIMIT);

    const grouped = groupIntoExposures(rawRows, excludeAnchorPerformedExerciseId);
    if (grouped.length === 0) return { exposures: [], excludedByPrescriptionChange: false };

    const sessionIds = [...new Set(grouped.map((g) => g.workoutSessionId))];
    const sessionRows = await this.db
      .select({ id: workoutSessions.id, status: workoutSessions.status, prescriptionSnapshot: workoutSessions.prescriptionSnapshot })
      .from(workoutSessions)
      .where(inArray(workoutSessions.id, sessionIds));
    const sessionsById = new Map(sessionRows.map((r) => [r.id, r]));
    // Planned Workout Occurrence Authority V1: a SECONDARY session never
    // counts as planned evidence — one planned occurrence must never be
    // counted twice. (Its raw history is untouched; this is a progression
    // filter only.)
    const roles = await resolveOccurrenceSessionRoles(this.db, actor.userId, sessionRows);

    const accepted: AssembledExposure[] = [];
    let excludedByPrescriptionChange = false;

    for (const group of grouped) {
      if (accepted.length >= MAX_PRIOR_COMPARABLE_EXPOSURES) break;

      const session = sessionsById.get(group.workoutSessionId);
      if (session === undefined || session.status !== "COMPLETED") continue;
      if (roles.get(session.id) === "SECONDARY") continue;

      const snapshot = session.prescriptionSnapshot as WorkoutPrescriptionV1;
      const context = reconstructPrescriptionContext(snapshot, group.prescriptionExerciseId);
      if (context === null) continue; // cannot reconstruct — excluded, never fabricated (not a "prescription changed" case)

      const hasUnmatchedWorkingSet = group.sets.some(
        (s) => s.prescriptionSetId === null || !context.prescribedWorkingSetIds.includes(s.prescriptionSetId),
      );
      const tier = classifyComparability(anchor, { exerciseOrder: group.exerciseOrder, context, hasUnmatchedWorkingSet });
      if (tier === "NOT_COMPARABLE") {
        excludedByPrescriptionChange = true;
        continue;
      }

      accepted.push({
        engineExposure: {
          comparability: tier,
          exerciseRef,
          workingSets: group.sets.map(
            (s): ProgressionExposureWorkingSetV1 => ({
              prescriptionSetId: s.prescriptionSetId,
              setType: "WORKING",
              actualReps: s.actualReps,
            }),
          ),
        },
        evidenceRefs: group.sets.map((s) => ({ performedSetId: s.performedSetId, revisionEvaluated: s.revision })),
      });
    }

    return { exposures: accepted, excludedByPrescriptionChange };
  }

  /**
   * Idempotent insert (§25/§27) — a real DB-enforced unique constraint on
   * `evidence_fingerprint`, never "check then insert" (which races; proven
   * by a real concurrent-insert integration test). On a genuine new
   * decision, links any prior un-superseded decision for the SAME source
   * exposure as superseded (§23/§24) in the same transaction.
   */
  private async persist(input: {
    readonly userId: string;
    readonly exerciseRef: string;
    readonly sourceWorkoutSessionId: string;
    readonly sourcePerformedExerciseId: string;
    readonly sourcePrescriptionExerciseId: string;
    readonly data: ProgressionDecisionDataV1;
    readonly normalizedInputSnapshot: ProgressionEvaluationInput;
    readonly evidenceRefs: readonly ProgressionEvidenceRefV1[];
    readonly evidenceFingerprint: string;
  }): Promise<ProgressionEvaluationOutcome> {
    const newId = createEntityId<"ProgressionDecision">();

    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(progressionDecisions)
        .values({
          id: newId,
          userId: input.userId,
          exerciseRef: input.exerciseRef,
          sourceWorkoutSessionId: input.sourceWorkoutSessionId,
          sourcePerformedExerciseId: input.sourcePerformedExerciseId,
          sourcePrescriptionExerciseId: input.sourcePrescriptionExerciseId,
          engine: ENGINE_VERSION.engine,
          policy: ENGINE_VERSION.policy,
          decisionType: input.data.decisionType,
          reasonCode: input.data.reasonCode,
          evidenceStrength: input.data.evidenceStrength,
          progressionStalled: input.data.progressionStalled,
          recommendedChange: input.data.recommendedChange,
          normalizedInputSnapshot: input.normalizedInputSnapshot,
          evidenceRefs: input.evidenceRefs,
          evidenceFingerprint: input.evidenceFingerprint,
          appliedAt: null,
        })
        .onConflictDoNothing({ target: progressionDecisions.evidenceFingerprint })
        .returning();

      if (inserted.length === 0) {
        // Idempotent no-op — this exact evidence was already evaluated
        // (either an earlier call, or the loser of a concurrent race).
        const [existing] = await tx
          .select()
          .from(progressionDecisions)
          .where(eq(progressionDecisions.evidenceFingerprint, input.evidenceFingerprint))
          .limit(1);
        if (existing === undefined) {
          // Vanishingly unlikely (the row we just lost a race for should
          // always be readable in the same transaction), but never persist
          // a misleading result if it somehow happens (§30).
          return { status: "ENGINE_VALIDATION_FAILED", reason: "IDEMPOTENCY_ROW_NOT_FOUND" };
        }
        return { status: "PERSISTED", decision: toPersistedDecision(existing), wasNewlyCreated: false };
      }

      const [newRow] = inserted;
      if (newRow === undefined) {
        return { status: "ENGINE_VALIDATION_FAILED", reason: "INSERT_RETURNED_NO_ROW" };
      }

      // Supersession (§23/§24): link the previously-active decision for
      // this exact source exposure, if one exists. A plain WHERE-gated
      // UPDATE — the row lock Postgres takes for the duration of this
      // UPDATE serializes any concurrent attempt to do the same thing, so
      // at most one transaction ever successfully links a given old
      // decision.
      await tx
        .update(progressionDecisions)
        .set({ supersededByDecisionId: newRow.id })
        .where(
          and(
            eq(progressionDecisions.sourcePerformedExerciseId, input.sourcePerformedExerciseId),
            ne(progressionDecisions.id, newRow.id),
            sql`${progressionDecisions.supersededByDecisionId} IS NULL`,
          ),
        );

      return { status: "PERSISTED", decision: toPersistedDecision(newRow), wasNewlyCreated: true };
    });
  }
}

interface GroupedExposureCandidate {
  readonly workoutSessionId: string;
  readonly prescriptionExerciseId: string | null;
  readonly exerciseOrder: number;
  readonly sets: readonly PerformedSetExposureV1[];
}

/**
 * Groups the flat, most-recent-first rows `WorkoutHistoryService` returns
 * into real exposures (§4), preserving most-recent-first order by the
 * first row of each distinct `performedExerciseId` encountered — never
 * re-sorting by `completedAt` after grouping (§23, canonical identity
 * order, not timestamp order). The anchor's own performed exercise is
 * excluded (it is evaluated separately as `exposures[0]`, never counted
 * twice). Only `completionState === "COMPLETED"` sets count — a
 * `REOPENED` set is mid-correction, not settled evidence.
 */
function groupIntoExposures(
  rows: readonly PerformedSetExposureV1[],
  excludePerformedExerciseId: string,
): readonly GroupedExposureCandidate[] {
  const order: string[] = [];
  const bucket = new Map<string, PerformedSetExposureV1[]>();

  for (const row of rows) {
    if (row.performedExerciseId === excludePerformedExerciseId) continue;
    if (row.completionState !== "COMPLETED") continue;
    if (!bucket.has(row.performedExerciseId)) {
      bucket.set(row.performedExerciseId, []);
      order.push(row.performedExerciseId);
    }
    bucket.get(row.performedExerciseId)!.push(row);
  }

  return order.map((performedExerciseId) => {
    const sets = bucket.get(performedExerciseId)!;
    const [first] = sets;
    return {
      workoutSessionId: first!.workoutSessionId,
      prescriptionExerciseId: first!.prescriptionExerciseId,
      exerciseOrder: first!.exerciseOrder,
      sets,
    };
  });
}

function toPersistedDecision(row: typeof progressionDecisions.$inferSelect): PersistedProgressionDecision {
  return {
    id: row.id,
    userId: row.userId,
    exerciseRef: row.exerciseRef,
    sourceWorkoutSessionId: row.sourceWorkoutSessionId,
    sourcePerformedExerciseId: row.sourcePerformedExerciseId,
    sourcePrescriptionExerciseId: row.sourcePrescriptionExerciseId,
    engine: row.engine,
    policy: row.policy,
    data: {
      decisionType: row.decisionType,
      reasonCode: row.reasonCode,
      evidenceStrength: row.evidenceStrength,
      progressionStalled: row.progressionStalled,
      recommendedChange: row.recommendedChange as ProgressionDecisionDataV1["recommendedChange"],
    },
    normalizedInputSnapshot: row.normalizedInputSnapshot as ProgressionEvaluationInput,
    evidenceRefs: row.evidenceRefs as readonly ProgressionEvidenceRefV1[],
    evidenceFingerprint: row.evidenceFingerprint,
    createdAt: row.createdAt,
    appliedAt: row.appliedAt,
    supersededByDecisionId: row.supersededByDecisionId,
  };
}
