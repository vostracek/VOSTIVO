import type { AvailableTimePreviewResponseV1, WorkoutPreviewV1 } from "@vostivo/contracts";
import { PlanApiRequestFailure } from "../plan/plan-api-client";
import type { StartAdjustedWorkoutInput, StartAdjustedWorkoutOutcome } from "../workout/adjusted-workout-start";
import type { StartWorkoutSessionOutcome } from "../workout/workout-repository";
import { INITIAL_FLOW_STATE, submittableMinutes, type AvailableTimeFlowState, type TimeSelection } from "./available-time-flow";

/** Everything the flow needs from the app — production: PlanApplicationService, AdjustedWorkoutStartService, WorkoutSyncCoordinator. */
export interface AvailableTimeFlowPorts {
  previewAvailableTime(plannedWorkoutId: string, availableMinutes: number): Promise<AvailableTimePreviewResponseV1>;
  getWorkoutPreview(plannedWorkoutId: string): Promise<WorkoutPreviewV1>;
  /** The EXISTING ordinary START (used for NO_CHANGE — never the adjusted path). */
  startWorkout(workoutPreview: WorkoutPreviewV1): Promise<StartWorkoutSessionOutcome>;
  /** The EXISTING Slice C local-first adjusted START (it requests sync itself, fire-and-forget). */
  startAdjustedWorkout(input: StartAdjustedWorkoutInput): Promise<StartAdjustedWorkoutOutcome>;
  requestSync(trigger: "mutation"): void;
}

export interface AvailableTimeFlowEffects {
  onStateChange(state: AvailableTimeFlowState): void;
  navigateToActiveWorkout(): void;
  /** Close the sheet — never a mutation. */
  dismiss(): void;
  /** Today's data is stale (the occurrence already started elsewhere) — re-read it through the normal path. */
  refreshToday(): void;
}

const ADJUSTED_NO_LONGER_VALID = "This adjusted version is no longer valid. Choose another time or keep your original workout.";
const START_FAILED = "Couldn't start the workout. Your planned workout is still available.";

/**
 * Available-Time Adaptation V1 — Slice D: the flow's application logic,
 * framework-free (the sheet component only renders `state` and forwards
 * taps). Owns the single-flight preview request and its cancellation: every
 * request carries a generation, and anything that resolves after the athlete
 * moved on (closed, chose another time, unmounted) is ignored — never a
 * stale state update.
 *
 * Starting never waits for the network: the canonical Workout Preview is
 * fetched together with the time preview, so "Start adjusted workout" (and
 * NO_CHANGE's "Start workout") are purely local, durable starts.
 */
