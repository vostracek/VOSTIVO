import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { colors, radius, spacing, touchTarget, typography } from "../design/tokens";
import type { WorkoutRowView } from "./progress-presentation";

/**
 * Progress & Feedback V1 — Slice B: the few presentational pieces the
 * Progress screens share. Refined Dark base tokens only (the same keys
 * Plan/Preview use); `signal` lime is reserved for the current week marker
 * — never for success or decoration.
 */

/** Drill-down header, same convention as Workout Preview: a plain "‹ Back", no bottom nav. */
export function BackHeader(): React.JSX.Element {
  const router = useRouter();
  return (
    <Pressable onPress={() => router.back()} style={progressStyles.backButton} accessibilityRole="button" accessibilityLabel="Back">
      <Text style={progressStyles.backButtonText}>‹ Back</Text>
    </Pressable>
  );
}

/** Calm, generic state (error, not available, empty) with an optional single action. */
export function StateMessage({ title, body, actionLabel, onAction }: { title: string; body?: string; actionLabel?: string; onAction?: () => void }): React.JSX.Element {
  return (
    <View style={progressStyles.stateMessage}>
      <Text style={progressStyles.stateTitle}>{title}</Text>
      {body === undefined ? null : <Text style={progressStyles.secondaryText}>{body}</Text>}
      {actionLabel === undefined || onAction === undefined ? null : <SecondaryButton label={actionLabel} onPress={onAction} />}
    </View>
  );
}

export function SecondaryButton({ label, onPress, disabled = false, accessibilityLabel }: { label: string; onPress: () => void; disabled?: boolean; accessibilityLabel?: string }): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [progressStyles.secondaryButton, (pressed || disabled) && progressStyles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled, busy: disabled }}
    >
      <Text style={progressStyles.secondaryButtonText}>{label}</Text>
    </Pressable>
  );
}

/** "this history item isn't available" — 404 never says whether it is unknown, foreign or not visible. */
export function HistoryItemUnavailable(): React.JSX.Element {
  const router = useRouter();
  return <StateMessage title="This history item isn't available." actionLabel="Back to Progress" onAction={() => router.dismissTo("/progress")} />;
}

/** Shape-only placeholder while loading — no numbers, no fake zero state. */
export function LoadingBlocks({ count, label }: { count: number; label: string }): React.JSX.Element {
  return (
    <View style={progressStyles.loadingBlocks} accessibilityLabel={label} accessibilityRole="progressbar">
      {Array.from({ length: count }, (_, index) => (
        <View key={index} style={[progressStyles.loadingBlock, index === 0 && progressStyles.loadingBlockTall]} />
      ))}
    </View>
  );
}

/** One completed workout row (Progress root and the history list). */
export function WorkoutRow({ row, onPress }: { row: WorkoutRowView; onPress: () => void }): React.JSX.Element {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [progressStyles.row, pressed && progressStyles.pressed]} accessibilityRole="button" accessibilityLabel={row.accessibilityLabel}>
      <View style={progressStyles.rowHeader}>
        <Text style={progressStyles.rowTitle}>{row.title}</Text>
        <Text style={progressStyles.rowMeta}>{row.dateLabel}</Text>
      </View>
      <Text style={progressStyles.captionText}>
        {row.setsLabel} · {row.completionLabel}
      </Text>
      {row.tags.length === 0 ? null : (
        <View style={progressStyles.chips}>
          {row.tags.map((tag) => (
            <View key={tag} style={progressStyles.chip}>
              <Text style={progressStyles.chipText}>{tag}</Text>
            </View>
          ))}
        </View>
      )}
    </Pressable>
  );
}

export const progressStyles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  scroll: { flex: 1 },
  scrollContent: { flexGrow: 1, paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.lg },
  screenTitle: { ...typography.title, color: colors.textPrimary, paddingTop: spacing.md },
  headline: { ...typography.heading, fontSize: 22, color: colors.textPrimary },
  secondaryText: { ...typography.body, color: colors.textSecondary },
  captionText: { ...typography.caption, color: colors.textSecondary },
  tertiaryText: { ...typography.caption, color: colors.textTertiary },
  sectionHeading: { ...typography.heading, color: colors.textPrimary, marginTop: spacing.sm },
  section: { gap: spacing.sm },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  row: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    minHeight: touchTarget.minHeight,
    gap: 2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  rowHeader: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: spacing.md },
  rowTitle: { ...typography.bodyStrong, color: colors.textPrimary, flexShrink: 1 },
  rowMeta: { ...typography.caption, color: colors.textSecondary, flexShrink: 0 },
  pressed: { opacity: 0.75 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginTop: spacing.xs },
  chip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  chipText: { ...typography.tiny, color: colors.textSecondary },
  change: { ...typography.heading, color: colors.textPrimary },
  backButton: { alignSelf: "flex-start", minHeight: touchTarget.minHeight, justifyContent: "center", paddingTop: spacing.sm },
  backButtonText: { ...typography.bodyStrong, color: colors.textPrimary },
  stateMessage: { paddingTop: spacing.xl, gap: spacing.sm, alignItems: "flex-start" },
  stateTitle: { ...typography.heading, color: colors.textPrimary },
  secondaryButton: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    minHeight: touchTarget.minHeight,
    justifyContent: "center",
    alignSelf: "flex-start",
  },
  secondaryButtonText: { ...typography.bodyStrong, color: colors.textPrimary },
  loadingBlocks: { gap: spacing.md, paddingTop: spacing.sm },
  loadingBlock: { height: 64, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  loadingBlockTall: { height: 96 },
  cardSection: { gap: spacing.xs, minHeight: touchTarget.minHeight },
  nextWorkoutLink: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    minHeight: touchTarget.minHeight,
    justifyContent: "center",
    gap: 2,
  },
  linkText: { ...typography.bodyStrong, color: colors.textPrimary },
  markerRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  currentMarker: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.signal },
});
