import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import type { GuidedLoadingSetupAttentionV1, PendingProgressionApplicationV1, PlanSessionSummaryV1 } from "@vostivo/contracts";
import { initializeLocalDatabase } from "../src/local-database/client";
import {
  getAvailableTimeFlowPorts,
  getEquipmentFlowPorts,
  getGuidedLoadingSetupApiClient,
  getMissedWorkoutFlowPorts,
  getPlanApplicationService,
  getProgressionApiClient,
  getWorkoutSyncCoordinator,
  logTechnicalFailure,
} from "../src/plan/plan-runtime";
import { deriveTodayHeroState, type TodayOverviewState } from "../src/plan/today-derivation";
import { completedTodayView } from "../src/plan/today-completed-presentation";
import { formatLoad } from "../src/workout/format-target";
import { BottomNav } from "../src/ui/bottom-nav";
import { AvailableTimeSheet } from "../src/available-time/available-time-sheet";
import { adjustableTodaySession } from "../src/available-time/available-time-flow";
import { MissedWorkoutFlowController } from "../src/missed-workout/missed-workout-controller";
import { INITIAL_MISSED_WORKOUT_STATE, missedWorkoutCard, type MissedWorkoutFlowState } from "../src/missed-workout/missed-workout-flow";
import { MissedWorkoutCard } from "../src/missed-workout/missed-workout-card";
import { MissedWorkoutReviewSheet } from "../src/missed-workout/missed-workout-review-sheet";
import { sessionScheduleNote } from "../src/plan/plan-session-schedule";
import { EquipmentSheet } from "../src/equipment/equipment-sheet";
import { EQUIPMENT_COPY, equipmentAdjustedCount, equipmentAdjustedLabel } from "../src/equipment/equipment-flow";
import { colors, radius, spacing, touchTarget, typography } from "../src/design/tokens";

/**
 * Athlete Mobile Today V1 Foundation + Progression Application V1 Slice
 * E — the app's root route (`/`). Locked principle: SNAPSHOT -> ACTION ->
 * DETAIL ON DEMAND, and ONE SCREEN, ONE PRIMARY JOB — "what should I do
 * today?", answered by one dominant Workout Hero. All Hero state
 * derivation is delegated to the pure, unit-tested `deriveTodayHeroState`
 * (`src/plan/today-derivation.ts`) — this file only renders whatever
 * `TodayHeroState` that produces and wires the Start Workout action to
 * the exact same `PlanApplicationService.getWorkoutPreview`/
 * `startWorkout` calls the existing Workout Preview screen already uses
 * (no second Start implementation).
 *
 * The reserved composition point below the Hero (task §2 of the original
 * Slice-E spec) now renders a Progression Review card when the
 * server-owned `GET pending` list has an actionable item — never more
 * than one, never for GUIDED (the server itself always returns an empty
 * list for GUIDED, task §4/§9 — Today never locally infers mode
 * authority). Tapping it only ever navigates to the focused Review Detail
 * screen (`app/progression/[applicationId].tsx`) — there is no direct
 * Apply from Today (task §9).
 */

type StartState = { readonly status: "idle" } | { readonly status: "starting" } | { readonly status: "error"; readonly message: string };

type ProgressionPendingState =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly item: PendingProgressionApplicationV1 | null };

type GuidedLoadingSetupState =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly item: GuidedLoadingSetupAttentionV1 | null };

