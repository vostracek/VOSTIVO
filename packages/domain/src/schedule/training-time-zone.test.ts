import { describe, expect, it } from "vitest";
import { normalizeTrainingTimeZone, resolveAthleteLocalDate } from "./training-time-zone.js";

describe("normalizeTrainingTimeZone", () => {
  it.each([
    ["Europe/Prague", "Europe/Prague"],
    ["europe/prague", "Europe/Prague"],
    ["America/New_York", "America/New_York"],
    ["Asia/Tokyo", "Asia/Tokyo"],
    ["UTC", "UTC"],
  ])("accepts the IANA zone %j and stores its canonical id", (value, canonical) => {
    expect(normalizeTrainingTimeZone(value)).toBe(canonical);
  });

  it.each(["+02:00", "-05:00", "UTC+2", "GMT+2", "", " Europe/Prague", "Garbage/Zone", "Z", null, undefined, 42])("rejects %j (offsets, empty, garbage, non-strings)", (value) => {
    expect(normalizeTrainingTimeZone(value)).toBeNull();
  });
});

describe("resolveAthleteLocalDate", () => {
  it("Europe/Prague: the athlete's calendar day, not the UTC day", () => {
    expect(resolveAthleteLocalDate(new Date("2026-10-06T22:30:00Z"), "Europe/Prague")).toBe("2026-10-07");
    expect(new Date("2026-10-06T22:30:00Z").toISOString().slice(0, 10)).toBe("2026-10-06"); // what UTC-date code would have said
  });

  it("America/New_York gives a different local date for the same instant", () => {
    const instant = new Date("2026-10-07T03:00:00Z");
    expect(resolveAthleteLocalDate(instant, "Europe/Prague")).toBe("2026-10-07");
    expect(resolveAthleteLocalDate(instant, "America/New_York")).toBe("2026-10-06");
  });

  it("Asia/Tokyo day boundary", () => {
    expect(resolveAthleteLocalDate(new Date("2026-10-06T14:59:59Z"), "Asia/Tokyo")).toBe("2026-10-06");
    expect(resolveAthleteLocalDate(new Date("2026-10-06T15:00:00Z"), "Asia/Tokyo")).toBe("2026-10-07");
  });

  it("follows DST — never a fixed numeric offset (Prague is +01:00 in winter, +02:00 in summer)", () => {
    expect(resolveAthleteLocalDate(new Date("2026-01-15T22:30:00Z"), "Europe/Prague")).toBe("2026-01-15"); // 23:30 CET
    expect(resolveAthleteLocalDate(new Date("2026-07-15T22:30:00Z"), "Europe/Prague")).toBe("2026-07-16"); // 00:30 CEST
    // DST starts 2026-03-29 01:00Z: the same 22:30Z wall-clock maps across the change correctly.
    expect(resolveAthleteLocalDate(new Date("2026-03-28T22:30:00Z"), "Europe/Prague")).toBe("2026-03-28");
    expect(resolveAthleteLocalDate(new Date("2026-03-29T22:30:00Z"), "Europe/Prague")).toBe("2026-03-30");
  });
});
