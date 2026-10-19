import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Scope guard for the Progress screens' source: omitted modules have no
 * placeholder, history never offers Start/editing, and no fabricated
 * analytics (streak, e1RM, tonnage, readiness, chart) slipped in.
 */
const APP_ROUTES = ["index.tsx", "workouts/index.tsx", "workouts/[workoutSessionId].tsx", "exercises/[exerciseRef].tsx"];
const SRC_FILES = ["progress-presentation.ts", "progress-ui.tsx", "load-more-footer.tsx", "progress-history.ts", "progress-read-controller.ts", "paged-history-controller.ts", "progress-api-client.ts", "progress-routes.ts"];
const appFile = (route: string): string => readFileSync(new URL(`../../app/progress/${route}`, import.meta.url), "utf8");

function sources(): { file: string; text: string }[] {
  return [
    ...APP_ROUTES.map((route) => ({ file: `app/progress/${route}`, text: appFile(route) })),
    ...SRC_FILES.map((file) => ({ file: `src/progress/${file}`, text: readFileSync(new URL(`./${file}`, import.meta.url), "utf8") })),
  ];
}

describe("Progress scope", () => {
  it.each([
    ["Athlete Memory placeholder", /Athlete Memory/],
    ["Needs Attention placeholder", /Needs Attention/],
    ["streaks", /streak/i],
    ["e1RM", /1RM/i],
    ["tonnage", /tonnage/i],
    ["readiness", /readiness/i],
    ["a chart library or chart component", /victory|react-native-svg|<Chart|Sparkline/i],
  ])("no %s in Progress screens", (_label, pattern) => {
    const offenders = sources().filter(({ text }) => pattern.test(text.replace(/\/\*\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("history drill-downs offer no Start Workout or editing", () => {
    for (const route of ["workouts/[workoutSessionId].tsx", "exercises/[exerciseRef].tsx", "workouts/index.tsx"]) {
      const text = appFile(route);
      expect(text).not.toMatch(/startWorkout|Start Workout|TextInput|reopen/i);
    }
  });
});