export default function TodayScreen(): React.JSX.Element {
  const router = useRouter();
  const [overviewState, setOverviewState] = useState<TodayOverviewState>({ status: "loading" });
  // Independent of the overview fetch for the same reason as Plan's own
  // Resume banner: a failed Today network request must never hide a real
  // Resume path, since resuming never needed the network to begin with.
  const [hasActiveSessionAnywhere, setHasActiveSessionAnywhere] = useState(false);
  const [startState, setStartState] = useState<StartState>({ status: "idle" });
  const [progressionState, setProgressionState] = useState<ProgressionPendingState>({ status: "loading" });
  const [guidedSetupState, setGuidedSetupState] = useState<GuidedLoadingSetupState>({ status: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((token) => token + 1), []);
  // Available-Time Slice D: which planned workout the sheet is open for (null = closed),
  // plus an opening counter so every opening mounts a fresh flow with NO time preselected.
  const [adjustTarget, setAdjustTarget] = useState<{ readonly plannedWorkoutId: string; readonly opening: number } | null>(null);
  const closeAdjustSheet = useCallback(() => setAdjustTarget(null), []);
  // Temporary Equipment V1 Slice D: same pattern — the target workout + an opening counter (fresh flow per opening).
  const [equipmentTarget, setEquipmentTarget] = useState<{ readonly plannedWorkoutId: string; readonly opening: number } | null>(null);
  const closeEquipmentSheet = useCallback(() => setEquipmentTarget(null), []);
  // The quiet "Equipment adjusted" line comes ONLY from the server's effective Workout Preview (never optimistic).
  const [equipmentAdjusted, setEquipmentAdjusted] = useState<{ readonly plannedWorkoutId: string; readonly count: number } | null>(null);
  // Missed Workout V1 Slice D: an OPTIONAL, secondary adaptation flow. Its
  // preview is fetched independently of the overview (a failure never
  // touches the Hero), it never auto-applies, and a successful Apply only
  // re-reads Today/Plan (the server's effective schedule) — never a start.
  const [missedState, setMissedState] = useState<MissedWorkoutFlowState>(INITIAL_MISSED_WORKOUT_STATE);
  const missedController = useMemo(
    () => new MissedWorkoutFlowController(getMissedWorkoutFlowPorts(), { onStateChange: setMissedState, refreshToday: reload, logFailure: logTechnicalFailure }),
    [reload],
  );
  useEffect(() => () => missedController.dispose(), [missedController]);
  const navigateToActiveWorkout = useCallback(() => {
    setAdjustTarget(null);
    // `replace`, not `push` — same as Today's own Start handling.
    router.replace("/active-workout");
  }, [router]);

  useEffect(() => {
    let cancelled = false;

    initializeLocalDatabase()
      .then(() => getPlanApplicationService().getActiveWorkoutSession())
      .then((activeSession) => {
        if (!cancelled) setHasActiveSessionAnywhere(activeSession !== undefined);
      })
      .catch(() => {
        // Best-effort — the Resume affordance simply stays hidden if this
        // fails; it never blocks the rest of the screen.
      });

    getPlanApplicationService()
      .getCurrentPlan()
      .then((overview) => {
        if (!cancelled) setOverviewState({ status: "ready", overview });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setOverviewState({ status: "error", message: error instanceof Error ? error.message : String(error) });
        }
      });

    // Independent of both fetches above (task §4 of the original Slice-E
    // spec — the server contract wins; a failed/slow Plan fetch must never
    // hide or block a real, separately-fetched progression review card,
    // and vice versa). Server already returns at most the athlete's own
    // actionable items, already ordered oldest-actionable-first — Today
    // only ever renders `applications[0]`, never re-ranks it.
    getProgressionApiClient()
      .getPending()
      .then((response) => {
        if (!cancelled) setProgressionState({ status: "ready", item: response.applications[0] ?? null });
      })
      .catch(() => {
        // A failed progression fetch simply hides the card — it is
        // low-priority, event-driven content, never worth an error banner
        // on Today's own primary surface.
        if (!cancelled) setProgressionState({ status: "error" });
      });

    // Slice F — mutually exclusive with the progression review card above
    // by construction (GUIDED never has pending review items; only GUIDED
    // ever has a recovery attention item, task §4/§2's own server-derived
    // guarantee) — fetched independently for the same reason.
    getGuidedLoadingSetupApiClient()
      .getAttention()
      .then((response) => {
        if (!cancelled) setGuidedSetupState({ status: "ready", item: response.item });
      })
      .catch(() => {
        if (!cancelled) setGuidedSetupState({ status: "error" });
      });

    // Bootstraps the training time zone once (never overwriting a saved
    // one), then previews; keeps whatever it showed while reloading.
    void missedController.load();

    return () => {
      cancelled = true;
    };
  }, [reloadToken, missedController]);

  // Re-check on every focus (returning from Active Workout, or from Plan)
  // so a session started/finished elsewhere is reflected immediately —
  // same convention as the Plan screen.
  useFocusEffect(reload);

  const heroState = deriveTodayHeroState({ hasActiveSessionAnywhere, overview: overviewState });
  const adjustableSession = adjustableTodaySession(heroState);
  const adjustableWorkoutId = adjustableSession?.plannedWorkoutId ?? null;

  // Re-read the effective Workout Preview of today's adjustable workout on every Today reload. Informational
  // only: a failure keeps the last known line (no flash) and never touches the Hero or Start Workout.
  useEffect(() => {
    // No adjustable workout: the line is hidden by the id match below (no state reset needed).
    if (adjustableWorkoutId === null) return undefined;
    let cancelled = false;
    getPlanApplicationService()
      .getWorkoutPreview(adjustableWorkoutId)
      .then((preview) => {
        if (!cancelled) setEquipmentAdjusted({ plannedWorkoutId: adjustableWorkoutId, count: equipmentAdjustedCount(preview) });
      })
      .catch(() => logTechnicalFailure("today equipment state read failed"));
    return () => {
      cancelled = true;
    };
  }, [adjustableWorkoutId, reloadToken]);
  const equipmentLabel = equipmentAdjusted !== null && equipmentAdjusted.plannedWorkoutId === adjustableWorkoutId ? equipmentAdjustedLabel(equipmentAdjusted.count) : null;

  const onStartWorkout = useCallback(
    async (session: PlanSessionSummaryV1) => {
      if (session.plannedWorkoutId === null) return;
      setStartState({ status: "starting" });
      try {
        const preview = await getPlanApplicationService().getWorkoutPreview(session.plannedWorkoutId);
        const outcome = await getPlanApplicationService().startWorkout(preview);
        // START is durable locally now; syncing it is fire-and-forget.
        if (outcome.status === "STARTED") getWorkoutSyncCoordinator().requestSync("mutation");
        if (outcome.status === "STARTED" || outcome.status === "ALREADY_ACTIVE") {
          // `replace`, not `push` — Today must not remain underneath
          // Active Workout on the stack (same reasoning as Workout
          // Preview's own Start handling).
          router.replace("/active-workout");
          return;
        }
      } catch (error: unknown) {
        setStartState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      }
    },
    [router],
  );

  const pendingProgressionItem = progressionState.status === "ready" ? progressionState.item : null;
  // Slice D: today's training is done — no missed-workout adaptation competes with that.
  const missedCard = heroState.kind === "completed-today" ? null : missedWorkoutCard(missedState);
  const guidedSetupItem = guidedSetupState.status === "ready" ? guidedSetupState.item : null;

  return (
    <SafeAreaView style={styles.safeArea} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Text style={styles.screenTitle}>Today</Text>
        <WorkoutHero
          heroState={heroState}
          startState={startState}
          onStartWorkout={onStartWorkout}
          onResume={() => router.push("/active-workout")}
          onRetry={reload}
          onViewPlan={() => router.replace("/plan")}
          onViewWorkout={(href) => router.push(href)}
          onAdjustTime={
            adjustableSession === null
              ? null
              : () => setAdjustTarget((current) => ({ plannedWorkoutId: adjustableSession.plannedWorkoutId, opening: (current?.opening ?? 0) + 1 }))
          }
          onEquipment={
            adjustableSession === null
              ? null
              : () => setEquipmentTarget((current) => ({ plannedWorkoutId: adjustableSession.plannedWorkoutId, opening: (current?.opening ?? 0) + 1 }))
          }
          equipmentLabel={equipmentLabel}
        />
        {missedCard !== null ? (
          <MissedWorkoutCard
            card={missedCard}
            onReview={() => missedController.openReview()}
            onViewPlan={() => router.replace("/plan")}
            onRetryTimeZone={() => void missedController.retryTimeZone()}
          />
        ) : null}
        {/* The reserved composition point below the Hero (Today V1
            Foundation) — a Progression Review card when one is
            actionable, nothing otherwise. No empty placeholder card. */}
        {pendingProgressionItem !== null ? (
          <ProgressionReviewCard
            item={pendingProgressionItem}
            // applicationId is the ONLY navigation authority (Slice E final
            // presentation-integrity gate, task §5) — Review Detail fetches
            // its own canonical proposal and renders `proposal.
            // exerciseDisplayName`; a navigation parameter is never treated
            // as exercise-identity authority.
            onReview={() => router.push(`/progression/${encodeURIComponent(pendingProgressionItem.applicationId)}`)}
          />
        ) : guidedSetupItem !== null ? (
          <GuidedLoadingSetupCard
            item={guidedSetupItem}
            onSetUp={() => router.push(`/progression/${encodeURIComponent(guidedSetupItem.applicationId)}/loading-setup`)}
          />
        ) : null}
      </ScrollView>
      <BottomNav active="today" />
      {missedState.kind === "ROLL_FORWARD" && missedState.reviewOpen ? (
        <MissedWorkoutReviewSheet state={missedState} onApply={() => void missedController.apply()} onNotNow={() => missedController.notNow()} />
      ) : null}
      {adjustTarget !== null ? (
        <AvailableTimeSheet
          key={`${adjustTarget.plannedWorkoutId}-${adjustTarget.opening}`}
          plannedWorkoutId={adjustTarget.plannedWorkoutId}
          ports={getAvailableTimeFlowPorts()}
          onDismiss={closeAdjustSheet}
          onNavigateToActiveWorkout={navigateToActiveWorkout}
          onRefreshToday={reload}
        />
      ) : null}
      {equipmentTarget !== null ? (
        <EquipmentSheet
          key={`${equipmentTarget.plannedWorkoutId}-${equipmentTarget.opening}`}
          plannedWorkoutId={equipmentTarget.plannedWorkoutId}
          ports={getEquipmentFlowPorts()}
          onDismiss={closeEquipmentSheet}
          onRefreshToday={reload}
          logFailure={logTechnicalFailure}
        />
      ) : null}
    </SafeAreaView>
  );
}

