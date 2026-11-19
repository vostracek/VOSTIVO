/**
 * Bottom-nav destinations, kept free of React Native so the routing table
 * is unit-tested. `target: null` = visible but not available yet (Profile).
 */
export type NavTarget = "today" | "plan" | "progress";

export interface NavItem {
  readonly label: string;
  readonly target: NavTarget | null;
  /** Approved nav glyph (Foundations §10 / Today Final canvas). */
  readonly icon: "today" | "plan" | "progress" | "profile";
}

export const NAV_ITEMS: readonly NavItem[] = [
  { label: "Today", target: "today", icon: "today" },
  { label: "Plan", target: "plan", icon: "plan" },
  { label: "Progress", target: "progress", icon: "progress" },
  { label: "Profile", target: null, icon: "profile" },
];

export const ROUTE_BY_TARGET: Record<NavTarget, "/" | "/plan" | "/progress"> = {
  today: "/",
  plan: "/plan",
  progress: "/progress",
};

/**
 * ANDROID-STAB-03 D4: the screen-reader semantics of one nav item, framework-free so they are unit-tested.
 * A not-yet-available item (Profile) is ONE focusable element that says so —
 * no button role (nothing would happen), `disabled` state — instead of a
 * bare text node whose label was never exposed.
 */
export interface NavItemAccessibility {
  readonly accessible: true;
  readonly accessibilityRole: "button" | undefined;
  readonly accessibilityLabel: string;
  readonly accessibilityState: { readonly disabled: boolean; readonly selected: boolean };
}

export function navItemAccessibility(item: NavItem, isActive: boolean): NavItemAccessibility {
  if (item.target === null) {
    return {
      accessible: true,
      accessibilityRole: undefined,
      accessibilityLabel: `${item.label}, not available yet`,
      accessibilityState: { disabled: true, selected: false },
    };
  }
  return {
    accessible: true,
    accessibilityRole: "button",
    accessibilityLabel: item.label,
    accessibilityState: { disabled: false, selected: isActive },
  };
}
