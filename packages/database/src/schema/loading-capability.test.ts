import { describe, expect, it } from "vitest";
import { getTableName } from "drizzle-orm";
import {
  LOADING_CAPABILITY_KIND_VALUES,
  exerciseLoadingCapabilityBindings,
  gymProfiles,
  loadingCapabilities,
} from "./loading-capability.js";

/**
 * Schema-shape tests only — no live Postgres connection required (same
 * precedent as plan.test.ts/progression.test.ts). The real migration is
 * generated/applied and its invariants (default-per-athlete, same-gym
 * binding, payload/kind consistency) are proven against real Postgres
 * separately — see loading-capability.integration.test.ts in
 * `@vostivo/progression-application`.
 */
describe("loading capability schema", () => {
  it("defines the Loading Capability tables in the app schema", () => {
    expect(getTableName(gymProfiles)).toBe("gym_profiles");
    expect(getTableName(loadingCapabilities)).toBe("loading_capabilities");
    expect(getTableName(exerciseLoadingCapabilityBindings)).toBe("exercise_loading_capability_bindings");
  });

  it("locks the capability kind vocabulary to exactly FIXED_INCREMENT / ENUMERATED_LIST", () => {
    expect(LOADING_CAPABILITY_KIND_VALUES).toEqual(["FIXED_INCREMENT", "ENUMERATED_LIST"]);
  });

  it("never gives loading_capabilities its own exerciseRef column — the binding table is the only place exerciseRef appears", () => {
    expect(Object.keys(loadingCapabilities)).not.toContain("exerciseRef");
    expect(Object.keys(exerciseLoadingCapabilityBindings)).toContain("exerciseRef");
  });

  it("gymProfiles has no independent name-based identity beyond athleteProfileId + isDefault", () => {
    const columns = Object.keys(gymProfiles);
    expect(columns).toContain("athleteProfileId");
    expect(columns).toContain("isDefault");
  });
});
