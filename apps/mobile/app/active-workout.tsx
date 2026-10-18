import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import type { ExternalWeightLoad, PrescribedExerciseV1, PrescribedSetV1 } from "@vostivo/domain";
import { getWorkoutApplicationService, getWorkoutSyncCoordinator } from "../src/plan/plan-runtime";
import type {
  ActivePerformedExercise,
  ActivePerformedSet,
  ActiveWorkoutSession,
} from "../src/workout/active-workout-session";
import type { PreviousSetPerformance } from "../src/workout/workout-repository";
import { computeSessionCompletion } from "../src/workout/session-completion";
import { adjustedSessionLabel } from "../src/available-time/available-time-flow";
import { computeElapsedSeconds, formatElapsedDuration } from "../src/workout/elapsed-time";
import { computeRemainingSeconds, isRestTimerFinished, resolveRestDuration } from "../src/workout/rest-timer";
import { formatLoad, formatPreviousSet, formatRepTarget } from "../src/workout/format-target";
import { previousPerformanceRefs, previousSetsFor, resolvePrefill } from "../src/workout/active-workout-presentation";
import { loadToAmountMilli, parseLoadInput, parseRepsInput } from "../src/workout/numeric-input";
import { colors, radius, spacing, touchTarget, typography } from "../src/design/tokens";

/**
 * Active Workout Core Logger V1 — the real gym logging experience.
 * LOG FIRST, EXPLAIN ON DEMAND (spec section 2): every set shows
 * Previous -> Today target -> Load -> Reps -> Complete, without a modal.
 *
 * Visuals aligned to the approved Claude Design canvas ("Vostivo Active
 * Workout v2.dc.html", project "Vostivo visual design exploration") and
 * Design System Foundations V1 — see docs/architecture/ACTIVE-WORKOUT.md
 * for the mapping and the explicit, deliberate deviations from that
 * canvas (RIR/engine-note/Swap/Pain omitted as deferred features; future
 * sets stay individually completable rather than becoming read-only, to
 * avoid regressing existing out-of-order logging).
 *
 * `getActiveWorkoutSession()` is the ONLY authoritative source on mount
 * (spec section 4) — this screen never fabricates workout data, and
 * every mutation re-reads canonical state afterward rather than trusting
 * local optimistic UI state (spec section 42). None of that boundary
 * changed in this visual pass — only JSX/styles below did.
 */

type ScreenState =
  | { readonly status: "loading" }
  | { readonly status: "no-session" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "active"; readonly session: ActiveWorkoutSession }
  | { readonly status: "finished"; readonly summary: WorkoutSummary };

interface WorkoutSummary {
  readonly workoutName: string;
  readonly durationSeconds: number;
  readonly completedWorkingSets: number;
  readonly totalPlannedSets: number;
}

type PreviousByExerciseRef = ReadonlyMap<string, readonly PreviousSetPerformance[]>;

