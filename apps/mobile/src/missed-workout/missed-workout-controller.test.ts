import { describe, expect, it } from "vitest";
import type { MissedWorkoutApplyResponseV1, MissedWorkoutPreviewResponseV1, PlanOverviewV1 } from "@vostivo/contracts";
import { deriveTodayHeroState } from "../plan/today-derivation";
import { adjustableTodaySession } from "../available-time/available-time-flow";
import { MissedWorkoutApiFailure } from "./missed-workout-api-client";
import { MissedWorkoutFlowController, type MissedWorkoutFlowPorts } from "./missed-workout-controller";
import { missedWorkoutCard, type MissedWorkoutFlowState } from "./missed-workout-flow";
import { IDS, NO_CHANGE, applied, reviewRequired, rollForwardPreview } from "./testing/fixtures";

type Step<T> = T | Error;

/** Scripted ports: each call takes the next scripted answer; every call is recorded. */
function harness(options: { previews: Step<MissedWorkoutPreviewResponseV1>[]; applies?: Step<MissedWorkoutApplyResponseV1>[] }) {
  const previews = [...options.previews];
  const applies = [...(options.applies ?? [])];
  const calls = { ensure: 0, retryTimeZone: 0, preview: 0, apply: [] as unknown[][], refreshToday: 0, logs: [] as string[] };
  const states: MissedWorkoutFlowState[] = [];
  const next = <T,>(queue: Step<T>[]): Promise<T> => {
    const answer = queue.shift();
    if (answer === undefined) return Promise.reject(new Error("unscripted call"));
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  const ports: MissedWorkoutFlowPorts = {
    ensureTrainingTimeZone: () => {
      calls.ensure += 1;
      return Promise.resolve();
    },
    retryTrainingTimeZone: () => {
      calls.retryTimeZone += 1;
      return Promise.resolve();
    },
    preview: () => {
      calls.preview += 1;
      return next(previews);
    },
    // Record EVERY argument the controller passes — the request may carry nothing but the fingerprint.
    apply: (...args: unknown[]) => {
      calls.apply.push(args);
      return next(applies);
    },
  };
  const controller = new MissedWorkoutFlowController(ports, {
    onStateChange: (state) => states.push(state),
    refreshToday: () => {
      calls.refreshToday += 1;
    },
    logFailure: (message) => calls.logs.push(message),
  });
  return { controller, calls, states };
}

const stale = () => new MissedWorkoutApiFailure(409, "MISSED_WORKOUT_PREVIEW_STALE", null);

describe("MissedWorkoutFlowController", () => {
  it("1: NO_CHANGE -> no card", async () => {
    const { controller } = harness({ previews: [NO_CHANGE] });
    await controller.load();
    expect(missedWorkoutCard(controller.getState())).toBeNull();
  });

  it("2/4: ROLL_FORWARD -> recommendation card; Review opens the review surface", async () => {
    const { controller } = harness({ previews: [rollForwardPreview()] });
    await controller.load();
    expect(controller.getState()).toMatchObject({ kind: "ROLL_FORWARD", reviewOpen: false });
    controller.openReview();
    expect(controller.getState()).toMatchObject({ kind: "ROLL_FORWARD", reviewOpen: true, apply: { status: "idle" } });
  });

  it("the training time zone bootstrap runs before the preview, every load (it is a no-op once done)", async () => {
    const { controller, calls } = harness({ previews: [NO_CHANGE, NO_CHANGE] });
    await controller.load();
    await controller.load();
    expect(calls.ensure).toBe(2);
    expect(calls.preview).toBe(2);
  });

  it("17 (no auto-apply): loading, opening the review, refreshing never call apply — for every mode, only an explicit Apply does", async () => {
    const { controller, calls } = harness({ previews: [rollForwardPreview(), rollForwardPreview()] });
    await controller.load();
    controller.openReview();
    await controller.load();
    expect(calls.apply).toHaveLength(0);
    // Apply outside an open review is ignored too.
    controller.notNow();
    await controller.apply();
    expect(calls.apply).toHaveLength(0);
  });

  it("9/10/12: Apply sends ONLY the preview fingerprint, then closes the review and refreshes Today/Plan — it never starts a workout", async () => {
    const preview = rollForwardPreview();
    const { controller, calls } = harness({ previews: [preview], applies: [applied()] });
    await controller.load();
    controller.openReview();
    await controller.apply();
    expect(calls.apply).toEqual([[preview.previewFingerprint]]);
    expect(controller.getState()).toEqual({ kind: "IDLE" });
    expect(calls.refreshToday).toBe(1);
    // The flow has no start/navigation capability at all: scheduling and training are separate actions.
    expect(Object.keys(controller)).not.toContain("start");
  });

  it("11: after Apply, Today's (server) overview resolves the rolled-forward workout as today's training", () => {
    const overviewAfterApply: PlanOverviewV1 = {
      currentBlock: { trainingBlockId: "b", name: "Block", goal: "Hypertrophy", currentCycleOrder: 0, cycleCount: 2, daysPerWeek: 3 },
      sessions: [
        { plannedWorkoutId: IDS.upperA, name: "Upper A", focus: null, order: 0, scheduledDate: "2026-10-07", authoredScheduledDate: "2026-10-05", scheduleSource: "ADAPTED", estimatedDurationMinutes: 60, displayStatus: "TODAY", hasActiveSession: false, hasAppliedProgression: false },
        { plannedWorkoutId: IDS.lowerA, name: "Lower A", focus: null, order: 1, scheduledDate: "2026-10-09", authoredScheduledDate: "2026-10-07", scheduleSource: "ADAPTED", estimatedDurationMinutes: 60, displayStatus: "PLANNED", hasActiveSession: false, hasAppliedProgression: false },
      ],
      weeklyFocus: [],
      schedule: { state: "IN_CURRENT_BLOCK", displayedCycle: "CURRENT" }, athleteLocalDate: null,
    };
    const hero = deriveTodayHeroState({ hasActiveSessionAnywhere: false, overview: { status: "ready", overview: overviewAfterApply } });
    expect(hero).toMatchObject({ kind: "training-day", session: { plannedWorkoutId: IDS.upperA, name: "Upper A" } });
    // 36 (mobile side): "Adjust time" targets the rolled-forward workout's OWN PlannedWorkout id — no synthetic workout.
    expect(adjustableTodaySession(hero)?.plannedWorkoutId).toBe(IDS.upperA);
    // An active session anywhere still wins (Resume) — recovery is untouched by schedule adaptation.
    expect(deriveTodayHeroState({ hasActiveSessionAnywhere: true, overview: { status: "ready", overview: overviewAfterApply } })).toEqual({ kind: "resume" });
  });

  it("13: Not now closes the review and hides the card — no request of any kind; a later refresh may show it again", async () => {
    const { controller, calls } = harness({ previews: [rollForwardPreview(), rollForwardPreview()] });
    await controller.load();
    controller.openReview();
    controller.notNow();
    expect(controller.getState()).toEqual({ kind: "DISMISSED" });
    expect(calls.apply).toHaveLength(0);
    expect(calls.preview).toBe(1);
    await controller.load();
    expect(controller.getState()).toMatchObject({ kind: "ROLL_FORWARD", reviewOpen: false, planChanged: false });
  });

  it("14: REVIEW_REQUIRED -> a review-required card; Apply is impossible", async () => {
    const { controller, calls } = harness({ previews: [reviewRequired("MULTIPLE_MISSED_WORKOUTS")] });
    await controller.load();
    expect(missedWorkoutCard(controller.getState())).toEqual({ kind: "REVIEW_REQUIRED", reason: "More than one workout was missed." });
    controller.openReview();
    await controller.apply();
    expect(calls.apply).toHaveLength(0);
  });

  it("15/20: a failed preview degrades quietly (no card, logged) — and never replaces an already shown recommendation", async () => {
    const { controller, calls } = harness({ previews: [new TypeError("Network request failed"), rollForwardPreview(), new TypeError("Network request failed")] });
    await controller.load();
    expect(controller.getState()).toEqual({ kind: "PREVIEW_ERROR" });
    expect(missedWorkoutCard(controller.getState())).toBeNull();
    expect(calls.logs).toHaveLength(1);
    await controller.load();
    await controller.load();
    expect(controller.getState()).toMatchObject({ kind: "ROLL_FORWARD" });
  });

  it("no current block / no profile -> nothing to adapt, quiet", async () => {
    const { controller } = harness({ previews: [new MissedWorkoutApiFailure(409, "CURRENT_TRAINING_BLOCK_UNRESOLVED", null)] });
    await controller.load();
    expect(controller.getState()).toEqual({ kind: "IDLE" });
  });

  it("16: an offline/failed Apply keeps the preview open with Retry, changes nothing locally, and does not refresh as if applied", async () => {
    const preview = rollForwardPreview();
    const { controller, calls } = harness({ previews: [preview], applies: [new TypeError("Network request failed"), applied()] });
    await controller.load();
    controller.openReview();
    await controller.apply();
    expect(controller.getState()).toEqual({ kind: "ROLL_FORWARD", preview, reviewOpen: true, apply: { status: "failed" }, planChanged: false });
    expect(calls.refreshToday).toBe(0);
    // Retry is the same explicit Apply with the same fingerprint.
    await controller.apply();
    expect(calls.apply).toEqual([[preview.previewFingerprint], [preview.previewFingerprint]]);
    expect(controller.getState()).toEqual({ kind: "IDLE" });
  });

  it("17/18: STALE -> refetch; a new ROLL_FORWARD reopens as 'Plan changed' and is NEVER auto-applied; a second explicit Apply sends the NEW fingerprint", async () => {
    const first = rollForwardPreview("a".repeat(64));
    const updated = rollForwardPreview("b".repeat(64));
    const { controller, calls } = harness({ previews: [first, updated], applies: [stale(), applied("b".repeat(64))] });
    await controller.load();
    controller.openReview();
    await controller.apply();
    expect(calls.apply).toEqual([["a".repeat(64)]]);
    expect(controller.getState()).toEqual({ kind: "ROLL_FORWARD", preview: updated, reviewOpen: true, apply: { status: "idle" }, planChanged: true });
    expect(calls.refreshToday).toBe(1);
    await controller.apply();
    expect(calls.apply).toEqual([["a".repeat(64)], ["b".repeat(64)]]);
  });

  it("8 (stale): STALE and the new preview is NO_CHANGE -> the adaptation disappears and Today refreshes", async () => {
    const { controller, calls } = harness({ previews: [rollForwardPreview(), NO_CHANGE], applies: [stale()] });
    await controller.load();
    controller.openReview();
    await controller.apply();
    expect(controller.getState()).toEqual({ kind: "IDLE" });
    expect(calls.refreshToday).toBe(1);
  });

  it("9 (not applicable): NOT_APPLICABLE -> refetch, REVIEW_REQUIRED shows the calm state; the same apply is never retried", async () => {
    const { controller, calls } = harness({
      previews: [rollForwardPreview(), reviewRequired("LATER_SESSION_ALREADY_PERFORMED")],
      applies: [new MissedWorkoutApiFailure(409, "MISSED_WORKOUT_NOT_APPLICABLE", "LATER_SESSION_ALREADY_PERFORMED")],
    });
    await controller.load();
    controller.openReview();
    await controller.apply();
    expect(controller.getState()).toEqual({ kind: "REVIEW_REQUIRED", reasonCode: "LATER_SESSION_ALREADY_PERFORMED" });
    expect(calls.apply).toHaveLength(1);
  });

  it("25: TRAINING_TIME_ZONE_REQUIRED -> retryable state; Try again re-runs the bootstrap explicitly, then previews again", async () => {
    const { controller, calls } = harness({ previews: [new MissedWorkoutApiFailure(409, "TRAINING_TIME_ZONE_REQUIRED", null), rollForwardPreview()] });
    await controller.load();
    expect(controller.getState()).toEqual({ kind: "TIMEZONE_REQUIRED", retrying: false });
    await controller.retryTimeZone();
    expect(calls.retryTimeZone).toBe(1);
    expect(controller.getState()).toMatchObject({ kind: "ROLL_FORWARD" });
  });

  it("a late preview after dispose (screen left) is ignored", async () => {
    const { controller, states } = harness({ previews: [rollForwardPreview()] });
    const loading = controller.load();
    controller.dispose();
    await loading;
    expect(states).toEqual([]);
  });
});
