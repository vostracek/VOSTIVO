import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import type { LoadingSetupContextResponseV1 } from "@vostivo/contracts";
import { getGuidedLoadingSetupApiClient } from "../../../src/plan/plan-runtime";
import { ProgressionApiRequestFailure } from "../../../src/progression/progression-api-client";
import { mapHttpErrorToUiOutcome } from "../../../src/progression/progression-outcome-mapping";
import { parseEnumeratedListInput, parseFixedIncrementInput } from "../../../src/progression/loading-setup-input";
import { formatLoad } from "../../../src/workout/format-target";
import { colors, radius, spacing, touchTarget, typography } from "../../../src/design/tokens";

/**
 * Progression Application V1 — Slice F (Guided Blocked-Capability
 * Recovery / Contextual Loading Setup V1) — the focused contextual setup
 * surface reached only from Today's own "Set Up Loading" card. Route:
 * `/progression/[applicationId]/loading-setup` (task §5's own suggested
 * shape) — `applicationId` is the only navigation authority, same
 * discipline as the Review Detail screen next to it; NOT a Profile tab
 * (task §5's own explicit "do not enable Profile navigation in this
 * slice").
 *
 * The athlete here is configuring PHYSICAL EQUIPMENT TRUTH, never
 * approving a progression recommendation (task §0) — there is no
 * Apply/Keep-Original anywhere on this screen. Unit/basis are always
 * server-derived and shown read-only; the athlete only ever supplies the
 * configuration shape itself (task §7/§8).
 */

type ContextAvailable = Extract<LoadingSetupContextResponseV1, { status: "AVAILABLE" }>;
type ConfigKind = "FIXED_INCREMENT" | "ENUMERATED_LIST";

type ScreenState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly context: ContextAvailable }
  | { readonly kind: "not-recoverable" }
  | { readonly kind: "mode-changed" }
  | { readonly kind: "not-found" }
  | { readonly kind: "network-error"; readonly message: string }
  | { readonly kind: "done"; readonly copy: string };

