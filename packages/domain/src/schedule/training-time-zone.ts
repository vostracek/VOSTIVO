/**
 * Missed Workout / Schedule Adaptation V1 — Slice B: the athlete's TRAINING
 * TIME ZONE is explicit scheduling context (docs/domain/
 * MISSED-WORKOUT-ADAPTATION-V1.md §9). It is an IANA zone id — never a
 * locale, a fixed UTC offset, an IP-derived guess or the server's zone —
 * and there is NO silent UTC fallback anywhere it is required.
 *
 * Validation uses the runtime's own IANA database (`Intl`), not a
 * hand-written whitelist. `Intl` additionally accepts bare UTC offsets
 * ("+02:00"), which are explicitly rejected: an offset cannot follow DST.
 */
export type TrainingTimeZone = string;

/** An ISO-8601 calendar date (`YYYY-MM-DD`) in the athlete's training time zone. */
export type AthleteLocalDate = string;

/** The canonical IANA id for `value` (e.g. "europe/prague" -> "Europe/Prague"), or `null` when it is not a valid IANA zone. */
export function normalizeTrainingTimeZone(value: unknown): TrainingTimeZone | null {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) return null;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  if (resolved.startsWith("+") || resolved.startsWith("-")) return null;
  return resolved;
}

/**
 * The calendar date of `instant` in `timeZone` — the one canonical
 * athlete-local-date resolver. Pure: the instant is passed in (callers own
 * the clock), the zone's real rules (DST included) come from `Intl`.
 */
export function resolveAthleteLocalDate(instant: Date, timeZone: TrainingTimeZone): AthleteLocalDate {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const part = (type: "year" | "month" | "day") => {
    const found = parts.find((p) => p.type === type)?.value;
    if (found === undefined) throw new Error(`Cannot resolve ${type} for time zone ${timeZone}`);
    return found;
  };
  return `${part("year")}-${part("month")}-${part("day")}`;
}
