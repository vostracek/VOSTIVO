import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  exerciseHistoryHeaderView,
  exposureView,
  formatDuration,
  formatLocalDay,
  formatSets,
  improvementView,
  progressInterpretation,
  shouldOfferWorkoutHistory,
  snapshotView,
  workoutDetailView,
  workoutRowView,
} from "./progress-presentation";
import { exerciseHistoryHref, isPreviewOnlySource, nextWorkoutPreviewHref, workoutDetailHref } from "./progress-routes";
import { IDS, benchImprovement, dumbbellImprovement, exercisePage, exposure, overview, set, workoutDetail, workoutItem } from "./testing/fixtures";

describe("Progress interpretation (server evidence only)", () => {
  it("an APPLIED improvement -> 'You're making progress' naming that exercise, never 'stronger'", () => {
    const view = progressInterpretation(overview());
    expect(view).toEqual({ headline: "You're making progress", supporting: "Bench Press is moving forward." });
    expect(JSON.stringify(view)).not.toMatch(/stronger/i);
  });

  it("several improvements name distinct exercises, newest first", () => {
    expect(progressInterpretation(overview({ improving: [benchImprovement(), dumbbellImprovement(), benchImprovement({ applicationId: "x" })] })).supporting).toBe("Bench Press and Dumbbell Bench Press are moving forward.");
    const many = ["A", "B", "C", "D"].map((name, i) => benchImprovement({ applicationId: `${i}`, exerciseDisplayName: name }));
    expect(progressInterpretation(overview({ improving: many })).supporting).toBe("A, B and 2 more are moving forward.");
  });

  it("no improvements -> calm 'Building your progress picture', not a failure", () => {
    expect(progressInterpretation(overview({ improving: [] }))).toEqual({
      headline: "Building your progress picture",
      supporting: "Keep training consistently and Vostivo will surface meaningful changes here.",
    });
  });
});

describe("Snapshot", () => {
  it("shows exactly the two server signals — Week X of N and N of M — never a percentage or score", () => {
    const view = snapshotView(overview().snapshot);
    expect(view).toEqual({ kind: "AVAILABLE", block: { title: "Week 4 of 6", subtitle: "Strength Base" }, consistency: "3 of 4 planned workouts completed" });
    expect(JSON.stringify(view)).not.toMatch(/%|score|streak/i);
  });

  it("null snapshot (plan misconfiguration / no current cycle) -> restrained unavailable line", () => {
    expect(snapshotView({ block: null, thisWeek: null })).toEqual({ kind: "UNAVAILABLE", message: "Current plan progress unavailable" });
  });

  it("each signal is independent; nothing due yet is said plainly", () => {
    expect(snapshotView({ block: null, thisWeek: { completed: 1, due: 1 } })).toEqual({ kind: "AVAILABLE", block: null, consistency: "1 of 1 planned workout completed" });
    expect(snapshotView({ block: { name: "B", cycleOrder: 1, cycleCount: 4 }, thisWeek: { completed: 0, due: 0 } })).toMatchObject({ kind: "AVAILABLE", consistency: "No workouts due yet this week" });
  });
});

