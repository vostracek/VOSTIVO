import { describe, expect, it } from "vitest";
import type { UnresolvedSyncSummary } from "./outbox-port";
import { UNRESOLVED_SYNC_MESSAGE, UnresolvedSyncMonitor, unresolvedSyncNotice, type UnresolvedSyncNotice, type UnresolvedSyncPorts } from "./unresolved-sync-notice";

const CLEAN: UnresolvedSyncSummary = { blocked: 0, waitingOnBlocked: 0, rejected: 0, conflicted: 0 };

describe("unresolvedSyncNotice (CC-03 Today notice)", () => {
  it("shows nothing when nothing is unresolved — never an 'all synced' claim", () => {
    expect(unresolvedSyncNotice(CLEAN, false)).toBeNull();
  });

  it.each<[string, Partial<UnresolvedSyncSummary>]>([
    ["BLOCKED", { blocked: 1 }],
    ["held behind a BLOCKED command", { waitingOnBlocked: 3 }],
    ["REJECTED", { rejected: 1 }],
    ["CONFLICT", { conflicted: 1 }],
  ])("shows the calm saved-on-device message for %s", (_label, counts) => {
    expect(unresolvedSyncNotice({ ...CLEAN, ...counts }, false)).toEqual({ message: UNRESOLVED_SYNC_MESSAGE });
  });

  it("shows it for a whole-request refusal that classified nothing in the outbox", () => {
    expect(unresolvedSyncNotice(CLEAN, true)).toEqual({ message: UNRESOLVED_SYNC_MESSAGE });
  });

  it("uses the approved copy, with no action", () => {
    expect(UNRESOLVED_SYNC_MESSAGE).toBe("Some workout records haven't synced yet. They're saved on this device.");
  });
});

class FakePorts implements UnresolvedSyncPorts {
  summary: UnresolvedSyncSummary | Error = CLEAN;
  requestRejected = false;
  readonly listeners = new Set<() => void>();
  reads = 0;
  readSummary(): Promise<UnresolvedSyncSummary> {
    this.reads += 1;
    return this.summary instanceof Error ? Promise.reject(this.summary) : Promise.resolve(this.summary);
  }
  isRequestRejected(): boolean {
    return this.requestRejected;
  }
  onSyncPassSettled(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  settlePass(): void {
    for (const listener of this.listeners) listener();
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("UnresolvedSyncMonitor", () => {
  function monitor(ports: FakePorts) {
    const notices: (UnresolvedSyncNotice | null)[] = [];
    const failures: string[] = [];
    const instance = new UnresolvedSyncMonitor(ports, (notice) => notices.push(notice), (message) => failures.push(message));
    return { instance, notices, failures };
  }

  it("reads on start and again after every settled sync pass (mutation, launch, foreground resume, retry)", async () => {
    const ports = new FakePorts();
    const { instance, notices } = monitor(ports);

    instance.start();
    await flush();
    expect(notices).toEqual([null]);

    ports.summary = { ...CLEAN, blocked: 1 };
    ports.settlePass();
    await flush();
    expect(notices.at(-1)).toEqual({ message: UNRESOLVED_SYNC_MESSAGE });

    ports.summary = CLEAN;
    ports.settlePass();
    await flush();
    expect(notices.at(-1)).toBeNull();
  });

  it("reflects a systemic request refusal reported by the coordinator", async () => {
    const ports = new FakePorts();
    ports.requestRejected = true;
    const { instance, notices } = monitor(ports);

    instance.start();
    await flush();

    expect(notices).toEqual([{ message: UNRESOLVED_SYNC_MESSAGE }]);
  });

  it("a failed read keeps the last known notice instead of clearing it", async () => {
    const ports = new FakePorts();
    ports.summary = { ...CLEAN, rejected: 1 };
    const { instance, notices, failures } = monitor(ports);
    instance.start();
    await flush();

    ports.summary = new Error("database closed");
    await instance.refresh();

    expect(notices).toEqual([{ message: UNRESOLVED_SYNC_MESSAGE }]);
    expect(failures).toEqual(["unresolved sync state read failed"]);
  });

  it("an older read finishing late never overwrites a newer one", async () => {
    let resolveOld: ((summary: UnresolvedSyncSummary) => void) | undefined;
    const ports = new FakePorts();
    const { instance, notices } = monitor(ports);
    ports.readSummary = () => new Promise((resolve) => (resolveOld = resolve));
    const older = instance.refresh();
    ports.readSummary = () => Promise.resolve({ ...CLEAN, conflicted: 1 });
    await instance.refresh();
    resolveOld!(CLEAN);
    await older;

    expect(notices).toEqual([{ message: UNRESOLVED_SYNC_MESSAGE }]);
  });

  it("dispose unsubscribes and ignores later passes", async () => {
    const ports = new FakePorts();
    const { instance, notices } = monitor(ports);
    instance.start();
    await flush();

    instance.dispose();
    ports.settlePass();
    await instance.refresh();
    await flush();

    expect(ports.listeners.size).toBe(0);
    expect(notices).toEqual([null]);
  });
});
