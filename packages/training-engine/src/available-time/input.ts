import type { SetType } from "@vostivo/domain";
import type { PriorityTierV1 } from "./vocabulary.js";

/**
 * Available-Time Adaptation V1 (locked §12) — the smallest pure
 * normalized representation. `exerciseKey`/`setKey` are opaque, stable
 * input references (never re-interpreted as `exerciseRef`/DB ids by this
 * engine) — the future assembler owns what they actually mean. No
 * `userId`, mode, subscription, `GymProfile`, or progression state
 * reaches this pure engine (§12) — mode/authority is an outer,
 * application-layer concern (§13), never a branch inside the mechanical
 * engine.
 *
 * `restSeconds` is REQUIRED on every set, never `null` (§9's own explicit
 * permission: "the simplest normalization may require valid restSeconds
 * on every input set... that is acceptable") — the engine must never
 * guess missing rest, and making it non-optional here is the simplest way
 * to keep that a compile-time/validation-time guarantee rather than a
 * runtime null-check scattered through the duration estimator.
 */
export interface AvailableTimeSetV1 {
  readonly setKey: string;
  readonly orderIndex: number;
  readonly setType: SetType;
  /** Seconds of rest AFTER this set, before the next one — never counted after the last RETAINED set of an exercise (`./duration.ts`). */
  readonly restSeconds: number;
}

/**
 * One already-planned exercise slot. `priorityTier` and
 * `minimumWorkingSets` are the two locked (§2/§3) adaptation-priority
 * signals — their Plan-authoring/persistence source is an explicit
 * Slice-B decision, not this slice's concern (§20).
 */
export interface AvailableTimeExerciseV1 {
  readonly exerciseKey: string;
  readonly orderIndex: number;
  readonly priorityTier: PriorityTierV1;
  /** Locked invariant (§3): `0 <= minimumWorkingSets <= (count of WORKING sets in `sets`)`. `0` means the whole exercise may eventually be fully removed. */
  readonly minimumWorkingSets: number;
  readonly sets: readonly AvailableTimeSetV1[];
}

/**
 * The fully normalized, pure engine input (§12). The engine never reads
 * Plan/Postgres/device state itself — assembling this shape from
 * `PlannedWorkout`/`PlannedExercise`/`PlannedSet` (plus wherever
 * `priorityTier`/`minimumWorkingSets` eventually live) is an
 * application-layer job for a future slice, exactly the same boundary the
 * Progression Engine already establishes for its own
 * `ProgressionEvaluationInput`.
 */
export interface AvailableTimeInputV1 {
  readonly availableTimeSeconds: number;
  readonly exercises: readonly AvailableTimeExerciseV1[];
}
