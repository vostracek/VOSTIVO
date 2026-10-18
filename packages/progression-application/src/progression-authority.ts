import type { ExperienceMode } from "@vostivo/domain";

/**
 * Progression Application V1 — Slice D (task §3/§0). The ONE pure,
 * framework-neutral authority policy — no database logic, no
 * `LoadingCapability` logic, no subscription/entitlement branch, no
 * `COACHED` branch (task §0/§49 — `COACHED` is not, and will never be, a
 * persisted `ExperienceMode`; a future `CoachingRelationship` is an
 * *overlay* on top of this base policy, not a fourth mode here — task
 * §30's documented extension seam).
 *
 * Mapping (task §0/§3, locked):
 *
 * - `GUIDED` -> `SYSTEM_AUTO_APPLY` (routine valid `INCREASE_LOAD`
 *   progression is system-controlled, applied automatically when
 *   mechanically resolvable)
 * - `ADAPTIVE` -> `ATHLETE_REVIEW`
 * - `EXPERT` -> `ATHLETE_REVIEW` (task §0/§38: identical mechanical
 *   authority to `ADAPTIVE` in V1 — the difference is future UI/control
 *   depth, never a separate progression write path; do not add an
 *   `EXPERT`-specific branch here)
 */
export type ProgressionAuthority = "SYSTEM_AUTO_APPLY" | "ATHLETE_REVIEW";

export interface ResolveProgressionAuthorityInput {
  readonly experienceMode: ExperienceMode;
}

export function resolveProgressionAuthority(input: ResolveProgressionAuthorityInput): ProgressionAuthority {
  return input.experienceMode === "GUIDED" ? "SYSTEM_AUTO_APPLY" : "ATHLETE_REVIEW";
}
