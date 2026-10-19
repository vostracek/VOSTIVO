/**
 * Opaque keyset cursor for the Progress history reads: the last row's
 * `(completed_at, id)` pair. `completedAt` is Postgres' own text rendering
 * of the `timestamptz` (microsecond precision) — a JS `Date` would truncate
 * to milliseconds and skip or repeat rows that share a millisecond.
 *
 * NOT an authorization token: every page is still scoped to the
 * authenticated actor. A cursor naming another athlete's row only moves the
 * keyset boundary inside the caller's own history.
 */
export interface ProgressCursor {
  readonly completedAt: string;
  readonly id: string;
}

const TIMESTAMPTZ_TEXT = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeProgressCursor(cursor: ProgressCursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.completedAt, i: cursor.id }), "utf8").toString("base64url");
}

/** `undefined` for anything that is not a cursor this API issued (malformed, tampered shape) — the caller answers 400. */
export function decodeProgressCursor(raw: string): ProgressCursor | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("t" in parsed) || !("i" in parsed)) return undefined;
  const { t, i } = parsed;
  if (typeof t !== "string" || typeof i !== "string") return undefined;
  if (!TIMESTAMPTZ_TEXT.test(t) || !isRealDateTime(t) || !UUID.test(i)) return undefined;
  return { completedAt: t, id: i };
}

/** Rejects shape-valid but impossible values (Feb 31, hour 25) that Postgres would refuse to cast. */
function isRealDateTime(text: string): boolean {
  const [year, month, day, hour, minute, second] = [text.slice(0, 4), text.slice(5, 7), text.slice(8, 10), text.slice(11, 13), text.slice(14, 16), text.slice(17, 19)].map(Number) as [number, number, number, number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day && hour < 24 && minute < 60 && second < 60;
}
