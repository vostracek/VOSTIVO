import { describe, expect, it } from "vitest";
import { classifyScheduleCalendar, type ScheduleCycleRef } from "./schedule-calendar.js";
import { legacyUtcCalendarDate, requireAthleteTimeZoneDate, resolveScheduleDateContext } from "./schedule-date-context.js";

function cycle(block: string, blockOrder: number, cycleOrder: number, startDate: string, endDate: string): ScheduleCycleRef {
  return { trainingBlockId: block, blockOrder, trainingCycleId: `${block}-c${cycleOrder}`, cycleOrder, startDate, endDate };
}

// Block 1: two weekly cycles; a one-week gap; Block 2: one cycle.
const B1C0 = cycle("b1", 0, 0, "2026-10-05", "2026-10-11");
const B1C1 = cycle("b1", 0, 1, "2026-10-12", "2026-10-18");
const B2C0 = cycle("b2", 1, 0, "2026-10-26", "2026-11-01");
const PLAN = [B1C0, B1C1, B2C0];

describe("resolveScheduleDateContext", () => {
  const instant = new Date("2026-10-06T22:30:00Z"); // Prague 00:30 on 10-07; New York 18:30 on 10-06

  it("an explicit zone is authoritative: the same instant is a different day in Prague and New York", () => {
    expect(resolveScheduleDateContext({ trainingTimeZone: "Europe/Prague" }, instant)).toEqual({ localDate: "2026-10-07", source: "ATHLETE_TIME_ZONE", trainingTimeZone: "Europe/Prague" });
    expect(resolveScheduleDateContext({ trainingTimeZone: "America/New_York" }, new Date("2026-10-07T02:00:00Z"))).toEqual({ localDate: "2026-10-06", source: "ATHLETE_TIME_ZONE", trainingTimeZone: "America/New_York" });
  });

  it("NULL zone -> LEGACY_UTC_FALLBACK, explicitly labelled, using the UTC calendar date", () => {
    expect(resolveScheduleDateContext({ trainingTimeZone: null }, instant)).toEqual({ localDate: "2026-10-06", source: "LEGACY_UTC_FALLBACK", trainingTimeZone: null });
    expect(legacyUtcCalendarDate(instant)).toBe("2026-10-06");
  });

  it("an unusable stored zone (an offset) is treated as missing, never as an offset", () => {
    expect(resolveScheduleDateContext({ trainingTimeZone: "+02:00" }, instant).source).toBe("LEGACY_UTC_FALLBACK");
  });

  it("DST: Prague local midnight is 22:00Z in summer and 23:00Z in winter", () => {
    const prague = { trainingTimeZone: "Europe/Prague" };
    expect(resolveScheduleDateContext(prague, new Date("2026-03-28T22:59:00Z")).localDate).toBe("2026-03-28"); // CET, 23:59
    expect(resolveScheduleDateContext(prague, new Date("2026-03-29T22:00:00Z")).localDate).toBe("2026-03-30"); // CEST, 00:00
    expect(resolveScheduleDateContext(prague, new Date("2026-10-24T21:59:00Z")).localDate).toBe("2026-10-24"); // CEST, 23:59
    expect(resolveScheduleDateContext(prague, new Date("2026-10-25T22:59:00Z")).localDate).toBe("2026-10-25"); // CET after fall-back, 23:59
    expect(resolveScheduleDateContext(prague, new Date("2026-10-25T23:00:00Z")).localDate).toBe("2026-10-26");
  });

  it("adaptation accepts only ATHLETE_TIME_ZONE, never the legacy fallback", () => {
    expect(requireAthleteTimeZoneDate(resolveScheduleDateContext({ trainingTimeZone: null }, instant))).toBeNull();
    expect(requireAthleteTimeZoneDate(resolveScheduleDateContext({ trainingTimeZone: "Europe/Prague" }, instant))?.localDate).toBe("2026-10-07");
  });
});

