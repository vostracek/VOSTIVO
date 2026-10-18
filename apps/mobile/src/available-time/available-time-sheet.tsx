import { useEffect, useMemo, useState, type ReactNode } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, radius, spacing, touchTarget, typography } from "../design/tokens";
import { AvailableTimeFlowController, type AvailableTimeFlowPorts } from "./available-time-controller";
import {
  QUICK_TIME_CHOICES_MINUTES,
  changeRowDetail,
  changeRows,
  estimatedMinutes,
  submittableMinutes,
  validateCustomMinutes,
  type AvailableTimeFlowState,
  type TimeSelection,
} from "./available-time-flow";

/**
 * Available-Time Adaptation V1 — Slice D: "a small Vostivo decision inside
 * Today". One sheet, one discriminated state (`AvailableTimeFlowState`),
 * rendered from `AvailableTimeFlowController` — all logic lives there and in
 * `available-time-flow.ts`. Mount it with a fresh `key` per opening so every
 * opening starts with NO time selected.
 */
export interface AvailableTimeSheetProps {
  readonly plannedWorkoutId: string;
  readonly ports: AvailableTimeFlowPorts;
  readonly onDismiss: () => void;
  readonly onNavigateToActiveWorkout: () => void;
  readonly onRefreshToday: () => void;
}

export function AvailableTimeSheet(props: AvailableTimeSheetProps): React.JSX.Element {
  const { plannedWorkoutId, ports, onDismiss, onNavigateToActiveWorkout, onRefreshToday } = props;
  const [state, setState] = useState<AvailableTimeFlowState>({ kind: "SELECT_TIME", selection: { kind: "none" } });
  const controller = useMemo(
    () =>
      new AvailableTimeFlowController(plannedWorkoutId, ports, {
        onStateChange: setState,
        navigateToActiveWorkout: onNavigateToActiveWorkout,
        dismiss: onDismiss,
        refreshToday: onRefreshToday,
      }),
    [plannedWorkoutId, ports, onDismiss, onNavigateToActiveWorkout, onRefreshToday],
  );
  // Unmounting (closing, navigating away) cancels any in-flight preview: late results are ignored.
  useEffect(() => () => controller.dispose(), [controller]);
  const insets = useSafeAreaInsets();

  return (
    <Modal visible transparent animationType="slide" statusBarTranslucent onRequestClose={() => controller.keepOriginal()}>
      <View style={styles.backdrop}>
        <Pressable style={styles.backdropTouch} onPress={() => controller.keepOriginal()} accessibilityLabel="Close" accessibilityRole="button" />
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.sheetWrapper}>
          <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]} accessibilityViewIsModal>
            <View style={styles.grabber} />
            <View style={styles.headerRow}>
              <Text style={styles.eyebrow}>AVAILABLE TIME</Text>
              <Pressable onPress={() => controller.keepOriginal()} hitSlop={12} style={styles.closeButton} accessibilityRole="button" accessibilityLabel="Close">
                <Text style={styles.closeGlyph}>✕</Text>
              </Pressable>
            </View>
            <SheetBody state={state} controller={controller} />
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

