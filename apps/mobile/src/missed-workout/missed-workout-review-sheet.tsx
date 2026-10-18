import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, radius, spacing, touchTarget, typography } from "../design/tokens";
import { COPY, reviewSummary, scheduleChanges, type MissedWorkoutFlowState } from "./missed-workout-flow";

type RollForwardState = Extract<MissedWorkoutFlowState, { kind: "ROLL_FORWARD" }>;

/**
 * Missed Workout V1 Slice D — the ONE review surface: what was missed, what
 * comes next, and a CHANGES-ONLY diff (current -> proposed effective day,
 * carryovers as "Needs a training day", never an invented date). Primary
 * "Apply update" is the only path to an application; "Not now" only
 * dismisses. Renders the controller's state; holds no logic.
 */
export function MissedWorkoutReviewSheet(props: { readonly state: RollForwardState; readonly onApply: () => void; readonly onNotNow: () => void }): React.JSX.Element {
  const { state } = props;
  const insets = useSafeAreaInsets();
  const summary = reviewSummary(state.preview);
  const changes = scheduleChanges(state.preview);
  const applying = state.apply.status === "applying";
  const failed = state.apply.status === "failed";
  const close = () => {
    if (!applying) props.onNotNow();
  };

  return (
    <Modal visible transparent animationType="slide" statusBarTranslucent onRequestClose={close}>
      <View style={styles.backdrop}>
        <Pressable style={styles.backdropTouch} onPress={close} accessibilityLabel={COPY.notNow} accessibilityRole="button" />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]} accessibilityViewIsModal>
          <View style={styles.grabber} />
          <Text style={styles.eyebrow}>{COPY.eyebrow}</Text>
          <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
            <Text style={styles.title}>{COPY.reviewTitle}</Text>
            {state.planChanged ? <Text style={styles.notice}>{COPY.planChanged}</Text> : null}

            <View style={styles.summaryRow}>
              <Summary label="MISSED" name={summary.missedName} detail={summary.missedDayLabel} />
              <View style={styles.divider} />
              <Summary label="RECOMMENDED NEXT" name={summary.recommendedName} detail={summary.recommendedDayLabel} emphasized />
            </View>

            {changes.moves.length > 0 ? (
              <View>
                <Text style={styles.sectionLabel}>SCHEDULE CHANGES</Text>
                {changes.moves.map((row) => (
                  <View key={row.plannedWorkoutId} style={styles.row} accessible accessibilityLabel={`${row.toLabel}: ${row.displayName}${row.fromLabel === null ? "" : `, from ${row.fromLabel}`}`}>
                    <Text style={styles.rowDay}>{row.toLabel}</Text>
                    <View style={styles.rowText}>
                      <Text style={styles.rowName} numberOfLines={2}>
                        {row.displayName}
                      </Text>
                      {row.fromLabel !== null ? <Text style={styles.rowFrom}>from {row.fromLabel}</Text> : null}
                    </View>
                  </View>
                ))}
              </View>
            ) : null}

            {changes.needsTrainingDay.length > 0 ? (
              <View>
                <Text style={styles.sectionLabel}>{COPY.needsTrainingDay.toUpperCase()}</Text>
                {changes.needsTrainingDay.map((row) => (
                  <View key={row.plannedWorkoutId} style={styles.row} accessible accessibilityLabel={`${row.displayName}, ${COPY.needsTrainingDay}`}>
                    <Text style={styles.rowName}>{row.displayName}</Text>
                  </View>
                ))}
              </View>
            ) : null}

            <Text style={styles.quiet}>{COPY.unchangedProgram}</Text>
            {failed ? <Text style={styles.inlineMessage}>{COPY.applyFailed}</Text> : null}
          </ScrollView>

          <View style={styles.actions}>
            <Pressable
              onPress={props.onApply}
              disabled={applying}
              style={({ pressed }) => [styles.primaryButton, applying && styles.primaryButtonDisabled, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel={failed ? COPY.retry : COPY.apply}
              accessibilityState={{ disabled: applying, busy: applying }}
            >
              <Text style={styles.primaryButtonText}>{applying ? COPY.applying : failed ? COPY.retry : COPY.apply}</Text>
            </Pressable>
            <Pressable
              onPress={close}
              disabled={applying}
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel={COPY.notNow}
              accessibilityState={{ disabled: applying }}
            >
              <Text style={styles.secondaryButtonText}>{COPY.notNow}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function Summary(props: { label: string; name: string; detail: string | null; emphasized?: boolean }): React.JSX.Element {
  return (
    <View style={styles.summary}>
      <Text style={styles.summaryLabel}>{props.label}</Text>
      <Text style={[styles.summaryName, props.emphasized === true && styles.summaryNameEmphasized]} numberOfLines={2}>
        {props.name}
      </Text>
      {props.detail !== null ? <Text style={styles.summaryDetail}>{props.detail}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.55)" },
  backdropTouch: StyleSheet.absoluteFill,
  sheet: {
    maxHeight: "92%",
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  grabber: { alignSelf: "center", width: 36, height: 4, borderRadius: radius.pill, backgroundColor: colors.border, marginBottom: spacing.sm },
  eyebrow: { ...typography.tiny, color: colors.textTertiary, letterSpacing: 1.6, minHeight: touchTarget.minHeight / 2 },
  content: { flexGrow: 0 },
  contentInner: { gap: spacing.md, paddingBottom: spacing.lg },
  title: { ...typography.title, color: colors.textPrimary },
  notice: { ...typography.caption, color: colors.textPrimary, backgroundColor: colors.surfaceElevated, borderRadius: radius.md, padding: spacing.md },
  summaryRow: {
    flexDirection: "row",
    alignItems: "stretch",
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.background,
    paddingVertical: spacing.md,
  },
  divider: { width: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  summary: { flex: 1, paddingHorizontal: spacing.md, gap: 2 },
  summaryLabel: { ...typography.tiny, color: colors.textTertiary, letterSpacing: 1.4 },
  summaryName: { ...typography.bodyStrong, color: colors.textSecondary },
  summaryNameEmphasized: { color: colors.textPrimary },
  summaryDetail: { ...typography.caption, color: colors.textTertiary },
  sectionLabel: { ...typography.tiny, color: colors.textTertiary, letterSpacing: 1.4, marginBottom: spacing.xs },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    minHeight: touchTarget.minHeight,
  },
  rowDay: { ...typography.bodyStrong, color: colors.textPrimary, width: 64 },
  rowText: { flex: 1, gap: 2 },
  rowName: { ...typography.body, color: colors.textPrimary, flexShrink: 1 },
  rowFrom: { ...typography.caption, color: colors.textTertiary },
  quiet: { ...typography.caption, color: colors.textTertiary },
  inlineMessage: { ...typography.caption, color: colors.textSecondary },
  actions: { gap: spacing.sm, paddingTop: spacing.sm },
  primaryButton: { backgroundColor: colors.signal, borderRadius: radius.pill, minHeight: touchTarget.minHeight, alignItems: "center", justifyContent: "center" },
  primaryButtonDisabled: { opacity: 0.4 },
  primaryButtonText: { ...typography.bodyStrong, color: colors.signalText },
  secondaryButton: { minHeight: touchTarget.minHeight, alignItems: "center", justifyContent: "center", borderRadius: radius.pill },
  secondaryButtonText: { ...typography.bodyStrong, color: colors.textPrimary },
  pressed: { opacity: 0.85 },
});
