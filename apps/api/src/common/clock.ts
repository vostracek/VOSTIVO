/**
 * The server's ONE injectable source of "now" (Missed Workout / Schedule
 * Adaptation V1 Slice B). Calendar-aware logic gets the current instant
 * from here and converts it to the athlete's local date with
 * `resolveAthleteLocalDate` (@vostivo/domain) — never
 * `new Date().toISOString().slice(0, 10)`. Tests inject a fixed clock, so
 * nothing depends on the wall-clock calendar date. Pure engines never read
 * a clock at all.
 */
export const CLOCK = Symbol("CLOCK");

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(instant: Date): Clock {
  return { now: () => new Date(instant.getTime()) };
}