export class AvailableTimeFlowController {
  private state: AvailableTimeFlowState = INITIAL_FLOW_STATE;
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly plannedWorkoutId: string,
    private readonly ports: AvailableTimeFlowPorts,
    private readonly effects: AvailableTimeFlowEffects,
  ) {}

  getState(): AvailableTimeFlowState {
    return this.state;
  }

  selectPreset(minutes: number): void {
    if (this.state.kind !== "SELECT_TIME") return;
    this.setState({ kind: "SELECT_TIME", selection: { kind: "preset", minutes } });
  }

  selectCustom(): void {
    if (this.state.kind !== "SELECT_TIME") return;
    const current = this.state.selection;
    this.setState({ kind: "SELECT_TIME", selection: { kind: "custom", text: current.kind === "custom" ? current.text : "" } });
  }

  setCustomText(text: string): void {
    if (this.state.kind !== "SELECT_TIME") return;
    this.setState({ kind: "SELECT_TIME", selection: { kind: "custom", text } });
  }

  /** "Preview changes" — at most one request in flight; a disabled selection does nothing. */
  requestPreview(): void {
    if (this.state.kind !== "SELECT_TIME") return;
    const minutes = submittableMinutes(this.state.selection);
    if (minutes === null) return;
    void this.loadPreview(minutes, this.state.selection);
  }

  /** PREVIEW_ERROR's Retry — the SAME selected minutes. */
  retry(): void {
    if (this.state.kind !== "PREVIEW_ERROR") return;
    void this.loadPreview(this.state.availableMinutes, this.state.selection);
  }

  /** "Choose another time" / "Choose more time" — back to the selector, keeping the athlete's choice visible. */
  chooseAnotherTime(): void {
    if (this.state.kind === "SELECT_TIME" || this.state.kind === "LOADING_PREVIEW") return;
    if ("start" in this.state && this.state.start.status === "starting") return;
    this.generation += 1;
    this.setState({ kind: "SELECT_TIME", selection: this.state.selection });
  }

  /** "Keep original" / close / back: no mutation, just dismiss. */
  keepOriginal(): void {
    if ("start" in this.state && this.state.start.status === "starting") return;
    this.generation += 1;
    this.effects.dismiss();
  }

  async startAdjusted(): Promise<void> {
    const state = this.state;
    if (state.kind !== "ADJUST_SESSION" || state.start.status === "starting") return;
    this.setState({ ...state, start: { status: "starting" } });
    try {
      const outcome = await this.ports.startAdjustedWorkout({ workoutPreview: state.workoutPreview, availableTimePreview: state.preview });
      if (outcome.status === "STARTED" || outcome.status === "ALREADY_ACTIVE") {
        // The workout is durable locally (or an active one already exists —
        // Resume wins); sync is the service's own fire-and-forget concern.
        this.effects.navigateToActiveWorkout();
        return;
      }
      this.setStateIfLive({ ...state, start: { status: "failed", message: ADJUSTED_NO_LONGER_VALID } });
    } catch {
      this.setStateIfLive({ ...state, start: { status: "failed", message: START_FAILED } });
    }
  }

  /** NO_CHANGE's "Start workout" — the ordinary START path, never an Available-Time application. */
  async startOriginal(): Promise<void> {
    const state = this.state;
    if (state.kind !== "NO_CHANGE" || state.start.status === "starting") return;
    this.setState({ ...state, start: { status: "starting" } });
    try {
      const outcome = await this.ports.startWorkout(state.workoutPreview);
      if (outcome.status === "STARTED") this.ports.requestSync("mutation");
      this.effects.navigateToActiveWorkout();
    } catch {
      this.setStateIfLive({ ...state, start: { status: "failed", message: START_FAILED } });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
  }

  private async loadPreview(availableMinutes: number, selection: TimeSelection): Promise<void> {
    const generation = ++this.generation;
    this.setState({ kind: "LOADING_PREVIEW", availableMinutes, selection });
    try {
      const [preview, workoutPreview] = await Promise.all([
        this.ports.previewAvailableTime(this.plannedWorkoutId, availableMinutes),
        this.ports.getWorkoutPreview(this.plannedWorkoutId),
      ]);
      if (generation !== this.generation || this.disposed) return;
      if (preview.plannedWorkoutId !== this.plannedWorkoutId || workoutPreview.plannedWorkoutId !== this.plannedWorkoutId) {
        this.setState({ kind: "PREVIEW_ERROR", availableMinutes, selection });
        return;
      }
      switch (preview.result) {
        case "ADJUST_SESSION":
          this.setState({ kind: "ADJUST_SESSION", availableMinutes, selection, preview, workoutPreview, start: { status: "idle" } });
          return;
        case "NO_CHANGE":
          this.setState({ kind: "NO_CHANGE", availableMinutes, selection, preview, workoutPreview, start: { status: "idle" } });
          return;
        case "CANNOT_FIT_MINIMUM":
          this.setState({ kind: "CANNOT_FIT_MINIMUM", availableMinutes, selection, preview });
          return;
      }
    } catch (error: unknown) {
      if (generation !== this.generation || this.disposed) return;
      if (error instanceof PlanApiRequestFailure && error.status === 409) {
        // WORKOUT_ALREADY_STARTED: Today is stale — reconcile through the
        // normal read path; never create anything from here.
        this.effects.dismiss();
        this.effects.refreshToday();
        return;
      }
      this.setState({ kind: "PREVIEW_ERROR", availableMinutes, selection });
    }
  }

  private setState(state: AvailableTimeFlowState): void {
    this.state = state;
    if (!this.disposed) this.effects.onStateChange(state);
  }

  private setStateIfLive(state: AvailableTimeFlowState): void {
    if (this.disposed) return;
    this.setState(state);
  }
}
