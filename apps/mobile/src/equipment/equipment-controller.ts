import type {
  EquipmentAdaptationApplyRequestV1,
  EquipmentAdaptationApplyResponseV1,
  EquipmentAdaptationOptionsResponseV1,
  EquipmentAdaptationPreviewRequestV1,
  EquipmentAdaptationPreviewResponseV1,
  WorkoutPreviewV1,
} from "@vostivo/contracts";
import { EquipmentApiFailure } from "./equipment-api-client";
import {
  INITIAL_EQUIPMENT_FLOW_STATE,
  equipmentAdjustedCount,
  initialSelection,
  retainValidSelection,
  selectAllEquipment,
  toggleEquipment,
  type EquipmentFlowState,
} from "./equipment-flow";

/** Everything the flow needs from the app — production: `EquipmentApiClient`, PlanApplicationService, the training time zone bootstrapper. */
export interface EquipmentFlowPorts {
  options(plannedWorkoutId: string): Promise<EquipmentAdaptationOptionsResponseV1>;
  preview(request: EquipmentAdaptationPreviewRequestV1): Promise<EquipmentAdaptationPreviewResponseV1>;
  apply(request: EquipmentAdaptationApplyRequestV1): Promise<EquipmentAdaptationApplyResponseV1>;
  /** The server's EFFECTIVE Workout Preview — the only authority for "is today's workout currently equipment-adjusted". */
  getWorkoutPreview(plannedWorkoutId: string): Promise<WorkoutPreviewV1>;
  /** Missed Workout's existing explicit time zone retry (the one bootstrapper). Never rejects. */
  retryTrainingTimeZone(): Promise<unknown>;
}

export interface EquipmentFlowEffects {
  onStateChange(state: EquipmentFlowState): void;
  /** Close the sheet — never a mutation. */
  dismiss(): void;
  /** Re-read Today (overview + effective Workout Preview) through the normal authoritative paths. */
  refreshToday(): void;
  /** Technical failures only (never tokens or plan data). */
  logFailure(message: string): void;
}

/**
 * Temporary Equipment / Gym Adaptation V1 — Slice D: the flow's application
 * logic, framework-free (the sheet only renders `state` and forwards taps) —
 * same architecture as `AvailableTimeFlowController` /
 * `MissedWorkoutFlowController`.
 *
 * Locked behavior:
 * - PREVIEW BEFORE APPLY: "Review changes" sends ONLY the target, the
 *   server's catalog version and the COMPLETE selected inventory.
 * - NO AUTO-APPLY: the only path to `ports.apply` is the athlete's explicit
 *   tap, with exactly the fingerprint/catalog/inventory of the preview being
 *   shown. APPLY NEVER AUTO-STARTS: success closes the sheet and re-reads
 *   Today; Start Workout stays the next explicit action.
 * - NO OPTIMISTIC SUBSTITUTION: nothing changes on Today until the server
 *   accepted the Apply and Today re-read its effective Workout Preview.
 * - STALE: never re-send the old Apply; re-preview the SAME inventory and
 *   require a fresh explicit tap ("Workout changed").
 * - Offline/5xx: keep the review open (Retry / Not now); Retry re-sends the
 *   same still-current request.
 * - Catalog version mismatch: reload the server options, keep only still
 *   valid ids, and require "Review changes" again.
 * - Single flight: duplicate taps never issue concurrent requests; late
 *   results after the athlete moved on are ignored (generation).
 */
