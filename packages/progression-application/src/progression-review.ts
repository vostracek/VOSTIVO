import { and, asc, eq } from "drizzle-orm";
import { progressionApplications, type Database, type ExpectedEffectiveLoadRow } from "@vostivo/database";
import type { ProgressionActorV1 } from "./actor.js";
import { resolveExerciseDisplayName } from "./exercise-display-name.js";
import { resolveApplicationProposal, type ApplicationProposalOutcome } from "./progression-application-apply.js";

/**
 * Progression Application V1 — Slice D (task §21) — `listPendingProgressionApplications`.
 * A decision-ready, framework-neutral query: only applications OWNED by
 * `actor` and currently `PENDING_REVIEW`. Deliberately excludes internal
 * engine/evidence internals (task §21's own explicit list: no normalized
 * engine input blob, no raw evidence snapshot, no capability internals
 * beyond what a proposal already exposes, no SQL identities irrelevant to
 * a client).
 *
 * **Mode-agnostic by design (task §28)**: this primitive returns every
 * owned `PENDING_REVIEW` row regardless of current authority — including
 * a GUIDED application left `PENDING_REVIEW` by a failed system apply
 * (task §17/§28's own explicit "may internally return Guided blocked
 * applications as owned pending data, because they are real domain
 * state"). The PUBLIC athlete-facing filtering (task §28's second half —
 * "only expose actionable review items when authority = ATHLETE_REVIEW")
 * is an API-boundary concern, not this shared package's — it belongs in
 * `apps/api`'s own service, alongside `resolveProgressionAuthority`,
 * never duplicated here.
 *
 * **Presentation-integrity gate (Slice E final gate, task §2/§3)**: a row
 * is only ever included when its exact canonical `PlannedExercise` can
 * still be resolved (`resolveExerciseDisplayName`) — never a raw
 * `exerciseRef` fallback. An application whose Program Slot Identity no
 * longer resolves is simply OMITTED from this list — it is a presentation
 * filter only; it does NOT transition the application's own persisted
 * `status` (that remains exclusively `computeRevalidation`'s/the existing
 * Apply/Keep-Original paths' concern — task §3's own explicit "this gate
 * is presentation integrity, not a new state-machine rule").
 */
export interface PendingProgressionApplicationItem {
  readonly applicationId: string;
  readonly exerciseRef: string;
  /** Presentation-safe, human-readable name, resolved server-side — see `resolveExerciseDisplayName`. Every item returned by this function has one; there is no raw-`exerciseRef` fallback anywhere on this path. */
  readonly exerciseDisplayName: string;
  readonly expectedEffectiveLoad: ExpectedEffectiveLoadRow;
  readonly proposal: ApplicationProposalOutcome;
}

/**
 * Ordered oldest-first (task §16 (Slice E unblock)'s explicit V1 fallback
 * — "nearest future occurrence" is not cheaply derivable from the
 * Program Slot Identity alone without new scheduling joins, so this
 * deliberately uses the simpler, already-approved fallback).
 * `id ASC` is a real time order — `EntityId`s are UUIDv7 (this codebase's
 * own established convention), never a separate `createdAt` sort needed.
 */
export async function listPendingProgressionApplications(
  db: Database,
  actor: ProgressionActorV1,
): Promise<readonly PendingProgressionApplicationItem[]> {
  const rows = await db
    .select({
      id: progressionApplications.id,
      exerciseRef: progressionApplications.exerciseRef,
      programVersionId: progressionApplications.programVersionId,
      trainingBlockId: progressionApplications.trainingBlockId,
      workoutOrderIndex: progressionApplications.workoutOrderIndex,
      exerciseOrderIndex: progressionApplications.exerciseOrderIndex,
      expectedEffectiveLoad: progressionApplications.expectedEffectiveLoad,
    })
    .from(progressionApplications)
    .where(and(eq(progressionApplications.userId, actor.userId), eq(progressionApplications.status, "PENDING_REVIEW")))
    .orderBy(asc(progressionApplications.id));

  const items = await Promise.all(
    rows.map(async (row): Promise<PendingProgressionApplicationItem | null> => {
      const [proposal, exerciseDisplayName] = await Promise.all([resolveApplicationProposal(db, actor, row.id), resolveExerciseDisplayName(db, row)]);
      if (exerciseDisplayName === null) return null;
      return { applicationId: row.id, exerciseRef: row.exerciseRef, exerciseDisplayName, expectedEffectiveLoad: row.expectedEffectiveLoad, proposal };
    }),
  );

  return items.filter((item): item is PendingProgressionApplicationItem => item !== null);
}
