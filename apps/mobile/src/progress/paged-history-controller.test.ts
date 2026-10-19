import { describe, expect, it } from "vitest";
import type { WorkoutHistoryItemV1, WorkoutHistoryPageV1 } from "@vostivo/contracts";
import { ProgressApiFailure } from "./progress-api-client";
import { PagedHistoryController, type PagedHistoryState } from "./paged-history-controller";
import { exerciseExposureKey, exerciseHistoryPages, workoutHistoryKey, workoutHistoryPages } from "./progress-history";
import { exercisePage, exposure, workoutItem } from "./testing/fixtures";

const item = (id: string): WorkoutHistoryItemV1 => workoutItem({ workoutSessionId: id });
const CURSOR = "eyJ0IjoiMjAyNi0xMC0xMyAwOTowMDowMC4wMDA5KzAwIiwiaSI6IngifQ";

/** Scripted pages; each call records the exact `before` it was given. Deferred answers let a test hold a request in flight. */
function harness(answers: (WorkoutHistoryPageV1 | Error | "HOLD")[]) {
  const queue = [...answers];
  const befores: (string | null)[] = [];
  let release: () => void = () => undefined;
  const states: PagedHistoryState<WorkoutHistoryItemV1, null>[] = [];
  const api = {
    getWorkoutHistory: (before: string | null): Promise<WorkoutHistoryPageV1> => {
      befores.push(before);
      const next = queue.shift();
      if (next === undefined) return Promise.reject(new Error("unscripted page"));
      if (next === "HOLD") return new Promise((resolve) => (release = () => resolve({ items: [item("held")], nextCursor: null })));
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
  const controller = new PagedHistoryController(workoutHistoryPages(api), workoutHistoryKey, { onStateChange: (s) => states.push(s), logFailure: () => undefined });
  return { controller, befores, states, release: () => release() };
}

describe("PagedHistoryController (workout / exercise history)", () => {
  it("first page, then Load more with the server cursor passed through VERBATIM", async () => {
    const h = harness([{ items: [item("a"), item("b")], nextCursor: CURSOR }, { items: [item("c")], nextCursor: null }]);
    await h.controller.load();
    expect(h.controller.getState()).toMatchObject({ kind: "READY", nextCursor: CURSOR, more: "IDLE" });
    await h.controller.loadMore();
    expect(h.befores).toEqual([null, CURSOR]);
    const state = h.controller.getState();
    expect(state.kind === "READY" && state.items.map((i) => i.workoutSessionId)).toEqual(["a", "b", "c"]);
    expect(state).toMatchObject({ nextCursor: null });
  });

  it("repeated Load more taps while a page is loading send ONE request", async () => {
    const h = harness([{ items: [item("a")], nextCursor: CURSOR }, "HOLD"]);
    await h.controller.load();
    const pending = h.controller.loadMore();
    expect(h.controller.getState()).toMatchObject({ more: "LOADING" });
    await h.controller.loadMore();
    await h.controller.loadMore();
    h.release();
    await pending;
    expect(h.befores).toEqual([null, CURSOR]);
  });

  it("a failed page keeps every loaded row; Retry asks for the SAME cursor", async () => {
    const h = harness([{ items: [item("a")], nextCursor: CURSOR }, new Error("offline"), { items: [item("b")], nextCursor: null }]);
    await h.controller.load();
    await h.controller.loadMore();
    const failed = h.controller.getState();
    expect(failed).toMatchObject({ kind: "READY", more: "ERROR", nextCursor: CURSOR });
    expect(failed.kind === "READY" && failed.items.map((i) => i.workoutSessionId)).toEqual(["a"]);
    await h.controller.loadMore();
    expect(h.befores).toEqual([null, CURSOR, CURSOR]);
    const done = h.controller.getState();
    expect(done.kind === "READY" && done.items.map((i) => i.workoutSessionId)).toEqual(["a", "b"]);
  });

  it("no next cursor -> Load more is a no-op (clear end state)", async () => {
    const h = harness([{ items: [item("a")], nextCursor: null }]);
    await h.controller.load();
    await h.controller.loadMore();
    expect(h.befores).toEqual([null]);
  });

  it("a row already shown is never appended twice", async () => {
    const h = harness([{ items: [item("a")], nextCursor: CURSOR }, { items: [item("a"), item("b")], nextCursor: null }]);
    await h.controller.load();
    await h.controller.loadMore();
    const state = h.controller.getState();
    expect(state.kind === "READY" && state.items.map((i) => i.workoutSessionId)).toEqual(["a", "b"]);
  });

  it("first page 404 -> NOT_AVAILABLE; other failure -> ERROR_INITIAL, then Retry", async () => {
    const notFound = harness([new ProgressApiFailure(404)]);
    await notFound.controller.load();
    expect(notFound.controller.getState()).toEqual({ kind: "NOT_AVAILABLE" });

    const failing = harness([new ProgressApiFailure(503), { items: [], nextCursor: null }]);
    await failing.controller.load();
    expect(failing.controller.getState()).toEqual({ kind: "ERROR_INITIAL" });
    await failing.controller.load();
    expect(failing.controller.getState()).toMatchObject({ kind: "READY", items: [], nextCursor: null });
  });

  it("exercise history asks for the EXACT ref (a substitute is never mapped to the authored exercise) and keeps the server header", async () => {
    const refs: string[] = [];
    const api = {
      getExerciseHistory: (exerciseRef: string, before: string | null) => {
        refs.push(`${exerciseRef}|${before ?? ""}`);
        return Promise.resolve(exercisePage({ exerciseRef, displayName: "Dumbbell Bench Press", exposures: [exposure({ isSubstitute: true })], nextCursor: CURSOR }));
      },
    };
    const controller = new PagedHistoryController(exerciseHistoryPages(api, "dumbbell-bench-press"), exerciseExposureKey, { onStateChange: () => undefined, logFailure: () => undefined });
    await controller.load();
    await controller.loadMore();
    expect(refs).toEqual(["dumbbell-bench-press|", `dumbbell-bench-press|${CURSOR}`]);
    expect(controller.getState()).toMatchObject({ kind: "READY", header: { exerciseRef: "dumbbell-bench-press", displayName: "Dumbbell Bench Press" } });
  });
});
