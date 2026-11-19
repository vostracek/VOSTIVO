import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import type { GuidedLoadingSetupAttentionV1, PendingProgressionApplicationV1, PlanOverviewV1, PlanSessionSummaryV1 } from "@vostivo/contracts";
import { logTechnicalFailure } from "../src/plan/plan-runtime";
import { useAthleteRuntime, useAuthRecoveryCount } from "../src/identity/athlete-runtime-context";
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
import { longDayLabel } from "../src/missed-workout/missed-workout-flow";
import { blockWeekLabel, todayMetaParts, weekStrip, type WeekStripView } from "../src/plan/week-presentation";
import { EquipmentSheet } from "../src/equipment/equipment-sheet";
import { EQUIPMENT_COPY, equipmentAdjustedCount, equipmentAdjustedLabel } from "../src/equipment/equipment-flow";
import { semantic, spacing, type } from "../src/design/tokens";
import { Icon } from "../src/ui/icon";
import { PrimaryButton, SecondaryButton, StatusMarker, TextAction, TopGlow, UpdateCard, Wordmark } from "../src/ui/primitives";
import { UnresolvedSyncMonitor, type UnresolvedSyncNotice } from "../src/workout/unresolved-sync-notice";

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
  const { availableTimeFlowPorts, equipmentFlowPorts, guidedLoadingSetupApiClient, missedWorkoutFlowPorts, planApplicationService, progressionApiClient, unresolvedSyncPorts, workoutSyncCoordinator } = useAthleteRuntime();
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
  const authRecoveries = useAuthRecoveryCount();
  // Available-Time Slice D: which planned workout the sheet is open for (null = closed),
  // plus an opening counter so every opening mounts a fresh flow with NO time preselected.
  const [adjustTarget, setAdjustTarget] = useState<{ readonly plannedWorkoutId: string; readonly opening: number } | null>(null);
  const closeAdjustSheet = useCallback(() => setAdjustTarget(null), []);
  // Temporary Equipment V1 Slice D: same pattern — the target workout + an opening counter (fresh flow per opening).
  const [equipmentTarget, setEquipmentTarget] = useState<{ readonly plannedWorkoutId: string; readonly opening: number } | null>(null);
  const closeEquipmentSheet = useCallback(() => setEquipmentTarget(null), []);
  // The quiet "Equipment adjusted" line comes ONLY from the server's effective Workout Preview (never optimistic).
  // Design Integration 01: the same read also gives the hero its REAL exercise count ("5 exercises").
  const [equipmentAdjusted, setEquipmentAdjusted] = useState<{ readonly plannedWorkoutId: string; readonly count: number; readonly exerciseCount: number } | null>(null);
  // Missed Workout V1 Slice D: an OPTIONAL, secondary adaptation flow. Its
  // preview is fetched independently of the overview (a failure never
  // touches the Hero), it never auto-applies, and a successful Apply only
  // re-reads Today/Plan (the server's effective schedule) — never a start.
  const [missedState, setMissedState] = useState<MissedWorkoutFlowState>(INITIAL_MISSED_WORKOUT_STATE);
  const missedController = useMemo(
    () => new MissedWorkoutFlowController(missedWorkoutFlowPorts, { onStateChange: setMissedState, refreshToday: reload, logFailure: logTechnicalFailure }),
    [missedWorkoutFlowPorts, reload],
  );
  useEffect(() => () => missedController.dispose(), [missedController]);
  // CC-03: a calm local-outbox notice, independent of every network read —
  // re-read after every settled sync pass (which also covers app resume:
  // foreground triggers a pass) and on every Today reload below.
  // Created inside the effect (not memoized), so a re-run effect (Fast
  // Refresh, StrictMode) never keeps a disposed monitor.
  const [syncNotice, setSyncNotice] = useState<UnresolvedSyncNotice | null>(null);
  const syncMonitorRef = useRef<UnresolvedSyncMonitor | null>(null);
  useEffect(() => {
    const monitor = new UnresolvedSyncMonitor(unresolvedSyncPorts, setSyncNotice, logTechnicalFailure);
    syncMonitorRef.current = monitor;
    monitor.start();
    return () => {
      monitor.dispose();
      if (syncMonitorRef.current === monitor) syncMonitorRef.current = null;
    };
  }, [unresolvedSyncPorts]);
  useEffect(() => {
    void syncMonitorRef.current?.refresh();
  }, [reloadToken]);
  const navigateToActiveWorkout = useCallback(() => {
    setAdjustTarget(null);
    // `replace`, not `push` — same as Today's own Start handling.
    router.replace("/active-workout");
  }, [router]);

  useEffect(() => {
    let cancelled = false;

    planApplicationService
      .getActiveWorkoutSession()
      .then((activeSession) => {
        if (!cancelled) setHasActiveSessionAnywhere(activeSession !== undefined);
      })
      .catch(() => {
        // Best-effort — the Resume affordance simply stays hidden if this
        // fails; it never blocks the rest of the screen.
      });

    planApplicationService
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
    progressionApiClient
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
    guidedLoadingSetupApiClient
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
    // `authRecoveries` (Auth Slice C): a load that ran while the session was
    // gone (re-auth) failed closed; re-run once the same owner signed in again.
    // Sign-in is an overlay, not a navigation, so the focus reload never fires.
  }, [guidedLoadingSetupApiClient, planApplicationService, progressionApiClient, reloadToken, missedController, authRecoveries]);

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
    planApplicationService
      .getWorkoutPreview(adjustableWorkoutId)
      .then((preview) => {
        if (!cancelled) setEquipmentAdjusted({ plannedWorkoutId: adjustableWorkoutId, count: equipmentAdjustedCount(preview), exerciseCount: preview.exercises.length });
      })
      .catch(() => logTechnicalFailure("today equipment state read failed"));
    return () => {
      cancelled = true;
    };
  }, [planApplicationService, adjustableWorkoutId, reloadToken]);
  const previewFacts = equipmentAdjusted !== null && equipmentAdjusted.plannedWorkoutId === adjustableWorkoutId ? equipmentAdjusted : null;
  const equipmentLabel = previewFacts !== null ? equipmentAdjustedLabel(previewFacts.count) : null;

  const onStartWorkout = useCallback(
    async (session: PlanSessionSummaryV1) => {
      if (session.plannedWorkoutId === null) return;
      setStartState({ status: "starting" });
      try {
        const preview = await planApplicationService.getWorkoutPreview(session.plannedWorkoutId);
        const outcome = await planApplicationService.startWorkout(preview);
        // START is durable locally now; syncing it is fire-and-forget.
        if (outcome.status === "STARTED") workoutSyncCoordinator.requestSync("mutation");
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
    [planApplicationService, workoutSyncCoordinator, router],
  );

  const pendingProgressionItem = progressionState.status === "ready" ? progressionState.item : null;
  // Slice D: today's training is done — no missed-workout adaptation competes with that.
  const missedCard = heroState.kind === "completed-today" ? null : missedWorkoutCard(missedState);
  const guidedSetupItem = guidedSetupState.status === "ready" ? guidedSetupState.item : null;

  const overview: PlanOverviewV1 | null = overviewState.status === "ready" ? overviewState.overview : null;
  const strip = overview !== null && heroState.kind !== "no-plan" ? weekStrip(overview) : null;

  return (
    <SafeAreaView style={styles.safeArea} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <TopGlow />
        <View style={styles.wordmarkRow}>
          <Wordmark />
        </View>
        <WorkoutHero
          heroState={heroState}
          overview={overview}
          exerciseCount={previewFacts?.exerciseCount ?? null}
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
        <View style={styles.cards}>
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
          {syncNotice !== null ? <UnresolvedSyncNoticeView notice={syncNotice} /> : null}
        </View>
        {strip !== null ? <WeekStrip strip={strip} /> : null}
      </ScrollView>
      <BottomNav active="today" />
      {missedState.kind === "ROLL_FORWARD" && missedState.reviewOpen ? (
        <MissedWorkoutReviewSheet state={missedState} onApply={() => void missedController.apply()} onNotNow={() => missedController.notNow()} />
      ) : null}
      {adjustTarget !== null ? (
        <AvailableTimeSheet
          key={`${adjustTarget.plannedWorkoutId}-${adjustTarget.opening}`}
          plannedWorkoutId={adjustTarget.plannedWorkoutId}
          ports={availableTimeFlowPorts}
          onDismiss={closeAdjustSheet}
          onNavigateToActiveWorkout={navigateToActiveWorkout}
          onRefreshToday={reload}
        />
      ) : null}
      {equipmentTarget !== null ? (
        <EquipmentSheet
          key={`${equipmentTarget.plannedWorkoutId}-${equipmentTarget.opening}`}
          plannedWorkoutId={equipmentTarget.plannedWorkoutId}
          ports={equipmentFlowPorts}
          onDismiss={closeEquipmentSheet}
          onRefreshToday={reload}
          logFailure={logTechnicalFailure}
        />
      ) : null}
    </SafeAreaView>
  );
}

/**
 * CC-03: informational only — no action, because no in-app resolve/retry
 * action exists. Foundations §09 "Offline · saved locally": a hollow
 * marker that states the consequence, never blocks.
 */
function UnresolvedSyncNoticeView({ notice }: { notice: UnresolvedSyncNotice }): React.JSX.Element {
  return (
    <View style={styles.syncNotice} accessibilityRole="text" accessibilityLiveRegion="polite">
      <StatusMarker tone="offline" label="Not synced yet" />
      <Text style={styles.syncNoticeText}>{notice.message}</Text>
    </View>
  );
}

function ProgressionReviewCard({ item, onReview }: { item: PendingProgressionApplicationV1; onReview: () => void }): React.JSX.Element {
  return (
    <UpdateCard
      tone="success"
      eyebrow="Training update"
      title={`Progression ready · ${item.exerciseDisplayName}`}
      body="You're ready to increase the load."
      detail={item.proposalAvailable && item.resolverProposedLoad !== null ? `${formatLoad(item.currentEffectiveLoad)} → ${formatLoad(item.resolverProposedLoad)}` : null}
      actionLabel="Review change"
      onAction={onReview}
    />
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
    <UpdateCard
      tone="neutral"
      eyebrow="Setup needed"
      title={`Set loading for ${item.exerciseDisplayName}`}
      body="Vostivo needs your gym's weight steps to apply this progression automatically."
      actionLabel="Set up loading"
      onAction={onSetUp}
    />
  );
}

/** Today Final "This week": a 2px rail + day + status word per training session (lime only for today). */
function WeekStrip({ strip }: { strip: WeekStripView }): React.JSX.Element {
  return (
    <View style={styles.week} accessible accessibilityLabel={strip.accessibilityLabel}>
      <View style={styles.weekHeader}>
        <Text style={styles.weekEyebrow}>This week</Text>
        <Text style={styles.weekSummary}>{strip.summary}</Text>
      </View>
      <View style={styles.weekColumns}>
        {strip.days.map((day) => (
          <View key={day.key} style={styles.weekColumn}>
            <View style={[styles.weekRail, day.tone === "done" && styles.weekRailDone, day.tone === "today" && styles.weekRailToday]} />
            <Text style={[styles.weekDay, day.tone === "done" && styles.weekDayDone, day.tone === "today" && styles.weekDayToday]}>{day.day}</Text>
            <Text style={[styles.weekStatus, day.tone === "today" && styles.weekStatusToday, day.tone === "planned" && styles.weekStatusPlanned]} numberOfLines={1}>
              {day.statusLabel}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function HeroEyebrow({ left, right }: { left: string; right: string | null }): React.JSX.Element {
  return (
    <View style={styles.eyebrowRow}>
      <Text style={styles.heroEyebrow}>{left}</Text>
      {right !== null ? <Text style={styles.heroWeek}>{right}</Text> : null}
    </View>
  );
}

function WorkoutHero({
  heroState,
  overview,
  exerciseCount,
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
  /** The server overview (block week, athlete-local date) — `null` while loading / on error. */
  overview: PlanOverviewV1 | null;
  /** Real exercise count from today's effective Workout Preview, `null` until read. */
  exerciseCount: number | null;
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
  const week = overview?.currentBlock != null && overview.schedule.displayedCycle === "CURRENT" ? blockWeekLabel(overview.currentBlock) : null;
  switch (heroState.kind) {
    case "loading":
      return (
        <View style={styles.hero} accessible accessibilityLabel="Loading today's training" accessibilityState={{ busy: true }}>
          <View style={[styles.skeleton, { width: "34%", height: 11 }]} />
          <View style={[styles.skeleton, { width: "70%", height: 40 }]} />
          <View style={[styles.skeleton, { width: "52%", height: 14 }]} />
          <View style={[styles.skeleton, styles.skeletonCta]} />
        </View>
      );

    case "error":
      return (
        <View style={styles.hero}>
          <HeroEyebrow left="Today" right={null} />
          <Text style={styles.heroTitleSmall}>Could not load today</Text>
          <Text style={styles.heroBody}>Check your connection and try again. Anything you logged is saved on this phone.</Text>
          {__DEV__ ? <Text style={styles.heroDebug}>{heroState.message}</Text> : null}
          <View style={styles.ctaWrap}>
            <SecondaryButton label="Try again" onPress={onRetry} accessibilityLabel="Retry" />
          </View>
        </View>
      );

    case "resume":
      return (
        <View style={styles.hero}>
          <HeroEyebrow left="In progress" right={week} />
          <Text style={styles.heroTitle}>Workout in progress</Text>
          <Text style={styles.heroBody}>Your sets are saved on this phone. Pick up where you left off.</Text>
          <View style={styles.ctaWrap}>
            <PrimaryButton label="Resume workout" onPress={onResume} accessibilityLabel="Resume Workout" />
          </View>
        </View>
      );

    case "no-plan":
      return (
        <View style={styles.hero}>
          <HeroEyebrow left="Today" right={null} />
          <Text style={styles.heroTitleSmall}>No active training plan</Text>
          <Text style={styles.heroBody}>Get a Vostivo plan to see today&apos;s training here.</Text>
          <View style={styles.ctaWrap}>
            <SecondaryButton label="View plan" onPress={onViewPlan} accessibilityLabel="View Plan" />
          </View>
        </View>
      );

    case "rest": {
      const today = overview?.athleteLocalDate ?? null;
      return (
        <View style={styles.hero}>
          <HeroEyebrow left={today !== null ? longDayLabel(today, today) : "Today"} right={week} />
          <Text style={styles.heroTitle}>Rest day</Text>
          <Text style={styles.heroBody}>No workout is planned for today.</Text>
          {heroState.nextWorkout !== null ? (
            <View style={styles.nextRow}>
              <Text style={styles.nextLabel}>Next workout</Text>
              <Text style={styles.nextName}>{heroState.nextWorkout.name}</Text>
            </View>
          ) : null}
        </View>
      );
    }

    case "completed-today": {
      // Slice D: calm, no primary training action left — only the history of what was done.
      const view = completedTodayView(heroState.completed, heroState.nextWorkout);
      return (
        <View style={styles.hero}>
          <View accessible accessibilityLabel={view.accessibilityLabel} style={styles.heroStack}>
            <HeroEyebrow left={view.microLabel} right={week} />
            <Text style={styles.heroTitle}>{view.title}</Text>
            <View style={styles.metaRow}>
              <Icon name="check" size={15} strokeWidth={2} color={semantic.successMarker} />
              <Text style={styles.metaFocus}>{view.body}</Text>
            </View>
          </View>
          <View style={styles.ctaWrap}>
            <SecondaryButton label={view.viewWorkoutLabel} onPress={() => onViewWorkout(view.viewWorkoutHref)} accessibilityLabel="View completed workout" />
          </View>
          {view.next !== null ? (
            <View style={styles.nextRow}>
              <Text style={styles.nextLabel}>Next</Text>
              <Text style={styles.nextName}>{view.next}</Text>
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
      const meta = todayMetaParts(session, exerciseCount);
      const weekday = session.scheduledDate !== null ? longDayLabel(session.scheduledDate, overview?.athleteLocalDate ?? null) : "Today";
      return (
        <View style={styles.hero}>
          <HeroEyebrow left={weekday} right={week} />
          <Text style={styles.heroTitle} accessibilityRole="header">
            {session.name}
          </Text>
          {meta.focus !== null || meta.details.length > 0 ? (
            <View style={styles.metaRow}>
              {meta.focus !== null ? <Text style={styles.metaFocus}>{meta.focus}</Text> : null}
              {meta.details.map((detail, index) => (
                <View key={detail} style={styles.metaPart}>
                  {index > 0 || meta.focus !== null ? <View style={styles.metaDot} /> : null}
                  <Text style={styles.metaDetail}>{detail}</Text>
                </View>
              ))}
            </View>
          ) : null}
          {scheduleNote.kind === "ADJUSTED" && scheduleNote.originally !== null ? <Text style={styles.metaDetail}>{scheduleNote.originally}</Text> : null}
          {equipmentLabel !== null ? <Text style={styles.metaDetail}>{equipmentLabel}</Text> : null}
          {onAdjustTime !== null || onEquipment !== null ? (
            <View style={styles.linksRow}>
              {onAdjustTime !== null ? (
                <TextAction
                  label="Adjust time"
                  onPress={onAdjustTime}
                  disabled={isStarting}
                  underline
                  leading={<Icon name="clock" size={14} strokeWidth={1.7} color={semantic.textMuted} />}
                  accessibilityLabel="Adjust workout time"
                />
              ) : null}
              {onEquipment !== null ? (
                <TextAction
                  label={EQUIPMENT_COPY.todayAction}
                  onPress={onEquipment}
                  disabled={isStarting}
                  underline
                  leading={<Icon name="equipment" size={14} strokeWidth={1.7} color={semantic.textMuted} />}
                  accessibilityLabel="Equipment available today"
                />
              ) : null}
            </View>
          ) : null}
          <View style={styles.ctaWrap}>
            {startState.status === "error" ? <Text style={styles.errorText}>{startState.message}</Text> : null}
            <PrimaryButton
              label={isStarting ? "Starting…" : "Start workout"}
              onPress={() => onStartWorkout(session)}
              loading={isStarting}
              accessibilityLabel="Start Workout"
            />
          </View>
        </View>
      );
    }
  }
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: semantic.bgApp },
  scrollContent: { flexGrow: 1, paddingHorizontal: spacing.screenGutter },
  wordmarkRow: { paddingTop: spacing.xl },
  hero: { paddingTop: spacing.s40, gap: 13 },
  heroStack: { gap: 13 },
  eyebrowRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
  heroEyebrow: { ...type.eyebrow, color: semantic.textMuted },
  heroWeek: { ...type.eyebrow, fontWeight: "500", letterSpacing: 1.76, color: semantic.textMuted, fontVariant: ["tabular-nums"] },
  heroTitle: { ...type.display, color: semantic.textPrimary },
  heroTitleSmall: { ...type.pageTitle, color: semantic.textPrimary },
  heroBody: { ...type.body, color: semantic.textMuted },
  heroDebug: { ...type.labelValue, color: semantic.textDisabled },
  metaRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: 9, rowGap: 4 },
  metaPart: { flexDirection: "row", alignItems: "center", gap: 9 },
  metaFocus: { ...type.rowTitle, color: "#DCE2E5" },
  metaDot: { width: 3, height: 3, borderRadius: 2, backgroundColor: semantic.ornamentDot },
  metaDetail: { ...type.body, color: semantic.textMuted, fontVariant: ["tabular-nums"] },
  linksRow: { flexDirection: "row", flexWrap: "wrap", columnGap: spacing.s20, marginTop: -4 },
  ctaWrap: { paddingTop: 17, gap: spacing.md },
  errorText: { ...type.body, color: semantic.critical },
  nextRow: { flexDirection: "row", alignItems: "baseline", gap: spacing.sm, paddingTop: spacing.sm },
  nextLabel: { ...type.microLabel, color: semantic.textMuted },
  nextName: { ...type.bodyStrong, color: semantic.textSecondary },
  skeleton: { borderRadius: 8, backgroundColor: semantic.surfaceInteractive },
  skeletonCta: { width: "100%", height: 60, borderRadius: 14, marginTop: 17 },

  cards: { paddingTop: spacing.lg, gap: spacing.md },
  syncNotice: { gap: 6, paddingVertical: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: semantic.borderHairline },
  syncNoticeText: { ...type.body, color: semantic.textTertiary },

  week: { marginTop: "auto", paddingTop: spacing.xxl, paddingBottom: spacing.xl, gap: spacing.md },
  weekHeader: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
  weekEyebrow: { ...type.microLabel, color: semantic.textMuted },
  weekSummary: { ...type.labelValue, fontSize: 11, color: semantic.textMuted, fontVariant: ["tabular-nums"] },
  weekColumns: { flexDirection: "row", gap: 9 },
  weekColumn: { flex: 1, gap: 7 },
  weekRail: { height: 2, borderRadius: 1, backgroundColor: "#22272A" },
  weekRailDone: { backgroundColor: "#5A6268" },
  weekRailToday: { backgroundColor: semantic.signal },
  weekDay: { ...type.bodyStrong, fontSize: 12, color: semantic.textMuted },
  weekDayDone: { color: semantic.textSecondary },
  weekDayToday: { color: "#F6F8F7" },
  weekStatus: { ...type.labelValue, fontSize: 10, color: semantic.textMuted },
  weekStatusToday: { fontWeight: "600", color: semantic.signal },
  weekStatusPlanned: { color: semantic.textMuted },
});
