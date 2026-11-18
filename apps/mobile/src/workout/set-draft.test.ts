import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SetDraftV1 } from "./active-workout-session";
import { resolvePrefill } from "./active-workout-presentation";
import { createDraftDebouncer, upsertSetDraft, type DraftScheduler } from "./set-draft";

const kg = (amount: number) =>
  ({
    kind: "EXTERNAL_WEIGHT",
    amountMilli: amount * 1000,
    unit: "KG",
    basis: "TOTAL",
  }) as unknown as NonNullable<SetDraftV1["draftLoad"]>;

function draft(
  exercise: string,
  set: string,
  reps: number | null,
  load: number | null,
): SetDraftV1 {
  return {
    prescriptionExerciseId: exercise,
    prescriptionSetId: set,
    draftReps: reps,
    draftLoad: load === null ? null : kg(load),
  };
}

function fakeScheduler(): DraftScheduler & { fire(): void; pending(): number } {
  let next = 0;
  const timers = new Map<number, () => void>();
  return {
    setTimeout(callback) {
      next += 1;
      timers.set(next, callback);
      return next;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    fire() {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach((cb) => cb());
    },
    pending: () => timers.size,
  };
}

describe("upsertSetDraft (ANDROID-STAB-03 D2)", () => {
  it("DRAFT-001: adds a new draft for an untouched slot", () => {
    expect(upsertSetDraft([], draft("bench", "s1", 12, 60))).toEqual([
      draft("bench", "s1", 12, 60),
    ]);
  });

  it("DRAFT-002: replaces only the same (exercise, set) slot", () => {
    const drafts = [draft("bench", "s1", 10, 60), draft("bench", "s2", 8, 60)];
    expect(upsertSetDraft(drafts, draft("bench", "s1", 12, 62.5))).toEqual([
      draft("bench", "s1", 12, 62.5),
      draft("bench", "s2", 8, 60),
    ]);
  });

  it("DRAFT-003: never leaks between exercises sharing a set id", () => {
    const drafts = upsertSetDraft([draft("bench", "s1", 12, 60)], draft("ohp", "s1", 7, 30));
    expect(drafts).toEqual([draft("bench", "s1", 12, 60), draft("ohp", "s1", 7, 30)]);
  });

  it("DRAFT-004: a cleared field stays a draft (null) and never fabricates a value", () => {
    expect(upsertSetDraft([draft("bench", "s1", 12, 60)], draft("bench", "s1", null, 60))).toEqual([
      draft("bench", "s1", null, 60),
    ]);
  });

  it("DRAFT-005: switch away and back — the remounted row restores the typed draft, and completed reality still wins", () => {
    const planned = {
      targetReps: { kind: "RANGE", min: 8, max: 12 },
      targetLoad: kg(60),
    } as unknown as Parameters<typeof resolvePrefill>[0];
    const drafts = upsertSetDraft([], draft("bench", "s1", 9, 57.5));
    const restored = resolvePrefill(
      planned,
      undefined,
      drafts.find((d) => d.prescriptionExerciseId === "bench"),
      undefined,
    );
    expect(restored.reps).toBe("9");
    expect(restored.load).toBe("57.5");
    const other = resolvePrefill(
      planned,
      undefined,
      drafts.find((d) => d.prescriptionExerciseId === "ohp"),
      undefined,
    );
    expect(other.reps).not.toBe("9");
    const performed = { actualReps: 12, actualLoad: kg(60) } as unknown as Parameters<
      typeof resolvePrefill
    >[1];
    expect(resolvePrefill(planned, performed, drafts[0], undefined)).toMatchObject({
      reps: "12",
      load: "60",
    });
  });
});

describe("createDraftDebouncer (ANDROID-STAB-03 D2)", () => {
  it("DRAFT-010: typing saves once after the debounce window", () => {
    const scheduler = fakeScheduler();
    let saves = 0;
    const debouncer = createDraftDebouncer(() => (saves += 1), 400, scheduler);
    debouncer.schedule();
    debouncer.schedule();
    expect(scheduler.pending()).toBe(1);
    scheduler.fire();
    expect(saves).toBe(1);
  });

  it("DRAFT-011: unmount inside the window SAVES the pending draft (the old cleanup dropped it)", () => {
    const scheduler = fakeScheduler();
    let saves = 0;
    const debouncer = createDraftDebouncer(() => (saves += 1), 400, scheduler);
    debouncer.schedule();
    debouncer.dispose();
    expect(saves).toBe(1);
    expect(scheduler.pending()).toBe(0);
    debouncer.schedule();
    scheduler.fire();
    expect(saves).toBe(1);
  });

  it("DRAFT-012: unmount with nothing pending writes nothing", () => {
    const scheduler = fakeScheduler();
    let saves = 0;
    const debouncer = createDraftDebouncer(() => (saves += 1), 400, scheduler);
    debouncer.schedule();
    scheduler.fire();
    debouncer.dispose();
    expect(saves).toBe(1);
  });

  it("DRAFT-013: blur saves immediately and cancels the pending window", () => {
    const scheduler = fakeScheduler();
    let saves = 0;
    const debouncer = createDraftDebouncer(() => (saves += 1), 400, scheduler);
    debouncer.schedule();
    debouncer.flush();
    expect(saves).toBe(1);
    expect(scheduler.pending()).toBe(0);
  });

  it("DRAFT-014: Active Workout mirrors each saved draft into its snapshot and flushes on unmount", () => {
    const source = readFileSync(new URL("../../app/active-workout.tsx", import.meta.url), "utf8");
    expect(source).toContain("upsertSetDraft(current.session.drafts, setDraft)");
    expect(source).toContain("return () => debouncer.dispose();");
    expect(source).not.toContain("draftTimerRef");
  });
});
