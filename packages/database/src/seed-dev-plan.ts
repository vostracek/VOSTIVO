import { eq, inArray } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { uuidv7 } from "uuidv7";
import { createLogger } from "@vostivo/observability";
import { loadDatabaseConfig } from "./config.js";
import { assertDevToolingTarget } from "./data-environment.js";
import * as schema from "./schema/index.js";

/**
 * Deterministic development fixture for the Plan & Workout Prescription
 * vertical slice (spec section 14) — NOT production demo-data
 * architecture. Onboarding and real program generation do not exist yet;
 * this exists purely so the Plan slice can be exercised end to end
 * (native verification, manual testing). Never imported by production UI
 * or application code — run standalone via `pnpm db:seed:dev-plan`.
 *
 * Idempotent: re-running wipes and recreates this exact fixture for the
 * given athlete, rather than accumulating duplicates.
 *
 * Requires an existing `athlete_profiles` row (created via a real
 * authenticated `GET /api/v1/me` call, which resolves/creates identity) —
 * pass its id as `ATHLETE_PROFILE_ID`.
 *
 * Fixture shape: one Upper/Lower hypertrophy program, one active version,
 * one 6-cycle block, with the *current* cycle (the one containing today)
 * populated with 4 realistic workout days (Upper A / Lower A / Upper B /
 * Lower B) — other cycles are left structurally present (for "Week X of
 * Y") but without planned workouts, keeping the fixture small.
 *
 * Local Manual E2E Runtime Unblock Slice (task section 15) — optionally
 * also sets the athlete's `experienceMode` via `EXPERIENCE_MODE`
 * (GUIDED/ADAPTIVE/EXPERT). No product service exists to change this
 * after identity-resolution creates it (it is fixed at `GUIDED` there,
 * never mutated by any endpoint — see `apps/api/src/auth/
 * identity-resolution.ts`), and this task explicitly forbids adding a
 * public "change mode" API just for a manual smoke test. A plain Drizzle
 * `.update()` against the same `app.athlete_profiles` row this script
 * already owns is the smallest DEV-ONLY, reusable extension — using the
 * ordinary runtime role's plain UPDATE privilege, the same one every other
 * write in this script already relies on.
 */

const logger = createLogger({ serviceName: "database-seed-dev-plan" });

function canonicalIanaTimeZone(value: string): string {
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    throw new Error(`TRAINING_TIME_ZONE must be an IANA time zone, got "${value}"`);
  }
  if (resolved.startsWith("+") || resolved.startsWith("-")) throw new Error(`TRAINING_TIME_ZONE must be an IANA zone, not a UTC offset: "${value}"`);
  return resolved;
}

async function main(): Promise<void> {
  const athleteProfileId = process.env.ATHLETE_PROFILE_ID;
  if (athleteProfileId === undefined || athleteProfileId.length === 0) {
    throw new Error("ATHLETE_PROFILE_ID env var is required (an existing app.athlete_profiles.id)");
  }

  if (EQUIPMENT_ADAPTATION_FIXTURE && MISSED_WORKOUT_FIXTURE) {
    throw new Error("EQUIPMENT_ADAPTATION_FIXTURE and MISSED_WORKOUT_FIXTURE are separate human-acceptance fixtures — set only one");
  }
  if (ATHLETE_JOURNEY_FIXTURE && !EQUIPMENT_ADAPTATION_FIXTURE) {
    throw new Error("ATHLETE_JOURNEY_FIXTURE extends EQUIPMENT_ADAPTATION_FIXTURE — set both");
  }
  // The equipment fixture is authored for a GUIDED athlete unless explicitly overridden.
  const experienceMode = process.env.EXPERIENCE_MODE ?? (EQUIPMENT_ADAPTATION_FIXTURE ? "GUIDED" : undefined);
  if (experienceMode !== undefined && !schema.EXPERIENCE_MODE_VALUES.includes(experienceMode as (typeof schema.EXPERIENCE_MODE_VALUES)[number])) {
    throw new Error(`EXPERIENCE_MODE must be one of ${schema.EXPERIENCE_MODE_VALUES.join(", ")}, got "${experienceMode}"`);
  }

  // Missed Workout / Schedule Adaptation V1 Slice B: the fixture athlete's
  // training calendar is explicitly authored as Europe/Prague (override with
  // TRAINING_TIME_ZONE) — never left to a silent UTC default. Same rule as
  // `normalizeTrainingTimeZone` (@vostivo/domain): a real IANA zone, never a
  // bare UTC offset; stored as the runtime's canonical id.
  const trainingTimeZone = canonicalIanaTimeZone(process.env.TRAINING_TIME_ZONE ?? "Europe/Prague");

  const config = loadDatabaseConfig();
  // A fixture seed wipes programs — never against the dogfood database (real plans arrive via tools/dogfood import only).
  await assertDevToolingTarget(config.DATABASE_URL, "db:seed:dev-plan");
  const sql = postgres(config.DATABASE_URL);
  const db = drizzle(sql, { schema });

  logger.info("Seeding dev Plan fixture", { athleteProfileId });
  await wipeExistingPrograms(db, athleteProfileId);
  await seedProgram(db, athleteProfileId, trainingTimeZone);

  if (experienceMode !== undefined) {
    await db
      .update(schema.athleteProfiles)
      .set({ experienceMode: experienceMode as (typeof schema.EXPERIENCE_MODE_VALUES)[number] })
      .where(eq(schema.athleteProfiles.id, athleteProfileId));
    logger.info("Set athlete experienceMode", { athleteProfileId, experienceMode });
  }

  await db.update(schema.athleteProfiles).set({ trainingTimeZone }).where(eq(schema.athleteProfiles.id, athleteProfileId));
  logger.info("Set athlete trainingTimeZone", { athleteProfileId, trainingTimeZone });

  logger.info("Dev Plan fixture seeded successfully");

  await sql.end();
}

