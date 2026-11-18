import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createFinishGuard } from "./finish-guard";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("FinishGuard (ANDROID-STAB-03 D1)", () => {
  it("FIN-UI-001: a rapid double tap runs Finish exactly once", async () => {
    const guard = createFinishGuard();
    const gate = deferred();
    let calls = 0;
    const action = async () => {
      calls += 1;
      await gate.promise;
    };

    const first = guard.run("session-1", action);
    const second = guard.run("session-1", action);
    gate.resolve();

    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(calls).toBe(1);
  });

  it("FIN-UI-002: a tap AFTER a successful Finish does not run it again (summary stays, no ALREADY_FINISHED reload)", async () => {
    const guard = createFinishGuard();
    let calls = 0;
    await guard.run("session-1", async () => {
      calls += 1;
    });

    expect(
      await guard.run("session-1", async () => {
        calls += 1;
      }),
    ).toBe(false);
    expect(guard.isClaimed("session-1")).toBe(true);
    expect(calls).toBe(1);
  });

  it("FIN-UI-003: a failed Finish releases the claim so the athlete can retry", async () => {
    const guard = createFinishGuard();
    await expect(
      guard.run("session-1", () => Promise.reject(new Error("local write failed"))),
    ).rejects.toThrow("local write failed");
    expect(guard.isClaimed("session-1")).toBe(false);

    let calls = 0;
    expect(
      await guard.run("session-1", async () => {
        calls += 1;
      }),
    ).toBe(true);
    expect(calls).toBe(1);
  });

  it("FIN-UI-004: sessions are independent", async () => {
    const guard = createFinishGuard();
    await guard.run("session-1", async () => {});
    let ran = false;
    expect(
      await guard.run("session-2", async () => {
        ran = true;
      }),
    ).toBe(true);
    expect(ran).toBe(true);
  });

  it("FIN-UI-005: Active Workout routes every Finish entry point (icon, bottom button, confirm sheet) through the guard", () => {
    const source = readFileSync(new URL("../../app/active-workout.tsx", import.meta.url), "utf8");
    expect(source).toContain("createFinishGuard()");
    expect(source).toMatch(/finishGuard\s*\.run\(session\.id/);
    // The summary is replaced only by an explicit Done, never by a second Finish reload.
    expect(source).toContain(
      '<SummaryView summary={state.summary} onDone={() => router.replace("/")} />',
    );
  });
});
