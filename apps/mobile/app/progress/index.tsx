import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import type { ProgressOverviewV1 } from "@vostivo/contracts";
import { logTechnicalFailure } from "../../src/plan/plan-runtime";
import { useAthleteRuntime } from "../../src/identity/athlete-runtime-context";
import { BottomNav } from "../../src/ui/bottom-nav";
import { ProgressReadController, type ProgressReadState } from "../../src/progress/progress-read-controller";
import {
  comparisonBars,
  improvementView,
  progressInterpretation,
  shouldOfferWorkoutHistory,
  snapshotView,
  workoutRowView,
  type ComparisonBarsView,
  type ImprovementView,
} from "../../src/progress/progress-presentation";
import { semantic, spacing, type } from "../../src/design/tokens";
import { TopGlow } from "../../src/ui/primitives";
import { exerciseHistoryHref, nextWorkoutPreviewHref, workoutDetailHref } from "../../src/progress/progress-routes";
import { LoadingBlocks, SecondaryButton, StateMessage, WorkoutRow, progressStyles as styles } from "../../src/progress/progress-ui";

/**
 * Progress & Feedback V1 — Slice B: the Progress tab. "Am I getting
 * better?" — interpretation first, then the two snapshot signals, applied
 * improvements and recent workouts. Every value is the server's (GET
 * /api/v1/progress); each section owns its own empty/omitted state, so one
 * missing section never hides the rest. Athlete Memory / Needs Attention
 * are omitted entirely (no placeholders). Refetches on focus; no polling.
 *
 * Visuals: the approved Claude Design `Vostivo Progress` canvas (Athlete
 * Design Integration 01) — interpretation line, hairline snapshot table,
 * "What's improving" cards with a two-bar comparison. Omitted because V1
 * has no data for them (never faked): "Last 8 weeks", Consistency %,
 * Performance / Priority area, Needs attention, RIR, and "What Vostivo has
 * learned" (Athlete Memory).
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
        <TopGlow />
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
  const improvements = overview.improving.map((item) => ({ view: improvementView(item, overview.athleteLocalDate), bars: comparisonBars(item) }));
  const workouts = overview.recentWorkouts.map(workoutRowView);

  return (
    <>
      <View style={styles.section}>
        <View style={local.interpretationRow}>
          {/* A success marker only when the server returned real applied progressions. */}
          {improvements.length > 0 ? <View style={local.successDot} accessibilityElementsHidden importantForAccessibility="no" /> : null}
          <Text style={styles.headline}>{interpretation.headline}</Text>
        </View>
        <Text style={styles.secondaryText}>{interpretation.supporting}</Text>
      </View>

      {snapshot.kind === "UNAVAILABLE" ? (
        <Text style={styles.tertiaryText}>{snapshot.message}</Text>
      ) : (
        <View>
          {snapshot.block === null ? null : (
            <SnapshotRow label="Current block" value={snapshot.block.title} detail={snapshot.block.subtitle} marker />
          )}
          {snapshot.consistency === null ? null : <SnapshotRow label="This week" value={snapshot.consistency} detail={null} marker={false} />}
        </View>
      )}

      <View style={styles.section}>
        <Text style={styles.sectionHeading} accessibilityRole="header">
          {"What's improving"}
        </Text>
        {improvements.length === 0 ? (
          <View style={local.emptyBlock}>
            <Text style={local.emptyTitle}>No progression changes yet</Text>
            <Text style={styles.captionText}>Completed training will appear here when Vostivo has meaningful evidence.</Text>
          </View>
        ) : (
          improvements.map(({ view, bars }) => (
            <ImprovementCard key={view.key} item={view} bars={bars} onOpenExercise={() => onOpenExercise(view.exerciseRef)} onOpenNextWorkout={onOpenNextWorkout} />
          ))
        )}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionHeading} accessibilityRole="header">
          Recent workouts
        </Text>
        {workouts.length === 0 ? (
          <Text style={styles.captionText}>No completed workouts yet. Finish a workout and it will show up here.</Text>
        ) : (
          <View>{workouts.map((row) => <WorkoutRow key={row.key} row={row} onPress={() => onOpenWorkout(row.workoutSessionId)} />)}</View>
        )}
        {shouldOfferWorkoutHistory(overview) ? <SecondaryButton label="View workout history" onPress={onOpenHistory} /> : null}
      </View>
    </>
  );
}