async function wipeExistingPrograms(db: DbClient, athleteProfileId: string): Promise<void> {
  const existingPrograms = await db
    .select({ id: schema.programs.id })
    .from(schema.programs)
    .where(eq(schema.programs.athleteProfileId, athleteProfileId));
  if (existingPrograms.length === 0) return;
  const programIds = existingPrograms.map((p) => p.id);

  const versions = await db
    .select({ id: schema.programVersions.id })
    .from(schema.programVersions)
    .where(inArray(schema.programVersions.programId, programIds));
  const versionIds = versions.map((v) => v.id);

  const blocks = await db
    .select({ id: schema.trainingBlocks.id })
    .from(schema.trainingBlocks)
    .where(inArray(schema.trainingBlocks.programVersionId, versionIds));
  const blockIds = blocks.map((b) => b.id);

  const cycles = await db
    .select({ id: schema.trainingCycles.id })
    .from(schema.trainingCycles)
    .where(inArray(schema.trainingCycles.trainingBlockId, blockIds));
  const cycleIds = cycles.map((c) => c.id);

  const workouts = await db
    .select({ id: schema.plannedWorkouts.id })
    .from(schema.plannedWorkouts)
    .where(inArray(schema.plannedWorkouts.trainingCycleId, cycleIds));
  const workoutIds = workouts.map((w) => w.id);

  const exercises = await db
    .select({ id: schema.plannedExercises.id })
    .from(schema.plannedExercises)
    .where(inArray(schema.plannedExercises.plannedWorkoutId, workoutIds));
  const exerciseIds = exercises.map((e) => e.id);

  // Missed Workout Slice C overlay rows reference planned workouts/blocks;
  // a dev re-seed wipes them with the plan they adapted.
  const overlayApplications = await db
    .select({ id: schema.missedWorkoutScheduleApplications.id })
    .from(schema.missedWorkoutScheduleApplications)
    .where(eq(schema.missedWorkoutScheduleApplications.athleteProfileId, athleteProfileId));
  if (overlayApplications.length > 0) {
    const applicationIds = overlayApplications.map((a) => a.id);
    await db.delete(schema.missedWorkoutScheduleAssignments).where(inArray(schema.missedWorkoutScheduleAssignments.applicationId, applicationIds));
    // Self-references (supersedes) must go before their targets.
    await db.update(schema.missedWorkoutScheduleApplications).set({ supersedesApplicationId: null }).where(inArray(schema.missedWorkoutScheduleApplications.id, applicationIds));
    await db.delete(schema.missedWorkoutScheduleApplications).where(inArray(schema.missedWorkoutScheduleApplications.id, applicationIds));
  }

  // Temporary Equipment Slice C TODAY_ONLY applications reference planned
  // workouts/blocks; a dev re-seed wipes them too (self-references first).
  const equipmentApplications = await db
    .select({ id: schema.equipmentAdaptationApplications.id })
    .from(schema.equipmentAdaptationApplications)
    .where(eq(schema.equipmentAdaptationApplications.athleteProfileId, athleteProfileId));
  if (equipmentApplications.length > 0) {
    const ids = equipmentApplications.map((a) => a.id);
    await db.update(schema.equipmentAdaptationApplications).set({ supersedesApplicationId: null }).where(inArray(schema.equipmentAdaptationApplications.id, ids));
    await db.delete(schema.equipmentAdaptationApplications).where(inArray(schema.equipmentAdaptationApplications.id, ids));
  }

  if (exerciseIds.length > 0) {
    await db.delete(schema.plannedSets).where(inArray(schema.plannedSets.plannedExerciseId, exerciseIds));
  }
  if (workoutIds.length > 0) {
    await db.delete(schema.plannedExercises).where(inArray(schema.plannedExercises.plannedWorkoutId, workoutIds));
  }
  if (cycleIds.length > 0) {
    await db.delete(schema.plannedWorkouts).where(inArray(schema.plannedWorkouts.trainingCycleId, cycleIds));
  }
  if (blockIds.length > 0) {
    await db.delete(schema.trainingCycles).where(inArray(schema.trainingCycles.trainingBlockId, blockIds));
  }
  if (versionIds.length > 0) {
    await db.delete(schema.trainingBlocks).where(inArray(schema.trainingBlocks.programVersionId, versionIds));
  }
  if (programIds.length > 0) {
    await db.delete(schema.programVersions).where(inArray(schema.programVersions.programId, programIds));
  }
  await db.delete(schema.programs).where(eq(schema.programs.athleteProfileId, athleteProfileId));
}

