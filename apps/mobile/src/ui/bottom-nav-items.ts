/**
 * Bottom-nav destinations, kept free of React Native so the routing table
 * is unit-tested. `target: null` = visible but not available yet (Profile).
 */
export type NavTarget = "today" | "plan" | "progress";

export interface NavItem {
  readonly label: string;
  readonly target: NavTarget | null;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { label: "Today", target: "today" },
  { label: "Plan", target: "plan" },
  { label: "Progress", target: "progress" },
  { label: "Profile", target: null },
];

export const ROUTE_BY_TARGET: Record<NavTarget, "/" | "/plan" | "/progress"> = {
  today: "/",
  plan: "/plan",
  progress: "/progress",
};
