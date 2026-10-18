import { createDatabaseClient, loadDatabaseConfig } from "@vostivo/database";
import {
  bindExerciseToCapability,
  createLoadingCapability,
  getOrCreateDefaultGymProfileForAthlete,
} from "@vostivo/progression-application";

/**
 * Local Manual E2E Runtime Unblock Slice (task section 18) — seeds a
 * VALID FIXED_INCREMENT loading capability bound to one exercise, so the
 * first ADAPTIVE manual smoke test reaches "Progression ready -> Review
 * Change -> Apply Change" without first hitting Guided Setup Needed
 * recovery (a deliberately separate, later manual scenario).
 *
 * Uses the real application-layer primitives
 * (`getOrCreateDefaultGymProfileForAthlete`/`createLoadingCapability`/
 * `bindExerciseToCapability` from `@vostivo/progression-application`) —
 * the exact same functions a real Profile/equipment-settings write
 * surface would call — never a raw SQL insert. Idempotent: re-running
 * creates a fresh capability revision and rebinds the exercise to it
 * (both underlying primitives are themselves idempotent/upsert-safe).
 *
 * Usage:
 *   ATHLETE_PROFILE_ID=<app.athlete_profiles.id> \
 *     EXERCISE_REF=bench-press INCREMENT_KG=2.5 \
 *     DATABASE_URL=<runtime role URL for the target database> \
 *     pnpm --filter @vostivo/api dev:seed-loading-capability
 */
async function main(): Promise<void> {
  const athleteProfileId = process.env.ATHLETE_PROFILE_ID;
  if (athleteProfileId === undefined || athleteProfileId.length === 0) {
    throw new Error("ATHLETE_PROFILE_ID env var is required (an existing app.athlete_profiles.id)");
  }
  const exerciseRef = process.env.EXERCISE_REF ?? "bench-press";
  const incrementKg = Number(process.env.INCREMENT_KG ?? "2.5");

  const config = loadDatabaseConfig();
  const db = createDatabaseClient(config.DATABASE_URL);

  const gymProfile = await getOrCreateDefaultGymProfileForAthlete(db, athleteProfileId);
  const capability = await createLoadingCapability(db, {
    kind: "FIXED_INCREMENT",
    gymProfileId: gymProfile.id,
    unit: "KG",
    basis: "TOTAL",
    incrementAmountMilli: Math.round(incrementKg * 1000),
  });
  if (capability.status !== "CREATED") {
    throw new Error(`createLoadingCapability failed: ${capability.status} (${capability.reason})`);
  }

  const bound = await bindExerciseToCapability(db, gymProfile.id, exerciseRef, capability.loadingCapabilityId);
  if (bound.status !== "BOUND") {
    throw new Error(`bindExerciseToCapability failed: ${bound.status}`);
  }

  console.error(
    `Bound exerciseRef="${exerciseRef}" to a FIXED_INCREMENT capability (+${incrementKg}kg, id=${capability.loadingCapabilityId}) ` +
      `under gymProfileId=${gymProfile.id} for athleteProfileId=${athleteProfileId}.`,
  );

  await (db as unknown as { readonly $client: { end(): Promise<void> } }).$client.end();
}

main().catch((error: unknown) => {
  console.error("Seeding manual loading capability failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