describe("classifyScheduleCalendar", () => {
  it("1: a date inside one cycle -> IN_CURRENT_BLOCK with exactly that cycle (inclusive bounds)", () => {
    expect(classifyScheduleCalendar(PLAN, "2026-10-07")).toEqual({ kind: "IN_CURRENT_BLOCK", currentBlockId: "b1", currentCycle: B1C0 });
    expect(classifyScheduleCalendar(PLAN, "2026-10-11")).toMatchObject({ kind: "IN_CURRENT_BLOCK", currentCycle: B1C0 });
    expect(classifyScheduleCalendar(PLAN, "2026-10-12")).toMatchObject({ kind: "IN_CURRENT_BLOCK", currentCycle: B1C1 });
    expect(classifyScheduleCalendar(PLAN, "2026-10-26")).toMatchObject({ kind: "IN_CURRENT_BLOCK", currentBlockId: "b2" });
  });

  it("2: the same instant in two zones lands in two different cycles", () => {
    const instant = new Date("2026-10-11T23:30:00Z");
    const prague = resolveScheduleDateContext({ trainingTimeZone: "Europe/Prague" }, instant).localDate;
    const newYork = resolveScheduleDateContext({ trainingTimeZone: "America/New_York" }, instant).localDate;
    expect(classifyScheduleCalendar(PLAN, prague)).toMatchObject({ currentCycle: B1C1 });
    expect(classifyScheduleCalendar(PLAN, newYork)).toMatchObject({ currentCycle: B1C0 });
  });

  it("3: before the first cycle -> BEFORE_PLAN (presentation: the first cycle, never 'current')", () => {
    expect(classifyScheduleCalendar(PLAN, "2026-10-01")).toEqual({ kind: "BEFORE_PLAN", presentationCycle: B1C0 });
  });

  it("4: after the final cycle -> AFTER_PLAN (presentation: the last cycle overall, not the first block's)", () => {
    expect(classifyScheduleCalendar(PLAN, "2026-11-02")).toEqual({ kind: "AFTER_PLAN", presentationCycle: B2C0 });
  });

  it("5: between blocks -> GAP with previous/next; a gap inside one block is a GAP too", () => {
    expect(classifyScheduleCalendar(PLAN, "2026-10-20")).toEqual({ kind: "GAP", previousCycle: B1C1, nextCycle: B2C0, presentationCycle: B2C0 });
    const withInnerGap = [B1C0, cycle("b1", 0, 1, "2026-10-14", "2026-10-20")];
    expect(classifyScheduleCalendar(withInnerGap, "2026-10-12")).toMatchObject({ kind: "GAP", previousCycle: B1C0 });
  });

  it("6: overlapping cycles of one block -> AMBIGUOUS OVERLAPPING_CYCLES", () => {
    expect(classifyScheduleCalendar([B1C0, cycle("b1", 0, 1, "2026-10-07", "2026-10-13")], "2026-10-08")).toEqual({ kind: "AMBIGUOUS", reason: "OVERLAPPING_CYCLES" });
  });

  it("7: overlapping blocks -> AMBIGUOUS OVERLAPPING_BLOCKS", () => {
    expect(classifyScheduleCalendar([B1C0, cycle("b9", 5, 0, "2026-10-09", "2026-10-15")], "2026-10-10")).toEqual({ kind: "AMBIGUOUS", reason: "OVERLAPPING_BLOCKS" });
  });

  it("8: a nearby cycle is only ever exposed as presentationCycle outside IN_CURRENT_BLOCK", () => {
    for (const date of ["2026-10-01", "2026-10-20", "2026-11-05"]) {
      const state = classifyScheduleCalendar(PLAN, date);
      expect(state).not.toHaveProperty("currentCycle");
      expect(state).toHaveProperty("presentationCycle");
    }
  });

  it("10: shuffled row order never changes the classification", () => {
    const shuffles = [[B2C0, B1C1, B1C0], [B1C1, B2C0, B1C0], [B1C0, B2C0, B1C1]];
    for (const date of ["2026-10-01", "2026-10-07", "2026-10-15", "2026-10-20", "2026-11-05"]) {
      const expected = classifyScheduleCalendar(PLAN, date);
      for (const rows of shuffles) expect(classifyScheduleCalendar(rows, date)).toEqual(expected);
    }
  });

  it("no cycles -> NO_SCHEDULE", () => {
    expect(classifyScheduleCalendar([], "2026-10-07")).toEqual({ kind: "NO_SCHEDULE" });
  });
});