function SheetBody({ state, controller }: { state: AvailableTimeFlowState; controller: AvailableTimeFlowController }): React.JSX.Element {
  switch (state.kind) {
    case "SELECT_TIME":
    case "LOADING_PREVIEW": {
      const loading = state.kind === "LOADING_PREVIEW";
      const minutes = submittableMinutes(state.selection);
      return (
        <Layout
          actions={
            <PrimaryButton
              label={loading ? "Previewing…" : "Preview changes"}
              disabled={loading || minutes === null}
              busy={loading}
              onPress={() => controller.requestPreview()}
            />
          }
        >
          <Text style={styles.title}>How much time do you have?</Text>
          <Text style={styles.body}>Vostivo will keep the highest-priority work and make only the changes needed.</Text>
          <TimeSelector selection={state.selection} disabled={loading} controller={controller} />
        </Layout>
      );
    }

    case "ADJUST_SESSION": {
      const rows = changeRows(state.preview);
      const starting = state.start.status === "starting";
      return (
        <Layout
          actions={
            <>
              <PrimaryButton label={starting ? "Starting…" : "Start adjusted workout"} disabled={starting} busy={starting} onPress={() => void controller.startAdjusted()} />
              <SecondaryButton label="Keep original" disabled={starting} onPress={() => controller.keepOriginal()} />
            </>
          }
        >
          <Text style={styles.title}>{state.availableMinutes}-min version</Text>
          <Text style={styles.body}>Only the changes needed to fit your time.</Text>
          <View style={styles.comparisonRow}>
            <Estimate label="ORIGINAL" seconds={state.preview.originalEstimatedSeconds} />
            <View style={styles.comparisonDivider} />
            <Estimate label="ADJUSTED" seconds={state.preview.adjustedEstimatedSeconds} emphasized />
          </View>
          <View style={styles.changeList}>
            {rows.map((row) => (
              <View key={row.plannedExerciseId} style={styles.changeRow} accessible accessibilityLabel={`${row.displayName}, ${changeRowDetail(row)}`}>
                <Text style={styles.changeName} numberOfLines={2}>
                  {row.displayName}
                </Text>
                <Text style={styles.changeDetail}>{changeRowDetail(row)}</Text>
              </View>
            ))}
          </View>
          <Text style={styles.body}>Vostivo kept the priority work and removed only what was needed.</Text>
          <Text style={styles.quiet}>Your plan stays unchanged.</Text>
          {state.start.status === "failed" ? <Text style={styles.inlineMessage}>{state.start.message}</Text> : null}
        </Layout>
      );
    }

    case "NO_CHANGE": {
      const starting = state.start.status === "starting";
      return (
        <Layout
          actions={
            <>
              <PrimaryButton label={starting ? "Starting…" : "Start workout"} disabled={starting} busy={starting} onPress={() => void controller.startOriginal()} />
              <SecondaryButton label="Choose another time" disabled={starting} onPress={() => controller.chooseAnotherTime()} />
            </>
          }
        >
          <Text style={styles.title}>Your workout already fits</Text>
          <Text style={styles.body}>No changes are needed for the time you selected.</Text>
          <View style={styles.comparisonRow}>
            <Estimate label="ESTIMATED" seconds={state.preview.originalEstimatedSeconds} emphasized />
          </View>
          {state.start.status === "failed" ? <Text style={styles.inlineMessage}>{state.start.message}</Text> : null}
        </Layout>
      );
    }

    case "CANNOT_FIT_MINIMUM":
      return (
        <Layout
          actions={
            <>
              <PrimaryButton label="Choose more time" onPress={() => controller.chooseAnotherTime()} />
              <SecondaryButton label="Keep original" onPress={() => controller.keepOriginal()} />
            </>
          }
        >
          <Text style={styles.title}>Not enough time for the core work</Text>
          <Text style={styles.body}>This workout can&apos;t fit into {state.availableMinutes} minutes without removing its priority work.</Text>
          <View style={styles.comparisonRow}>
            <Estimate label="SHORTEST SAFE VERSION" seconds={state.preview.adjustedEstimatedSeconds} emphasized />
          </View>
        </Layout>
      );

    case "PREVIEW_ERROR":
      return (
        <Layout
          actions={
            <>
              <PrimaryButton label="Retry" onPress={() => controller.retry()} />
              <SecondaryButton label="Keep original" onPress={() => controller.keepOriginal()} />
            </>
          }
        >
          <Text style={styles.title}>Couldn&apos;t adjust right now</Text>
          <Text style={styles.body}>Your planned workout is still available.</Text>
        </Layout>
      );
  }
}

/** Scrollable content above a footer that always keeps the actions reachable (keyboard, large text). */
function Layout({ children, actions }: { children: ReactNode; actions: ReactNode }): React.JSX.Element {
  return (
    <>
      <ScrollView style={styles.content} contentContainerStyle={styles.contentInner} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
      <View style={styles.actions}>{actions}</View>
    </>
  );
}