describe("What's improving", () => {
  it("what happened + what it is based on + the next target the server returned", () => {
    expect(improvementView(benchImprovement(), "2026-10-14")).toMatchObject({
      exerciseRef: "bench-press",
      title: "Bench Press",
      change: "60kg → 62.5kg",
      evidence: "From 60kg × 12, 12, 12",
      next: "Next time · 62.5kg · Upper A, Mon",
    });
  });

  it("no next exposure from the server -> no future claim and no navigation affordance", () => {
    const view = improvementView(benchImprovement({ nextExposure: null }), "2026-10-14");
    expect(view.next).toBeNull();
    expect(view.nextWorkout).toBeNull();
    expect(view.accessibilityLabel).not.toMatch(/Next time/);
  });

  it("'View next workout' targets the EXACT server plannedWorkoutId, as a read-only preview", () => {
    const view = improvementView(benchImprovement(), "2026-10-14");
    expect(view.nextWorkout).toEqual({ plannedWorkoutId: IDS.nextUpperA, accessibilityLabel: "View next workout. Next time · 62.5kg · Upper A, Mon" });
    expect(nextWorkoutPreviewHref(view.nextWorkout!.plannedWorkoutId)).toBe(`/workout/${IDS.nextUpperA}?source=progress`);
    expect(isPreviewOnlySource("progress")).toBe(true);
    expect(isPreviewOnlySource(undefined)).toBe(false);
  });

  it("a carryover next exposure (no date) names the workout without inventing a day", () => {
    expect(improvementView(benchImprovement({ nextExposure: { plannedWorkoutId: IDS.nextUpperA, scheduledDate: null, workoutName: "Upper A" } }), "2026-10-14").next).toBe("Next time · 62.5kg · Upper A");
  });

  it("a substitute keeps its own identity and routes to its own history, never the authored exercise", () => {
    const view = improvementView(dumbbellImprovement(), "2026-10-14");
    expect(view.exerciseRef).toBe("dumbbell-bench-press");
    expect(exerciseHistoryHref(view.exerciseRef)).toBe("/progress/exercises/dumbbell-bench-press");
    expect(exerciseHistoryHref("bench-press")).not.toBe(exerciseHistoryHref(view.exerciseRef));
  });

  it("long names are passed through whole (layout wraps; nothing truncated)", () => {
    const name = "Single-Arm Half-Kneeling Landmine Press With Pause At The Bottom";
    expect(improvementView(benchImprovement({ exerciseDisplayName: name }), "2026-10-14").title).toBe(name);
  });
});

describe("Recent workouts", () => {
  it("row: name, day, working sets done/planned, Full/Partial as text, tags only from the server", () => {
    expect(workoutRowView(workoutItem())).toMatchObject({ title: "Upper A", dateLabel: "Mon 12 Oct", setsLabel: "4 of 5 working sets", completionLabel: "Partial", tags: [] });
    expect(workoutRowView(workoutItem({ adaptations: { availableTime: true, equipment: true } })).tags).toEqual(["Time adjusted", "Equipment adjusted"]);
  });

  it("a tap opens the exact session the server returned", () => {
    expect(workoutDetailHref(workoutRowView(workoutItem()).workoutSessionId)).toBe(`/progress/workouts/${IDS.upperA}`);
  });

  it("'View workout history' only when the capped preview may be truncated", () => {
    expect(shouldOfferWorkoutHistory(overview())).toBe(false);
    expect(shouldOfferWorkoutHistory(overview({ recentWorkouts: Array.from({ length: 5 }, (_, i) => workoutItem({ workoutSessionId: `${i}` })) }))).toBe(true);
  });
});

describe("Workout detail", () => {
  it("summary, completed sets, progression events from the server", () => {
    const view = workoutDetailView(workoutDetail());
    expect(view.meta).toBe("Mon 12 Oct · 1 h 5 min");
    expect(view.summary).toBe("4 of 5 working sets · Partially completed");
    expect(view.exercises[0]!.sets).toEqual(["Warm-up · 20kg × 10", "Set 2 · 60kg × 12", "Set 3 · 60kg × 12", "Set 4 · 60kg × 12"]);
    expect(view.exercises[1]!.sets).toEqual(["Set 1 · 30kg × 10"]);
    expect(view.progression).toEqual(["Next target raised · 60kg → 62.5kg"]);
    expect(view.provenance).toEqual([]);
  });

  it("no progression events / adaptations returned -> none shown", () => {
    const view = workoutDetailView(workoutDetail({ progressionEvents: [] }));
    expect(view.progression).toEqual([]);
    expect(view.provenance).toEqual([]);
  });

  it("adaptation provenance only as returned; substitute shows its authored context and routes to its own ref", () => {
    const view = workoutDetailView(
      workoutDetail({
        workout: workoutItem({ adaptations: { availableTime: true, equipment: true } }),
        availableTime: { availableMinutes: 30 },
        exercises: [{ exerciseRef: "dumbbell-bench-press", displayName: "Dumbbell Bench Press", substitution: { authoredDisplayName: "Bench Press" }, plannedWorkingSets: 1, sets: [set(1, 12, 22)] }],
      }),
    );
    expect(view.provenance).toEqual(["Time adjusted · 30 min available", "Equipment adjusted for this session"]);
    expect(view.exercises[0]).toMatchObject({ title: "Dumbbell Bench Press", exerciseRef: "dumbbell-bench-press", note: "Instead of Bench Press" });
  });

  it("an unperformed prescribed exercise is 'Not performed', not tappable, no fake sets", () => {
    const view = workoutDetailView(workoutDetail({ exercises: [{ exerciseRef: "overhead-press", displayName: "Overhead Press", substitution: null, plannedWorkingSets: 2, sets: [] }] }));
    expect(view.exercises[0]).toMatchObject({ sets: [], emptyLabel: "Not performed", exerciseRef: null });
  });
});

