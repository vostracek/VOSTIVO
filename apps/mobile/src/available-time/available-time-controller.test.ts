import { describe, expect, it } from "vitest";
import type { AvailableTimePreviewResponseV1, WorkoutPreviewV1 } from "@vostivo/contracts";
import { PlanApiRequestFailure } from "../plan/plan-api-client";
import type { ActiveWorkoutSession } from "../workout/active-workout-session";
import type { StartAdjustedWorkoutInput, StartAdjustedWorkoutOutcome } from "../workout/adjusted-workout-start";
import type { StartWorkoutSessionOutcome } from "../workout/workout-repository";
import { AvailableTimeFlowController, type AvailableTimeFlowPorts } from "./available-time-controller";
import type { AvailableTimeFlowState } from "./available-time-flow";
import { WORKOUT_ID, adjustPreview, cannotFitPreview, noChangePreview, workoutPreview } from "./testing/fixtures";

const SESSION = { id: "session-1" } as ActiveWorkoutSession;

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

class FakePorts implements AvailableTimeFlowPorts {
  previewCalls: { plannedWorkoutId: string; availableMinutes: number }[] = [];
  workoutPreviewCalls = 0;
  startWorkoutCalls: WorkoutPreviewV1[] = [];
  startAdjustedCalls: StartAdjustedWorkoutInput[] = [];
  syncRequests = 0;
  nextPreview: () => Promise<AvailableTimePreviewResponseV1> = () => Promise.resolve(adjustPreview());
  readonly canonicalWorkoutPreview = workoutPreview();
  adjustedOutcome: () => Promise<StartAdjustedWorkoutOutcome> = () => Promise.resolve({ status: "STARTED", session: SESSION });
  ordinaryOutcome: () => Promise<StartWorkoutSessionOutcome> = () => Promise.resolve({ status: "STARTED", session: SESSION });

  previewAvailableTime(plannedWorkoutId: string, availableMinutes: number): Promise<AvailableTimePreviewResponseV1> {
    this.previewCalls.push({ plannedWorkoutId, availableMinutes });
    return this.nextPreview();
  }
  getWorkoutPreview(): Promise<WorkoutPreviewV1> {
    this.workoutPreviewCalls += 1;
    return Promise.resolve(this.canonicalWorkoutPreview);
  }
  startWorkout(preview: WorkoutPreviewV1): Promise<StartWorkoutSessionOutcome> {
    this.startWorkoutCalls.push(preview);
    return this.ordinaryOutcome();
  }
  startAdjustedWorkout(input: StartAdjustedWorkoutInput): Promise<StartAdjustedWorkoutOutcome> {
    this.startAdjustedCalls.push(input);
    return this.adjustedOutcome();
  }
  requestSync(): void {
    this.syncRequests += 1;
  }

  get mutations(): number {
    return this.startWorkoutCalls.length + this.startAdjustedCalls.length;
  }
}

function setup() {
  const ports = new FakePorts();
  const events = { states: [] as AvailableTimeFlowState[], navigations: 0, dismissals: 0, refreshes: 0 };
  const controller = new AvailableTimeFlowController(WORKOUT_ID, ports, {
    onStateChange: (state) => events.states.push(state),
    navigateToActiveWorkout: () => (events.navigations += 1),
    dismiss: () => (events.dismissals += 1),
    refreshToday: () => (events.refreshes += 1),
  });
  return { ports, events, controller };
}