function TimeSelector({ selection, disabled, controller }: { selection: TimeSelection; disabled: boolean; controller: AvailableTimeFlowController }): React.JSX.Element {
  const customSelected = selection.kind === "custom";
  const customValidation = customSelected ? validateCustomMinutes(selection.text) : null;
  return (
    <View style={styles.selector} accessibilityRole="radiogroup">
      <View style={styles.chipRow}>
        {QUICK_TIME_CHOICES_MINUTES.map((minutes) => {
          const selected = selection.kind === "preset" && selection.minutes === minutes;
          return (
            <Chip key={minutes} label={`${minutes} min`} selected={selected} disabled={disabled} onPress={() => controller.selectPreset(minutes)} accessibilityLabel={`${minutes} minutes`} />
          );
        })}
        <Chip label="Custom" selected={customSelected} disabled={disabled} onPress={() => controller.selectCustom()} accessibilityLabel="Custom time" />
      </View>
      {customSelected ? (
        <View style={styles.customField}>
          <View style={[styles.customInputRow, styles.customInputRowFocused]}>
            <TextInput
              value={selection.text}
              onChangeText={(text) => controller.setCustomText(text)}
              keyboardType="number-pad"
              inputMode="numeric"
              autoFocus
              maxLength={3}
              editable={!disabled}
              returnKeyType="done"
              onSubmitEditing={() => controller.requestPreview()}
              placeholder="Minutes"
              placeholderTextColor={colors.textTertiary}
              selectionColor={colors.signal}
              style={styles.customInput}
              accessibilityLabel="Custom available time in minutes, 1 to 240"
            />
            <Text style={styles.customSuffix}>min</Text>
          </View>
          {customValidation?.status === "invalid" ? (
            <Text style={styles.validation} accessibilityLiveRegion="polite">
              {customValidation.message}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function Chip(props: { label: string; selected: boolean; disabled: boolean; onPress: () => void; accessibilityLabel: string }): React.JSX.Element {
  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled}
      style={({ pressed }) => [styles.chip, props.selected && styles.chipSelected, pressed && styles.pressed]}
      accessibilityRole="radio"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{ checked: props.selected, disabled: props.disabled }}
    >
      <Text style={[styles.chipLabel, props.selected && styles.chipLabelSelected]}>{props.label}</Text>
    </Pressable>
  );
}

function Estimate({ label, seconds, emphasized = false }: { label: string; seconds: number; emphasized?: boolean }): React.JSX.Element {
  const minutes = estimatedMinutes(seconds);
  return (
    <View style={styles.estimate} accessible accessibilityLabel={`${label.toLowerCase()}, about ${minutes} minutes`}>
      <Text style={styles.estimateLabel}>{label}</Text>
      <Text style={[styles.estimateValue, emphasized && styles.estimateValueEmphasized]}>~{minutes} min</Text>
    </View>
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
    <Pressable
      onPress={props.onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled }}
    >
      <Text style={styles.secondaryButtonText}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.55)" },
  backdropTouch: StyleSheet.absoluteFill,
  sheetWrapper: { maxHeight: "92%" },
  sheet: {
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
  closeButton: { minWidth: touchTarget.minHeight, minHeight: touchTarget.minHeight, alignItems: "flex-end", justifyContent: "center" },
  closeGlyph: { ...typography.heading, color: colors.textSecondary },
  content: { flexGrow: 0 },
  contentInner: { gap: spacing.md, paddingBottom: spacing.lg },
  title: { ...typography.title, color: colors.textPrimary },
  body: { ...typography.body, color: colors.textSecondary },
  quiet: { ...typography.caption, color: colors.textTertiary },
  inlineMessage: { ...typography.caption, color: colors.textSecondary },
  selector: { gap: spacing.md, marginTop: spacing.xs },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  chip: {
    minHeight: touchTarget.minHeight,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceElevated,
    justifyContent: "center",
  },
  chipSelected: { borderColor: colors.signal },
  chipLabel: { ...typography.bodyStrong, color: colors.textSecondary },
  chipLabelSelected: { color: colors.textPrimary },
  customField: { gap: spacing.xs },
  customInputRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: touchTarget.minHeight,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.md,
  },
  customInputRowFocused: { borderColor: colors.signal },
  customInput: { flex: 1, ...typography.heading, color: colors.textPrimary, paddingVertical: spacing.sm },
  customSuffix: { ...typography.body, color: colors.textTertiary },
  validation: { ...typography.caption, color: colors.textSecondary },
  comparisonRow: {
    flexDirection: "row",
    alignItems: "stretch",
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.background,
    paddingVertical: spacing.md,
  },
  comparisonDivider: { width: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  estimate: { flex: 1, paddingHorizontal: spacing.md, gap: 2 },
  estimateLabel: { ...typography.tiny, color: colors.textTertiary, letterSpacing: 1.4 },
  estimateValue: { ...typography.heading, color: colors.textSecondary },
  estimateValueEmphasized: { color: colors.textPrimary },
  changeList: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  changeRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  changeName: { ...typography.bodyStrong, color: colors.textPrimary, flexShrink: 1 },
  changeDetail: { ...typography.body, color: colors.textSecondary, flexShrink: 0 },
  actions: { gap: spacing.sm, paddingTop: spacing.sm },
  primaryButton: { backgroundColor: colors.signal, borderRadius: radius.pill, minHeight: touchTarget.minHeight, alignItems: "center", justifyContent: "center" },
  primaryButtonDisabled: { opacity: 0.4 },
  primaryButtonText: { ...typography.bodyStrong, color: colors.signalText },
  secondaryButton: { minHeight: touchTarget.minHeight, alignItems: "center", justifyContent: "center", borderRadius: radius.pill },
  secondaryButtonText: { ...typography.bodyStrong, color: colors.textPrimary },
  pressed: { opacity: 0.85 },
});
