import { describe, expect, it } from "vitest";
import { createInFlightGuard, setActionKey } from "./in-flight-guard";

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

describe("CORE-FIX-11 in-flight guard", () => {
  it("drops a second run of the same key while the first is pending (double tap)", async () => {
    const guard = createInFlightGuard();
    const gate = deferred();
    let calls = 0;
    const first = guard.run("ex:set-1", async () => {
      calls += 1;
      await gate.promise;
    });
    const second = guard.run("ex:set-1", () => {
      calls += 1;
      return Promise.resolve();
    });
    expect(guard.isInFlight("ex:set-1")).toBe(true);
    expect(await second).toBe(false);
    gate.resolve();
    expect(await first).toBe(true);
    expect(calls).toBe(1);
    expect(guard.isInFlight("ex:set-1")).toBe(false);
  });

  it("never blocks a different set (logger stays responsive)", async () => {
    const guard = createInFlightGuard();
    const gate = deferred();
    const first = guard.run("ex:set-1", () => gate.promise);
    expect(await guard.run("ex:set-2", () => Promise.resolve())).toBe(true);
    gate.resolve();
    await first;
  });

  it("releases the key after a failure, so the athlete can retry", async () => {
    const guard = createInFlightGuard();
    await expect(
      guard.run("ex:set-1", () => Promise.reject(new Error("disk full"))),
    ).rejects.toThrow("disk full");
    expect(guard.isInFlight("ex:set-1")).toBe(false);
    expect(await guard.run("ex:set-1", () => Promise.resolve())).toBe(true);
  });

  it("releases the key after success, so a later legitimate action runs", async () => {
    const guard = createInFlightGuard();
    expect(await guard.run("ex:set-1", () => Promise.resolve())).toBe(true);
    expect(await guard.run("ex:set-1", () => Promise.resolve())).toBe(true);
  });

  it("keys planned slots by exercise slot + set slot", () => {
    expect(setActionKey("bench-a", "bench-a-set-1")).toBe("bench-a:bench-a-set-1");
    expect(setActionKey(null, "row-1")).toBe("unplanned:row-1");
    expect(setActionKey("a", "1")).not.toBe(setActionKey("b", "1"));
  });
});
