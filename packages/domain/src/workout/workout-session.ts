import type { EntityId } from "../entity-id.js";
import type { WorkoutPrescriptionV1 } from "./prescription.js";

export type WorkoutSessionId = EntityId<"WorkoutSession">;

/**
 * Deliberately minimal (spec section 9: "do not invent large lifecycle
 * models yet"). `COMPLETED` is reserved for a future "finish workout"
 * operation — not implemented by this slice; every session this slice
 * creates stays `ACTIVE`. The single-local-active-session guard (spec
 * section 36) is what actually prevents duplicate concurrent sessions,
 * not this status field.
 */
export const WORKOUT_SESSION_STATUSES = ["ACTIVE", "COMPLETED"] as const;
export type WorkoutSessionStatus = (typeof WORKOUT_SESSION_STATUSES)[number];

/**
 * `prescription` is an immutable snapshot taken at session start (spec
 * section 6) — later changes to the source Plan/Program data must never
 * rewrite what this session was actually prescribed. `userId` is
 * server-derived ownership, never trusted from a sync payload (spec
 * section 21/24).
 *
 * `completedAt` is set exactly once, by `FINISH_WORKOUT_SESSION_V1`
 * (Active Workout Core Logger V1, section 25/26) — `null` while
 * `status === "ACTIVE"`. Finishing is local-first and allowed with
 * incomplete planned sets (section 27); it never deletes or rewrites
 * `PerformedExercise`/`PerformedSet` reality (section 29).
 */
export interface WorkoutSession {
  readonly id: WorkoutSessionId;
  readonly userId: string;
  readonly prescription: WorkoutPrescriptionV1;
  readonly startedAt: Date;
  readonly status: WorkoutSessionStatus;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The single source of truth for "is this session still active" (spec
 * section 29) — a `COMPLETED` session must never again be treated as the
 * one active session, regardless of what else changes about it. A pure
 * predicate rather than scattering `status === "ACTIVE"` checks.
 */
export function isActiveWorkoutSession(session: Pick<WorkoutSession, "status">): boolean {
  return session.status === "ACTIVE";
}
