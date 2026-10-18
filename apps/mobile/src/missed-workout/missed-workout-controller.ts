import type { MissedWorkoutApplyResponseV1, MissedWorkoutPreviewResponseV1 } from "@vostivo/contracts";
import { MissedWorkoutApiFailure } from "./missed-workout-api-client";
import { INITIAL_MISSED_WORKOUT_STATE, type MissedWorkoutFlowState } from "./missed-workout-flow";

/** Everything the flow needs from the app — production: the training time zone bootstrapper + `MissedWorkoutApiClient`. */
export interface MissedWorkoutFlowPorts {
  /** The one-time bootstrap (no-op once done; never overwrites a saved zone). Never rejects. */
  ensureTrainingTimeZone(): Promise<unknown>;
  /** Explicit "Try again" after a failed bootstrap. Never rejects. */
  retryTrainingTimeZone(): Promise<unknown>;
  preview(): Promise<MissedWorkoutPreviewResponseV1>;
  /** Sends ONLY the approved preview's fingerprint. */
  apply(previewFingerprint: string): Promise<MissedWorkoutApplyResponseV1>;
}

export interface MissedWorkoutFlowEffects {
  onStateChange(state: MissedWorkoutFlowState): void;
  /** Re-read Today/Plan through their normal authoritative paths (which also reloads this flow). */
  refreshToday(): void;
  /** Technical failures only (never tokens or plan data). */
  logFailure(message: string): void;
}

/**
 * Missed Workout / Schedule Adaptation V1 — Slice D: the flow's
 * application logic, framework-free (Today's card and the review sheet only
 * render `state` and forward taps) — same architecture as Available-Time's
 * `AvailableTimeFlowController`.
 *
 * Locked behavior:
 * - NO AUTO-APPLY, in every mode: the only path to `ports.apply` is the
 *   athlete's explicit `apply()` from an open review, with exactly the
 *   fingerprint of the preview being shown.
 * - Apply changes scheduling only: it never starts a workout; on success
 *   the review closes and Today/Plan re-read the server's EFFECTIVE schedule.
 * - STALE / NOT_APPLICABLE: re-read the preview, never re-send blindly; a
 *   new ROLL_FORWARD needs a fresh explicit Apply ("Plan changed").
 * - Offline/5xx on apply: keep the preview, offer Retry / Not now; nothing
 *   is changed locally (no optimistic plan mutation).
 * - The preview is optional: its failure degrades quietly and never touches
 *   Today's own workout surface; a reload never blanks a shown state (no flash).
 */
