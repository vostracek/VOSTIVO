import type { AvailableTimeApplicationV1, ExternalWeightLoad, SetType, WorkoutPrescriptionV1 } from "@vostivo/domain";

/**
 * Wire contract for the workout sync commands (spec section 18/26).
 * Deliberately only these three command types — a domain-aware outbox,
 * not "sync every table row." All timestamps are ISO 8601 strings on the
 * wire; `commandId` is a client-generated UUIDv7 and is the sole
 * idempotency key (spec section 20).
 */
interface BaseWorkoutCommandV1 {
  readonly commandId: string;
  readonly schemaVersion: 1;
  readonly createdAt: string;
}

export interface StartWorkoutSessionCommandV1 extends BaseWorkoutCommandV1 {
  readonly type: "START_WORKOUT_SESSION_V1";
  readonly workoutSessionId: string;
  readonly prescription: WorkoutPrescriptionV1;
  readonly startedAt: string;
  /**
   * Available-Time Adaptation V1 Slice C — OPTIONAL, additive (same
   * precedent as `setType`/`exerciseRef`/`sessionSeq` within V1): present
   * only when the athlete explicitly chose "Start adjusted workout" from an
   * `ADJUST_SESSION` preview, in which case `prescription` is already the
   * adjusted (retained-sets-only) snapshot. Absent on every ordinary START,
   * whose payload is byte-for-byte unchanged.
   */
  readonly availableTimeApplication?: AvailableTimeApplicationV1;
}

/**
 * Carries enough denormalized exercise data to idempotently upsert the
 * parent `PerformedExercise` as a side effect — deliberately not a
 * separate fourth command type (spec section 18: "initial command set
 * should be deliberately small").
 */
export interface CompleteSetCommandV1 extends BaseWorkoutCommandV1 {
  readonly type: "COMPLETE_SET_V1";
  readonly workoutSessionId: string;
  readonly performedExerciseId: string;
  readonly prescriptionExerciseId: string | null;
  /**
   * The stable cross-session catalog pointer (Progression Prerequisites
   * V1, docs/domain/PROGRESSION-ENGINE-V1.md §25/OD-1) — denormalized
   * here the same way `exerciseDisplayName`/`exerciseOrder` already are,
   * so the server can persist it onto `app.performed_exercises` without a
   * second round trip. Supersedes the prior Active Workout Core Logger V1
   * scoping decision that kept this mobile-local-only: it is now
   * synchronized, queryable canonical server workout reality. Never
   * derived from `exerciseDisplayName` — `null` means "no reliable
   * cross-session identity," same semantics as `ExerciseIdentityV1`
   * everywhere else.
   */
  /**
   * Required (Exercise Ref Legacy Reconciliation) — a `COMPLETE_SET_V1`
   * whose source planned exercise has no resolved `exerciseRef` is
   * rejected before it reaches persistence, never stored with a null
   * identity. See `PerformedExercise.exerciseRef` in `@vostivo/domain`.
   */
  readonly exerciseRef: string;
  readonly exerciseDisplayName: string;
  readonly exerciseOrder: number;
  readonly performedSetId: string;
  readonly prescriptionSetId: string | null;
  readonly setOrder: number;
  readonly actualReps: number;
  readonly actualLoad: ExternalWeightLoad;
  /**
   * Required, always explicit (Progression Prerequisites V1) — the server
   * never infers set type from any other field. Carried on every
   * completion, including a recompletion, so a corrected `setType`
   * (e.g. WARM_UP -> WORKING) reaches canonical reality the same way a
   * corrected `actualReps` already does — no separate command.
   */
  readonly setType: SetType;
  readonly revision: number;
  readonly completedAt: string;
  /**
   * Per-session monotonic sequence, client-allocated atomically at
   * mutation-creation time — never derived from wall-clock time (Active
   * Workout Finish Causal Boundary Fix). This is what lets the server
   * distinguish "created before this session's local Finish, delivered
   * late" (must still apply) from "created after Finish" (must be
   * rejected), independent of network delivery order — see
   * ADR-0007's "Finish causal boundary" section. Distinct from
   * `revision`, which is scoped to one set, not the whole session.
   */
  readonly sessionSeq: number;
}