export default function LoadingSetupScreen(): React.JSX.Element {
  const { applicationId } = useLocalSearchParams<{ applicationId: string }>();
  const router = useRouter();
  const [state, setState] = useState<ScreenState>({ kind: "loading" });
  const [configKind, setConfigKind] = useState<ConfigKind>("FIXED_INCREMENT");
  const [fixedIncrementText, setFixedIncrementText] = useState("");
  const [enumeratedListText, setEnumeratedListText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);

  const fetchContext = useCallback(
    () =>
      getGuidedLoadingSetupApiClient()
        .getContext(applicationId)
        .then((context) => {
          if (context.status === "NOT_RECOVERABLE") {
            setState({ kind: "not-recoverable" });
            return;
          }
          setState({ kind: "ready", context });
          if (context.currentConfiguration?.kind === "FIXED_INCREMENT") {
            setConfigKind("FIXED_INCREMENT");
          } else if (context.currentConfiguration?.kind === "ENUMERATED_LIST") {
            setConfigKind("ENUMERATED_LIST");
          }
        })
        .catch((error: unknown) => {
          if (error instanceof ProgressionApiRequestFailure) {
            const outcome = mapHttpErrorToUiOutcome(error.status, error.message);
            if (outcome.kind === "not-found") return setState({ kind: "not-found" });
            if (outcome.kind === "mode-changed") return setState({ kind: "mode-changed" });
            return setState({ kind: "network-error", message: outcome.message });
          }
          setState({ kind: "network-error", message: "Connect to set up loading for this exercise." });
        }),
    [applicationId],
  );

  useEffect(() => {
    void fetchContext();
  }, [fetchContext]);

  const onSave = useCallback(async () => {
    if (state.kind !== "ready" || submitting) return;
    setInlineError(null);

    const request =
      configKind === "FIXED_INCREMENT"
        ? (() => {
            const incrementAmountMilli = parseFixedIncrementInput(fixedIncrementText);
            if (incrementAmountMilli === null) {
              setInlineError("Enter a weight step greater than zero.");
              return null;
            }
            return { kind: "FIXED_INCREMENT" as const, incrementAmountMilli };
          })()
        : (() => {
            const parsed = parseEnumeratedListInput(enumeratedListText);
            if (!parsed.ok) {
              setInlineError(
                parsed.reason === "EMPTY"
                  ? "Enter the available weights, separated by commas."
                  : parsed.reason === "NOT_STRICTLY_ASCENDING"
                    ? "Enter each weight once, from lowest to highest."
                    : "Check the weights entered — one of them isn't a valid number.",
              );
              return null;
            }
            return { kind: "ENUMERATED_LIST" as const, loadsMilli: parsed.loadsMilli };
          })();

    if (request === null) return;

    setSubmitting(true);
    try {
      const result = await getGuidedLoadingSetupApiClient().save(applicationId, request);
      if (result.status === "APPLIED") return setState({ kind: "done", copy: "Loading setup saved. Training plan updated." });
      if (result.status === "SAVED_STILL_BLOCKED") {
        return setState({ kind: "done", copy: "Loading setup saved, but this progression still can’t be applied." });
      }
      if (result.status === "SAVED_RETRY_FAILED") {
        return setState({ kind: "done", copy: "Loading setup saved. Couldn’t update the plan yet." });
      }
      if (result.status === "INVALID_FIXED_INCREMENT" || result.status === "INVALID_ENUMERATED_LIST") {
        setInlineError("Check the weights entered — one of them isn't valid.");
        return;
      }
      // NOT_RECOVERABLE — the application stopped being current mid-flow.
      setState({ kind: "not-recoverable" });
    } catch (error: unknown) {
      if (error instanceof ProgressionApiRequestFailure) {
        const outcome = mapHttpErrorToUiOutcome(error.status, error.message);
        if (outcome.kind === "not-found") return setState({ kind: "not-found" });
        if (outcome.kind === "mode-changed") return setState({ kind: "mode-changed" });
        setInlineError(outcome.message);
        return;
      }
      setInlineError("Connect to try again.");
    } finally {
      setSubmitting(false);
    }
  }, [state, submitting, configKind, fixedIncrementText, enumeratedListText, applicationId]);

  return (
    <SafeAreaView style={styles.safeArea} edges={["top", "bottom"]}>
      <View style={styles.navRow}>
        <Pressable onPress={() => router.back()} style={styles.backButton} accessibilityRole="button" accessibilityLabel="Back" hitSlop={8}>
          <Text style={styles.backButtonText}>‹ Back</Text>
        </Pressable>
      </View>
      <ScrollView style={styles.flex} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        {state.kind === "loading" ? <Text style={styles.secondaryText}>Loading…</Text> : null}

        {state.kind === "not-found" ? (
          <EmptyState title="This item is no longer available" body="It may have already been resolved." onDone={() => router.back()} />
        ) : null}

        {state.kind === "mode-changed" ? (
          <EmptyState title="This is no longer available" body="Your training mode changed." onDone={() => router.back()} />
        ) : null}

        {state.kind === "not-recoverable" ? (
          <EmptyState title="This is no longer available" body="Your plan may have changed since this update was shown." onDone={() => router.back()} />
        ) : null}

        {state.kind === "network-error" ? (
          <EmptyState title="Could not load this update" body={state.message} onDone={() => router.back()} onRetry={() => void fetchContext()} />
        ) : null}

        {state.kind === "done" ? <EmptyState title={state.copy} body={null} onDone={() => router.back()} doneLabel="Done" /> : null}

        {state.kind === "ready" ? (
          <View style={styles.content}>
            <Text style={styles.exerciseName}>{state.context.exerciseDisplayName}</Text>
            <Text style={styles.secondaryText}>
              Current: {formatLoad(state.context.currentEffectiveLoad)}
            </Text>
            <Text style={styles.question}>How can this exercise increase at your gym?</Text>

            <View style={styles.kindToggleRow}>
              <Pressable
                onPress={() => setConfigKind("FIXED_INCREMENT")}
                style={[styles.kindToggle, configKind === "FIXED_INCREMENT" && styles.kindToggleActive]}
                accessibilityRole="button"
                accessibilityLabel="Fixed weight step"
              >
                <Text style={[styles.kindToggleText, configKind === "FIXED_INCREMENT" && styles.kindToggleTextActive]}>Fixed step</Text>
              </Pressable>
              <Pressable
                onPress={() => setConfigKind("ENUMERATED_LIST")}
                style={[styles.kindToggle, configKind === "ENUMERATED_LIST" && styles.kindToggleActive]}
                accessibilityRole="button"
                accessibilityLabel="Available weights list"
              >
                <Text style={[styles.kindToggleText, configKind === "ENUMERATED_LIST" && styles.kindToggleTextActive]}>Available weights</Text>
              </Pressable>
            </View>

            {configKind === "FIXED_INCREMENT" ? (
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>Weight step</Text>
                <TextInput
                  value={fixedIncrementText}
                  onChangeText={setFixedIncrementText}
                  keyboardType="decimal-pad"
                  placeholder="2.5"
                  placeholderTextColor={colors.textTertiary}
                  style={styles.textInput}
                  accessibilityLabel="Weight step"
                />
              </View>
            ) : (
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>Available weights, lowest to highest</Text>
                <TextInput
                  value={enumeratedListText}
                  onChangeText={setEnumeratedListText}
                  keyboardType="numbers-and-punctuation"
                  placeholder="20, 25, 30, 35, 40"
                  placeholderTextColor={colors.textTertiary}
                  style={styles.textInput}
                  accessibilityLabel="Available weights"
                />
              </View>
            )}

            {inlineError !== null ? <Text style={styles.errorText}>{inlineError}</Text> : null}

            <Pressable
              disabled={submitting}
              onPress={() => void onSave()}
              style={({ pressed }) => [styles.primaryButton, pressed && styles.primaryButtonPressed, submitting && styles.buttonDisabled]}
              accessibilityRole="button"
              accessibilityLabel="Save Loading Setup"
              accessibilityState={{ disabled: submitting, busy: submitting }}
            >
              <Text style={styles.primaryButtonText}>{submitting ? "Saving…" : "Save"}</Text>
            </Pressable>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function EmptyState({
  title,
  body,
  onDone,
  onRetry,
  doneLabel = "Back",
}: {
  title: string;
  body: string | null;
  onDone: () => void;
  onRetry?: () => void;
  doneLabel?: string;
}): React.JSX.Element {
  return (
    <View style={styles.content}>
      <Text style={styles.exerciseName}>{title}</Text>
      {body !== null ? <Text style={styles.secondaryText}>{body}</Text> : null}
      {onRetry !== undefined ? (
        <Pressable onPress={onRetry} style={styles.secondaryButton} accessibilityRole="button" accessibilityLabel="Retry">
          <Text style={styles.secondaryButtonText}>Retry</Text>
        </Pressable>
      ) : null}
      <Pressable onPress={onDone} style={styles.primaryButton} accessibilityRole="button" accessibilityLabel={doneLabel}>
        <Text style={styles.primaryButtonText}>{doneLabel}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  navRow: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.xs },
  backButton: { alignSelf: "flex-start", minHeight: touchTarget.minHeight, justifyContent: "center", paddingVertical: spacing.xs },
  backButtonText: { ...typography.bodyStrong, color: colors.textPrimary },
  scrollContent: { flexGrow: 1, paddingBottom: spacing.xxl },
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.md },
  secondaryText: { ...typography.body, color: colors.textSecondary },
  errorText: { ...typography.body, color: colors.danger },
  exerciseName: { ...typography.title, color: colors.textPrimary },
  question: { ...typography.heading, color: colors.textPrimary, marginTop: spacing.sm },
  kindToggleRow: { flexDirection: "row", gap: spacing.sm },
  kindToggle: {
    flex: 1,
    borderRadius: radius.pill,
    minHeight: touchTarget.minHeight,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  kindToggleActive: { borderColor: colors.signal, backgroundColor: colors.surface },
  kindToggleText: { ...typography.bodyStrong, color: colors.textSecondary },
  kindToggleTextActive: { color: colors.signal },
  field: { gap: spacing.xs },
  fieldLabel: { ...typography.caption, color: colors.textTertiary },
  textInput: {
    ...typography.title,
    color: colors.textPrimary,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    minHeight: touchTarget.minHeight,
  },
  primaryButton: {
    backgroundColor: colors.signal,
    borderRadius: radius.pill,
    minHeight: touchTarget.minHeight,
    alignItems: "center",
    justifyContent: "center",
    marginTop: spacing.sm,
  },
  primaryButtonPressed: { opacity: 0.85 },
  primaryButtonText: { ...typography.bodyStrong, color: colors.signalText },
  secondaryButton: {
    backgroundColor: colors.surfaceElevated,
    borderRadius: radius.pill,
    minHeight: touchTarget.minHeight,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryButtonText: { ...typography.bodyStrong, color: colors.textPrimary },
  buttonDisabled: { opacity: 0.6 },
});
