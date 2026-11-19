import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NAV_ITEMS, ROUTE_BY_TARGET, navItemAccessibility } from "./bottom-nav-items";

const appFile = (route: string): string => readFileSync(new URL(`../../app/${route}`, import.meta.url), "utf8");

describe("bottom navigation", () => {
  it("Progress and Profile (V1) are real destinations backed by their routes", () => {
    expect(NAV_ITEMS.map((item) => [item.label, item.target])).toEqual([
      ["Today", "today"],
      ["Plan", "plan"],
      ["Progress", "progress"],
      ["Profile", "profile"],
    ]);
    expect(ROUTE_BY_TARGET.progress).toBe("/progress");
    expect(ROUTE_BY_TARGET.profile).toBe("/profile");
    // The route files exist (readFileSync throws otherwise) and are real screens.
    expect(appFile("progress/index.tsx")).toContain("export default function ProgressScreen");
    expect(appFile("profile/index.tsx")).toContain("export default function ProfileScreen");
  });

  it("the Progress screen renders the bottom nav with Progress active; drill-downs follow the detail convention (no bottom nav)", () => {
    expect(appFile("progress/index.tsx")).toContain('<BottomNav active="progress" />');
    for (const route of ["progress/workouts/index.tsx", "progress/workouts/[workoutSessionId].tsx", "progress/exercises/[exerciseRef].tsx"]) {
      const source = appFile(route);
      expect(source).not.toContain("BottomNav");
      expect(source).toContain("<BackHeader />");
    }
  });

  describe("accessibility (ANDROID-STAB-03 D4)", () => {
    const placeholder = { label: "Later", target: null, icon: "profile" } as const;
    const today = NAV_ITEMS.find((item) => item.label === "Today")!;
    const profile = NAV_ITEMS.find((item) => item.label === "Profile")!;

    it("NAV-A11Y-001: an unavailable item is one focusable element announced as unavailable, never as a working tab/button", () => {
      expect(navItemAccessibility(placeholder, false)).toEqual({
        accessible: true,
        accessibilityRole: undefined,
        accessibilityLabel: "Later, not available yet",
        accessibilityState: { disabled: true, selected: false },
      });
      // Even if it were somehow "active", it never claims to be selected.
      expect(navItemAccessibility(placeholder, true).accessibilityState.selected).toBe(false);
    });

    it("NAV-A11Y-004: Profile V1 is now a real button destination", () => {
      expect(navItemAccessibility(profile, false)).toMatchObject({ accessibilityRole: "button", accessibilityLabel: "Profile", accessibilityState: { disabled: false } });
    });

    it("NAV-A11Y-002: real destinations stay buttons with their plain label and selected state", () => {
      expect(navItemAccessibility(today, true)).toEqual({
        accessible: true,
        accessibilityRole: "button",
        accessibilityLabel: "Today",
        accessibilityState: { disabled: false, selected: true },
      });
      expect(navItemAccessibility(today, false).accessibilityState.selected).toBe(false);
    });

    it("NAV-A11Y-003: BottomNav applies these semantics to an unavailable item (no Pressable, no onPress)", () => {
      const source = readFileSync(new URL("./bottom-nav.tsx", import.meta.url), "utf8");
      expect(source).toContain("navItemAccessibility(item, isActive)");
      expect(source).toMatch(/<View key=\{item\.label\} style=\{styles\.item\} \{\.\.\.a11y\}>/);
    });
  });
});
