import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NAV_ITEMS, ROUTE_BY_TARGET } from "./bottom-nav-items";

const appFile = (route: string): string => readFileSync(new URL(`../../app/${route}`, import.meta.url), "utf8");

describe("bottom navigation", () => {
  it("Progress is a real destination backed by the /progress route; Profile stays unavailable", () => {
    expect(NAV_ITEMS.map((item) => [item.label, item.target])).toEqual([
      ["Today", "today"],
      ["Plan", "plan"],
      ["Progress", "progress"],
      ["Profile", null],
    ]);
    expect(ROUTE_BY_TARGET.progress).toBe("/progress");
    // The route file exists (readFileSync throws otherwise) and is a real screen.
    expect(appFile("progress/index.tsx")).toContain("export default function ProgressScreen");
  });

  it("the Progress screen renders the bottom nav with Progress active; drill-downs follow the detail convention (no bottom nav)", () => {
    expect(appFile("progress/index.tsx")).toContain('<BottomNav active="progress" />');
    for (const route of ["progress/workouts/index.tsx", "progress/workouts/[workoutSessionId].tsx", "progress/exercises/[exerciseRef].tsx"]) {
      const source = appFile(route);
      expect(source).not.toContain("BottomNav");
      expect(source).toContain("<BackHeader />");
    }
  });
});