describe("Exercise history", () => {
  it("factual header and rows — date, workout, load × reps; no e1RM / tonnage / trend", () => {
    const header = exerciseHistoryHeaderView(exercisePage(), [exposure()]);
    expect(header).toEqual({ title: "Bench Press", interpretation: "Last performed Mon 12 Oct · 60kg × 12, 12, 12" });
    const row = exposureView(exposure());
    expect(row).toMatchObject({ dateLabel: "Mon 12 Oct", context: "Upper A", sets: "20kg × 10 · 60kg × 12, 12, 12" });
    expect(JSON.stringify([header, row])).not.toMatch(/1RM|tonnage|volume|trend|%/i);
  });

  it("a substitute exposure is labelled as such; missing optional data shows no placeholder", () => {
    expect(exposureView(exposure({ isSubstitute: true })).context).toBe("Upper A · equipment substitute");
    expect(exposureView(exposure({ sets: [] })).sets).toBe("No completed sets");
    expect(exerciseHistoryHeaderView(exercisePage(), [exposure({ sets: [set(1, 10, 20, "WARM_UP")] })]).interpretation).toBe("Last performed Mon 12 Oct");
    expect(exerciseHistoryHeaderView(exercisePage({ exposures: [] }), []).interpretation).toBeNull();
  });
});

describe("athlete-local history days (server authority, never the device zone)", () => {
  // 22:30 UTC on 18 Oct is already 19 Oct for a Prague athlete: the server says so in completedLocalDate.
  const boundary = { completedAt: "2026-10-18T22:30:00.000Z", completedLocalDate: "2026-10-19" };

  it("workout row, workout detail and exercise history all show the server's day, not a conversion of completedAt", () => {
    expect(workoutRowView(workoutItem(boundary)).dateLabel).toBe("Mon 19 Oct");
    expect(workoutDetailView(workoutDetail({ workout: workoutItem(boundary) })).meta).toBe("Mon 19 Oct · 1 h 5 min");
    expect(exposureView(exposure(boundary)).dateLabel).toBe("Mon 19 Oct");
    expect(exerciseHistoryHeaderView(exercisePage(), [exposure(boundary)]).interpretation).toMatch(/^Last performed Mon 19 Oct/);
  });

  it("formats a YYYY-MM-DD value with calendar arithmetic only — stable in any device zone (incl. month/year edges)", () => {
    expect(formatLocalDay("2026-10-19")).toBe("Mon 19 Oct");
    expect(formatLocalDay("2026-11-01")).toBe("Sun 1 Nov");
    expect(formatLocalDay("2027-01-01")).toBe("Fri 1 Jan");
  });

  it("the presentation never reads local (device-zone) date getters", () => {
    const source = readFileSync(new URL("./progress-presentation.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\.get(Day|Date|Month|FullYear|Hours)\(\)/);
    expect(source).not.toMatch(/toLocale(Date)?String/);
  });
});

describe("formatting", () => {
  it("groups consecutive equal loads; per-implement loads say 'each'", () => {
    expect(formatSets([set(1, 8, 60), set(2, 8, 60), set(3, 6, 62.5)])).toBe("60kg × 8, 8 · 62.5kg × 6");
    expect(formatSets([{ order: 1, setType: "WORKING", reps: 10, load: { kind: "EXTERNAL_WEIGHT", amountMilli: 22000, unit: "KG", basis: "PER_IMPLEMENT" } }])).toBe("22kg each × 10");
  });

  it("durations", () => {
    expect(formatDuration(2400)).toBe("40 min");
    expect(formatDuration(3600)).toBe("1 h");
    expect(formatDuration(3900)).toBe("1 h 5 min");
  });
});