type DbClient = ReturnType<typeof drizzle<typeof schema>>;

const CURRENT_CYCLE_ORDER = 4;
const CYCLE_COUNT = 6;
const CYCLE_LENGTH_DAYS = 7;

async function seedProgram(db: DbClient, athleteProfileId: string, trainingTimeZone: string): Promise<void> {
  const now = new Date();
  // The current cycle's first day. Default: the UTC calendar day (unchanged
  // behavior). MISSED_WORKOUT_FIXTURE: the athlete-LOCAL day in the fixture's
  // own training time zone minus 2 — so "today" is the cycle's 3rd day and
  // the day-0 workout is genuinely missed (Schedule Calendar Authority V1).
  // EQUIPMENT_ADAPTATION_FIXTURE: the athlete-LOCAL day itself, so Upper Body
  // A (day 0) is exactly today's workout in the training time zone.
  const currentCycleStart = MISSED_WORKOUT_FIXTURE ? addDays(localCalendarDay(now, trainingTimeZone), -2) : EQUIPMENT_ADAPTATION_FIXTURE ? localCalendarDay(now, trainingTimeZone) : now;
  const workoutDates = WORKOUT_FIXTURES.map((fixture, index) => ({
    fixture,
    scheduledDate: toIsoDate(addDays(currentCycleStart, MISSED_WORKOUT_FIXTURE ? MISSED_WORKOUT_DAY_OFFSETS[index]! : fixture.dayOffset)),
  }));
  // ATHLETE_JOURNEY_FIXTURE: the same week again in the NEXT cycle, so a
  // progression applied from today's workout has a real next exposure.
  if (ATHLETE_JOURNEY_FIXTURE) {
    workoutDates.push(...WORKOUT_FIXTURES.map((fixture) => ({ fixture, scheduledDate: toIsoDate(addDays(currentCycleStart, fixture.dayOffset + CYCLE_LENGTH_DAYS)) })));
  }

  const [program] = await db
    .insert(schema.programs)
    .values({
      id: uuidv7(),
      athleteProfileId,
      name: "Upper/Lower Hypertrophy",
      status: "ACTIVE",
    })
    .returning();
  if (program === undefined) throw new Error("failed to insert program");

  const [version] = await db
    .insert(schema.programVersions)
    .values({
      id: uuidv7(),
      programId: program.id,
      versionNumber: 1,
      status: "ACTIVE",
      activatedAt: now,
    })
    .returning();
  if (version === undefined) throw new Error("failed to insert program version");

  const [block] = await db
    .insert(schema.trainingBlocks)
    .values({
      id: uuidv7(),
      programVersionId: version.id,
      name: "Hypertrophy Block 1",
      goal: "Hypertrophy — Upper/Lower",
      orderIndex: 1,
      cycleCount: CYCLE_COUNT,
      focusAreas: [
        { name: "Back", emphasis: "PRIORITY" },
        { name: "Chest", emphasis: "MAINTAIN" },
        { name: "Legs", emphasis: "MAINTAIN" },
      ],
    })
    .returning();
  if (block === undefined) throw new Error("failed to insert training block");

  for (let cycleOrder = 1; cycleOrder <= CYCLE_COUNT; cycleOrder++) {
    const { startDate, endDate } = cycleDateRange(currentCycleStart, cycleOrder);
    const [cycle] = await db
      .insert(schema.trainingCycles)
      .values({
        id: uuidv7(),
        trainingBlockId: block.id,
        orderIndex: cycleOrder,
        startDate,
        endDate,
      })
      .returning();
    if (cycle === undefined) throw new Error("failed to insert training cycle");

    // Each workout belongs to the cycle whose date range contains it (the
    // default fixture: all four in the current cycle, exactly as before).
    const cycleWorkouts = workoutDates.filter((w) => w.scheduledDate >= startDate && w.scheduledDate <= endDate);
    if (cycleWorkouts.length > 0) await seedCycleWorkouts(db, cycle.id, cycleWorkouts);
  }
}

