/**
 * V1-real set types only (Progression Prerequisites V1) — `WORKING` and
 * `WARM_UP`. `BACKOFF`/`DROP`/`AMRAP`/`FAILURE` remain deferred concepts
 * (docs/domain/load-model-v1.md §91-95) and are deliberately NOT added to
 * this production enum as placeholders — see
 * docs/domain/PROGRESSION-ENGINE-V1.md §5/§8 and its tech-lead resolution
 * (OD-3): model only currently real semantics, not reserved placeholders.
 *
 * Exactly one representation for "ordinary set" — `WORKING` — never a
 * nullable/absent value silently interpreted as `WORKING` at read time
 * (the tech-lead resolution explicitly rejects that pattern). Every
 * `PlannedSet`/`PrescribedSetV1`/`PerformedSet` carries this field,
 * required.
 */
export const SET_TYPES = ["WORKING", "WARM_UP"] as const;
export type SetType = (typeof SET_TYPES)[number];

/**
 * Runtime boundary validator (spec section 10 — "do not rely on
 * TypeScript at runtime") for every external input: sync commands
 * deserialized from JSON, DTOs, local SQLite rows read back as `string`.
 * Rejects `null`, `undefined`, wrong case, arbitrary strings, and future
 * reserved values (`BACKOFF`/`DROP`/`AMRAP`/`FAILURE`) — none of those are
 * valid V1 set types, even though the vocabulary is named the same as
 * Load Model V1's forward-looking list.
 */
export function isSetType(value: unknown): value is SetType {
  return typeof value === "string" && (SET_TYPES as readonly string[]).includes(value);
}
