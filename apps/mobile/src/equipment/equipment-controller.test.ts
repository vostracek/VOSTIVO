import { describe, expect, it } from "vitest";
import type {
  EquipmentAdaptationApplyRequestV1,
  EquipmentAdaptationApplyResponseV1,
  EquipmentAdaptationOptionsResponseV1,
  EquipmentAdaptationPreviewRequestV1,
  EquipmentAdaptationPreviewResponseV1,
  WorkoutPreviewV1,
} from "@vostivo/contracts";
import { EquipmentApiFailure } from "./equipment-api-client";
import { EquipmentFlowController, type EquipmentFlowPorts } from "./equipment-controller";
import type { EquipmentFlowState } from "./equipment-flow";
import {
  APPLICATION_ID,
  CATALOG,
  FINGERPRINT_ADJUST,
  FINGERPRINT_ADJUST_2,
  FINGERPRINT_NO_CHANGE,
  NO_BARBELL,
  WORKOUT_ID,
  adjustPreview,
  adjustedWorkoutPreview,
  authoredWorkoutPreview,
  noChangePreview,
  options,
  reviewRequiredPreview,
} from "./testing/fixtures";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const APPLY_RESPONSE: EquipmentAdaptationApplyResponseV1 = {
  applicationId: APPLICATION_ID,
  scope: "TODAY_ONLY",
  plannedWorkoutId: WORKOUT_ID,
  athleteLocalDate: "2026-10-12",
  previewFingerprint: FINGERPRINT_ADJUST,
  status: "ACTIVE",
  result: "ADJUST_SESSION",
  replacements: [],
  appliedAt: "2026-10-12T08:00:00.000Z",
};

const conflict = (code: string, reasonCode: string | null = null) => new EquipmentApiFailure(409, code, reasonCode);

class FakePorts implements EquipmentFlowPorts {
  optionsCalls: string[] = [];
  previewCalls: EquipmentAdaptationPreviewRequestV1[] = [];
  applyCalls: EquipmentAdaptationApplyRequestV1[] = [];
  workoutPreviewCalls: string[] = [];
  timeZoneRetries = 0;
  nextOptions: () => Promise<EquipmentAdaptationOptionsResponseV1> = () => Promise.resolve(options());
  nextPreview: () => Promise<EquipmentAdaptationPreviewResponseV1> = () => Promise.resolve(adjustPreview());
  nextApply: () => Promise<EquipmentAdaptationApplyResponseV1> = () => Promise.resolve(APPLY_RESPONSE);
  effectiveWorkout: () => WorkoutPreviewV1 = authoredWorkoutPreview;

  options(plannedWorkoutId: string): Promise<EquipmentAdaptationOptionsResponseV1> {
    this.optionsCalls.push(plannedWorkoutId);
    return this.nextOptions();
  }
  preview(request: EquipmentAdaptationPreviewRequestV1): Promise<EquipmentAdaptationPreviewResponseV1> {
    this.previewCalls.push(request);
    return this.nextPreview();
  }
  apply(request: EquipmentAdaptationApplyRequestV1): Promise<EquipmentAdaptationApplyResponseV1> {
    this.applyCalls.push(request);
    return this.nextApply();
  }
  getWorkoutPreview(plannedWorkoutId: string): Promise<WorkoutPreviewV1> {
    this.workoutPreviewCalls.push(plannedWorkoutId);
    return Promise.resolve(this.effectiveWorkout());
  }
  retryTrainingTimeZone(): Promise<unknown> {
    this.timeZoneRetries += 1;
    return Promise.resolve();
  }
}

function harness(ports = new FakePorts(), plannedWorkoutId = WORKOUT_ID) {
  const states: EquipmentFlowState[] = [];
  const effects = { dismissed: 0, refreshes: 0, failures: [] as string[] };
  const controller = new EquipmentFlowController(plannedWorkoutId, ports, {
    onStateChange: (state) => states.push(state),
    dismiss: () => (effects.dismissed += 1),
    refreshToday: () => (effects.refreshes += 1),
    logFailure: (message) => effects.failures.push(message),
  });
  return { controller, ports, states, effects };
}

async function selecting(h = harness()) {
  await h.controller.load();
  return h;
}

async function reviewing(selection: readonly string[] = NO_BARBELL, h = harness()) {
  await h.controller.load();
  for (const id of selection) h.controller.toggle(id);
  await h.controller.requestPreview();
  return h;
}

