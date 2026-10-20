import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import type { ProgressOverviewV1 } from "@vostivo/contracts";
import { logTechnicalFailure } from "../../src/plan/plan-runtime";
import { useAthleteRuntime } from "../../src/identity/athlete-runtime-context";
import { BottomNav } from "../../src/ui/bottom-nav";
import { ProgressReadController, type ProgressReadState } from "../../src/progress/progress-read-controller";
import {
  improvementView,
  progressInterpretation,
  shouldOfferWorkoutHistory,
  snapshotView,
  workoutRowView,
  type ImprovementView,
} from "../../src/progress/progress-presentation";
import { exerciseHistoryHref, nextWorkoutPreviewHref, workoutDetailHref } from "../../src/progress/progress-routes";
import { LoadingBlocks, SecondaryButton, StateMessage, WorkoutRow, progressStyles as styles } from "../../src/progress/progress-ui";

/**
 * Progress & Feedback V1 — Slice B: the Progress tab. "Am I getting
 * better?" — interpretation first, then the two snapshot signals, applied
 * improvements and recent workouts. Every value is the server's (GET
 * /api/v1/progress); each section owns its own empty/omitted state, so one
 * missing section never hides the rest. Athlete Memory / Needs Attention
 * are omitted entirely (no placeholders). Refetches on focus; no polling.
 */
export default function ProgressScreen(): React.JSX.Element {
  const { progressApiClient } = useAthleteRuntime();
  const router = useRouter();
  const [state, setState] = useState<ProgressReadState<ProgressOverviewV1>>({ kind: "LOADING" });
  const controller = useMemo(() => new ProgressReadController(() => progressApiClient.getOverview(), { onStateChange: setState, logFailure: logTechnicalFailure }), [progressApiClient]);
  useEffect(() => () => controller.dispose(), [controller]);
  useFocusEffect(
    useCallback(() => {
      void controller.load();
    }, [controller]),
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={["top"]}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <Text style={styles.screenTitle} accessibilityRole="header">
          Progress
        </Text>
        {state.kind === "LOADING" ? <LoadingBlocks count={3} label="Loading progress" /> : null}
        {state.kind === "ERROR" || state.kind === "NOT_AVAILABLE" ? <StateMessage title="Couldn't load progress" actionLabel="Retry" onAction={() => void controller.load()} /> : null}
        {state.kind === "READY" ? (
          <ReadyProgress
            overview={state.data}
            onOpenExercise={(exerciseRef) => router.push(exerciseHistoryHref(exerciseRef))}
            onOpenNextWorkout={(plannedWorkoutId) => router.push(nextWorkoutPreviewHref(plannedWorkoutId))}
            onOpenWorkout={(workoutSessionId) => router.push(workoutDetailHref(workoutSessionId))}
            onOpenHistory={() => router.push("/progress/workouts")}
          />
        ) : null}
      </ScrollView>
      <BottomNav active="progress" />
    </SafeAreaView>
  );
}

function ReadyProgress({
  overview,
  onOpenExercise,
  onOpenNextWorkout,
  onOpenWorkout,
  onOpenHistory,
}: {
  overview: ProgressOverviewV1;
  onOpenExercise: (exerciseRef: string) => void;
  onOpenNextWorkout: (plannedWorkoutId: string) => void;
  onOpenWorkout: (workoutSessionId: string) => void;
  onOpenHistory: () => void;
}): React.JSX.Element {
  const interpretation = progressInterpretation(overview);
  const snapshot = snapshotView(overview.snapshot);
  const improvements = overview.improving.map((item) => improvementView(item, overview.athleteLocalDate));
  const workouts = overview.recentWorkouts.map(workoutRowView);

  return (
    <>
      <View style={styles.section}>
        <Text style={styles.headline}>{interpretation.headline}</Text>
        <Text style={styles.secondaryText}>{interpretation.supporting}</Text>
      </View>

      {snapshot.kind === "UNAVAILABLE" ? (
        <Text style={styles.tertiaryText}>{snapshot.message}</Text>
      ) : (
        <View style={styles.card}>
          {snapshot.block === null ? null : (
            <View style={styles.section}>
              <View style={styles.markerRow}>
                <View style={styles.currentMarker} accessibilityElementsHidden importantForAccessibility="no" />
                <Text style={styles.change}>{snapshot.block.title}</Text>
              </View>
              <Text style={styles.captionText}>{snapshot.block.subtitle}</Text>
            </View>
          )}
          {snapshot.consistency === null ? null : <Text style={styles.secondaryText}>{snapshot.consistency}</Text>}
        </View>
      )}

      <View style={styles.section}>
        <Text style={styles.sectionHeading} accessibilityRole="header">
          {"What's improving"}
        </Text>
        {improvements.length === 0 ? (
          <View style={styles.card}>
            <Text style={styles.rowTitle}>No progression changes yet</Text>
            <Text style={styles.captionText}>Completed training will appear here when Vostivo has meaningful evidence.</Text>
          </View>
        ) : (
          improvements.map((item) => <ImprovementCard key={item.key} item={item} onOpenExercise={() => onOpenExercise(item.exerciseRef)} onOpenNextWorkout={onOpenNextWorkout} />)
        )}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionHeading} accessibilityRole="header">
          Recent workouts
        </Text>
        {workouts.length === 0 ? (
          <Text style={styles.captionText}>No completed workouts yet.</Text>
        ) : (
          workouts.map((row) => <WorkoutRow key={row.key} row={row} onPress={() => onOpenWorkout(row.workoutSessionId)} />)
        )}
        {shouldOfferWorkoutHistory(overview) ? <SecondaryButton label="View workout history" onPress={onOpenHistory} /> : null}
      </View>
    </>
  );
}

/** Two sibling targets (never nested buttons): the evidence opens exercise history; the next line opens the exact next workout. */
function ImprovementCard({ item, onOpenExercise, onOpenNextWorkout }: { item: ImprovementView; onOpenExercise: () => void; onOpenNextWorkout: (plannedWorkoutId: string) => void }): React.JSX.Element {
  const nextWorkout = item.nextWorkout;
  return (
    <View style={styles.card}>
      <Pressable onPress={onOpenExercise} style={({ pressed }) => [styles.cardSection, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel={item.accessibilityLabel}>
        <Text style={styles.rowTitle}>{item.title}</Text>
        <Text style={styles.change}>{item.change}</Text>
        {item.evidence === null ? null : <Text style={styles.captionText}>{item.evidence}</Text>}
      </Pressable>
      {nextWorkout === null || item.next === null ? null : (
        <Pressable
          onPress={() => onOpenNextWorkout(nextWorkout.plannedWorkoutId)}
          style={({ pressed }) => [styles.nextWorkoutLink, pressed && styles.pressed]}
          accessibilityRole="link"
          accessibilityLabel={nextWorkout.accessibilityLabel}
        >
          <Text style={styles.secondaryText}>{item.next}</Text>
          <Text style={styles.linkText}>View next workout ›</Text>
        </Pressable>
      )}
    </View>
  );
}