function cycleDateRange(now: Date, cycleOrder: number): { startDate: string; endDate: string } {
  const offsetDays = (cycleOrder - CURRENT_CYCLE_ORDER) * CYCLE_LENGTH_DAYS;
  const start = addDays(now, offsetDays);
  const end = addDays(start, CYCLE_LENGTH_DAYS - 1);
  return { startDate: toIsoDate(start), endDate: toIsoDate(end) };
}

/** The calendar day of `instant` in `timeZone`, as a UTC-midnight Date (pure calendar arithmetic from here on). */
function localCalendarDay(instant: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const part = (type: "year" | "month" | "day") => parts.find((p) => p.type === type)?.value ?? "";
  return new Date(`${part("year")}-${part("month")}-${part("day")}T00:00:00.000Z`);
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

interface WorkoutFixture {
  readonly dayOffset: number;
  readonly name: string;
  readonly focus: string;
  readonly exercises: readonly {
    readonly exerciseRef: string;
    readonly displayName: string;
    readonly sets: number;
    readonly repsMin: number;
    readonly repsMax: number;
    readonly loadKg: number;
    readonly loadBasis: "TOTAL" | "PER_IMPLEMENT";
    readonly restSeconds: number;
    /**
     * Available-Time Adaptation V1 authored structure (§2/§3) — written
     * only where the tech lead authored it explicitly; omitted means the
     * row stays NULL ("not authored"), and that workout's available-time
     * preview fails closed rather than using invented values.
     */
    readonly availableTime?: {
      readonly priorityTier: "TIER_1" | "TIER_2" | "TIER_3";
      readonly minimumWorkingSets: number;
    };
  }[];
}

/**
 * `exerciseRef` here is the narrow `ExerciseIdentityV1` shim (Active
 * Workout Core Logger V1, section 8) — a deterministic, opaque per-name
 * key so "Previous performance" can match the same real-world exercise
 * across separate training cycles/weeks. This is a dev-fixture-only
 * stand-in, NOT the Exercise Taxonomy (see
 * docs/architecture/PLAN-PRESCRIPTION.md's "Deliberate deferrals") — a
 * real catalog would assign these, not a seed script guessing slugs.
 *
 * "Incline Dumbbell Press" is `PER_IMPLEMENT` (dumbbells, per Load Model
 * V1 section 27-31), not `TOTAL` — corrected here; it was misclassified
 * before this fix pass introduced native verification coverage that
 * actually needs a genuine `PER_IMPLEMENT` fixture.
 */
/**
 * Local Manual E2E Test #2 (task section 5) — when `SMALL_FIXTURE` is set,
 * "Upper Body A" (today's workout) is reduced to exactly 2 exercises
 * (Bench Press 3 working sets, Overhead Press 2) instead of the default
 * 3, so a human manually logging every set through the real Android app
 * finishes quickly. Default (unset) behavior is completely unchanged —
 * this is purely additive, dev-fixture-only, and never alters the other
 * 3 seeded workouts (Lower Body A/Upper Body B/Lower Body B) or any
 * domain/engine methodology (same exerciseRef, same RANGE target, same
 * load — only the set/exercise COUNT shrinks).
 */
const SMALL_FIXTURE = process.env.SMALL_FIXTURE === "true";

/**
 * Missed Workout / Schedule Adaptation V1 Slice D human acceptance — when
 * `MISSED_WORKOUT_FIXTURE` is set, the four workouts land on the current
 * cycle's days 0/2/4 and the NEXT cycle's day 0 (Mon / Wed / Fri / next Mon
 * when the cycle starts on a Monday), with the current cycle starting two
 * athlete-local days before today: Upper Body A is exactly ONE missed,
 * unresolved workout and Lower Body A is today. Dev-fixture-only; the
 * default (unset) fixture is unchanged.
 */
const MISSED_WORKOUT_FIXTURE = process.env.MISSED_WORKOUT_FIXTURE === "true";
const MISSED_WORKOUT_DAY_OFFSETS = [0, 2, 4, 7] as const;

/**
 * Temporary Equipment / Gym Adaptation V1 Slice D human acceptance — when
 * `EQUIPMENT_ADAPTATION_FIXTURE` is set: Upper Body A is the SMALL_FIXTURE
 * workout (Bench Press 3 x 8–12, Overhead Press 2 x 8–12 — implied, no need
 * to also set SMALL_FIXTURE) on the athlete-LOCAL today (training time zone,
 * default Europe/Prague), the athlete is GUIDED unless EXPERIENCE_MODE says
 * otherwise, and nothing is started. Declaring dumbbells + flat bench +
 * adjustable bench (no barbell / rack) then yields Bench Press -> Dumbbell
 * Bench Press and Overhead Press -> Seated Dumbbell Overhead Press, with no
 * substitute history (no prescribed substitute load). Dev-fixture-only; the
 * default (unset) fixture is unchanged.
 */
const EQUIPMENT_ADAPTATION_FIXTURE = process.env.EQUIPMENT_ADAPTATION_FIXTURE === "true";

/**
 * Full Athlete Journey E2E Audit V1 — when `ATHLETE_JOURNEY_FIXTURE` is set
 * (together with `EQUIPMENT_ADAPTATION_FIXTURE`), the four workouts are also
 * seeded in the NEXT cycle (same order, +7 days), so the same Program Slot
 * Identity has a future exposure on which an applied progression overlay is
 * visible. Dev-fixture-only; every other fixture is unchanged.
 */
const ATHLETE_JOURNEY_FIXTURE = process.env.ATHLETE_JOURNEY_FIXTURE === "true";

const UPPER_BODY_A_EXERCISES: WorkoutFixture["exercises"] = SMALL_FIXTURE || EQUIPMENT_ADAPTATION_FIXTURE
  ? [
      // Available-Time V1 manual fixture (tech-lead decision, Slice B §14):
      // Bench is the protected core (TIER_1, never below 2 working sets);
      // OHP is reducible first and may be removed entirely (TIER_2, 0).
      {
        exerciseRef: "bench-press",
        displayName: "Bench Press",
        sets: 3,
        repsMin: 8,
        repsMax: 12,
        loadKg: 60,
        loadBasis: "TOTAL",
        restSeconds: 90,
        availableTime: { priorityTier: "TIER_1", minimumWorkingSets: 2 },
      },
      {
        exerciseRef: "overhead-press",
        displayName: "Overhead Press",
        sets: 2,
        repsMin: 8,
        repsMax: 12,
        loadKg: 30,
        loadBasis: "TOTAL",
        restSeconds: 90,
        availableTime: { priorityTier: "TIER_2", minimumWorkingSets: 0 },
      },
    ]
  : [
      { exerciseRef: "bench-press", displayName: "Bench Press", sets: 4, repsMin: 8, repsMax: 12, loadKg: 60, loadBasis: "TOTAL", restSeconds: 90 },
      { exerciseRef: "overhead-press", displayName: "Overhead Press", sets: 3, repsMin: 8, repsMax: 12, loadKg: 30, loadBasis: "TOTAL", restSeconds: 90 },
      { exerciseRef: "lat-pulldown", displayName: "Lat Pulldown", sets: 3, repsMin: 10, repsMax: 15, loadKg: 50, loadBasis: "TOTAL", restSeconds: 60 },
    ];

const WORKOUT_FIXTURES: readonly WorkoutFixture[] = [
  {
    dayOffset: 0,
    name: "Upper Body A",
    focus: "Push emphasis",
    exercises: UPPER_BODY_A_EXERCISES,
  },
  {
    dayOffset: 2,
    name: "Lower Body A",
    focus: "Quad emphasis",
    exercises: [
      { exerciseRef: "back-squat", displayName: "Back Squat", sets: 4, repsMin: 8, repsMax: 12, loadKg: 80, loadBasis: "TOTAL", restSeconds: 120 },
      { exerciseRef: "romanian-deadlift", displayName: "Romanian Deadlift", sets: 3, repsMin: 8, repsMax: 12, loadKg: 70, loadBasis: "TOTAL", restSeconds: 90 },
      { exerciseRef: "leg-press", displayName: "Leg Press", sets: 3, repsMin: 10, repsMax: 15, loadKg: 120, loadBasis: "TOTAL", restSeconds: 60 },
    ],
  },
  {
    dayOffset: 4,
    name: "Upper Body B",
    focus: "Pull emphasis",
    exercises: [
      { exerciseRef: "barbell-row", displayName: "Barbell Row", sets: 4, repsMin: 8, repsMax: 12, loadKg: 55, loadBasis: "TOTAL", restSeconds: 90 },
      { exerciseRef: "incline-dumbbell-press", displayName: "Incline Dumbbell Press", sets: 3, repsMin: 8, repsMax: 12, loadKg: 24, loadBasis: "PER_IMPLEMENT", restSeconds: 90 },
      { exerciseRef: "face-pull", displayName: "Face Pull", sets: 3, repsMin: 12, repsMax: 20, loadKg: 15, loadBasis: "TOTAL", restSeconds: 45 },
    ],
  },
  {
    dayOffset: 6,
    name: "Lower Body B",
    focus: "Posterior chain emphasis",
    exercises: [
      { exerciseRef: "deadlift", displayName: "Deadlift", sets: 3, repsMin: 5, repsMax: 8, loadKg: 100, loadBasis: "TOTAL", restSeconds: 150 },
      { exerciseRef: "bulgarian-split-squat", displayName: "Bulgarian Split Squat", sets: 3, repsMin: 10, repsMax: 12, loadKg: 20, loadBasis: "PER_IMPLEMENT", restSeconds: 60 },
      { exerciseRef: "leg-curl", displayName: "Leg Curl", sets: 3, repsMin: 10, repsMax: 15, loadKg: 35, loadBasis: "TOTAL", restSeconds: 60 },
    ],
  },
];

async function seedCycleWorkouts(
  db: DbClient,
  trainingCycleId: string,
  workouts: readonly { readonly fixture: WorkoutFixture; readonly scheduledDate: string }[],
): Promise<void> {
  for (const [workoutIndex, { fixture, scheduledDate }] of workouts.entries()) {
    const [workout] = await db
      .insert(schema.plannedWorkouts)
      .values({
        id: uuidv7(),
        trainingCycleId,
        name: fixture.name,
        focus: fixture.focus,
        orderIndex: workoutIndex + 1,
        scheduledDate,
        estimatedDurationMinutes: 60,
        status: "PLANNED",
      })
      .returning();
    if (workout === undefined) throw new Error("failed to insert planned workout");

    for (const [exerciseIndex, exerciseFixture] of fixture.exercises.entries()) {
      const [exercise] = await db
        .insert(schema.plannedExercises)
        .values({
          id: uuidv7(),
          plannedWorkoutId: workout.id,
          exerciseRef: exerciseFixture.exerciseRef,
          displayName: exerciseFixture.displayName,
          orderIndex: exerciseIndex + 1,
          priorityTier: exerciseFixture.availableTime?.priorityTier ?? null,
          minimumWorkingSets: exerciseFixture.availableTime?.minimumWorkingSets ?? null,
        })
        .returning();
      if (exercise === undefined) throw new Error("failed to insert planned exercise");

      const setRows = Array.from({ length: exerciseFixture.sets }, (_, setIndex) => ({
        id: uuidv7(),
        plannedExerciseId: exercise.id,
        orderIndex: setIndex + 1,
        targetRepsMin: exerciseFixture.repsMin,
        targetRepsMax: exerciseFixture.repsMax,
        restSeconds: exerciseFixture.restSeconds,
        // Explicit, never relying on the column's migration-safety default
        // (Progression Prerequisites V1 §12 — "no fixture should silently
        // depend on null/default inference").
        setType: "WORKING" as const,
        loadKind: "EXTERNAL_WEIGHT" as const,
        loadAmountMilli: exerciseFixture.loadKg * 1000,
        loadUnit: "KG" as const,
        loadBasis: exerciseFixture.loadBasis,
      }));
      await db.insert(schema.plannedSets).values(setRows);
    }
  }
}

main().catch((error: unknown) => {
  logger.error("Dev Plan seed failed", { error: error instanceof Error ? error.message : error });
  process.exitCode = 1;
});