/** Lets the controller's awaited promises settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function previewed(minutes = 45, next?: () => Promise<AvailableTimePreviewResponseV1>) {
  const context = setup();
  if (next !== undefined) context.ports.nextPreview = next;
  context.controller.selectPreset(minutes);
  context.controller.requestPreview();
  await flush();
  return context;
}

describe("AvailableTimeFlowController — selection & preview", () => {
  it("3/4: starts with nothing selected; Preview changes does nothing until a valid time exists", async () => {
    const { controller, ports } = setup();
    expect(controller.getState()).toEqual({ kind: "SELECT_TIME", selection: { kind: "none" } });
    controller.requestPreview();
    controller.selectCustom();
    controller.setCustomText("0");
    controller.requestPreview();
    controller.setCustomText("12.5");
    controller.requestPreview();
    await flush();
    expect(ports.previewCalls).toEqual([]);
  });

  it("5/6: selecting a preset replaces a Custom value (and switching back to Custom starts empty)", () => {
    const { controller } = setup();
    controller.selectCustom();
    controller.setCustomText("35");
    controller.selectPreset(60);
    expect(controller.getState()).toEqual({ kind: "SELECT_TIME", selection: { kind: "preset", minutes: 60 } });
    controller.selectCustom();
    expect(controller.getState()).toEqual({ kind: "SELECT_TIME", selection: { kind: "custom", text: "" } });
  });

  it("12: sends the exact plannedWorkoutId and the integer minutes (preset and valid Custom)", async () => {
    const { controller, ports } = setup();
    controller.selectCustom();
    controller.setCustomText("35");
    controller.requestPreview();
    await flush();
    expect(ports.previewCalls).toEqual([{ plannedWorkoutId: WORKOUT_ID, availableMinutes: 35 }]);
  });

  it("13: repeated taps while a preview is in flight make exactly ONE request", async () => {
    const { controller, ports } = setup();
    const pending = deferred<AvailableTimePreviewResponseV1>();
    ports.nextPreview = () => pending.promise;
    controller.selectPreset(45);
    controller.requestPreview();
    controller.requestPreview();
    controller.requestPreview();
    expect(controller.getState()).toMatchObject({ kind: "LOADING_PREVIEW", availableMinutes: 45 });
    pending.resolve(adjustPreview(45));
    await flush();
    expect(ports.previewCalls).toHaveLength(1);
    expect(controller.getState().kind).toBe("ADJUST_SESSION");
  });

  it("14: ADJUST_SESSION carries the server preview and the canonical Workout Preview fetched with it", async () => {
    const { controller, ports } = await previewed(45);
    const state = controller.getState();
    expect(state).toMatchObject({ kind: "ADJUST_SESSION", availableMinutes: 45, start: { status: "idle" } });
    if (state.kind !== "ADJUST_SESSION") return;
    expect(state.preview.originalEstimatedSeconds).toBe(540);
    expect(state.preview.adjustedEstimatedSeconds).toBe(210);
    expect(state.workoutPreview).toBe(ports.canonicalWorkoutPreview);
  });
});

describe("AvailableTimeFlowController — actions", () => {
  it("19: Keep original dismisses with ZERO mutation", async () => {
    const { controller, ports, events } = await previewed();
    controller.keepOriginal();
    expect(events.dismissals).toBe(1);
    expect(ports.mutations).toBe(0);
    expect(events.navigations).toBe(0);
  });

  it("20/21/22: Start adjusted workout hands the EXACT server objects to the existing adjusted-start service, then navigates", async () => {
    const { controller, ports, events } = await previewed();
    const state = controller.getState();
    if (state.kind !== "ADJUST_SESSION") throw new Error(state.kind);
    await controller.startAdjusted();
    expect(ports.startAdjustedCalls).toHaveLength(1);
    expect(ports.startAdjustedCalls[0]!.availableTimePreview).toBe(state.preview); // never reconstructed
    expect(ports.startAdjustedCalls[0]!.workoutPreview).toBe(state.workoutPreview);
    expect(ports.startWorkoutCalls).toEqual([]);
    expect(events.navigations).toBe(1);
  });

  it("an existing active session (ALREADY_ACTIVE) goes to Active Workout without creating anything", async () => {
    const { controller, ports, events } = await previewed();
    ports.adjustedOutcome = () => Promise.resolve({ status: "ALREADY_ACTIVE", session: SESSION });
    await controller.startAdjusted();
    expect(events.navigations).toBe(1);
  });

  it.each([
    [{ status: "NOT_APPLICABLE", result: "NO_CHANGE" }],
    [{ status: "INVALID_PREVIEW", reason: "PARTITION_MISMATCH" }],
  ] as const)("a no-longer-applicable adjusted start (%o) fails safely — no navigation, calm inline message", async (outcome) => {
    const { controller, ports, events } = await previewed();
    ports.adjustedOutcome = () => Promise.resolve(outcome);
    await controller.startAdjusted();
    expect(events.navigations).toBe(0);
    expect(controller.getState()).toMatchObject({ kind: "ADJUST_SESSION", start: { status: "failed" } });
  });

  it("a local transaction failure never pretends the workout started", async () => {
    const { controller, ports, events } = await previewed();
    ports.adjustedOutcome = () => Promise.reject(new Error("SQLITE_FULL"));
    await controller.startAdjusted();
    expect(events.navigations).toBe(0);
    expect(controller.getState()).toMatchObject({ kind: "ADJUST_SESSION", start: { status: "failed", message: "Couldn't start the workout. Your planned workout is still available." } });
  });

  it("a double tap on Start adjusted workout starts once", async () => {
    const { controller, ports } = await previewed();
    const pending = deferred<StartAdjustedWorkoutOutcome>();
    ports.adjustedOutcome = () => pending.promise;
    void controller.startAdjusted();
    void controller.startAdjusted();
    pending.resolve({ status: "STARTED", session: SESSION });
    await flush();
    expect(ports.startAdjustedCalls).toHaveLength(1);
  });

  it("25/26: NO_CHANGE's Start workout uses the ORDINARY start (no Available-Time application) and requests sync", async () => {
    const { controller, ports, events } = await previewed(60, () => Promise.resolve(noChangePreview(60)));
    expect(controller.getState().kind).toBe("NO_CHANGE");
    await controller.startOriginal();
    expect(ports.startWorkoutCalls).toEqual([ports.canonicalWorkoutPreview]);
    expect(ports.startAdjustedCalls).toEqual([]);
    expect(ports.syncRequests).toBe(1);
    expect(events.navigations).toBe(1);
  });

  it("NO_CHANGE: Choose another time returns to the selector without starting", async () => {
    const { controller, ports } = await previewed(60, () => Promise.resolve(noChangePreview(60)));
    controller.chooseAnotherTime();
    expect(controller.getState()).toEqual({ kind: "SELECT_TIME", selection: { kind: "preset", minutes: 60 } });
    expect(ports.mutations).toBe(0);
  });

  it("27/28: CANNOT_FIT_MINIMUM can never start anything; Choose more time returns to the selector", async () => {
    const { controller, ports } = await previewed(30, () => Promise.resolve(cannotFitPreview(30)));
    expect(controller.getState().kind).toBe("CANNOT_FIT_MINIMUM");
    await controller.startAdjusted();
    await controller.startOriginal();
    expect(ports.mutations).toBe(0);
    controller.chooseAnotherTime();
    expect(controller.getState()).toEqual({ kind: "SELECT_TIME", selection: { kind: "preset", minutes: 30 } });
  });

  it("29/30: a preview failure shows PREVIEW_ERROR; Retry re-sends the SAME minutes", async () => {
    let calls = 0;
    const { controller, ports } = await previewed(75, () => (++calls === 1 ? Promise.reject(new TypeError("Network request failed")) : Promise.resolve(adjustPreview(75))));
    expect(controller.getState()).toEqual({ kind: "PREVIEW_ERROR", availableMinutes: 75, selection: { kind: "preset", minutes: 75 } });
    controller.retry();
    await flush();
    expect(ports.previewCalls.map((call) => call.availableMinutes)).toEqual([75, 75]);
    expect(controller.getState().kind).toBe("ADJUST_SESSION");
  });

  it("18 (stale Today): an already-started occurrence (409) dismisses and refreshes Today — never an error state, never a start", async () => {
    const { controller, ports, events } = await previewed(45, () => Promise.reject(new PlanApiRequestFailure("Plan API request failed: 409", 409)));
    expect(events.dismissals).toBe(1);
    expect(events.refreshes).toBe(1);
    expect(ports.mutations).toBe(0);
    expect(controller.getState().kind).toBe("LOADING_PREVIEW"); // never rendered: the sheet is gone
  });

  it("33: whatever the athlete's mode, nothing starts until Start adjusted workout is explicitly tapped", async () => {
    // The flow has no mode input at all — the only path to a start is the explicit action.
    const { ports } = await previewed();
    await flush();
    expect(ports.mutations).toBe(0);
  });

  it("34: closing during an in-flight preview cancels it — the late result causes no state update and no mutation", async () => {
    const { controller, ports, events } = setup();
    const pending = deferred<AvailableTimePreviewResponseV1>();
    ports.nextPreview = () => pending.promise;
    controller.selectPreset(45);
    controller.requestPreview();
    controller.keepOriginal(); // close / Android back
    controller.dispose(); // the sheet unmounts
    const statesBefore = events.states.length;
    pending.resolve(adjustPreview(45));
    await flush();
    expect(events.states).toHaveLength(statesBefore);
    expect(events.dismissals).toBe(1);
    expect(ports.mutations).toBe(0);
  });
});
