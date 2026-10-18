import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, spacing, touchTarget, typography } from "../design/tokens";

type NavTarget = "today" | "plan";

interface NavItem {
  readonly label: string;
  readonly target: NavTarget | null;
}

const ITEMS: readonly NavItem[] = [
  { label: "Today", target: "today" },
  { label: "Plan", target: "plan" },
  { label: "Progress", target: null },
  { label: "Profile", target: null },
];

const ROUTE_BY_TARGET: Record<NavTarget, "/" | "/plan"> = {
  today: "/",
  plan: "/plan",
};

/**
 * Persistent bottom navigation (Today V1 Foundation task §2) — Today and
 * Plan both now navigate for real; Progress/Profile remain visible but
 * explicitly non-interactive (task §2: "leave them visible-but-disabled"
 * — they still have no screen behind them). `router.replace`, not `push`:
 * there is no `Tabs` navigator here, only a `Stack` (`app/_layout.tsx`),
 * so switching tabs must not grow the stack — repeatedly bouncing
 * Today<->Plan must not leave a deepening back-stack behind it.
 */
export function BottomNav({ active }: { active: NavTarget }): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  return (
    <View style={[styles.container, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
      {ITEMS.map((item) => {
        const isActive = item.target === active;
        const enabled = item.target !== null;

        if (!enabled) {
          return (
            <View key={item.label} style={styles.item} accessibilityLabel={`${item.label} — not available yet`} accessibilityState={{ disabled: true }}>
              <Text style={[styles.label, styles.labelDisabled]}>{item.label}</Text>
            </View>
          );
        }

        const target = item.target;
        return (
          <Pressable
            key={item.label}
            style={styles.item}
            disabled={isActive}
            onPress={() => router.replace(ROUTE_BY_TARGET[target])}
            accessibilityRole="button"
            accessibilityLabel={item.label}
            accessibilityState={{ selected: isActive }}
          >
            <Text style={[styles.label, isActive && styles.labelActive]}>{item.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    paddingTop: spacing.md,
  },
  item: {
    flex: 1,
    alignItems: "center",
    minHeight: touchTarget.minHeight,
    justifyContent: "center",
  },
  label: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  labelActive: {
    color: colors.signal,
    fontWeight: "700",
  },
  labelDisabled: {
    color: colors.textTertiary,
  },
});
