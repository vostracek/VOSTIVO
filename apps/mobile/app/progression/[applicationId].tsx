import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import type { ProgressionApplicationProposalResponseV1 } from "@vostivo/contracts";
import { createEntityId } from "@vostivo/domain";
import { useAthleteRuntime } from "../../src/identity/athlete-runtime-context";
import { ProgressionApiRequestFailure } from "../../src/progression/progression-api-client";
import { mapCommandResponseToUiOutcome, mapHttpErrorToUiOutcome } from "../../src/progression/progression-outcome-mapping";
import { formatLoad } from "../../src/workout/format-target";
import { colors, radius, spacing, touchTarget, typography } from "../../src/design/tokens";

/**
 * Progression Application V1 — Slice E — the focused Review Detail
 * surface ("Review Change" from Today's card). A dedicated Stack route
 * (`/progression/[applicationId]`), the same navigation convention
 * already used for Workout Preview (`app/workout/[plannedWorkoutId].tsx`)
 * — this repository has no bottom-sheet/modal library, so a route is the
 * existing convention, not a new one.
 *
 * Server remains sole authority throughout (task §8): every Apply/Keep
 * request carries only `commandId` + the server-issued proposal
 * precondition fields already on `ProgressionApplicationProposalResponseV1`
 * — never a client-chosen load, mode, or actor.
 *
 * Slice E final presentation-integrity gate (task §5): `applicationId` is
 * the ONLY navigation authority for this route — there is deliberately no
 * `exerciseDisplayName` route param. The exercise name rendered here comes
 * exclusively from the just-fetched canonical `proposal.exerciseDisplayName`
 * — this makes a direct/deep-link open of a bare `applicationId` behave
 * identically to one reached via Today's card (task §6).
 */

type ProposalAvailable = Extract<ProgressionApplicationProposalResponseV1, { status: "AVAILABLE" }>;

type ReviewState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly proposal: ProposalAvailable; readonly commandId: string; readonly refreshBannerVisible: boolean; readonly actionError: string | null }
  | { readonly kind: "unavailable" }
  | { readonly kind: "not-found" }
  | { readonly kind: "mode-changed" }
  | { readonly kind: "network-error"; readonly message: string }
  | { readonly kind: "done"; readonly outcome: "applied" | "kept-original" };