function ProgressionReviewCard({ item, onReview }: { item: PendingProgressionApplicationV1; onReview: () => void }): React.JSX.Element {
  return (
    <Pressable
      onPress={onReview}
      style={({ pressed }) => [styles.reviewCard, pressed && styles.reviewCardPressed]}
      accessibilityRole="button"
      accessibilityLabel={`Review progression change for ${item.exerciseDisplayName}`}
    >
      <Text style={styles.reviewMicroLabel}>TRAINING UPDATE</Text>
      <Text style={styles.reviewTitle}>Progression ready</Text>
      <Text style={styles.reviewExercise}>{item.exerciseDisplayName}</Text>
      {item.proposalAvailable && item.resolverProposedLoad !== null ? (
        <Text style={styles.reviewLoadLine}>
          {formatLoad(item.currentEffectiveLoad)} → {formatLoad(item.resolverProposedLoad)}
        </Text>
      ) : null}
      <Text style={styles.reviewSecondary}>You&apos;re ready to increase the load.</Text>
      <Text style={styles.reviewCta}>Review Change</Text>
    </Pressable>
  );
}

/**
 * Task §3 (Slice F) — deliberately NOT a Progression Review card: no
 * Apply/Keep Original, no "Progression ready" copy, no red/alarm styling.
 * The athlete is configuring physical equipment truth, never approving a
 * recommendation (task §0's own hard distinction).
 */