/** One hairline snapshot row: micro label, value, quiet detail; lime marker only for the CURRENT block week. */
function SnapshotRow({ label, value, detail, marker }: { label: string; value: string; detail: string | null; marker: boolean }): React.JSX.Element {
  return (
    <View style={local.snapshotRow} accessible accessibilityLabel={[label, value, detail].filter((part) => part !== null).join(". ")}>
      <Text style={local.snapshotLabel}>{label}</Text>
      <View style={local.snapshotValueBlock}>
        <View style={styles.markerRow}>
          {marker ? <View style={styles.currentMarker} /> : null}
          <Text style={local.snapshotValue}>{value}</Text>
        </View>
        {detail !== null ? <Text style={styles.captionText}>{detail}</Text> : null}
      </View>
    </View>
  );
}

/** Two sibling targets (never nested buttons): the evidence opens exercise history; the next line opens the exact next workout. */
function ImprovementCard({
  item,
  bars,
  onOpenExercise,
  onOpenNextWorkout,
}: {
  item: ImprovementView;
  bars: ComparisonBarsView | null;
  onOpenExercise: () => void;
  onOpenNextWorkout: (plannedWorkoutId: string) => void;
}): React.JSX.Element {
  const nextWorkout = item.nextWorkout;
  return (
    <LinearGradient colors={[semantic.surfaceRaisedStart, semantic.surfaceRaisedEnd]} style={local.card}>
      <Pressable onPress={onOpenExercise} style={({ pressed }) => [local.cardBody, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel={item.accessibilityLabel}>
        <View style={styles.rowHeader}>
          <Text style={styles.rowTitle}>{item.title}</Text>
          <Text style={styles.chevron}>›</Text>
        </View>
        {bars !== null ? (
          <View style={local.bars} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Bar label="Before" value={bars.previousLabel} ratio={bars.previousRatio} current={false} />
            <Bar label="Now" value={bars.currentLabel} ratio={bars.currentRatio} current />
          </View>
        ) : (
          <Text style={styles.change}>{item.change}</Text>
        )}
        {item.evidence === null ? null : <Text style={styles.captionText}>{item.evidence}</Text>}
      </Pressable>
      {nextWorkout === null || item.next === null ? null : (
        <Pressable
          onPress={() => onOpenNextWorkout(nextWorkout.plannedWorkoutId)}
          style={({ pressed }) => [local.cardFooter, pressed && styles.pressed]}
          accessibilityRole="link"
          accessibilityLabel={nextWorkout.accessibilityLabel}
        >
          <Text style={[styles.secondaryText, local.flex]}>{item.next}</Text>
          <Text style={styles.chevron}>›</Text>
        </Pressable>
      )}
    </LinearGradient>
  );
}

/** Foundations §13 comparison bar: same scale, semantic fill only on the current value. */
function Bar({ label, value, ratio, current }: { label: string; value: string; ratio: number; current: boolean }): React.JSX.Element {
  return (
    <View style={local.barRow}>
      <Text style={local.barLabel}>{label}</Text>
      <View style={local.barTrack}>
        <View style={[local.barFill, { width: `${Math.max(4, Math.round(ratio * 100))}%` }, current && local.barFillCurrent]} />
      </View>
      <Text style={[local.barValue, current && local.barValueCurrent]}>{value}</Text>
    </View>
  );
}

const local = StyleSheet.create({
  flex: { flex: 1 },
  interpretationRow: { flexDirection: "row", alignItems: "center", gap: 9 },
  successDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: semantic.successMarker },
  snapshotRow: {
    flexDirection: "row",
    gap: spacing.lg,
    paddingVertical: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: semantic.borderHairline,
  },
  snapshotLabel: { ...type.microLabel, width: 92, paddingTop: 4, color: semantic.textMuted },
  snapshotValueBlock: { flex: 1, gap: 2 },
  snapshotValue: { ...type.bodyStrong, color: semantic.textPrimary, fontVariant: ["tabular-nums"] },
  emptyBlock: { gap: spacing.xs, paddingVertical: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: semantic.borderHairline },
  emptyTitle: { ...type.bodyStrong, color: semantic.textSecondary },
  card: { borderRadius: 14, borderWidth: 1, borderColor: semantic.borderDefault, overflow: "hidden" },
  cardBody: { paddingHorizontal: 18, paddingTop: spacing.lg, paddingBottom: 15, gap: spacing.md },
  cardFooter: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: 18,
    paddingVertical: 13,
    minHeight: 44,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: semantic.borderHairline,
  },
  bars: { gap: 9 },
  barRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  barLabel: { ...type.microLabel, width: 46, color: semantic.textMuted },
  barTrack: { flex: 1, height: 6, borderRadius: 3, backgroundColor: "rgba(255,255,255,0.05)", overflow: "hidden" },
  barFill: { height: 6, borderRadius: 3, backgroundColor: "#4A5257" },
  barFillCurrent: { backgroundColor: semantic.successMarker },
  barValue: { ...type.numericSmall, minWidth: 72, textAlign: "right", color: semantic.textTertiary },
  barValueCurrent: { color: semantic.textPrimary },
});
