import { describe, expect, it } from "vitest";
import type { ProgressOverviewV1 } from "@vostivo/contracts";
import { ProgressApiFailure } from "./progress-api-client";
import { ProgressReadController, type ProgressReadState } from "./progress-read-controller";
import { overview } from "./testing/fixtures";

type Step = ProgressOverviewV1 | Error;

function harness(steps: Step[]) {
  const queue = [...steps];
  const states: ProgressReadState<ProgressOverviewV1>[] = [];
  const logs: string[] = [];
  let reads = 0;
  const controller = new ProgressReadController<ProgressOverviewV1>(
    () => {
      reads += 1;
      const next = queue.shift();
      if (next === undefined) return Promise.reject(new Error("unscripted read"));
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    { onStateChange: (state) => states.push(state), logFailure: (message) => logs.push(message) },
  );
  return { controller, states, logs, reads: () => reads };
}

describe("ProgressReadController (Progress root / workout detail)", () => {
  it("starts LOADING, then READY with exactly the server data", async () => {
    const data = overview();
    const h = harness([data]);
    expect(h.controller.getState()).toEqual({ kind: "LOADING" });
    await h.controller.load();
    expect(h.controller.getState()).toEqual({ kind: "READY", data });
  });

  it("a failed first load -> ERROR (logged); Retry loads again", async () => {
    const data = overview();
    const h = harness([new ProgressApiFailure(500), data]);
    await h.controller.load();
    expect(h.controller.getState()).toEqual({ kind: "ERROR" });
    expect(h.logs).toHaveLength(1);
    await h.controller.load();
    expect(h.controller.getState()).toEqual({ kind: "READY", data });
  });

  it("404 -> NOT_AVAILABLE (one generic state, never why)", async () => {
    const h = harness([new ProgressApiFailure(404)]);
    await h.controller.load();
    expect(h.controller.getState()).toEqual({ kind: "NOT_AVAILABLE" });
  });

  it("a focus refetch keeps READY visible (no LOADING flash); a failed refetch keeps the last data", async () => {
    const first = overview();
    const h = harness([first, new Error("offline")]);
    await h.controller.load();
    const before = h.states.length;
    await h.controller.load();
    expect(h.states.slice(before)).toEqual([]);
    expect(h.controller.getState()).toEqual({ kind: "READY", data: first });
  });

  it("overlapping loads: the last call wins; nothing is emitted after dispose", async () => {
    let resolveFirst: (value: ProgressOverviewV1) => void = () => undefined;
    const second = overview({ improving: [] });
    let call = 0;
    const states: ProgressReadState<ProgressOverviewV1>[] = [];
    const controller = new ProgressReadController<ProgressOverviewV1>(
      () => {
        call += 1;
        return call === 1 ? new Promise((resolve) => (resolveFirst = resolve)) : Promise.resolve(second);
      },
      { onStateChange: (s) => states.push(s), logFailure: () => undefined },
    );
    const firstLoad = controller.load();
    await controller.load();
    resolveFirst(overview());
    await firstLoad;
    expect(controller.getState()).toEqual({ kind: "READY", data: second });
    controller.dispose();
    const count = states.length;
    await controller.load().catch(() => undefined);
    expect(states.length).toBe(count);
  });
});