function stateOf<K extends EquipmentFlowState["kind"]>(controller: EquipmentFlowController, kind: K): Extract<EquipmentFlowState, { kind: K }> {
  const state = controller.getState();
  if (state.kind !== kind) throw new Error(`expected ${kind}, got ${state.kind}`);
  return state as Extract<EquipmentFlowState, { kind: K }>;
}

describe("EquipmentFlowController — options and selection", () => {
  it("options come from the server response for THIS workout; first use selects NOTHING", async () => {
    const h = await selecting();
    expect(h.ports.optionsCalls).toEqual([WORKOUT_ID]);
    const state = stateOf(h.controller, "SELECTING");
    expect(state.options).toEqual(options());
    expect(state.selection).toEqual([]);
  });

  it("a server option the fixture never mentions is offered as-is (no hardcoded mobile catalog)", async () => {
    const h = harness();
    h.ports.nextOptions = () => Promise.resolve(options({ equipmentOptions: [{ equipmentId: "sled-of-the-future", displayLabel: "Future sled", relevance: "PLANNED" }] }));
    await h.controller.load();
    h.controller.selectAll();
    expect(stateOf(h.controller, "SELECTING").selection).toEqual(["sled-of-the-future"]);
  });

  it("'Everything available' explicitly selects every returned option; 'Clear all' produces []", async () => {
    const h = await selecting();
    h.controller.selectAll();
    expect(stateOf(h.controller, "SELECTING").selection).toEqual(["barbell", "barbell-rack", "flat-bench", "adjustable-bench", "dumbbells"]);
    h.controller.clearAll();
    expect(stateOf(h.controller, "SELECTING").selection).toEqual([]);
  });

  it("toggles keep option order; an id the server did not offer is ignored", async () => {
    const h = await selecting();
    h.controller.toggle("dumbbells");
    h.controller.toggle("flat-bench");
    h.controller.toggle("made-up");
    expect(stateOf(h.controller, "SELECTING").selection).toEqual(["flat-bench", "dumbbells"]);
    h.controller.toggle("flat-bench");
    expect(stateOf(h.controller, "SELECTING").selection).toEqual(["dumbbells"]);
  });

  it("today's still-applicable application seeds the selection from the SERVER-stored inventory (only still-offered ids)", async () => {
    const h = harness();
    h.ports.nextOptions = () => Promise.resolve(options({ currentApplication: { applicationId: APPLICATION_ID, result: "ADJUST_SESSION", availableEquipmentIds: ["adjustable-bench", "cable-station", "dumbbells", "flat-bench"] } }));
    await h.controller.load();
    expect(stateOf(h.controller, "SELECTING").selection).toEqual(["flat-bench", "adjustable-bench", "dumbbells"]);
  });

  it("options failure -> small retryable error; Retry re-fetches", async () => {
    const h = harness();
    h.ports.nextOptions = () => Promise.reject(new TypeError("Network request failed"));
    await h.controller.load();
    expect(h.controller.getState().kind).toBe("OPTIONS_ERROR");
    h.ports.nextOptions = () => Promise.resolve(options());
    await h.controller.retryOptions();
    expect(h.controller.getState().kind).toBe("SELECTING");
    expect(h.ports.optionsCalls).toHaveLength(2);
    expect(h.effects.dismissed).toBe(0);
  });

  it("an already-started / no-longer-today workout (409 NOT_APPLICABLE) closes the sheet and refreshes Today", async () => {
    const h = harness();
    h.ports.nextOptions = () => Promise.reject(conflict("EQUIPMENT_ADAPTATION_NOT_APPLICABLE", "WORKOUT_ALREADY_STARTED"));
    await h.controller.load();
    expect(h.effects).toMatchObject({ dismissed: 1, refreshes: 1 });
  });

  it("TRAINING_TIME_ZONE_REQUIRED uses the existing bootstrap retry, then reloads options", async () => {
    const h = harness();
    h.ports.nextOptions = () => Promise.reject(conflict("TRAINING_TIME_ZONE_REQUIRED"));
    await h.controller.load();
    expect(h.controller.getState()).toEqual({ kind: "TIMEZONE_REQUIRED", retrying: false });
    h.ports.nextOptions = () => Promise.resolve(options());
    await h.controller.retryTimeZone();
    expect(h.ports.timeZoneRetries).toBe(1);
    expect(h.controller.getState().kind).toBe("SELECTING");
  });
});