export class MissedWorkoutFlowController {
  private state: MissedWorkoutFlowState = INITIAL_MISSED_WORKOUT_STATE;
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly ports: MissedWorkoutFlowPorts,
    private readonly effects: MissedWorkoutFlowEffects,
  ) {}

  getState(): MissedWorkoutFlowState {
    return this.state;
  }

  /** Today's (re)load: bootstrap the training time zone once, then fetch the preview. Keeps the current state visible meanwhile. */
  async load(): Promise<void> {
    if (this.state.kind === "ROLL_FORWARD" && this.state.apply.status === "applying") return;
    const generation = ++this.generation;
    await this.ports.ensureTrainingTimeZone();
    if (generation !== this.generation || this.disposed) return;
    try {
      const preview = await this.ports.preview();
      if (generation !== this.generation || this.disposed) return;
      this.setState(this.fromPreview(preview, false));
    } catch (error: unknown) {
      if (generation !== this.generation || this.disposed) return;
      this.setState(this.fromPreviewError(error));
    }
  }

  openReview(): void {
    if (this.state.kind !== "ROLL_FORWARD") return;
    this.setState({ ...this.state, reviewOpen: true });
  }

  /** "Not now": close the review and hide the card until the next refresh. No request, nothing persisted. */
  notNow(): void {
    if (this.state.kind !== "ROLL_FORWARD" || this.state.apply.status === "applying") return;
    this.setState({ kind: "DISMISSED" });
  }

  /** "Apply update" (and "Retry" after a failed apply) — the ONLY way an application is ever requested. */
  async apply(): Promise<void> {
    const state = this.state;
    if (state.kind !== "ROLL_FORWARD" || !state.reviewOpen || state.apply.status === "applying") return;
    const generation = ++this.generation;
    this.setState({ ...state, apply: { status: "applying" } });
    try {
      await this.ports.apply(state.preview.previewFingerprint);
      if (this.disposed) return;
      // Scheduling only — never a workout start. Today/Plan re-read the server's effective schedule.
      this.setState({ kind: "IDLE" });
      this.effects.refreshToday();
    } catch (error: unknown) {
      if (this.disposed || generation !== this.generation) return;
      if (error instanceof MissedWorkoutApiFailure && error.status === 409) {
        if (error.code === "TRAINING_TIME_ZONE_REQUIRED") {
          this.setState({ kind: "TIMEZONE_REQUIRED", retrying: false });
          this.effects.refreshToday();
          return;
        }
        // MISSED_WORKOUT_PREVIEW_STALE / MISSED_WORKOUT_NOT_APPLICABLE /
        // CURRENT_TRAINING_BLOCK_UNRESOLVED: reality changed — re-read it,
        // never retry the same apply.
        await this.reconcileAfterRejectedApply(state.preview.previewFingerprint, generation);
        return;
      }
      this.effects.logFailure(`missed workout apply failed: ${error instanceof Error ? error.message : "unknown error"}`);
      this.setState({ ...state, apply: { status: "failed" } });
    }
  }

  /** TIMEZONE_REQUIRED's "Try again": an explicit bootstrap retry, then a fresh preview. */
  async retryTimeZone(): Promise<void> {
    if (this.state.kind !== "TIMEZONE_REQUIRED" || this.state.retrying) return;
    this.setState({ kind: "TIMEZONE_REQUIRED", retrying: true });
    await this.ports.retryTrainingTimeZone();
    if (this.disposed) return;
    this.setState({ kind: "TIMEZONE_REQUIRED", retrying: false });
    await this.load();
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
  }

  private async reconcileAfterRejectedApply(rejectedFingerprint: string, generation: number): Promise<void> {
    try {
      const preview = await this.ports.preview();
      if (this.disposed || generation !== this.generation) return;
      const next = this.fromPreview(preview, true);
      // A still-applicable recommendation stays open, flagged "Plan changed" — never auto-applied.
      this.setState(next.kind === "ROLL_FORWARD" ? { ...next, reviewOpen: true, planChanged: next.preview.previewFingerprint !== rejectedFingerprint || next.planChanged } : next);
    } catch (error: unknown) {
      if (this.disposed || generation !== this.generation) return;
      this.setState(this.fromPreviewError(error));
    }
    this.effects.refreshToday();
  }

  private fromPreview(preview: MissedWorkoutPreviewResponseV1, afterRejectedApply: boolean): MissedWorkoutFlowState {
    switch (preview.result) {
      case "NO_CHANGE":
        return { kind: "IDLE" };
      case "REVIEW_REQUIRED":
        return { kind: "REVIEW_REQUIRED", reasonCode: preview.reasonCode };
      case "ROLL_FORWARD": {
        const current = this.state;
        // The same recommendation (same fingerprint) keeps its on-screen state (open review, "Plan changed").
        if (current.kind === "ROLL_FORWARD" && current.preview.previewFingerprint === preview.previewFingerprint) return { ...current, preview };
        // A NEW recommendation arriving while its predecessor's review was open is flagged "Plan changed".
        const reviewWasOpen = current.kind === "ROLL_FORWARD" && current.reviewOpen;
        return { kind: "ROLL_FORWARD", preview, reviewOpen: reviewWasOpen, apply: { status: "idle" }, planChanged: reviewWasOpen || afterRejectedApply };
      }
    }
  }

  private fromPreviewError(error: unknown): MissedWorkoutFlowState {
    if (error instanceof MissedWorkoutApiFailure && error.status === 409 && error.code === "TRAINING_TIME_ZONE_REQUIRED") return { kind: "TIMEZONE_REQUIRED", retrying: false };
    // No strict current block / no profile: there is simply nothing to adapt — quiet.
    if (error instanceof MissedWorkoutApiFailure && (error.status === 409 || error.status === 404)) return { kind: "IDLE" };
    this.effects.logFailure(`missed workout preview failed: ${error instanceof Error ? error.message : "unknown error"}`);
    // Keep an already shown recommendation (Apply re-validates it anyway); otherwise degrade quietly.
    return this.state.kind === "ROLL_FORWARD" ? this.state : { kind: "PREVIEW_ERROR" };
  }

  private setState(state: MissedWorkoutFlowState): void {
    this.state = state;
    if (!this.disposed) this.effects.onStateChange(state);
  }
}