export interface ReopenSetCommandV1 extends BaseWorkoutCommandV1 {
  readonly type: "REOPEN_SET_V1";
  readonly performedSetId: string;
  readonly revision: number;
  /** See `CompleteSetCommandV1.sessionSeq`. */
  readonly sessionSeq: number;
}

/**
 * The minimum required extension to represent workout completion (Active
 * Workout Core Logger V1, section 25) — deliberately not a generic session
 * PATCH. Finishing is a one-way, idempotent transition: applying it twice
 * (even with different `commandId`s, e.g. a genuine retry after a lost
 * acknowledgement) converges to the same canonical state, so it needs no
 * revision counter of its own.
 */
export interface FinishWorkoutSessionCommandV1 extends BaseWorkoutCommandV1 {
  readonly type: "FINISH_WORKOUT_SESSION_V1";
  readonly workoutSessionId: string;
  readonly completedAt: string;
  /**
   * The Finish causal boundary/watermark: the highest `sessionSeq` validly
   * issued (client-side) before this local Finish transition — see
   * `CompleteSetCommandV1.sessionSeq`. `0` if no set mutation was ever
   * issued for this session. Established once; a later, different FINISH
   * command for the same session must never move it.
   */
  readonly finishSeq: number;
}

export type WorkoutCommandV1 =
  | StartWorkoutSessionCommandV1
  | CompleteSetCommandV1
  | ReopenSetCommandV1
  | FinishWorkoutSessionCommandV1;

/**
 * Client-distinguishable outcomes (spec section 27):
 * - APPLIED: genuinely new, mutated canonical state.
 * - DUPLICATE: this exact commandId was already processed before —
 *   nothing changed, safe to mark SYNCED.
 * - STALE: a different, later-revision command already superseded this
 *   one — the underlying reality was NOT reverted; safe to mark SYNCED.
 * - CONFLICT: a genuine domain conflict needing intervention (not used by
 *   the revision-gated writes in this slice, reserved for future use).
 * - REJECTED: permanently invalid (validation failure, ownership
 *   mismatch) — never retry as-is.
 *
 * A transport/server failure (timeout, 5xx) is NOT one of these outcomes
 * — it means no acknowledgement was received at all, which the client
 * treats as retryable (spec section 33).
 */
export const SYNC_OUTCOMES = ["APPLIED", "DUPLICATE", "STALE", "CONFLICT", "REJECTED"] as const;
export type SyncOutcome = (typeof SYNC_OUTCOMES)[number];

export interface WorkoutCommandAcknowledgementV1 {
  readonly commandId: string;
  readonly outcome: SyncOutcome;
  /** Safe, non-leaking explanation — never a raw DB/validation error string. */
  readonly reason?: string;
}

export interface SyncWorkoutCommandsRequest {
  /**
   * Auth & Local Athlete Boundary V1 Slice B — the verified `userId` that
   * owns the mobile runtime (and therefore the local outbox) this batch was
   * read from. A CONSISTENCY / wrong-runtime guard only, never
   * authorization: the server compares it with the authenticated actor and
   * rejects the WHOLE batch (409 `SYNC_OWNER_MISMATCH`, nothing processed or
   * persisted) on mismatch. Ownership itself still comes only from the
   * bearer token.
   */
  readonly ownerUserId: string;
  readonly commands: readonly WorkoutCommandV1[];
}

/** 409 body code: the batch's `ownerUserId` is not the authenticated actor (Slice B). */
export const SYNC_OWNER_MISMATCH = "SYNC_OWNER_MISMATCH";

export interface SyncWorkoutCommandsResponse {
  readonly acknowledgements: readonly WorkoutCommandAcknowledgementV1[];
}
