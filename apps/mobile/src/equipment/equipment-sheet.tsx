import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, radius, spacing, touchTarget, typography } from "../design/tokens";
import { EquipmentFlowController, type EquipmentFlowPorts } from "./equipment-controller";
import { EQUIPMENT_COPY as COPY, INITIAL_EQUIPMENT_FLOW_STATE, replacementRows, reviewRequiredMessage, type EquipmentFlowState } from "./equipment-flow";

/**
 * Temporary Equipment / Gym Adaptation V1 — Slice D: "Equipment available
 * today" — a small Vostivo decision inside Today, same sheet language as
 * Available-Time. One discriminated state rendered from
 * `EquipmentFlowController`; all logic lives there and in
 * `equipment-flow.ts`. Mount with a fresh `key` per opening (a fresh flow,
 * nothing remembered). Never starts a workout.
 */
export interface EquipmentSheetProps {
  readonly plannedWorkoutId: string;
  readonly ports: EquipmentFlowPorts;
  readonly onDismiss: () => void;
  readonly onRefreshToday: () => void;
  readonly logFailure: (message: string) => void;
}

export function EquipmentSheet(props: EquipmentSheetProps): React.JSX.Element {
  const { plannedWorkoutId, ports, onDismiss, onRefreshToday, logFailure } = props;
  const [state, setState] = useState<EquipmentFlowState>(INITIAL_EQUIPMENT_FLOW_STATE);
  const controller = useMemo(
    () => new EquipmentFlowController(plannedWorkoutId, ports, { onStateChange: setState, dismiss: onDismiss, refreshToday: onRefreshToday, logFailure }),
    [plannedWorkoutId, ports, onDismiss, onRefreshToday, logFailure],
  );
  useEffect(() => {
    void controller.load();
    // Unmounting (closing, navigating away) cancels anything in flight: late results are ignored.
    return () => controller.dispose();
  }, [controller]);
  const insets = useSafeAreaInsets();

  return (
    <Modal visible transparent animationType="slide" statusBarTranslucent onRequestClose={() => controller.close()}>
      <View style={styles.backdrop}>
        <Pressable style={styles.backdropTouch} onPress={() => controller.close()} accessibilityLabel="Close" accessibilityRole="button" />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]} accessibilityViewIsModal>
          <View style={styles.grabber} />
          <View style={styles.headerRow}>
            <Text style={styles.eyebrow}>{COPY.eyebrow}</Text>
            <Pressable onPress={() => controller.close()} hitSlop={12} style={styles.closeButton} accessibilityRole="button" accessibilityLabel="Close">
              <Text style={styles.closeGlyph}>✕</Text>
            </Pressable>
          </View>
          <SheetBody state={state} controller={controller} />
        </View>
      </View>
    </Modal>
  );
}