export class EquipmentFlowController {
  private state: EquipmentFlowState = INITIAL_EQUIPMENT_FLOW_STATE;
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly plannedWorkoutId: string,
    private readonly ports: EquipmentFlowPorts,
    private readonly effects: EquipmentFlowEffects,
  ) {}

  getState(): EquipmentFlowState {
    return this.state;
  }

  /** Opening the sheet: fetch the server's equipment options. */
  async load(): Promise<void> {
    await this.loadOptions(null);
  }

  /** OPTIONS_ERROR's Retry. */
  async retryOptions(): Promise<void> {
    if (this.state.kind !== "OPTIONS_ERROR") return;
    await this.loadOptions(null);
  }

  toggle(equipmentId: string): void {
    const state = this.state;
    if (state.kind !== "SELECTING" || state.previewing) return;
    this.setState({ ...state, selection: toggleEquipment(state.options, state.selection, equipmentId), previewFailed: false });
  }

  /** "Everything available" — an explicit choice, never a default. */
  selectAll(): void {
    const state = this.state;
    if (state.kind !== "SELECTING" || state.previewing) return;
    this.setState({ ...state, selection: selectAllEquipment(state.options), previewFailed: false });
  }

  clearAll(): void {
    const state = this.state;
    if (state.kind !== "SELECTING" || state.previewing) return;
    this.setState({ ...state, selection: [], previewFailed: false });
  }

  /** "Review changes" (and its Retry after a failed preview) — at most one request in flight. */
  async requestPreview(): Promise<void> {
    const state = this.state;
    if (state.kind !== "SELECTING" || state.previewing) return;
    const generation = ++this.generation;
    this.setState({ ...state, previewing: true, previewFailed: false, catalogRefreshed: false });
    await this.runPreview(state.options, state.selection, generation, false);
  }

  /** "Edit equipment" from any review: back to the selection, kept as it was. */
  editEquipment(): void {
    const state = this.state;
    if (state.kind !== "ADJUST_SESSION" && state.kind !== "NO_CHANGE" && state.kind !== "REVIEW_REQUIRED") return;
    if ("apply" in state && state.apply.status === "applying") return;
    this.generation += 1;
    this.setState({ kind: "SELECTING", options: state.options, selection: state.selection, previewing: false, previewFailed: false, catalogRefreshed: false });
  }

  /** "Not now" / "Done" / close: no request, nothing persisted. */
  close(): void {
    if ("apply" in this.state && this.state.apply.status === "applying") return;
    this.generation += 1;
    this.effects.dismiss();
  }

  /** "Apply changes", "Use original workout" (NO_CHANGE explicit clear) and Retry after a failed apply. */
  async apply(): Promise<void> {
    const state = this.state;
    const applicable = state.kind === "ADJUST_SESSION" || (state.kind === "NO_CHANGE" && state.currentlyAdjusted);
    if (!applicable || state.apply.status === "applying") return;
    const generation = ++this.generation;
    this.setState({ ...state, apply: { status: "applying" } });
    try {
      await this.ports.apply({
        plannedWorkoutId: this.plannedWorkoutId,
        previewFingerprint: state.preview.previewFingerprint,
        catalogVersion: state.preview.catalogVersion,
        availableEquipmentIds: state.selection,
      });
      if (this.disposed) return;
      // Never a start: the sheet closes and Today re-reads the server's effective workout.
      this.effects.dismiss();
      this.effects.refreshToday();
    } catch (error: unknown) {
      if (this.disposed || generation !== this.generation) return;
      if (error instanceof EquipmentApiFailure && (error.status === 409 || error.status === 404 || error.status === 400)) {
        await this.handleRejection(error, state.options, state.selection, generation, true);
        return;
      }
      this.effects.logFailure(`equipment apply failed: ${error instanceof Error ? error.message : "unknown error"}`);
      this.setState({ ...state, apply: { status: "failed" } });
    }
  }

  /** TIMEZONE_REQUIRED's "Try again": the existing explicit bootstrap retry, then the options again. */
  async retryTimeZone(): Promise<void> {
    if (this.state.kind !== "TIMEZONE_REQUIRED" || this.state.retrying) return;
    this.setState({ kind: "TIMEZONE_REQUIRED", retrying: true });
    await this.ports.retryTrainingTimeZone();
    if (this.disposed) return;
    await this.loadOptions(null);
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
  }

  private async loadOptions(keepSelection: readonly string[] | null): Promise<void> {
    const generation = ++this.generation;
    this.setState({ kind: "LOADING_OPTIONS" });
    try {
      const options = await this.ports.options(this.plannedWorkoutId);
      if (generation !== this.generation || this.disposed) return;
      if (options.plannedWorkoutId !== this.plannedWorkoutId) {
        this.setState({ kind: "OPTIONS_ERROR" });
        return;
      }
      const selection = keepSelection === null ? initialSelection(options) : retainValidSelection(options, keepSelection);
      this.setState({ kind: "SELECTING", options, selection, previewing: false, previewFailed: false, catalogRefreshed: keepSelection !== null });
    } catch (error: unknown) {
      if (generation !== this.generation || this.disposed) return;
      if (error instanceof EquipmentApiFailure && (error.status === 409 || error.status === 404)) {
        if (error.code === "TRAINING_TIME_ZONE_REQUIRED") {
          this.setState({ kind: "TIMEZONE_REQUIRED", retrying: false });
          return;
        }
        // Not today's pre-start workout any more (started, moved, resolved…): Today is stale.
        this.closeAndRefresh();
        return;
      }
      this.effects.logFailure(`equipment options failed: ${error instanceof Error ? error.message : "unknown error"}`);
      this.setState({ kind: "OPTIONS_ERROR" });
    }
  }

  private async runPreview(options: EquipmentAdaptationOptionsResponseV1, selection: readonly string[], generation: number, workoutChanged: boolean): Promise<void> {
    try {
      const [preview, workoutPreview] = await Promise.all([
        this.ports.preview({ plannedWorkoutId: this.plannedWorkoutId, catalogVersion: options.catalogVersion, availableEquipmentIds: selection }),
        this.ports.getWorkoutPreview(this.plannedWorkoutId),
      ]);
      if (generation !== this.generation || this.disposed) return;
      if (preview.plannedWorkoutId !== this.plannedWorkoutId || workoutPreview.plannedWorkoutId !== this.plannedWorkoutId) throw new Error("preview for another workout");
      switch (preview.result) {
        case "ADJUST_SESSION":
          this.setState({ kind: "ADJUST_SESSION", options, selection, preview, apply: { status: "idle" }, workoutChanged });
          return;
        case "NO_CHANGE":
          this.setState({ kind: "NO_CHANGE", options, selection, preview, currentlyAdjusted: equipmentAdjustedCount(workoutPreview) > 0, apply: { status: "idle" }, workoutChanged });
          return;
        case "REVIEW_REQUIRED":
          this.setState({ kind: "REVIEW_REQUIRED", options, selection, preview, workoutChanged });
          return;
      }
    } catch (error: unknown) {
      if (generation !== this.generation || this.disposed) return;
      if (error instanceof EquipmentApiFailure && (error.status === 409 || error.status === 404 || error.status === 400)) {
        await this.handleRejection(error, options, selection, generation, false);
        return;
      }
      this.effects.logFailure(`equipment preview failed: ${error instanceof Error ? error.message : "unknown error"}`);
      this.setState({ kind: "SELECTING", options, selection, previewing: false, previewFailed: true, catalogRefreshed: false });
    }
  }

  /** A stable server refusal of a preview or an apply — reality changed; never re-send the same request. */
  private async handleRejection(error: EquipmentApiFailure, options: EquipmentAdaptationOptionsResponseV1, selection: readonly string[], generation: number, fromApply: boolean): Promise<void> {
    if (error.code === "TRAINING_TIME_ZONE_REQUIRED") {
      this.setState({ kind: "TIMEZONE_REQUIRED", retrying: false });
      return;
    }
    if (error.code === "EQUIPMENT_CATALOG_VERSION_MISMATCH" || error.code === "UNKNOWN_EQUIPMENT_ID") {
      // Never Apply against another catalog: reload the server options, keep what is still valid, review again.
      await this.loadOptions(selection);
      return;
    }
    if (fromApply && (error.code === "EQUIPMENT_PREVIEW_STALE" || error.code === "EQUIPMENT_ADAPTATION_REVIEW_REQUIRED")) {
      // Re-run the preview with the SAME inventory (the review stays busy meanwhile); the result needs a NEW explicit tap.
      await this.runPreview(options, selection, generation, true);
      return;
    }
    // EQUIPMENT_ADAPTATION_NOT_APPLICABLE / 404 / anything else stable: Today is stale.
    this.closeAndRefresh();
  }

  private closeAndRefresh(): void {
    this.generation += 1;
    this.effects.dismiss();
    this.effects.refreshToday();
  }

  private setState(state: EquipmentFlowState): void {
    this.state = state;
    if (!this.disposed) this.effects.onStateChange(state);
  }
}