export default function ActiveWorkoutScreen(): React.JSX.Element {
  const router = useRouter();
  const [state, setState] = useState<ScreenState>({ status: "loading" });
  const [previousByExerciseRef, setPreviousByExerciseRef] = useState<PreviousByExerciseRef>(new Map());
  const [currentExerciseIndex, setCurrentExerciseIndex] = useState(0);
  const [showFinishConfirm, setShowFinishConfirm] = useState(false);

  const service = useMemo(() => getWorkoutApplicationService(), []);
  const syncCoordinator = useMemo(() => getWorkoutSyncCoordinator(), []);

  const loadSession = useCallback(async (): Promise<ActiveWorkoutSession | undefined> => {
    const session = await service.getActiveWorkoutSession();
    if (session === undefined) {
      setState({ status: "no-session" });
      return undefined;
    }
    setState({ status: "active", session });

    // Previous performance is fetched once per distinct exerciseRef in
    // this prescription (spec section 9) — a compact context lookup, not
    // a History sync/cache.
    const refs = previousPerformanceRefs(session.prescription);
    const entries = await Promise.all(
      refs.map(async (ref) => [ref, await service.getPreviousExercisePerformance(ref, session.id)] as const),
    );
    const map = new Map<string, readonly PreviousSetPerformance[]>();
    for (const [ref, sets] of entries) {
      if (sets !== undefined) map.set(ref, sets);
    }
    setPreviousByExerciseRef(map);
    return session;
  }, [service]);

  useEffect(() => {
    let cancelled = false;

    service
      .getActiveWorkoutSession()
      .then(async (session) => {
        if (cancelled) return;
        if (session === undefined) {
          setState({ status: "no-session" });
          return;
        }
        setState({ status: "active", session });

        const refs = previousPerformanceRefs(session.prescription);
        const entries = await Promise.all(
          refs.map(async (ref) => [ref, await service.getPreviousExercisePerformance(ref, session.id)] as const),
        );
        if (cancelled) return;
        const map = new Map<string, readonly PreviousSetPerformance[]>();
        for (const [ref, sets] of entries) {
          if (sets !== undefined) map.set(ref, sets);
        }
        setPreviousByExerciseRef(map);
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      });

    return () => {
      cancelled = true;
    };
  }, [service]);

  const handleFinish = useCallback(
    async (session: ActiveWorkoutSession) => {
      const { totalPlannedSets, completedWorkingSets } = computeSessionCompletion(session);
      const startedAtMs = new Date(session.startedAt).getTime();
      const durationSeconds = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));

      const outcome = await service.finishWorkoutSession(session.id);
      if (outcome.status === "ALREADY_FINISHED") {
        // The local terminal invariant already resolved this session —
        // just reflect real local state rather than fabricating a summary.
        await loadSession();
        return;
      }
      syncCoordinator.requestSync("mutation");

      setState({
        status: "finished",
        summary: { workoutName: session.prescription.name, durationSeconds, completedWorkingSets, totalPlannedSets },
      });
    },
    [service, syncCoordinator, loadSession],
  );

  const onTapFinish = useCallback(() => {
    if (state.status !== "active") return;
    const { allSetsComplete } = computeSessionCompletion(state.session);
    if (!allSetsComplete) {
      setShowFinishConfirm(true);
    } else {
      void handleFinish(state.session);
    }
  }, [state, handleFinish]);

  if (state.status === "loading") {
    return (
      <SafeAreaView style={styles.safeArea} edges={["top", "bottom"]}>
        <Text style={styles.secondaryText}>Loading active session…</Text>
      </SafeAreaView>
    );
  }

  if (state.status === "no-session") {
    return (
      <SafeAreaView style={styles.safeArea} edges={["top", "bottom"]}>
        <View style={styles.centeredContent}>
          <Text style={styles.title}>No active workout</Text>
          <Text style={styles.secondaryText}>Start a workout from Today to begin logging.</Text>
          <Pressable
            onPress={() => router.replace("/")}
            style={styles.primaryButton}
            accessibilityRole="button"
            accessibilityLabel="Back to Today"
          >
            <Text style={styles.primaryButtonText}>Back to Today</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (state.status === "error") {
    return (
      <SafeAreaView style={styles.safeArea} edges={["top", "bottom"]}>
        <View style={styles.centeredContent}>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.errorText}>{state.message}</Text>
          <Pressable
            onPress={() => router.replace("/")}
            style={styles.primaryButton}
            accessibilityRole="button"
            accessibilityLabel="Back to Today"
          >
            <Text style={styles.primaryButtonText}>Back to Today</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (state.status === "finished") {
    return <SummaryView summary={state.summary} onDone={() => router.replace("/")} />;
  }

  const { session } = state;
  const plannedExercise = session.prescription.exercises[currentExerciseIndex];
  const { allSetsComplete } = computeSessionCompletion(session);

  return (
    <SafeAreaView style={styles.safeArea} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        style={styles.flex}
        // Android already resizes the window for the keyboard via this
        // Activity's `windowSoftInputMode="adjustResize"` — layering RN's
        // own "height" behavior on top double-compensates and can leave
        // the focused row hidden behind the keyboard. iOS has no such OS-
        // level resize, so it still needs "padding" here.
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={0}
      >
        <WorkoutHeader
          session={session}
          exerciseIndex={currentExerciseIndex}
          totalExercises={session.prescription.exercises.length}
          onAdjustRest={async (delta) => {
            await service.adjustRestTimer(session.id, delta);
            await loadSession();
          }}
          onFinish={onTapFinish}
        />

        <ExerciseTabs
          exercises={session.prescription.exercises}
          activeIndex={currentExerciseIndex}
          onSelect={setCurrentExerciseIndex}
        />

        <ScrollView style={styles.flex} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          {plannedExercise !== undefined ? (
            <ExerciseCard
              key={plannedExercise.prescriptionExerciseId}
              plannedExercise={plannedExercise}
              performedExercise={session.exercises.find((e) => e.prescriptionExerciseId === plannedExercise.prescriptionExerciseId)}
              drafts={session.drafts}
              previousSets={previousSetsFor(plannedExercise, previousByExerciseRef)}
              onSetCompleted={async (input) => {
                const restSeconds = resolveRestDuration(input.plannedSet);
                const outcome = await service.completeSet(
                  {
                    workoutSessionId: session.id,
                    performedExerciseId: input.performedExerciseId,
                    performedSetId: input.existingPerformedSetId,
                    prescriptionExerciseId: plannedExercise.prescriptionExerciseId,
                    exerciseRef: plannedExercise.exerciseRef,
                    exerciseDisplayName: plannedExercise.displayName,
                    exerciseOrder: plannedExercise.order,
                    prescriptionSetId: input.plannedSet.prescriptionSetId,
                    setOrder: input.plannedSet.order,
                    actualReps: input.actualReps,
                    actualLoad: input.actualLoad,
                    setType: input.plannedSet.setType,
                  },
                  restSeconds,
                );
                if (outcome.status === "SESSION_ALREADY_COMPLETED") {
                  // The local terminal invariant closed this attempt —
                  // just reflect real local state (the screen will show
                  // "no-session" once this session no longer resolves as
                  // active), never pretend the set was logged.
                  await loadSession();
                  return;
                }
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
                syncCoordinator.requestSync("mutation");
                const refreshed = await loadSession();

                // Auto-advance (spec section 24): once every set of the
                // current exercise is complete, move focus to the next
                // exercise — never forced, the athlete can still tap any tab.
                if (refreshed !== undefined) {
                  const exercise = refreshed.prescription.exercises[currentExerciseIndex];
                  const performed = refreshed.exercises.find((e) => e.prescriptionExerciseId === exercise?.prescriptionExerciseId);
                  const allComplete =
                    exercise !== undefined &&
                    exercise.sets.every((set) =>
                      performed?.sets.some((p) => p.prescriptionSetId === set.prescriptionSetId && p.completionState === "COMPLETED"),
                    );
                  if (allComplete && currentExerciseIndex < refreshed.prescription.exercises.length - 1) {
                    setCurrentExerciseIndex(currentExerciseIndex + 1);
                  }
                }
              }}
              onSetReopened={async (performedSetId) => {
                const outcome = await service.reopenSet(performedSetId);
                if (outcome.status === "SESSION_ALREADY_COMPLETED") {
                  await loadSession();
                  return;
                }
                void Haptics.selectionAsync().catch(() => {});
                syncCoordinator.requestSync("mutation");
                await loadSession();
              }}
              onDraftChanged={async (draft) => {
                await service.saveSetDraft({
                  workoutSessionId: session.id,
                  prescriptionExerciseId: plannedExercise.prescriptionExerciseId,
                  prescriptionSetId: draft.prescriptionSetId,
                  draftReps: draft.draftReps,
                  draftLoad: draft.draftLoad,
                });
              }}
            />
          ) : null}

          {allSetsComplete ? (
            <View style={styles.allCompleteFinishWrap}>
              <Text style={styles.allCompleteFinishLabel}>Every planned set is logged.</Text>
              <Pressable
                onPress={onTapFinish}
                style={styles.allCompleteFinishButton}
                accessibilityRole="button"
                accessibilityLabel="Finish workout"
              >
                <Text style={styles.allCompleteFinishButtonText}>Finish Workout</Text>
              </Pressable>
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>

      {showFinishConfirm ? (
        <FinishConfirmSheet
          onCancel={() => setShowFinishConfirm(false)}
          onConfirm={() => {
            setShowFinishConfirm(false);
            void handleFinish(session);
          }}
        />
      ) : null}
    </SafeAreaView>
  );
}

/**
 * Isolated ticking clock (spec section 41: "avoid rerendering every
 * exercise row every timer tick") — only this subtree re-renders once per
 * second, never the exercise/set list below it. Elapsed time and rest
 * remaining are both derived from persisted timestamps every tick, never
 * from a decremented in-memory counter (spec section 6/19).
 *
 * Visual: compact eyebrow header (workout name + exercise N/M) with the
 * elapsed clock and a deliberately secondary, icon-only Finish affordance
 * (Foundations §07 "icon button" — 44×44 hit area, 32px visible circle),
 * matching the approved canvas exactly rather than a full-width labeled
 * button. The rest timer strip below reuses the exact well/track/±15
 * treatment from the canvas — a muted grey fill, never signal lime,
 * since "resting" is not a today/current-set state (Foundations §02: "a
 * card is a claim... signal lime never means success/progress").
 */
function WorkoutHeader({
  session,
  exerciseIndex,
  totalExercises,
  onAdjustRest,
  onFinish,
}: {
  session: ActiveWorkoutSession;
  exerciseIndex: number;
  totalExercises: number;
  onAdjustRest: (deltaSeconds: number) => void;
  onFinish: () => void;
}): React.JSX.Element {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const elapsedSeconds = computeElapsedSeconds(session.startedAt, now);
  const remainingRestSeconds = session.restTimer !== null ? computeRemainingSeconds(session.restTimer, now) : null;
  const restFinished = session.restTimer !== null && isRestTimerFinished(session.restTimer, now);
  const restDurationSeconds = session.restTimer?.durationSeconds ?? 0;
  const restProgress =
    session.restTimer !== null && restDurationSeconds > 0
      ? Math.max(0, Math.min(1, ((remainingRestSeconds ?? 0) / restDurationSeconds)))
      : 0;

  const adjustedLabel = adjustedSessionLabel(session);

  return (
    <View style={styles.header}>
      <View style={styles.headerTopRow}>
        <View style={styles.headerTitleBlock}>
          <View style={styles.headerEyebrowRow}>
            <Text style={styles.headerWorkoutName} numberOfLines={1}>
              {session.prescription.name}
            </Text>
            <View style={styles.dotSeparator} />
            <Text style={styles.headerExerciseIndex} numberOfLines={1}>
              Exercise {exerciseIndex + 1} / {totalExercises}
            </Text>
          </View>
          {/* Available-Time Slice D: a restrained sublabel only for an adjusted session
              (durable local metadata); an ordinary session renders exactly as before. */}
          {adjustedLabel !== null ? (
            <Text style={styles.headerAdjustedLabel} numberOfLines={1}>
              {adjustedLabel}
            </Text>
          ) : null}
        </View>
        <View style={styles.headerRightRow}>
          <Text style={styles.headerElapsed} accessibilityLabel={`Elapsed ${formatElapsedDuration(elapsedSeconds)}`}>
            {formatElapsedDuration(elapsedSeconds)}
          </Text>
          <Pressable onPress={onFinish} style={styles.finishIconButton} accessibilityRole="button" accessibilityLabel="Finish workout">
            <View style={styles.finishIconCircle}>
              <View style={styles.finishIconBar} />
              <View style={styles.finishIconBar} />
            </View>
          </Pressable>
        </View>
      </View>

      {session.restTimer !== null ? (
        <View style={styles.restTimerRow}>
          <Pressable
            onPress={() => onAdjustRest(-15)}
            style={styles.restAdjustButton}
            accessibilityRole="button"
            accessibilityLabel="Subtract 15 seconds from rest"
          >
            <Text style={styles.restAdjustText}>−15s</Text>
          </Pressable>
          <View style={styles.restCenterBlock}>
            <Text style={styles.restEyebrow}>Rest</Text>
            <Text style={[styles.restTimeText, restFinished && styles.restTimeTextDone]} accessibilityLabel={restFinished ? "Rest finished" : `${remainingRestSeconds} seconds of rest remaining`}>
              {restFinished ? "Rest done" : formatElapsedDuration(remainingRestSeconds ?? 0)}
            </Text>
          </View>
          <View style={styles.restTrack}>
            <View style={[styles.restTrackFill, { width: `${restFinished ? 0 : restProgress * 100}%` }]} />
          </View>
          <Pressable
            onPress={() => onAdjustRest(15)}
            style={styles.restAdjustButton}
            accessibilityRole="button"
            accessibilityLabel="Add 15 seconds to rest"
          >
            <Text style={styles.restAdjustText}>+15s</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

/**
 * Compact exercise switcher. The approved canvas represents this purely
 * as a "Exercise 2 / 5" header indicator (implying swipe paging); a swipe
 * pager is a new interaction mechanism this pass does not add (per "do
 * not add new features"). This keeps the existing tap-to-jump-to-any-
 * exercise capability — restyled as quiet underlined text tabs rather
 * than bordered pill chips, closer to the canvas's restrained mood.
 */
function ExerciseTabs({
  exercises,
  activeIndex,
  onSelect,
}: {
  exercises: readonly PrescribedExerciseV1[];
  activeIndex: number;
  onSelect: (index: number) => void;
}): React.JSX.Element {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.tabsScroll}
      contentContainerStyle={styles.tabsRow}
    >
      {exercises.map((exercise, index) => {
        const isActive = index === activeIndex;
        return (
          <Pressable
            key={exercise.prescriptionExerciseId}
            onPress={() => onSelect(index)}
            style={styles.tabChip}
            accessibilityRole="button"
            accessibilityLabel={exercise.displayName}
            accessibilityState={{ selected: isActive }}
          >
            <Text style={[styles.tabChipText, isActive && styles.tabChipTextActive]} numberOfLines={1}>
              {exercise.displayName}
            </Text>
            <View style={[styles.tabChipUnderline, isActive && styles.tabChipUnderlineActive]} />
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

interface CompletedSetInput {
  readonly plannedSet: PrescribedSetV1;
  readonly performedExerciseId: string | undefined;
  /** Set when recompleting a previously reopened set — see `CompleteSetInput.performedSetId`. */
  readonly existingPerformedSetId: string | undefined;
  readonly actualReps: number;
  readonly actualLoad: ExternalWeightLoad;
}

interface DraftChange {
  readonly prescriptionSetId: string;
  readonly draftReps: number | null;
  readonly draftLoad: ExternalWeightLoad | null;
}

/**
 * Exercise focus block (canvas: exercise title -> "N × range" -> "Today"
 * line) plus the set-rows card. "Today" shows the target for the current
 * (first not-yet-completed) set — the athlete's actual next action —
 * rather than repeating every row's own target inline, matching the
 * canvas's single-target-line composition. Per-set target data is not
 * lost: each row still reads its own `plannedSet.targetReps/targetLoad`
 * for validation and prefill: this only changes what's *displayed* once
 * up top versus inline per row.
 */
function ExerciseCard({
  plannedExercise,
  performedExercise,
  drafts,
  previousSets,
  onSetCompleted,
  onSetReopened,
  onDraftChanged,
}: {
  plannedExercise: PrescribedExerciseV1;
  performedExercise: ActivePerformedExercise | undefined;
  drafts: ActiveWorkoutSession["drafts"];
  previousSets: readonly PreviousSetPerformance[] | undefined;
  onSetCompleted: (input: CompletedSetInput) => Promise<void>;
  onSetReopened: (performedSetId: string) => Promise<void>;
  onDraftChanged: (draft: DraftChange) => Promise<void>;
}): React.JSX.Element {
  const isSetComplete = (plannedSet: PrescribedSetV1): boolean =>
    performedExercise?.sets.find((s) => s.prescriptionSetId === plannedSet.prescriptionSetId)?.completionState === "COMPLETED";
  const firstIncompleteSet = plannedExercise.sets.find((s) => !isSetComplete(s));
  const todayTargetSet = firstIncompleteSet ?? plannedExercise.sets[plannedExercise.sets.length - 1];

  return (
    <View style={styles.exerciseFocusBlock}>
      <Text style={styles.exerciseTitle}>{plannedExercise.displayName}</Text>

      {todayTargetSet !== undefined ? (
        <View style={styles.todayRow}>
          <Text style={styles.todayEyebrow}>Today</Text>
          {todayTargetSet.targetLoad !== null ? <Text style={styles.todayValue}>{formatLoad(todayTargetSet.targetLoad)}</Text> : null}
          <View style={styles.dotSeparator} />
          <Text style={styles.todayAim} numberOfLines={1}>
            aim {formatRepTarget(todayTargetSet.targetReps)}
          </Text>
        </View>
      ) : null}

      <View style={styles.setTableWrap}>
        <View style={styles.setTableHeaderRow}>
          <Text style={[styles.tableHeaderText, styles.colSet]}>Set</Text>
          <Text style={[styles.tableHeaderText, styles.colPrev]}>Prev</Text>
          <Text style={[styles.tableHeaderText, styles.colInput, styles.textCenter]}>Kg</Text>
          <Text style={[styles.tableHeaderText, styles.colInput, styles.textCenter]}>Reps</Text>
          <View style={styles.colAction} />
        </View>

        <LinearGradient
          colors={[colors.awSurfaceCardGradientStart, colors.awSurfaceCardGradientEnd]}
          style={styles.setTableCard}
        >
          {plannedExercise.sets.map((plannedSet, index) => {
            const performedSet = performedExercise?.sets.find((s) => s.prescriptionSetId === plannedSet.prescriptionSetId);
            const draft = drafts.find(
              (d) => d.prescriptionExerciseId === plannedExercise.prescriptionExerciseId && d.prescriptionSetId === plannedSet.prescriptionSetId,
            );
            const previous = previousSets?.find((p) => p.order === plannedSet.order);
            const isComplete = performedSet?.completionState === "COMPLETED";
            const isCurrent = !isComplete && plannedSet.prescriptionSetId === firstIncompleteSet?.prescriptionSetId;

            return (
              <View key={plannedSet.prescriptionSetId}>
                {index > 0 ? <View style={styles.setRowDivider} /> : null}
                <SetRow
                  plannedSet={plannedSet}
                  performedSet={performedSet}
                  draft={draft}
                  previous={previous}
                  isCurrent={isCurrent}
                  onComplete={(actualReps, actualLoad) =>
                    onSetCompleted({
                      plannedSet,
                      performedExerciseId: performedExercise?.id,
                      existingPerformedSetId: performedSet?.id,
                      actualReps,
                      actualLoad,
                    })
                  }
                  onReopen={() => (performedSet !== undefined ? onSetReopened(performedSet.id) : Promise.resolve())}
                  onDraftChanged={(draftReps, draftLoad) => onDraftChanged({ prescriptionSetId: plannedSet.prescriptionSetId, draftReps, draftLoad })}
                />
              </View>
            );
          })}
        </LinearGradient>
      </View>
    </View>
  );
}

function SetRow({
  plannedSet,
  performedSet,
  draft,
  previous,
  isCurrent,
  onComplete,
  onReopen,
  onDraftChanged,
}: {
  plannedSet: PrescribedSetV1;
  performedSet: ActivePerformedSet | undefined;
  draft: { readonly draftReps: number | null; readonly draftLoad: ExternalWeightLoad | null } | undefined;
  previous: PreviousSetPerformance | undefined;
  isCurrent: boolean;
  onComplete: (actualReps: number, actualLoad: ExternalWeightLoad) => Promise<void>;
  onReopen: () => Promise<void>;
  onDraftChanged: (draftReps: number | null, draftLoad: ExternalWeightLoad | null) => Promise<void>;
}): React.JSX.Element {
  const isComplete = performedSet?.completionState === "COMPLETED";
  const prefill = useMemo(() => resolvePrefill(plannedSet, performedSet, draft, previous), [plannedSet, performedSet, draft, previous]);

  // `useState(prefill.*)` only takes its initial value on this
  // component's first mount for its current key (`SetRow` is keyed by
  // `prescriptionSetId` in `ExerciseCard`) — a genuine remount happens on
  // exercise-tab switch and on process restart (spec section 32/AW-MOB-
  // 007), which is exactly when re-deriving the prefill is correct;
  // in-between re-renders never clobber in-progress typing.
  const [repsText, setRepsText] = useState(prefill.reps);
  const [loadText, setLoadText] = useState(prefill.load);
  const unit = prefill.unit;
  const basis = prefill.basis;

  const parsedReps = parseRepsInput(repsText);
  const parsedLoad = parseLoadInput(loadText);
  const repsValid = parsedReps !== null;
  const loadValid = parsedLoad !== null;

  // Mirrored in refs (updated synchronously in the change handlers below,
  // not via a state-driven effect) so the debounced/blur flush below
  // always reads the true latest keystroke, never a stale closure over a
  // render that hasn't committed yet.
  const repsTextRef = useRef(repsText);
  const loadTextRef = useRef(loadText);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushDraft = useCallback(() => {
    if (draftTimerRef.current !== null) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    if (isComplete) return; // completed reality is not a draft
    const reps = parseRepsInput(repsTextRef.current);
    const load = parseLoadInput(loadTextRef.current);
    void onDraftChanged(
      reps,
      load !== null ? { kind: "EXTERNAL_WEIGHT", amountMilli: loadToAmountMilli(load), unit, basis } : null,
    );
  }, [isComplete, onDraftChanged, unit, basis]);

  /**
   * Debounced auto-save while typing (spec section 33: "persisted...
   * when changed / blurred") — `onBlur` alone misses the case where the
   * app process is killed abruptly while the field is STILL focused (no
   * blur ever fires, e.g. a real OS low-memory kill or a swipe-away).
   * ~400ms after the last keystroke is short enough to survive a kill
   * that happens once typing has paused, while staying far short of a
   * per-keystroke write (the "reasonable write efficiency" the spec asks
   * for). A kill within that ~400ms window can still lose the very latest
   * character — no debounce can fully close that gap without per-
   * keystroke writes, which the spec explicitly rules out.
   */
  const scheduleDraftFlush = useCallback(() => {
    if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(flushDraft, 400);
  }, [flushDraft]);

  useEffect(
    () => () => {
      if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current);
    },
    [],
  );

  const canSubmit = repsValid && loadValid;
  const onPressComplete = useCallback(() => {
    if (parsedReps === null || parsedLoad === null) return;
    void onComplete(parsedReps, { kind: "EXTERNAL_WEIGHT", amountMilli: loadToAmountMilli(parsedLoad), unit, basis });
  }, [parsedReps, parsedLoad, onComplete, unit, basis]);

  return (
    <View style={[styles.setRow, isCurrent && styles.setRowCurrent]}>
      {isCurrent ? <View style={styles.currentRail} /> : null}
      <View style={styles.setRowGrid}>
        <View style={styles.colSet}>
          <Text style={[styles.setNumberText, isComplete && styles.setNumberTextDone, isCurrent && styles.setNumberTextCurrent]}>
            {plannedSet.order}
          </Text>
          {isCurrent ? <Text style={styles.nowLabel}>Now</Text> : null}
        </View>
        <Text style={[styles.prevText, isCurrent && styles.prevTextCurrent]} numberOfLines={1}>
          {formatPreviousSet(previous)}
        </Text>

        {isComplete ? (
          <>
            <View style={[styles.wellQuiet, styles.colInput]}>
              <Text style={styles.wellQuietText}>{loadText}</Text>
            </View>
            <View style={[styles.wellQuiet, styles.colInput]}>
              <Text style={styles.wellQuietText}>{repsText}</Text>
            </View>
            <Pressable
              onPress={() => void onReopen()}
              style={[styles.colAction, styles.reopenChip]}
              accessibilityRole="button"
              accessibilityLabel={`Reopen set ${plannedSet.order}`}
            >
              <Text style={styles.reopenCheck}>✓</Text>
            </Pressable>
          </>
        ) : (
          <>
            <TextInput
              style={[styles.colInput, isCurrent ? styles.wellCurrent : styles.wellFuture]}
              value={loadText}
              onChangeText={(text) => {
                setLoadText(text);
                loadTextRef.current = text;
                scheduleDraftFlush();
              }}
              onBlur={flushDraft}
              selectTextOnFocus
              keyboardType="decimal-pad"
              placeholder="kg"
              placeholderTextColor={colors.awTextFaint}
              accessibilityLabel={`Load for set ${plannedSet.order}`}
            />
            <TextInput
              style={[styles.colInput, isCurrent ? styles.wellCurrent : styles.wellFuture]}
              value={repsText}
              onChangeText={(text) => {
                setRepsText(text);
                repsTextRef.current = text;
                scheduleDraftFlush();
              }}
              onBlur={flushDraft}
              selectTextOnFocus
              keyboardType="number-pad"
              placeholder="reps"
              placeholderTextColor={colors.awTextFaint}
              accessibilityLabel={`Reps for set ${plannedSet.order}`}
            />
            {isCurrent ? (
              <View style={styles.colAction} />
            ) : (
              <Pressable
                onPress={onPressComplete}
                disabled={!canSubmit}
                style={[styles.colAction, styles.futureCompleteChip, !canSubmit && styles.futureCompleteChipDisabled]}
                accessibilityRole="button"
                accessibilityLabel={`Complete set ${plannedSet.order}`}
              >
                <Text style={[styles.futureCompleteChipText, !canSubmit && styles.futureCompleteChipTextDisabled]}>✓</Text>
              </Pressable>
            )}
          </>
        )}
      </View>

      {isCurrent ? (
        <View style={styles.logSetWrap}>
          <Pressable
            onPress={onPressComplete}
            disabled={!canSubmit}
            style={styles.logSetButton}
            accessibilityRole="button"
            accessibilityLabel={`Complete set ${plannedSet.order}`}
          >
            {canSubmit ? (
              <LinearGradient colors={["#FFFFFF", "#EFF2F0"]} style={styles.logSetFill}>
                <Text style={styles.logSetLabel}>LOG SET {plannedSet.order}</Text>
                <Text style={styles.logSetSub}>
                  {loadValid ? `${formatLoad({ kind: "EXTERNAL_WEIGHT", amountMilli: loadToAmountMilli(parsedLoad ?? 0), unit, basis })}` : "—"}
                  {repsValid ? ` × ${parsedReps}` : ""}
                </Text>
              </LinearGradient>
            ) : (
              <View style={styles.logSetDisabled}>
                <Text style={styles.logSetLabelDisabled}>LOG SET {plannedSet.order}</Text>
              </View>
            )}
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function FinishConfirmSheet({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }): React.JSX.Element {
  return (
    <View style={styles.sheetOverlay}>
      <View style={styles.sheet}>
        <Text style={styles.sheetTitle}>Finish with sets remaining?</Text>
        <Text style={styles.secondaryText}>Not every planned set is complete yet. You can still finish now.</Text>
        <View style={styles.sheetActions}>
          <Pressable onPress={onCancel} style={styles.sheetSecondaryButton} accessibilityRole="button" accessibilityLabel="Keep logging">
            <Text style={styles.sheetSecondaryButtonText}>Keep logging</Text>
          </Pressable>
          <Pressable onPress={onConfirm} style={styles.sheetPrimaryButton} accessibilityRole="button" accessibilityLabel="Finish anyway">
            <Text style={styles.sheetPrimaryButtonText}>Finish anyway</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function SummaryView({ summary, onDone }: { summary: WorkoutSummary; onDone: () => void }): React.JSX.Element {
  return (
    <SafeAreaView style={styles.safeArea} edges={["top", "bottom"]}>
      <View style={styles.centeredContent}>
        <Text style={styles.title}>Workout complete</Text>
        <Text style={styles.summaryWorkoutName}>{summary.workoutName}</Text>
        <View style={styles.summaryStatsRow}>
          <View style={styles.summaryStat}>
            <Text style={styles.summaryStatValue}>{formatElapsedDuration(summary.durationSeconds)}</Text>
            <Text style={styles.summaryStatLabel}>Duration</Text>
          </View>
          <View style={styles.summaryStat}>
            <Text style={styles.summaryStatValue}>
              {summary.completedWorkingSets}/{summary.totalPlannedSets}
            </Text>
            <Text style={styles.summaryStatLabel}>Sets completed</Text>
          </View>
        </View>
        <Pressable onPress={onDone} style={styles.primaryButton} accessibilityRole="button" accessibilityLabel="Back to Today">
          <Text style={styles.primaryButtonText}>Back to Today</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safeArea: { flex: 1, backgroundColor: colors.background },
  centeredContent: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.md, paddingHorizontal: spacing.xl },
  title: { ...typography.title, color: colors.textPrimary },
  secondaryText: { ...typography.body, color: colors.textSecondary, textAlign: "center" },
  errorText: { ...typography.body, color: colors.danger, textAlign: "center" },
  primaryButton: {
    backgroundColor: colors.signal,
    borderRadius: radius.pill,
    minHeight: touchTarget.minHeight,
    paddingHorizontal: spacing.xl,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryButtonText: { ...typography.bodyStrong, color: colors.signalText },

  // --- Header ---
  header: {
    paddingHorizontal: spacing.screenGutter,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    backgroundColor: colors.background,
    gap: spacing.sm,
  },
  headerTopRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  headerTitleBlock: { flexShrink: 1 },
  headerEyebrowRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  headerWorkoutName: { ...typography.awSessionEyebrow, color: colors.awTextPrimary },
  headerExerciseIndex: { ...typography.tiny, letterSpacing: 0.9, textTransform: "uppercase", color: colors.awTextFaint },
  headerAdjustedLabel: { ...typography.tiny, letterSpacing: 0.4, color: colors.awTextMuted, marginTop: 3 },
  headerRightRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  headerElapsed: { ...typography.awLabelValue, color: colors.awTextSecondary },
  dotSeparator: { width: 3, height: 3, borderRadius: 1.5, backgroundColor: "#424950" },

  finishIconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  finishIconCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.awBorderMicro,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 3,
  },
  finishIconBar: { width: 2, height: 10, borderRadius: 1, backgroundColor: colors.awTextSecondary },

  restTimerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.awBorderHairline,
    paddingVertical: 3,
  },
  restAdjustButton: { minHeight: touchTarget.minHeight, minWidth: 44, alignItems: "center", justifyContent: "center" },
  restAdjustText: { ...typography.awLabelValue, color: colors.awTextSecondary },
  restCenterBlock: { flexDirection: "row", alignItems: "baseline", gap: spacing.xs },
  restEyebrow: { ...typography.awMicroLabel, color: colors.awTextFaint },
  restTimeText: { fontSize: 18, fontWeight: "700", letterSpacing: -0.2, color: colors.awTextPrimary },
  restTimeTextDone: { fontWeight: "600", color: colors.awTextDisabled },
  restTrack: { flex: 1, height: 2, borderRadius: 1, backgroundColor: "#1A1E21", overflow: "hidden" },
  restTrackFill: { height: 2, borderRadius: 1, backgroundColor: colors.awTextDisabled },

  // --- Exercise tabs (compact underline style) ---
  tabsScroll: { flexGrow: 0, flexShrink: 0 },
  tabsRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.screenGutter,
    paddingTop: spacing.xs,
    gap: spacing.lg,
  },
  tabChip: { alignSelf: "flex-start", alignItems: "center", paddingVertical: spacing.xs, gap: 6 },
  tabChipText: { ...typography.awBody, color: colors.awTextFaint, maxWidth: 140 },
  tabChipTextActive: { color: colors.awTextPrimary, fontWeight: "700" },
  tabChipUnderline: { height: 2, width: "100%", borderRadius: 1, backgroundColor: "transparent" },
  tabChipUnderlineActive: { backgroundColor: colors.signal },

  // --- Exercise focus block ---
  scrollContent: { paddingHorizontal: spacing.screenGutter, paddingTop: spacing.xl, paddingBottom: spacing.xxl },
  exerciseFocusBlock: { gap: spacing.sm },
  exerciseTitle: { ...typography.awExerciseTitle, color: colors.awTextPrimary },
  todayRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs, flexWrap: "wrap", marginBottom: spacing.aw20 },
  todayEyebrow: { ...typography.awMicroLabel, color: colors.awTextFaint },
  todayValue: { ...typography.awLabelValue, color: colors.awTextSecondary },
  todayAim: { ...typography.awBody, color: colors.awTextMuted },

  // --- Set table ---
  setTableWrap: {},
  setTableHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.xs,
  },
  tableHeaderText: { ...typography.awTableHeader, color: colors.awTextFainter },
  textCenter: { textAlign: "center" },
  colSet: { width: 30 },
  colPrev: { width: 62, ...typography.awBody, color: colors.awTextFaint },
  colInput: { flex: 1 },
  colAction: { width: 40, alignItems: "flex-end" },

  setTableCard: {
    borderRadius: radius.awSurface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.awBorderDefault,
    overflow: "hidden",
  },
  setRowDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.awBorderHairline },

  setRow: { position: "relative" },
  setRowCurrent: { backgroundColor: colors.awSurfaceRowNow },
  currentRail: { position: "absolute", left: 0, top: 0, bottom: 0, width: 2, backgroundColor: colors.signal },
  setRowGrid: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  setNumberText: { ...typography.awNumericCompleted, color: colors.awChevronCompleted },
  setNumberTextDone: { color: colors.awTextFainter },
  setNumberTextCurrent: { fontSize: 14, fontWeight: "700", color: colors.awTextPrimary },
  nowLabel: { ...typography.awMicroLabel, fontSize: 9, letterSpacing: 1.2, color: colors.awSignalMutedLabel, marginTop: 3 },
  prevText: { width: 62, ...typography.awBody, color: colors.awPrevText },
  prevTextCurrent: { color: colors.awPrevTextNow },

  wellQuiet: {
    height: 40,
    borderRadius: radius.awMicro + 2,
    backgroundColor: colors.awSurfaceInteractive,
    alignItems: "center",
    justifyContent: "center",
  },
  wellQuietText: { ...typography.awNumericCompleted, color: colors.awTextSecondary },

  wellCurrent: {
    height: 44,
    borderRadius: radius.awControl,
    backgroundColor: colors.awSurfaceWellFocused,
    borderWidth: 1,
    borderColor: colors.awBorderStrong,
    color: colors.awTextPrimary,
    textAlign: "center",
    padding: 0,
    ...typography.awNumeric,
  },
  wellFuture: {
    height: 40,
    borderRadius: radius.awMicro + 2,
    backgroundColor: "transparent",
    color: colors.awFutureValueText,
    textAlign: "center",
    padding: 0,
    ...typography.awNumericCompleted,
    fontWeight: "500",
  },

  reopenChip: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.awReopenChipBg,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
  },
  reopenCheck: { color: colors.awReopenIcon, fontSize: 13, fontWeight: "700" },

  futureCompleteChip: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.awBorderMicro,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
  },
  futureCompleteChipDisabled: { opacity: 0.4 },
  futureCompleteChipText: { color: colors.awTextSecondary, fontSize: 13, fontWeight: "700" },
  futureCompleteChipTextDisabled: { color: colors.awTextDisabled },

  logSetWrap: { paddingHorizontal: spacing.sm, paddingBottom: spacing.sm, paddingTop: 2 },

  // Active Workout Finish-blocker fix: once every planned set across the
  // whole session is logged, the per-set "LOG SET N" primary action (the
  // only prior bottom-of-screen call to action) never renders for any
  // row — this is the sole, clearly visible replacement, reusing the
  // exact same canonical finish path as the header's icon-only Finish
  // button (`onTapFinish`), never a second completion mechanism.
  allCompleteFinishWrap: { marginTop: spacing.xl, alignItems: "center", gap: spacing.md },
  allCompleteFinishLabel: { ...typography.body, color: colors.awTextSecondary, textAlign: "center" },
  allCompleteFinishButton: {
    alignSelf: "stretch",
    backgroundColor: colors.signal,
    borderRadius: radius.pill,
    minHeight: touchTarget.minHeight,
    alignItems: "center",
    justifyContent: "center",
  },
  allCompleteFinishButtonText: { ...typography.bodyStrong, color: colors.signalText },
  logSetButton: { borderRadius: radius.awSurface, overflow: "hidden" },
  logSetFill: {
    height: 60,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  logSetLabel: { ...typography.awButtonLabelPrimary, color: colors.awTextInverse },
  logSetSub: { ...typography.awButtonLabelPrimarySub, color: "rgba(10,12,13,0.5)" },
  logSetDisabled: {
    height: 60,
    borderRadius: radius.awSurface,
    borderWidth: 1,
    borderColor: colors.awBorderHairline,
    alignItems: "center",
    justifyContent: "center",
  },
  logSetLabelDisabled: { ...typography.awButtonLabelPrimary, color: colors.awTextDisabled },

  sheetOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.awSurfacePanel,
    borderTopLeftRadius: radius.awSurface,
    borderTopRightRadius: radius.awSurface,
    padding: spacing.xl,
    gap: spacing.md,
  },
  sheetTitle: { ...typography.heading, color: colors.awTextPrimary },
  sheetActions: { flexDirection: "row", gap: spacing.md, marginTop: spacing.sm },
  sheetSecondaryButton: {
    flex: 1,
    minHeight: touchTarget.minHeight,
    borderRadius: radius.awControl,
    borderWidth: 1,
    borderColor: colors.awBorderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  sheetSecondaryButtonText: { ...typography.awLabelValue, color: colors.awTextPrimary },
  sheetPrimaryButton: {
    flex: 1,
    minHeight: touchTarget.minHeight,
    borderRadius: radius.awControl,
    backgroundColor: colors.signal,
    alignItems: "center",
    justifyContent: "center",
  },
  sheetPrimaryButtonText: { ...typography.awLabelValue, color: colors.signalText },

  summaryWorkoutName: { ...typography.body, color: colors.textSecondary },
  summaryStatsRow: { flexDirection: "row", gap: spacing.xxl, marginVertical: spacing.lg },
  summaryStat: { alignItems: "center", gap: spacing.xs },
  summaryStatValue: { ...typography.title, color: colors.textPrimary },
  summaryStatLabel: { ...typography.caption, color: colors.textSecondary },
});
