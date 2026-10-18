import { and, desc, eq, sql } from "drizzle-orm";
import { performedExercises, performedSets, workoutSessions, type Database } from "@vostivo/database";
import type { ExternalWeightLoad, PerformedSetCompletionState, SetType } from "@vostivo/domain";
import type { ProgressionActorV1 } from "./actor.js";

/**
 * The smallest bound over the Progression Engine V1 evidence window
 * (docs/domain/PROGRESSION-ENGINE-V1.md §11 — a 3-exposure trend window)
 * that comfortably covers several recent sessions' worth of working sets
 * for one exercise, without scanning an athlete's full training history.
 * Deliberately generous over the window itself: comparability
 * classification (which exposures actually count) is a later slice's job
 * (§10/§29) — this query hands back candidate evidence, not a decision.
 */
const DEFAULT_HISTORY_LIMIT = 40;
const MAX_HISTORY_LIMIT = 100;

/**
 * One canonical performed-set row, exactly as needed for a future
 * Progression Engine evidence-assembly step to classify comparability
 * (Progression Prerequisites V1, docs/domain/PROGRESSION-ENGINE-V1.md
 * §29) — never a decision, never a comparability classification. Plain
 * data, not a serialized ORM row.
 */
export interface PerformedSetExposureV1 {
  readonly performedSetId: string;
  readonly performedExerciseId: string;
  readonly workoutSessionId: string;
  /**
   * Progression EngineDecision Persistence & Evidence Integration V1 —
   * added so a caller (the progression evidence assembler) can look up
   * the immutable prescription snapshot that governed this specific
   * exposure (§7 — never today's live Plan). `null` for an unplanned/
   * extra exercise the athlete performed without a matching planned slot.
   */
  readonly prescriptionExerciseId: string | null;
  readonly prescriptionSetId: string | null;
  readonly exerciseOrder: number;
  readonly setOrder: number;
  readonly actualReps: number;
  readonly actualLoad: ExternalWeightLoad;
  readonly setType: SetType;
  readonly completionState: PerformedSetCompletionState;
  readonly revision: number;
  readonly completedAt: Date | null;
}

/**
 * Progression Prerequisites V1's one server-side capability: a bounded,
 * ownership-scoped read of an athlete's recent `WORKING` performed-set
 * history for one exact `exerciseRef` (docs/domain/PROGRESSION-ENGINE-V1.md
 * §29's "expected query shape"). Deliberately NOT exposed as an HTTP
 * endpoint — no progression/history route exists yet, matching the task's
 * "prefer no new public endpoint" instruction; this is a plain injectable
 * service a future application-layer evidence-assembly step (Progression
 * Engine V1 slice C) will call directly.
 *
 * This does not evaluate progression, classify comparability, or return
 * "exposures" grouped by session — it returns the bounded raw canonical
 * evidence a later slice groups/classifies. No progression decision logic
 * lives here (locked scope boundary — see the final report).
 *
 * Framework-agnostic (Orchestration V1 framework-boundary cleanup): a
 * plain class with an explicit constructor dependency, no Nest decorators,
 * no `reflect-metadata` requirement — `apps/worker` constructs it directly
 * with `new`, and `apps/api` adapts it into its own Nest DI via an
 * explicit `useFactory` provider (`workout.module.ts`), never by decorating
 * the class itself.
 */
export class WorkoutHistoryService {
  constructor(private readonly db: Database) {}

  /**
   * Ownership derives from `ProgressionActorV1.userId` — the real
   * ownership column on `app.workout_sessions` (never a client-supplied
   * id, never `athleteProfileId`: workout execution history in this
   * codebase has always been owned by `userId`, the same column every
   * other WDI command handler already checks — see
   * `workout-command-processing.ts`'s `applyCompleteSet`/`applyReopenSet`.
   * `athleteProfileId` owns the separate Plan/Program hierarchy, not
   * performed workout reality).
   *
   * Filters to `setType = 'WORKING'` at the query level (Progression
   * Prerequisites V1 §5.6 — warm-up sets are structurally excluded from
   * progression evidence, never filtered out later by a caller that might
   * forget to).
   */
  async getRecentWorkingExposures(
    actor: ProgressionActorV1,
    exerciseRef: string,
    limit: number = DEFAULT_HISTORY_LIMIT,
  ): Promise<readonly PerformedSetExposureV1[]> {
    const boundedLimit = Math.max(1, Math.min(limit, MAX_HISTORY_LIMIT));

    const rows = await this.db
      .select({
        performedSetId: performedSets.id,
        performedExerciseId: performedSets.performedExerciseId,
        workoutSessionId: performedExercises.workoutSessionId,
        prescriptionExerciseId: performedExercises.prescriptionExerciseId,
        prescriptionSetId: performedSets.prescriptionSetId,
        exerciseOrder: performedExercises.orderIndex,
        setOrder: performedSets.orderIndex,
        actualReps: performedSets.actualReps,
        loadKind: performedSets.loadKind,
        loadAmountMilli: performedSets.loadAmountMilli,
        loadUnit: performedSets.loadUnit,
        loadBasis: performedSets.loadBasis,
        setType: performedSets.setType,
        completionState: performedSets.completionState,
        revision: performedSets.revision,
        completedAt: performedSets.completedAt,
      })
      .from(performedSets)
      .innerJoin(performedExercises, eq(performedExercises.id, performedSets.performedExerciseId))
      .innerJoin(workoutSessions, eq(workoutSessions.id, performedExercises.workoutSessionId))
      .where(
        and(
          eq(workoutSessions.userId, actor.userId),
          eq(performedExercises.exerciseRef, exerciseRef),
          eq(performedSets.setType, "WORKING"),
        ),
      )
      .orderBy(desc(sql`coalesce(${performedSets.completedAt}, ${performedSets.createdAt})`))
      .limit(boundedLimit);

    return rows.map((row) => ({
      performedSetId: row.performedSetId,
      performedExerciseId: row.performedExerciseId,
      workoutSessionId: row.workoutSessionId,
      prescriptionExerciseId: row.prescriptionExerciseId,
      prescriptionSetId: row.prescriptionSetId,
      exerciseOrder: row.exerciseOrder,
      setOrder: row.setOrder,
      actualReps: row.actualReps,
      actualLoad: {
        kind: "EXTERNAL_WEIGHT",
        amountMilli: row.loadAmountMilli,
        unit: row.loadUnit,
        basis: row.loadBasis,
      },
      setType: row.setType,
      completionState: row.completionState,
      revision: row.revision,
      completedAt: row.completedAt,
    }));
  }
}