describe("EquipmentFlowController — preview", () => {
  it("'Review changes' sends ONLY plannedWorkoutId + server catalogVersion + the COMPLETE selected inventory", async () => {
    const h = await reviewing(["dumbbells", "flat-bench", "adjustable-bench"]);
    expect(h.ports.previewCalls).toEqual([{ plannedWorkoutId: WORKOUT_ID, catalogVersion: CATALOG, availableEquipmentIds: ["flat-bench", "adjustable-bench", "dumbbells"] }]);
    expect(Object.keys(h.ports.previewCalls[0]!).sort()).toEqual(["availableEquipmentIds", "catalogVersion", "plannedWorkoutId"]);
    expect(h.controller.getState().kind).toBe("ADJUST_SESSION");
    expect(h.ports.applyCalls).toHaveLength(0);
  });

  it("an empty selection is a valid complete inventory ([]): nothing available", async () => {
    const h = harness();
    h.ports.nextPreview = () => Promise.resolve(reviewRequiredPreview());
    await reviewing([], h);
    expect(h.ports.previewCalls[0]!.availableEquipmentIds).toEqual([]);
  });

  it("while previewing: selection kept, duplicate submits and edits ignored, sheet stays open", async () => {
    const h = await selecting();
    h.controller.toggle("dumbbells");
    const pending = deferred<EquipmentAdaptationPreviewResponseV1>();
    h.ports.nextPreview = () => pending.promise;
    const first = h.controller.requestPreview();
    void h.controller.requestPreview();
    h.controller.toggle("barbell");
    h.controller.selectAll();
    expect(stateOf(h.controller, "SELECTING")).toMatchObject({ previewing: true, selection: ["dumbbells"] });
    expect(h.ports.previewCalls).toHaveLength(1);
    pending.resolve(adjustPreview());
    await first;
    expect(h.effects.dismissed).toBe(0);
  });

  it("preview network failure keeps the selection and the sheet; Retry re-sends the SAME inventory", async () => {
    const h = await selecting();
    for (const id of NO_BARBELL) h.controller.toggle(id);
    h.ports.nextPreview = () => Promise.reject(new TypeError("Network request failed"));
    await h.controller.requestPreview();
    expect(stateOf(h.controller, "SELECTING")).toMatchObject({ previewFailed: true, previewing: false, selection: ["flat-bench", "adjustable-bench", "dumbbells"] });
    h.ports.nextPreview = () => Promise.resolve(adjustPreview());
    await h.controller.requestPreview();
    expect(h.ports.previewCalls.map((c) => c.availableEquipmentIds)).toEqual([["flat-bench", "adjustable-bench", "dumbbells"], ["flat-bench", "adjustable-bench", "dumbbells"]]);
    expect(h.effects.dismissed).toBe(0);
  });

  it("catalog version mismatch reloads the server options, keeps still-valid ids, and requires Review again (no apply)", async () => {
    const h = await selecting();
    h.controller.toggle("barbell");
    h.controller.toggle("dumbbells");
    h.ports.nextPreview = () => Promise.reject(conflict("EQUIPMENT_CATALOG_VERSION_MISMATCH"));
    h.ports.nextOptions = () => Promise.resolve(options({ catalogVersion: "exercise-equipment-catalog/v2", equipmentOptions: [{ equipmentId: "dumbbells", displayLabel: "Dumbbells", relevance: "SUBSTITUTE" }] }));
    await h.controller.requestPreview();
    const state = stateOf(h.controller, "SELECTING");
    expect(state).toMatchObject({ selection: ["dumbbells"], catalogRefreshed: true, previewing: false });
    expect(state.options.catalogVersion).toBe("exercise-equipment-catalog/v2");
    expect(h.ports.applyCalls).toHaveLength(0);
    h.ports.nextPreview = () => Promise.resolve(adjustPreview());
    await h.controller.requestPreview();
    expect(h.ports.previewCalls.at(-1)!.catalogVersion).toBe("exercise-equipment-catalog/v2");
  });

  it("REVIEW_REQUIRED has no apply path at all", async () => {
    const h = harness();
    h.ports.nextPreview = () => Promise.resolve(reviewRequiredPreview());
    await reviewing([], h);
    expect(h.controller.getState().kind).toBe("REVIEW_REQUIRED");
    await h.controller.apply();
    expect(h.ports.applyCalls).toHaveLength(0);
    h.controller.editEquipment();
    expect(stateOf(h.controller, "SELECTING").selection).toEqual([]);
  });
});

