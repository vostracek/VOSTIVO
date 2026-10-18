import { parseExactDecimalToMilli, validateEnumeratedListLoads } from "@vostivo/domain";

/**
 * Progression Application V1 — Slice F (task §7/§9/§41) — pure,
 * framework-free input parsing for the Contextual Loading Setup screen.
 * Mobile-side validation is for usability only (task §9's own explicit
 * "Mobile may provide inline validation... Server/domain validator is
 * final authority") — this module never sorts, deduplicates, rounds,
 * inserts the current load, or invents a missing value; it only parses
 * exactly what the athlete typed and defers all ordering/uniqueness rules
 * to the SAME canonical `validateEnumeratedListLoads` the server itself
 * uses, never a second reimplementation.
 */

/** `null` for empty/malformed text or a non-positive value — a weight step of zero is syntactically parseable but never a valid increment. */
export function parseFixedIncrementInput(text: string): number | null {
  const milli = parseExactDecimalToMilli(text);
  return milli !== null && milli > 0 ? milli : null;
}

export type EnumeratedListInputResult =
  | { readonly ok: true; readonly loadsMilli: readonly number[] }
  | { readonly ok: false; readonly reason: "EMPTY" | "MALFORMED_ENTRY" | "NON_POSITIVE" | "NOT_STRICTLY_ASCENDING" };

/** Splits on whitespace/commas, in the order the athlete typed them — never re-sorted before validation, so "30, 20, 25" correctly fails as NOT_STRICTLY_ASCENDING rather than being silently fixed. */
export function parseEnumeratedListInput(text: string): EnumeratedListInputResult {
  const entries = text
    .trim()
    .split(/[\s,]+/)
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return { ok: false, reason: "EMPTY" };

  const loadsMilli: number[] = [];
  for (const entry of entries) {
    const milli = parseExactDecimalToMilli(entry);
    if (milli === null) return { ok: false, reason: "MALFORMED_ENTRY" };
    loadsMilli.push(milli);
  }

  const validated = validateEnumeratedListLoads(loadsMilli);
  if (!validated.ok) {
    if (validated.error.reason === "EMPTY") return { ok: false, reason: "EMPTY" };
    if (validated.error.reason === "NOT_STRICTLY_ASCENDING") return { ok: false, reason: "NOT_STRICTLY_ASCENDING" };
    return { ok: false, reason: "NON_POSITIVE" };
  }

  return { ok: true, loadsMilli: validated.value };
}