function SheetBody({ state, controller }: { state: EquipmentFlowState; controller: EquipmentFlowController }): React.JSX.Element {
  switch (state.kind) {
    case "LOADING_OPTIONS":
      return (
        <Layout actions={<PrimaryButton label={COPY.reviewChanges} disabled onPress={() => undefined} />}>
          <Text style={styles.title}>{COPY.selectTitle}</Text>
          <Text style={styles.body}>{COPY.selectBody}</Text>
          <Text style={styles.quiet}>Loading equipment…</Text>
        </Layout>
      );

    case "OPTIONS_ERROR":
      return (
        <Layout
          actions={
            <>
              <PrimaryButton label={COPY.retry} onPress={() => void controller.retryOptions()} />
              <SecondaryButton label={COPY.notNow} onPress={() => controller.close()} />
            </>
          }
        >
          <Text style={styles.title}>{COPY.selectTitle}</Text>
          <Text style={styles.inlineMessage}>{COPY.optionsError}</Text>
          <Text style={styles.quiet}>Your planned workout is still available.</Text>
        </Layout>
      );

    case "TIMEZONE_REQUIRED":
      return (
        <Layout
          actions={
            <>
              <PrimaryButton label={state.retrying ? "Trying…" : COPY.tryAgain} disabled={state.retrying} busy={state.retrying} onPress={() => void controller.retryTimeZone()} />
              <SecondaryButton label={COPY.notNow} onPress={() => controller.close()} />
            </>
          }
        >
          <Text style={styles.title}>{COPY.selectTitle}</Text>
          <Text style={styles.body}>{COPY.timeZoneRequired}</Text>
        </Layout>
      );

    case "SELECTING": {
      const { previewing } = state;
      const selected = new Set(state.selection);
      return (
        <Layout
          actions={<PrimaryButton label={previewing ? COPY.reviewing : COPY.reviewChanges} disabled={previewing} busy={previewing} onPress={() => void controller.requestPreview()} />}
        >
          <Text style={styles.title}>{COPY.selectTitle}</Text>
          <Text style={styles.body}>{COPY.selectBody}</Text>
          <Text style={styles.quiet}>{COPY.selectHint}</Text>
          <View style={styles.bulkRow}>
            <TextButton label={COPY.everythingAvailable} disabled={previewing} onPress={() => controller.selectAll()} />
            <TextButton label={COPY.clearAll} disabled={previewing} onPress={() => controller.clearAll()} />
          </View>
          <View style={styles.optionList}>
            {state.options.equipmentOptions.map((option) => (
              <OptionRow key={option.equipmentId} label={option.displayLabel} selected={selected.has(option.equipmentId)} disabled={previewing} onPress={() => controller.toggle(option.equipmentId)} />
            ))}
          </View>
          {state.catalogRefreshed ? <Text style={styles.inlineMessage}>{COPY.catalogRefreshed}</Text> : null}
          {state.previewFailed ? <Text style={styles.inlineMessage}>{COPY.previewError}</Text> : null}
        </Layout>
      );
    }

    case "ADJUST_SESSION": {
      const applying = state.apply.status === "applying";
      const rows = replacementRows(state.preview);
      return (
        <Layout
          actions={
            <>
              <PrimaryButton
                label={applying ? COPY.applying : state.apply.status === "failed" ? COPY.retry : COPY.apply}
                disabled={applying}
                busy={applying}
                onPress={() => void controller.apply()}
              />
              <SecondaryButton label={COPY.notNow} disabled={applying} onPress={() => controller.close()} />
            </>
          }
        >
          <Text style={styles.microLabel}>{COPY.adjustEyebrow}</Text>
          <Text style={styles.title}>{COPY.adjustTitle}</Text>
          {state.workoutChanged ? <Text style={styles.inlineMessage}>{COPY.workoutChanged}</Text> : null}
          <View style={styles.changeList}>
            {rows.map((row) => (
              <View key={row.plannedExerciseId} style={styles.changeRow} accessible accessibilityLabel={`${row.authoredName} becomes ${row.substituteName}. ${COPY.replacementReason}. ${row.prescriptionLine}.`}>
                <Text style={styles.authoredName}>{row.authoredName}</Text>
                <Text style={styles.substituteName}>→ {row.substituteName}</Text>
                <Text style={styles.changeDetail}>{COPY.replacementReason}</Text>
                <Text style={styles.changeDetail}>{row.prescriptionLine}</Text>
              </View>
            ))}
          </View>
          <Text style={styles.body}>{COPY.preserved}</Text>
          <Text style={styles.body}>{COPY.loadResolved}</Text>
          <Text style={styles.quiet}>Today only. Your plan stays unchanged.</Text>
          {state.apply.status === "failed" ? <Text style={styles.inlineMessage}>{COPY.applyFailed}</Text> : null}
          <TextButton label={COPY.editEquipment} disabled={applying} onPress={() => controller.editEquipment()} />
        </Layout>
      );
    }

    case "NO_CHANGE": {
      const applying = state.apply.status === "applying";
      return (
        <Layout
          actions={
            state.currentlyAdjusted ? (
              <>
                <PrimaryButton
                  label={applying ? COPY.applying : state.apply.status === "failed" ? COPY.retry : COPY.useOriginal}
                  disabled={applying}
                  busy={applying}
                  onPress={() => void controller.apply()}
                />
                <SecondaryButton label={COPY.notNow} disabled={applying} onPress={() => controller.close()} />
              </>
            ) : (
              <PrimaryButton label={COPY.done} onPress={() => controller.close()} />
            )
          }
        >
          <Text style={styles.title}>{COPY.noChangeTitle}</Text>
          {state.workoutChanged ? <Text style={styles.inlineMessage}>{COPY.workoutChanged}</Text> : null}
          <Text style={styles.body}>{COPY.noChangeBody}</Text>
          {state.currentlyAdjusted ? <Text style={styles.body}>{COPY.useOriginalBody}</Text> : null}
          {state.apply.status === "failed" ? <Text style={styles.inlineMessage}>{COPY.applyFailed}</Text> : null}
          <TextButton label={COPY.editEquipment} disabled={applying} onPress={() => controller.editEquipment()} />
        </Layout>
      );
    }

    case "REVIEW_REQUIRED":
      return (
        <Layout
          actions={
            <>
              <PrimaryButton label={COPY.editEquipment} onPress={() => controller.editEquipment()} />
              <SecondaryButton label={COPY.notNow} onPress={() => controller.close()} />
            </>
          }
        >
          <Text style={styles.title}>{COPY.reviewRequiredTitle}</Text>
          {state.workoutChanged ? <Text style={styles.inlineMessage}>{COPY.workoutChanged}</Text> : null}
          <Text style={styles.body}>{reviewRequiredMessage(state.preview.reasonCode)}</Text>
          <Text style={styles.quiet}>Your planned workout is still available.</Text>
        </Layout>
      );
  }
}

/** Scrollable content above a footer that always keeps the actions reachable (large text, long option lists). */
function Layout({ children, actions }: { children: ReactNode; actions: ReactNode }): React.JSX.Element {
  return (
    <>
      <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
        {children}
      </ScrollView>
      <View style={styles.actions}>{actions}</View>
    </>
  );
}