describe("EquipmentFlowController — apply", () => {
  it("Apply sends exactly the shown preview's fingerprint + catalogVersion + the same inventory; success closes and refreshes Today — never starts", async () => {
    const h = await reviewing();
    await h.controller.apply();
    expect(h.ports.applyCalls).toEqual([{ plannedWorkoutId: WORKOUT_ID, previewFingerprint: FINGERPRINT_ADJUST, catalogVersion: CATALOG, availableEquipmentIds: ["flat-bench", "adjustable-bench", "dumbbells"] }]);
    expect(h.effects).toMatchObject({ dismissed: 1, refreshes: 1 });
    // The flow has no start port at all — nothing could auto-start.
    expect(Object.keys(h.ports)).not.toContain("startWorkout");
  });

  it("'Not now' sends no apply and persists nothing", async () => {
    const h = await reviewing();
    h.controller.close();
    expect(h.ports.applyCalls).toHaveLength(0);
    expect(h.effects).toMatchObject({ dismissed: 1, refreshes: 0 });
  });

  it("duplicate taps never issue concurrent Apply requests", async () => {
    const h = await reviewing();
    const pending = deferred<EquipmentAdaptationApplyResponseV1>();
    h.ports.nextApply = () => pending.promise;
    const first = h.controller.apply();
    void h.controller.apply();
    void h.controller.apply();
    h.controller.close();
    h.controller.editEquipment();
    expect(h.ports.applyCalls).toHaveLength(1);
    expect(stateOf(h.controller, "ADJUST_SESSION").apply).toEqual({ status: "applying" });
    pending.resolve(APPLY_RESPONSE);
    await first;
    expect(h.effects.dismissed).toBe(1);
  });

  it("offline/5xx: review stays open with the error, NO optimistic refresh; Retry re-sends the same still-current request", async () => {
    const h = await reviewing();
    h.ports.nextApply = () => Promise.reject(new EquipmentApiFailure(503, null, null));
    await h.controller.apply();
    expect(stateOf(h.controller, "ADJUST_SESSION").apply).toEqual({ status: "failed" });
    expect(h.effects).toMatchObject({ dismissed: 0, refreshes: 0 });
    h.ports.nextApply = () => Promise.resolve(APPLY_RESPONSE);
    await h.controller.apply();
    expect(h.ports.applyCalls).toHaveLength(2);
    expect(h.ports.applyCalls[1]).toEqual(h.ports.applyCalls[0]);
    expect(h.effects).toMatchObject({ dismissed: 1, refreshes: 1 });
  });

  it("STALE never re-sends the old Apply: re-previews the SAME inventory; a new ADJUST_SESSION needs a second explicit tap", async () => {
    const h = await reviewing();
    h.ports.nextApply = () => Promise.reject(conflict("EQUIPMENT_PREVIEW_STALE"));
    h.ports.nextPreview = () => Promise.resolve(adjustPreview(FINGERPRINT_ADJUST_2));
    await h.controller.apply();
    expect(h.ports.applyCalls).toHaveLength(1);
    expect(h.ports.previewCalls.map((c) => c.availableEquipmentIds)).toEqual([["flat-bench", "adjustable-bench", "dumbbells"], ["flat-bench", "adjustable-bench", "dumbbells"]]);
    const state = stateOf(h.controller, "ADJUST_SESSION");
    expect(state).toMatchObject({ workoutChanged: true, apply: { status: "idle" } });
    expect(state.preview.previewFingerprint).toBe(FINGERPRINT_ADJUST_2);
    expect(h.effects.dismissed).toBe(0);
    h.ports.nextApply = () => Promise.resolve(APPLY_RESPONSE);
    await h.controller.apply();
    expect(h.ports.applyCalls.map((c) => c.previewFingerprint)).toEqual([FINGERPRINT_ADJUST, FINGERPRINT_ADJUST_2]);
  });

  it("STALE -> NO_CHANGE transitions to 'No changes needed' (no apply needed when nothing is adjusted)", async () => {
    const h = await reviewing();
    h.ports.nextApply = () => Promise.reject(conflict("EQUIPMENT_PREVIEW_STALE"));
    h.ports.nextPreview = () => Promise.resolve(noChangePreview());
    await h.controller.apply();
    expect(stateOf(h.controller, "NO_CHANGE")).toMatchObject({ currentlyAdjusted: false, workoutChanged: true });
    await h.controller.apply();
    expect(h.ports.applyCalls).toHaveLength(1);
  });

  it("STALE -> REVIEW_REQUIRED removes Apply", async () => {
    const h = await reviewing();
    h.ports.nextApply = () => Promise.reject(conflict("EQUIPMENT_PREVIEW_STALE"));
    h.ports.nextPreview = () => Promise.resolve(reviewRequiredPreview());
    await h.controller.apply();
    expect(h.controller.getState().kind).toBe("REVIEW_REQUIRED");
    await h.controller.apply();
    expect(h.ports.applyCalls).toHaveLength(1);
  });

  it("Apply answered NOT_APPLICABLE (e.g. started on another device) closes and refreshes Today — no retry", async () => {
    const h = await reviewing();
    h.ports.nextApply = () => Promise.reject(conflict("EQUIPMENT_ADAPTATION_NOT_APPLICABLE", "WORKOUT_ALREADY_STARTED"));
    await h.controller.apply();
    expect(h.ports.applyCalls).toHaveLength(1);
    expect(h.effects).toMatchObject({ dismissed: 1, refreshes: 1 });
  });
});

