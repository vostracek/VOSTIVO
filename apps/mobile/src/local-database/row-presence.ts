/**
 * expo-sqlite's `drizzle-orm` adapter returns `null`, not `undefined`, for
 * "no row matched" on `db.get()`. A check written as `row !== undefined`
 * silently passes `null` through as "present" — this is exactly what let
 * every local migration, including the original Foundation Bootstrap one,
 * go silently unapplied on real devices (see
 * docs/architecture/WORKOUT-DATA-INTEGRITY.md). This is the one place
 * that distinction is made, so every adapter (the migration runner, the
 * workout repository) shares one tested definition of "row present" —
 * framework-free, so it can be imported and tested directly under Vitest
 * without pulling in `expo-sqlite`.
 */
export function isRowPresent<T>(row: T | null | undefined): row is T {
  return row !== null && row !== undefined;
}
