import { normalizeTrainingTimeZone, resolveAthleteLocalDate, type AthleteLocalDate, type TrainingTimeZone } from "./training-time-zone.js";

/**
 * Schedule Calendar Authority V1 — the ONE place an athlete's schedule
 * date ("today") is decided (docs/domain/SCHEDULE-CALENDAR-AUTHORITY-V1.md).
 *
 * ATHLETE LOCAL CALENDAR TIME IS AUTHORITATIVE: an instant (UTC storage /
 * instant context) + the athlete's explicit training time zone -> a local
 * calendar date. The server's UTC calendar date is NOT a training day.
 *
 * LEGACY_UTC_FALLBACK is temporary compatibility behavior for ORDINARY
 * Today/Plan reads only, while `trainingTimeZone` is still NULL for
 * existing athletes. It is visible in the returned `source` — never hidden
 * inside `resolveAthleteLocalDate()` — and adaptation logic must never
 * accept it (see `requireAthleteTimeZoneDate`).
 */
export type ScheduleDateSource = "ATHLETE_TIME_ZONE" | "LEGACY_UTC_FALLBACK";

export interface ScheduleDateContext {
  readonly localDate: AthleteLocalDate;
  readonly source: ScheduleDateSource;
  /** The canonical zone when `source` is ATHLETE_TIME_ZONE; `null` under the legacy fallback. */
  readonly trainingTimeZone: TrainingTimeZone | null;
}

/**
 * TEMPORARY (Schedule Calendar Authority V1): the pre-time-zone behavior
 * — the server's UTC calendar date. Isolated and named so it can be found
 * and deleted once every athlete has an explicit training time zone.
 */
export function legacyUtcCalendarDate(instant: Date): AthleteLocalDate {
  return instant.toISOString().slice(0, 10);
}

/**
 * For ORDINARY schedule reads (Today / Plan / Workout Preview display).
 * A stored value that is not a usable IANA zone counts as missing. Never
 * writes anything back to the profile.
 */
export function resolveScheduleDateContext(profile: { readonly trainingTimeZone: string | null }, instant: Date): ScheduleDateContext {
  const trainingTimeZone = normalizeTrainingTimeZone(profile.trainingTimeZone);
  if (trainingTimeZone === null) return { localDate: legacyUtcCalendarDate(instant), source: "LEGACY_UTC_FALLBACK", trainingTimeZone: null };
  return { localDate: resolveAthleteLocalDate(instant, trainingTimeZone), source: "ATHLETE_TIME_ZONE", trainingTimeZone };
}

/** An athlete-time-zone date context — the only kind adaptation logic may use. */
export type AthleteTimeZoneDateContext = ScheduleDateContext & { readonly source: "ATHLETE_TIME_ZONE"; readonly trainingTimeZone: TrainingTimeZone };

/** For calendar-aware ADAPTATION: `null` unless the date came from the athlete's explicit time zone. ADAPTATION NEVER USES THE LEGACY FALLBACK. */
export function requireAthleteTimeZoneDate(context: ScheduleDateContext): AthleteTimeZoneDateContext | null {
  if (context.source !== "ATHLETE_TIME_ZONE" || context.trainingTimeZone === null) return null;
  return { ...context, source: "ATHLETE_TIME_ZONE", trainingTimeZone: context.trainingTimeZone };
}