describe("EquipmentFlowController — NO_CHANGE / explicit clear", () => {
  it("NO_CHANGE while the effective workout is NOT adjusted: Done, no apply request", async () => {
    const h = harness();
    h.ports.nextPreview = () => Promise.resolve(noChangePreview());
    await reviewing(["barbell", "barbell-rack", "flat-bench"], h);
    expect(stateOf(h.controller, "NO_CHANGE").currentlyAdjusted).toBe(false);
    await h.controller.apply();
    h.controller.close();
    expect(h.ports.applyCalls).toHaveLength(0);
    expect(h.effects.dismissed).toBe(1);
  });

  it("NO_CHANGE while the SERVER's effective workout IS adjusted: 'Use original workout' applies the NO_CHANGE preview (Slice C clear), never starts", async () => {
    const h = harness();
    h.ports.effectiveWorkout = adjustedWorkoutPreview;
    h.ports.nextPreview = () => Promise.resolve(noChangePreview());
    await reviewing(["barbell", "barbell-rack", "flat-bench"], h);
    expect(stateOf(h.controller, "NO_CHANGE").currentlyAdjusted).toBe(true);
    await h.controller.apply();
    expect(h.ports.applyCalls).toEqual([{ plannedWorkoutId: WORKOUT_ID, previewFingerprint: FINGERPRINT_NO_CHANGE, catalogVersion: CATALOG, availableEquipmentIds: ["barbell", "barbell-rack", "flat-bench"] }]);
    expect(h.effects).toMatchObject({ dismissed: 1, refreshes: 1 });
  });
});

describe("EquipmentFlowController — interop / lifecycle", () => {
  it("a Missed-Workout moved workout is targeted by its SAME PlannedWorkout id everywhere", async () => {
    const MOVED_ID = "00000000-0000-7000-8000-000000000999";
    const ports = new FakePorts();
    ports.nextOptions = () => Promise.resolve(options({ plannedWorkoutId: MOVED_ID }));
    ports.nextPreview = () => Promise.resolve({ ...adjustPreview(), plannedWorkoutId: MOVED_ID });
    ports.effectiveWorkout = () => ({ ...authoredWorkoutPreview(), plannedWorkoutId: MOVED_ID });
    const h = await reviewing(NO_BARBELL, harness(ports, MOVED_ID));
    await h.controller.apply();
    expect(ports.optionsCalls).toEqual([MOVED_ID]);
    expect(ports.previewCalls[0]!.plannedWorkoutId).toBe(MOVED_ID);
    expect(ports.workoutPreviewCalls).toEqual([MOVED_ID]);
    expect(ports.applyCalls[0]!.plannedWorkoutId).toBe(MOVED_ID);
  });

  it("a response for another workout is never shown", async () => {
    const h = harness();
    h.ports.nextOptions = () => Promise.resolve(options({ plannedWorkoutId: "00000000-0000-7000-8000-000000000777" }));
    await h.controller.load();
    expect(h.controller.getState().kind).toBe("OPTIONS_ERROR");
  });

  it("late results after closing are ignored (no state update after dispose)", async () => {
    const h = await selecting();
    const pending = deferred<EquipmentAdaptationPreviewResponseV1>();
    h.ports.nextPreview = () => pending.promise;
    const run = h.controller.requestPreview();
    const statesBefore = h.states.length;
    h.controller.dispose();
    pending.resolve(adjustPreview());
    await run;
    expect(h.states).toHaveLength(statesBefore);
  });
});
