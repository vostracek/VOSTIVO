/**
 * Progression Application V1 — Slice F (task §7/§41) — the exact
 * decimal-string -> milli-integer parser for athlete-entered CANONICAL
 * load configuration (Loading Capability setup). LOAD-INV-002's
 * fixed-precision-integer boundary must never be crossed by floating-point
 * arithmetic on the way in: `Number.parseFloat(text) * 1000` can produce a
 * value like `2500.0000000000005` for perfectly ordinary decimal input,
 * and "hope `Math.round` fixes it" is explicitly not an acceptable
 * correctness boundary for authoritative equipment truth (unlike Active
 * Workout's own `numeric-input.ts`, which logs a PERFORMED value, not a
 * persisted equipment configuration, and is intentionally left unchanged).
 *
 * Works entirely on the input string — split at the decimal point, pad
 * the fractional part to exactly 3 digits, parse the concatenated digits
 * as a plain integer. No floating-point multiplication ever occurs.
 *
 * Accepts up to 3 fractional digits (milli precision, LOAD-INV-002) —
 * `"2.5555"` is rejected outright, never silently truncated or rounded.
 * Requires at least one leading digit (`".5"` is rejected, `"0.5"` is
 * accepted) and no sign — this parser is for a positive weight-step/load
 * value; callers needing an upper bound (e.g. "> 0") apply that
 * separately, since "zero" is a syntactically valid decimal.
 */
const EXACT_DECIMAL_PATTERN = /^\d+(\.\d{1,3})?$/;

export function parseExactDecimalToMilli(text: string): number | null {
  const trimmed = text.trim();
  if (!EXACT_DECIMAL_PATTERN.test(trimmed)) return null;

  const [wholePart, fractionPart = ""] = trimmed.split(".");
  const milli = Number.parseInt(wholePart! + fractionPart.padEnd(3, "0"), 10);
  return Number.isSafeInteger(milli) ? milli : null;
}
