import {
  availableTimeApplicationFromPreview,
  type AvailableTimeApplicationFromPreviewError,
  type AvailableTimePreviewResponseV1,
  type WorkoutPreviewV1,
} from "@vostivo/contracts";
import {
  selectAvailableTimePrescription,
  type AvailableTimeApplicationV1,
  type AvailableTimeSelectionReason,
  type WorkoutPrescriptionV1,
} from "@vostivo/domain";
import type { ActiveWorkoutSession } from "./active-workout-session";
import type { StartWorkoutSessionOutcome } from "./workout-repository";

/** The durable local start — `WorkoutApplicationService`/`WorkoutRepository` in production. */
export interface AdjustedWorkoutSessionStarter {
  startWorkoutSession(prescription: WorkoutPrescriptionV1, availableTimeApplication: AvailableTimeApplicationV1): Promise<StartWorkoutSessionOutcome>;
}

/** The existing fire-and-forget sync trigger — `WorkoutSyncCoordinator` in production. */
export interface WorkoutSyncRequester {
  requestSync(trigger: "mutation"): void;
}

export interface StartAdjustedWorkoutInput {
  /** The server Workout Preview — its `prescription` is the canonical effective (progression-overlaid) prescription a normal START uses. */
  readonly workoutPreview: WorkoutPreviewV1;
  /** The server Available-Time preview the athlete explicitly chose to apply. */
  readonly availableTimePreview: AvailableTimePreviewResponseV1;
}

export type StartAdjustedWorkoutOutcome =
  | { readonly status: "STARTED"; readonly session: ActiveWorkoutSession }
  /** An active session already exists — Resume wins; nothing new was created. */
  | { readonly status: "ALREADY_ACTIVE"; readonly session: ActiveWorkoutSession }
  /** NO_CHANGE (use the ordinary START) or CANNOT_FIT_MINIMUM (never applied as if it fit). Nothing was written. */
  | { readonly status: "NOT_APPLICABLE"; readonly result: AvailableTimePreviewResponseV1["result"] }
  /** The preview does not exactly describe the workout about to start. Nothing was written. */
  | {
      readonly status: "INVALID_PREVIEW";
      readonly reason: AvailableTimeApplicationFromPreviewError["reason"] | AvailableTimeSelectionReason | "WORKOUT_MISMATCH";
    };

/**
 * Available-Time Adaptation V1 — Slice C: "Start adjusted workout" as an
 * application-layer operation (no React, no SQL, no network wait).
 *
 * 1. the server preview's exact retained/removed PlannedSet ids become the
 *    immutable `AvailableTimeApplicationV1` (shared contract mapping — only
 *    `ADJUST_SESSION` is applicable; the decision is never re-derived here);
 * 2. the SAME effective prescription a normal START uses is structurally
 *    filtered to the retained sets (shared domain filter — load, reps, rest
 *    and set type are never recomputed);
 * 3. session + snapshot + application + START outbox command commit in ONE
 *    local transaction;
 * 4. only after that commit is sync requested — fire-and-forget, so a
 *    missing network can never undo or delay the local start.
 */
export class AdjustedWorkoutStartService {
  constructor(
    private readonly sessions: AdjustedWorkoutSessionStarter,
    private readonly sync: WorkoutSyncRequester,
  ) {}

  async startAdjustedWorkout(input: StartAdjustedWorkoutInput): Promise<StartAdjustedWorkoutOutcome> {
    const { workoutPreview, availableTimePreview } = input;
    if (availableTimePreview.result !== "ADJUST_SESSION") return { status: "NOT_APPLICABLE", result: availableTimePreview.result };
    if (workoutPreview.plannedWorkoutId !== availableTimePreview.plannedWorkoutId) return { status: "INVALID_PREVIEW", reason: "WORKOUT_MISMATCH" };

    const application = availableTimeApplicationFromPreview(availableTimePreview);
    if (!application.ok) return { status: "INVALID_PREVIEW", reason: application.error.reason };

    const adjusted = selectAvailableTimePrescription(workoutPreview.prescription, application.value);
    if (!adjusted.ok) return { status: "INVALID_PREVIEW", reason: adjusted.error };

    const outcome = await this.sessions.startWorkoutSession(adjusted.value, application.value);
    if (outcome.status === "STARTED") this.sync.requestSync("mutation");
    return outcome;
  }
}