export default function ProgressionReviewScreen(): React.JSX.Element {
  const { progressionApiClient } = useAthleteRuntime();
  const { applicationId } = useLocalSearchParams<{ applicationId: string }>();
  const router = useRouter();
  const [state, setState] = useState<ReviewState>({ kind: "loading" });
  const [submitting, setSubmitting] = useState(false);

  // A `.then()/.catch()` chain, deliberately never `async`/`await`
  // (same convention as Plan/Preview's own mount fetches): this function's
  // own synchronous body calls no `setState` at all — only the nested
  // `.then`/`.catch` callbacks do, which never run synchronously during
  // the mount `useEffect` below (`react-hooks/set-state-in-effect`'s own
  // safe pattern). `mode: "initial"` relies on `useState`'s own
  // `{ kind: "loading" }` default rather than re-setting it here — a
  // Retry tap after a failed load (`mode: "initial"` again) simply keeps
  // showing that error view until the retry resolves, rather than an
  // intermediate loading flash, consistent with "no giant full-screen
  // spinner."
  const fetchProposal = useCallback(
    (mode: "initial" | "refresh") =>
      progressionApiClient
        .getProposal(applicationId)
        .then((proposal) => {
          if (proposal.status === "UNAVAILABLE") {
            setState({ kind: "unavailable" });
            return;
          }
          // A fresh proposal is a NEW logical confirmation — a new
          // commandId (task §12/§21). On the very first load this is
          // simply the first commandId ever issued for this review.
          setState({ kind: "ready", proposal, commandId: createEntityId(), refreshBannerVisible: mode === "refresh", actionError: null });
        })
        .catch((error: unknown) => {
          if (error instanceof ProgressionApiRequestFailure) {
            const outcome = mapHttpErrorToUiOutcome(error.status, error.message);
            if (outcome.kind === "not-found") return setState({ kind: "not-found" });
            if (outcome.kind === "mode-changed") return setState({ kind: "mode-changed" });
            return setState({ kind: "network-error", message: outcome.message });
          }
          // Not an HTTP response at all — `fetch` itself threw (task
          // §14/§18: genuinely offline/no connectivity). Calm copy, never
          // the raw platform error text.
          setState({ kind: "network-error", message: "Connect to review this training update." });
        }),
    [progressionApiClient, applicationId],
  );

  useEffect(() => {
    void fetchProposal("initial");
  }, [fetchProposal]);

  const submitCommand = useCallback(
    async (action: "apply" | "keep-original") => {
      if (state.kind !== "ready" || submitting) return;
      const { proposal, commandId } = state;
      setSubmitting(true);
      try {
        const response =
          action === "apply"
            ? await progressionApiClient.apply(applicationId, {
                commandId,
                expectedCurrentEffectiveLoad: proposal.currentEffectiveLoad,
                expectedLoadingCapabilityId: proposal.loadingCapabilityId,
                expectedLoadingCapabilityRevision: proposal.loadingCapabilityRevision,
                expectedResolverProposedLoad: proposal.resolverProposedLoad,
              })
            : await progressionApiClient.keepOriginal(applicationId, { commandId });

        const outcome = mapCommandResponseToUiOutcome(response);
        if (outcome.kind === "applied") return setState({ kind: "done", outcome: "applied" });
        if (outcome.kind === "kept-original") return setState({ kind: "done", outcome: "kept-original" });
        if (outcome.kind === "refresh-required") {
          await fetchProposal("refresh");
          return;
        }
        setState({ kind: "unavailable" });
      } catch (error: unknown) {
        if (error instanceof ProgressionApiRequestFailure) {
          const httpOutcome = mapHttpErrorToUiOutcome(error.status, error.message);
          if (httpOutcome.kind === "not-found") return setState({ kind: "not-found" });
          if (httpOutcome.kind === "mode-changed") return setState({ kind: "mode-changed" });
          // Transient (network/5xx, or the should-not-normally-happen
          // COMMAND_CONFLICT) — stay on the SAME ready state so Retry can
          // reuse the exact same commandId (task §21), never lose the
          // athlete's place in the review.
          setState((current) => (current.kind === "ready" ? { ...current, actionError: httpOutcome.message } : current));
          return;
        }
        // `fetch` itself threw — no connectivity. Calm copy (task §14),
        // never the raw platform error text; the ready state (and its
        // commandId) is preserved so Retry reuses the same attempt.
        setState((current) => (current.kind === "ready" ? { ...current, actionError: "Connect to try again." } : current));
      } finally {
        setSubmitting(false);
      }
    },
    [progressionApiClient, state, submitting, applicationId, fetchProposal],
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={["top", "bottom"]}>
      <View style={styles.navRow}>
        <Pressable onPress={() => router.back()} style={styles.backButton} accessibilityRole="button" accessibilityLabel="Back" hitSlop={8}>
          <Text style={styles.backButtonText}>‹ Back</Text>
        </Pressable>
      </View>
      <ScrollView style={styles.flex} contentContainerStyle={styles.scrollContent}>
        {state.kind === "loading" ? <Text style={styles.secondaryText}>Loading…</Text> : null}

        {state.kind === "not-found" ? (
          <EmptyState title="This item is no longer available" body="It may have already been reviewed elsewhere." onDone={() => router.back()} />
        ) : null}

        {state.kind === "mode-changed" ? (
          <EmptyState title="This is no longer available for review" body="Your training mode changed." onDone={() => router.back()} />
        ) : null}

        {state.kind === "unavailable" ? (
          <EmptyState title="This change can’t be applied right now." body={null} onDone={() => router.back()} />
        ) : null}

        {state.kind === "network-error" ? (
          <EmptyState title="Could not load this update" body={state.message} onDone={() => router.back()} onRetry={() => void fetchProposal("initial")} />
        ) : null}

        {state.kind === "done" ? (
          <EmptyState
            title={state.outcome === "applied" ? "Training plan updated." : "Original load kept."}
            body={null}
            onDone={() => router.back()}
            doneLabel="Done"
          />
        ) : null}

        {state.kind === "ready" ? (
          <ReadyContent
            proposal={state.proposal}
            refreshBannerVisible={state.refreshBannerVisible}
            actionError={state.actionError}
            submitting={submitting}
            onApply={() => void submitCommand("apply")}
            onKeepOriginal={() => void submitCommand("keep-original")}
          />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function ReadyContent({
  proposal,
  refreshBannerVisible,
  actionError,
  submitting,
  onApply,
  onKeepOriginal,
}: {
  proposal: ProposalAvailable;
  refreshBannerVisible: boolean;
  actionError: string | null;
  submitting: boolean;
  onApply: () => void;
  onKeepOriginal: () => void;
}): React.JSX.Element {
  return (
    <View style={styles.content}>
      {/* Canonical exercise identity — from the fetched proposal, never a route param (Slice E final presentation-integrity gate). */}
      <Text style={styles.exerciseName}>{proposal.exerciseDisplayName}</Text>

      <View style={styles.loadComparisonRow}>
        <View style={styles.loadColumn}>
          <Text style={styles.loadLabel}>CURRENT</Text>
          <Text style={styles.loadValue}>{formatLoad(proposal.currentEffectiveLoad)}</Text>
        </View>
        <Text style={styles.loadArrow}>→</Text>
        <View style={styles.loadColumn}>
          <Text style={[styles.loadLabel, styles.loadLabelSignal]}>RECOMMENDED</Text>
          <Text style={[styles.loadValue, styles.loadValueSignal]}>{formatLoad(proposal.resolverProposedLoad)}</Text>
        </View>
      </View>

      <Text style={styles.whyText}>Vostivo detected that this progression step is ready based on the progression decision.</Text>
      <Text style={styles.scopeText}>Applies to future sessions.</Text>

      {refreshBannerVisible ? <Text style={styles.refreshBanner}>The recommendation changed. Review the updated load before applying.</Text> : null}
      {actionError !== null ? <Text style={styles.errorText}>{actionError}</Text> : null}

      <Pressable
        disabled={submitting}
        onPress={onApply}
        style={({ pressed }) => [styles.primaryButton, pressed && styles.primaryButtonPressed, submitting && styles.buttonDisabled]}
        accessibilityRole="button"
        accessibilityLabel="Apply Change"
        accessibilityState={{ disabled: submitting, busy: submitting }}
      >
        <Text style={styles.primaryButtonText}>{submitting ? "Applying…" : "Apply Change"}</Text>
      </Pressable>
      <Pressable
        disabled={submitting}
        onPress={onKeepOriginal}
        style={({ pressed }) => [styles.secondaryButton, pressed && styles.secondaryButtonPressed, submitting && styles.buttonDisabled]}
        accessibilityRole="button"
        accessibilityLabel="Keep Original"
        accessibilityState={{ disabled: submitting, busy: submitting }}
      >
        <Text style={styles.secondaryButtonText}>Keep Original</Text>
      </Pressable>
    </View>
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
  loadComparisonRow: { flexDirection: "row", alignItems: "center", gap: spacing.lg, marginTop: spacing.sm },
  loadColumn: { gap: spacing.xs },
  loadLabel: { ...typography.tiny, color: colors.textTertiary, textTransform: "uppercase" },
  loadLabelSignal: { color: colors.signal },
  loadValue: { ...typography.title, color: colors.textPrimary },
  loadValueSignal: { color: colors.signal },
  loadArrow: { ...typography.title, color: colors.textTertiary },
  whyText: { ...typography.body, color: colors.textSecondary, marginTop: spacing.sm },
  scopeText: { ...typography.caption, color: colors.textTertiary },
  refreshBanner: { ...typography.body, color: colors.textPrimary, backgroundColor: colors.surfaceElevated, borderRadius: radius.md, padding: spacing.md },
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
  secondaryButtonPressed: { opacity: 0.85 },
  secondaryButtonText: { ...typography.bodyStrong, color: colors.textPrimary },
  buttonDisabled: { opacity: 0.6 },
});
