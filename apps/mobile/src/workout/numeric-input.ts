/**
 * Pure parsing/validation for the Active Workout Load/Reps text fields
 * (manual UX triage: "numeric inputs are not normally editable"). Kept
 * separate from `SetRow` so the coercion rules are unit-testable without
 * rendering a `TextInput` — the component only ever holds the raw string
 * the athlete is typing; canonical `PerformedSet` reality is never derived
 * until `Complete` is pressed (spec section 33's "commit at the boundary,
 * not per keystroke", now with explicit shared logic instead of ad hoc
 * `Number.parseInt`/`parseFloat` calls duplicated at each call site).
 *
 * Both parsers treat an empty (or whitespace-only) string as a valid
 * *intermediate* editing state — not an error — returning `null` rather
 * than throwing or coercing to `0`. A field showing `null` is simply not
 * yet ready to commit; the UI reads that as "Complete disabled", never as
 * "reset the field".
 */

const INTEGER_PATTERN = /^\d+$/;
/** One decimal separator, `.` or `,` — a Czech-locale `decimal-pad` offers the comma. */
const DECIMAL_PATTERN = /^\d+([.,]\d+)?$/;

/** Reps: integer-only when non-empty. `"8.5"` is rejected outright, never silently truncated to `8`. */
export function parseRepsInput(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (!INTEGER_PATTERN.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Load: decimal entry allowed (e.g. `"42.5"` or `"42,5"`); `0` is a valid load (e.g. bodyweight-adjacent). */
export function parseLoadInput(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (!DECIMAL_PATTERN.test(trimmed)) return null;
  const parsed = Number.parseFloat(trimmed.replace(",", "."));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** The one place a validated load number becomes the canonical fixed-precision integer (LOAD-INV-002). */
export function loadToAmountMilli(load: number): number {
  return Math.round(load * 1000);
}