function GuidedLoadingSetupCard({ item, onSetUp }: { item: GuidedLoadingSetupAttentionV1; onSetUp: () => void }): React.JSX.Element {
  return (
    <Pressable
      onPress={onSetUp}
      style={({ pressed }) => [styles.reviewCard, pressed && styles.reviewCardPressed]}
      accessibilityRole="button"
      accessibilityLabel={`Set up loading for ${item.exerciseDisplayName}`}
    >
      <Text style={styles.reviewMicroLabel}>SETUP NEEDED</Text>
      <Text style={styles.reviewTitle}>Set loading for {item.exerciseDisplayName}</Text>
      <Text style={styles.reviewSecondary}>Vostivo needs your gym&apos;s weight steps to apply this progression automatically.</Text>
      <Text style={styles.reviewCta}>Set Up Loading</Text>
    </Pressable>
  );
}

function WorkoutHero({
  heroState,
  startState,
  onStartWorkout,
  onResume,
  onRetry,
  onViewPlan,
  onViewWorkout,
  onAdjustTime,
  onEquipment,
  equipmentLabel,
}: {
  heroState: ReturnType<typeof deriveTodayHeroState>;
  startState: StartState;
  onStartWorkout: (session: PlanSessionSummaryV1) => void;
  onResume: () => void;
  onRetry: () => void;
  onViewPlan: () => void;
  /** Slice D — the canonical completed session's history. */
  onViewWorkout: (href: `/progress/workouts/${string}`) => void;
  /** Available-Time Slice D — `null` hides the action (no eligible workout / Resume wins). */
  onAdjustTime: (() => void) | null;
  /** Temporary Equipment Slice D — `null` hides the action (same eligibility as Adjust time). */
  onEquipment: (() => void) | null;
  /** "Equipment adjusted · N exercises" from the server's effective Workout Preview, or `null`. */
  equipmentLabel: string | null;
}): React.JSX.Element {
  switch (heroState.kind) {
    case "loading":
      return (
        <View style={[styles.heroCard, styles.heroCardSkeleton]}>
          <Text style={styles.secondaryText}>Loading today&apos;s training…</Text>
        </View>
      );

    case "error":
      return (
        <View style={styles.heroCard}>
          <Text style={styles.heroTitle}>Could not load today</Text>
          <Text style={styles.secondaryText}>{heroState.message}</Text>
          <Pressable onPress={onRetry} style={styles.secondaryButton} accessibilityRole="button" accessibilityLabel="Retry">
            <Text style={styles.secondaryButtonText}>Retry</Text>
          </Pressable>
        </View>
      );

    case "resume":
      return (
        <View style={[styles.heroCard, styles.heroCardActive]}>
          <Text style={styles.heroMicroLabel}>IN PROGRESS</Text>
          <Text style={styles.heroTitle}>Workout in progress</Text>
          <Pressable onPress={onResume} style={styles.primaryButton} accessibilityRole="button" accessibilityLabel="Resume Workout">
            <Text style={styles.primaryButtonText}>Resume Workout</Text>
          </Pressable>
        </View>
      );

    case "no-plan":
      return (
        <View style={styles.heroCard}>
          <Text style={styles.heroTitle}>No active training plan</Text>
          <Text style={styles.secondaryText}>Get a Vostivo plan to see today&apos;s training here.</Text>
          <Pressable onPress={onViewPlan} style={styles.secondaryButton} accessibilityRole="button" accessibilityLabel="View Plan">
            <Text style={styles.secondaryButtonText}>View Plan</Text>
          </Pressable>
        </View>
      );

    case "rest":
      return (
        <View style={styles.heroCard}>
          <Text style={styles.heroMicroLabel}>TODAY</Text>
          <Text style={styles.heroTitle}>Rest day</Text>
          <Text style={styles.secondaryText}>Everything is on track.</Text>
          {heroState.nextWorkout !== null ? (
            <View style={styles.nextWorkoutRow}>
              <Text style={styles.nextWorkoutLabel}>Next workout</Text>
              <Text style={styles.nextWorkoutName}>{heroState.nextWorkout.name}</Text>
            </View>
          ) : null}
        </View>
      );

    case "completed-today": {
      // Slice D: calm, no primary training action left — only the history of what was done.
      const view = completedTodayView(heroState.completed, heroState.nextWorkout);
      return (
        <View style={styles.heroCard}>
          <View accessible accessibilityLabel={view.accessibilityLabel} style={styles.completedSummary}>
            <Text style={styles.heroMicroLabel}>{view.microLabel}</Text>
            <Text style={styles.heroTitle}>{view.title}</Text>
            <Text style={styles.secondaryText}>{view.body}</Text>
          </View>
          <Pressable onPress={() => onViewWorkout(view.viewWorkoutHref)} style={styles.secondaryButton} accessibilityRole="button" accessibilityLabel="View completed workout">
            <Text style={styles.secondaryButtonText}>{view.viewWorkoutLabel}</Text>
          </Pressable>
          {view.next !== null ? (
            <View style={styles.nextWorkoutRow}>
              <Text style={styles.nextWorkoutLabel}>Next</Text>
              <Text style={styles.nextWorkoutName}>{view.next}</Text>
            </View>
          ) : null}
        </View>
      );
    }

    case "training-day": {
      const { session } = heroState;
      const isStarting = startState.status === "starting";
      // Missed Workout Slice D: a rolled-forward workout shows its authored day as quiet context only.
      const scheduleNote = sessionScheduleNote(session);
      return (
        <View style={[styles.heroCard, styles.heroCardActive]}>
          <Text style={styles.heroMicroLabel}>TODAY</Text>
          <Text style={styles.heroTitle}>{session.name}</Text>
          {session.focus !== null ? <Text style={styles.heroFocus}>{session.focus}</Text> : null}
          {scheduleNote.kind === "ADJUSTED" && scheduleNote.originally !== null ? <Text style={styles.heroDuration}>{scheduleNote.originally}</Text> : null}
          {session.estimatedDurationMinutes !== null || onAdjustTime !== null || onEquipment !== null ? (
            <View style={styles.heroMetaRow}>
              {session.estimatedDurationMinutes !== null ? <Text style={styles.heroDuration}>{session.estimatedDurationMinutes} min</Text> : null}
              {onAdjustTime !== null ? (
                <Pressable
                  onPress={onAdjustTime}
                  disabled={isStarting}
                  hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
                  style={styles.adjustTimeLink}
                  accessibilityRole="button"
                  accessibilityLabel="Adjust workout time"
                  accessibilityState={{ disabled: isStarting }}
                >
                  <Text style={styles.adjustTimeLinkText}>Adjust time</Text>
                </Pressable>
              ) : null}
              {onEquipment !== null ? (
                <Pressable
                  onPress={onEquipment}
                  disabled={isStarting}
                  hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
                  style={styles.adjustTimeLink}
                  accessibilityRole="button"
                  accessibilityLabel="Equipment available today"
                  accessibilityState={{ disabled: isStarting }}
                >
                  <Text style={styles.adjustTimeLinkText}>{EQUIPMENT_COPY.todayAction}</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {equipmentLabel !== null ? <Text style={styles.heroDuration}>{equipmentLabel}</Text> : null}
          {startState.status === "error" ? <Text style={styles.errorText}>{startState.message}</Text> : null}
          <Pressable
            disabled={isStarting}
            onPress={() => onStartWorkout(session)}
            style={({ pressed }) => [styles.primaryButton, pressed && styles.primaryButtonPressed, isStarting && styles.primaryButtonDisabled]}
            accessibilityRole="button"
            accessibilityLabel="Start Workout"
            accessibilityState={{ disabled: isStarting, busy: isStarting }}
          >
            <Text style={styles.primaryButtonText}>{isStarting ? "Starting…" : "Start Workout"}</Text>
          </Pressable>
        </View>
      );
    }
  }
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  scrollContent: { flexGrow: 1, paddingBottom: spacing.xl },
  screenTitle: { ...typography.title, color: colors.textPrimary, paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.sm },
  secondaryText: { ...typography.body, color: colors.textSecondary },
  errorText: { ...typography.body, color: colors.danger },
  heroCard: {
    marginHorizontal: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  heroCardActive: { borderColor: colors.signal },
  heroCardSkeleton: { opacity: 0.6 },
  completedSummary: { gap: spacing.sm },
  heroMicroLabel: { ...typography.tiny, color: colors.textTertiary, textTransform: "uppercase" },
  heroTitle: { ...typography.title, color: colors.textPrimary },
  heroFocus: { ...typography.body, color: colors.textSecondary },
  heroDuration: { ...typography.caption, color: colors.textTertiary },
  heroMetaRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  // Visually quiet, but a full touch target (minHeight + hitSlop).
  adjustTimeLink: { minHeight: touchTarget.minHeight, justifyContent: "center" },
  adjustTimeLinkText: { ...typography.caption, color: colors.textSecondary, textDecorationLine: "underline" },
  nextWorkoutRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs, marginTop: spacing.xs },
  nextWorkoutLabel: { ...typography.caption, color: colors.textTertiary },
  nextWorkoutName: { ...typography.bodyStrong, color: colors.textPrimary },
  primaryButton: {
    backgroundColor: colors.signal,
    borderRadius: radius.pill,
    minHeight: touchTarget.minHeight,
    alignItems: "center",
    justifyContent: "center",
    marginTop: spacing.xs,
  },
  primaryButtonPressed: { opacity: 0.85 },
  primaryButtonDisabled: { opacity: 0.6 },
  primaryButtonText: { ...typography.bodyStrong, color: colors.signalText },
  secondaryButton: {
    alignSelf: "flex-start",
    backgroundColor: colors.surfaceElevated,
    borderRadius: radius.pill,
    minHeight: touchTarget.minHeight,
    paddingHorizontal: spacing.lg,
    justifyContent: "center",
    marginTop: spacing.xs,
  },
  secondaryButtonText: { ...typography.bodyStrong, color: colors.textPrimary },
  reviewCard: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: 2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  reviewCardPressed: { opacity: 0.85 },
  reviewMicroLabel: { ...typography.tiny, color: colors.textTertiary, textTransform: "uppercase" },
  reviewTitle: { ...typography.heading, color: colors.textPrimary, marginTop: spacing.xs },
  reviewExercise: { ...typography.bodyStrong, color: colors.textPrimary, marginTop: spacing.xs },
  reviewLoadLine: { ...typography.body, color: colors.signal },
  reviewSecondary: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  reviewCta: { ...typography.bodyStrong, color: colors.signal, marginTop: spacing.sm },
});
