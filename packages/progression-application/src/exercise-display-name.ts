import { and, eq } from "drizzle-orm";
import { plannedExercises, plannedWorkouts, trainingBlocks, trainingCycles, type Database } from "@vostivo/database";

/**
 * Progression Application V1 — Slice E Final Presentation-Integrity Gate
 * (task §2/§3/§4) — the ONE place athlete-facing exercise naming is
 * resolved. Returns `null` — NEVER the raw `exerciseRef` — when the exact
 * canonical `PlannedExercise` at an application's own locked Program Slot
 * Identity can no longer be resolved (the Plan changed underneath a still-
 * pending application). Every caller MUST treat `null` as "this
 * application is not presentable to the athlete right now," never as a
 * license to substitute an internal identifier as copy.
 *
 * Deliberately the SAME join + identity-match rigor as
 * `computeRevalidation`'s own slot re-resolution (`programVersionId`
 * mismatch is corruption, `exerciseRef` mismatch is corruption — never a
 * legitimate second stream), kept in its own module specifically so both
 * `progression-review.ts` (the pending list) and
 * `progression-application-apply.ts` (`resolveApplicationProposal`) can
 * share it without a circular import between those two files.
 */
export interface ProgramSlotIdentityRef {
  readonly programVersionId: string;
  readonly trainingBlockId: string;
  readonly workoutOrderIndex: number;
  readonly exerciseOrderIndex: number;
  readonly exerciseRef: string;
}

export async function resolveExerciseDisplayName(db: Database, slot: ProgramSlotIdentityRef): Promise<string | null> {
  const [row] = await db
    .select({
      displayName: plannedExercises.displayName,
      exerciseRef: plannedExercises.exerciseRef,
      trainingBlockProgramVersionId: trainingBlocks.programVersionId,
    })
    .from(plannedExercises)
    .innerJoin(plannedWorkouts, eq(plannedWorkouts.id, plannedExercises.plannedWorkoutId))
    .innerJoin(trainingCycles, eq(trainingCycles.id, plannedWorkouts.trainingCycleId))
    .innerJoin(trainingBlocks, eq(trainingBlocks.id, trainingCycles.trainingBlockId))
    .where(
      and(
        eq(trainingBlocks.id, slot.trainingBlockId),
        eq(plannedWorkouts.orderIndex, slot.workoutOrderIndex),
        eq(plannedExercises.orderIndex, slot.exerciseOrderIndex),
      ),
    )
    .limit(1);

  if (row === undefined) return null;
  if (row.trainingBlockProgramVersionId !== slot.programVersionId || row.exerciseRef !== slot.exerciseRef) return null;
  return row.displayName;
}
