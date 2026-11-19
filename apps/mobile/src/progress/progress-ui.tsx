import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { radius, semantic, spacing, touchTarget, type } from "../design/tokens";
import { SecondaryButton as FoundationSecondaryButton } from "../ui/primitives";
import type { WorkoutRowView } from "./progress-presentation";

/**
 * Progress & Feedback V1 — Slice B: the few presentational pieces the
 * Progress screens share. Athlete Design Integration 01: restyled to the
 * approved Progress canvas / Foundations V1 — hairline rows and flat
 * panels instead of bordered boxes; `signal` lime only for the current
 * week marker — never for success or decoration. The drill-downs
 * (history, workout detail, exercise) have no approved canvas: their
 * look is Foundations-derived through these shared styles.
 */

/** Drill-down header, same convention as Workout Preview: a plain "‹ Back", no bottom nav. */
export function BackHeader(): React.JSX.Element {
  const router = useRouter();
  return (
    <Pressable onPress={() => router.back()} style={progressStyles.backButton} accessibilityRole="button" accessibilityLabel="Back">
      <Text style={progressStyles.backButtonText}>‹  Back</Text>
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
  return <FoundationSecondaryButton label={label} onPress={onPress} loading={disabled} accessibilityLabel={accessibilityLabel} style={progressStyles.secondaryButton} />;
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
        <Text style={progressStyles.chevron}>›</Text>
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
  safeArea: { flex: 1, backgroundColor: semantic.bgApp },
  scroll: { flex: 1 },
  scrollContent: { flexGrow: 1, paddingHorizontal: spacing.screenGutter, paddingBottom: spacing.bottomClearance, gap: spacing.sectionRhythm },
  screenTitle: { ...type.pageTitle, color: semantic.textPrimary, paddingTop: spacing.xl },
  headline: { ...type.sessionTitle, color: semantic.textPrimary },
  secondaryText: { ...type.body, color: semantic.textTertiary },
  captionText: { ...type.body, color: semantic.textMuted },
  tertiaryText: { ...type.body, color: semantic.textMuted },
  sectionHeading: { ...type.microLabel, color: semantic.textMuted },
  section: { gap: spacing.md },
  /** Flat grouped panel (Foundations §06 "surface / panel") — no gradient, no shadow. */
  card: {
    backgroundColor: semantic.surfacePanel,
    borderRadius: radius.surface,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: semantic.borderDefault,
  },
  row: {
    paddingVertical: spacing.md,
    minHeight: 48,
    gap: 3,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: semantic.borderHairline,
  },
  rowHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md },
  rowTitle: { ...type.bodyStrong, fontSize: 15, color: semantic.textPrimary, flex: 1 },
  rowMeta: { ...type.labelValue, color: semantic.textMuted, flexShrink: 0, fontVariant: ["tabular-nums"] },
  chevron: { ...type.button, fontSize: 17, color: semantic.ornamentFaint },
  pressed: { opacity: 0.7 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginTop: spacing.xs },
  chip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.awMicro,
    backgroundColor: semantic.surfaceInteractive,
  },
  chipText: { ...type.labelValue, fontSize: 11, color: semantic.textTertiary },
  change: { ...type.numeric, color: semantic.textPrimary },
  backButton: { alignSelf: "flex-start", minHeight: touchTarget.minHeight, justifyContent: "center", paddingTop: spacing.sm },
  backButtonText: { ...type.button, fontSize: 14, color: semantic.textSecondary },
  stateMessage: { paddingTop: spacing.xl, gap: spacing.sm, alignItems: "flex-start" },
  stateTitle: { ...type.sessionTitle, color: semantic.textPrimary },
  secondaryButton: { marginTop: spacing.sm, alignSelf: "flex-start" },
  loadingBlocks: { gap: spacing.md, paddingTop: spacing.sm },
  loadingBlock: { height: 56, borderRadius: radius.input, backgroundColor: semantic.surfaceInteractive },
  loadingBlockTall: { height: 88 },
  cardSection: { gap: spacing.xs, minHeight: touchTarget.minHeight },
  nextWorkoutLink: {
    marginTop: spacing.xs,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: semantic.borderHairline,
    minHeight: touchTarget.minHeight,
    justifyContent: "center",
    gap: 2,
  },
  linkText: { ...type.button, color: semantic.textSecondary },
  markerRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  currentMarker: { width: 5, height: 5, borderRadius: 3, backgroundColor: semantic.signal },
});