/** A full-width, gym-sized row; selected state is a filled check box + text, never colour alone. */
function OptionRow(props: { label: string; selected: boolean; disabled: boolean; onPress: () => void }): React.JSX.Element {
  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled}
      style={({ pressed }) => [styles.optionRow, props.selected && styles.optionRowSelected, pressed && styles.pressed]}
      accessibilityRole="checkbox"
      accessibilityLabel={props.label}
      accessibilityState={{ checked: props.selected, disabled: props.disabled }}
    >
      <Text style={[styles.optionLabel, props.selected && styles.optionLabelSelected]}>{props.label}</Text>
      <View style={[styles.checkBox, props.selected && styles.checkBoxSelected]}>{props.selected ? <Text style={styles.checkGlyph}>✓</Text> : null}</View>
    </Pressable>
  );
}

function PrimaryButton(props: { label: string; onPress: () => void; disabled?: boolean; busy?: boolean }): React.JSX.Element {
  const disabled = props.disabled ?? false;
  return (
    <Pressable
      onPress={props.onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, disabled && styles.primaryButtonDisabled]}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled, busy: props.busy ?? false }}
    >
      <Text style={styles.primaryButtonText}>{props.label}</Text>
    </Pressable>
  );
}

function SecondaryButton(props: { label: string; onPress: () => void; disabled?: boolean }): React.JSX.Element {
  const disabled = props.disabled ?? false;
  return (
    <Pressable onPress={props.onPress} disabled={disabled} style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel={props.label} accessibilityState={{ disabled }}>
      <Text style={styles.secondaryButtonText}>{props.label}</Text>
    </Pressable>
  );
}

/** Restrained inline action (Everything available / Clear all / Edit equipment) — still a full touch target. */
function TextButton(props: { label: string; onPress: () => void; disabled?: boolean }): React.JSX.Element {
  const disabled = props.disabled ?? false;
  return (
    <Pressable onPress={props.onPress} disabled={disabled} hitSlop={{ top: 8, bottom: 8 }} style={styles.textButton} accessibilityRole="button" accessibilityLabel={props.label} accessibilityState={{ disabled }}>
      <Text style={[styles.textButtonLabel, disabled && styles.textButtonDisabled]}>{props.label}</Text>
    </Pressable>
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
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: touchTarget.minHeight },
  eyebrow: { ...typography.tiny, color: colors.textTertiary, letterSpacing: 1.6 },
  microLabel: { ...typography.tiny, color: colors.textTertiary, letterSpacing: 1.4 },
  closeButton: { minWidth: touchTarget.minHeight, minHeight: touchTarget.minHeight, alignItems: "flex-end", justifyContent: "center" },
  closeGlyph: { ...typography.heading, color: colors.textSecondary },
  content: { flexGrow: 0 },
  contentInner: { gap: spacing.md, paddingBottom: spacing.lg },
  title: { ...typography.title, color: colors.textPrimary },
  body: { ...typography.body, color: colors.textSecondary },
  quiet: { ...typography.caption, color: colors.textTertiary },
  inlineMessage: { ...typography.caption, color: colors.textSecondary },
  bulkRow: { flexDirection: "row", gap: spacing.lg },
  optionList: { gap: spacing.sm },
  optionRow: {
    minHeight: touchTarget.minHeight + spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceElevated,
  },
  optionRowSelected: { borderColor: colors.signal },
  optionLabel: { ...typography.bodyStrong, color: colors.textSecondary, flexShrink: 1 },
  optionLabelSelected: { color: colors.textPrimary },
  checkBox: { width: 26, height: 26, borderRadius: radius.sm, borderWidth: 2, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  checkBoxSelected: { borderColor: colors.signal, backgroundColor: colors.signal },
  checkGlyph: { ...typography.bodyStrong, color: colors.signalText },
  changeList: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  changeRow: { paddingVertical: spacing.md, gap: 2, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  authoredName: { ...typography.body, color: colors.textTertiary },
  substituteName: { ...typography.bodyStrong, color: colors.textPrimary },
  changeDetail: { ...typography.caption, color: colors.textSecondary },
  actions: { gap: spacing.sm, paddingTop: spacing.sm },
  primaryButton: { backgroundColor: colors.signal, borderRadius: radius.pill, minHeight: touchTarget.minHeight, alignItems: "center", justifyContent: "center" },
  primaryButtonDisabled: { opacity: 0.4 },
  primaryButtonText: { ...typography.bodyStrong, color: colors.signalText },
  secondaryButton: { minHeight: touchTarget.minHeight, alignItems: "center", justifyContent: "center", borderRadius: radius.pill },
  secondaryButtonText: { ...typography.bodyStrong, color: colors.textPrimary },
  textButton: { minHeight: touchTarget.minHeight, justifyContent: "center", alignSelf: "flex-start" },
  textButtonLabel: { ...typography.caption, color: colors.textSecondary, textDecorationLine: "underline" },
  textButtonDisabled: { opacity: 0.4 },
  pressed: { opacity: 0.85 },
});
