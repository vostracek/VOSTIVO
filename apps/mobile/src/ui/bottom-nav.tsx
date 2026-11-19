import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { semantic, type } from "../design/tokens";
import { Icon } from "./icon";
import { NAV_ITEMS, ROUTE_BY_TARGET, navItemAccessibility, type NavTarget } from "./bottom-nav-items";

/**
 * Persistent bottom navigation — Foundations V1 §10 / Today Final canvas:
 * #0D1012 chrome with a .065 top hairline, 21px line icons at 1.7 stroke,
 * active stated only by weight and full-strength colour (#F4F6F5, 600) —
 * never by a pill, underline or lime fill. The home-indicator strip keeps
 * the chrome colour. A destination without a screen yet stays visible but
 * non-interactive. `router.replace`, not `push`: there is no `Tabs`
 * navigator, only a `Stack`, so switching tabs must not grow the stack.
 */
export function BottomNav({ active }: { active: NavTarget }): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  return (
    <View style={[styles.container, { paddingBottom: Math.max(insets.bottom, 7) }]}>
      {NAV_ITEMS.map((item) => {
        const isActive = item.target === active;
        const a11y = navItemAccessibility(item, isActive);
        const tint = isActive ? semantic.navActive : semantic.navInactive;
        const content = (
          <>
            <Icon name={item.icon} size={21} strokeWidth={1.7} color={item.target === null ? semantic.textDisabled : tint} />
            <Text style={[styles.label, isActive && styles.labelActive, item.target === null && styles.labelDisabled]}>{item.label}</Text>
          </>
        );

        if (item.target === null) {
          return (
            <View key={item.label} style={styles.item} {...a11y}>
              {content}
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
            {...a11y}
          >
            {content}
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
    borderTopColor: semantic.borderDefault,
    backgroundColor: semantic.bgChrome,
    paddingTop: 11,
    paddingHorizontal: 12,
  },
  item: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    minHeight: 48,
    padding: 4,
  },
  label: { ...type.navLabel, color: semantic.navInactive },
  labelActive: { fontWeight: "600", color: semantic.navActive },
  labelDisabled: { color: semantic.textDisabled },
});
