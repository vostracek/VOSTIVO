import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, spacing, touchTarget, typography } from "../design/tokens";
import { NAV_ITEMS, ROUTE_BY_TARGET, type NavTarget } from "./bottom-nav-items";

/**
 * Persistent bottom navigation (Today V1 Foundation task §2) — Today,
 * Plan and Progress (Progress & Feedback V1 Slice B) navigate for real;
 * Profile remains visible but explicitly non-interactive (it still has no
 * screen behind it). `router.replace`, not `push`:
 * there is no `Tabs` navigator here, only a `Stack` (`app/_layout.tsx`),
 * so switching tabs must not grow the stack — repeatedly bouncing
 * Today<->Plan must not leave a deepening back-stack behind it.
 */
export function BottomNav({ active }: { active: NavTarget }): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  return (
    <View style={[styles.container, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
      {NAV_ITEMS.map((item) => {
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
