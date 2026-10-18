import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import type { WorkoutPreviewExerciseV1, WorkoutPreviewV1 } from "@vostivo/contracts";
import { getPlanApplicationService, getWorkoutSyncCoordinator } from "../../src/plan/plan-runtime";
import { formatLoad, formatRepTarget } from "../../src/workout/format-target";
import { colors, radius, spacing, touchTarget, typography } from "../../src/design/tokens";

/**
 * Workout Preview (spec section 22/32): purpose, exercises, sets/rep
 * ranges, target/load, estimated duration, session status, and the
 * primary Start Workout action. Secondary actions (Change day / Adjust
 * time / Edit) do not exist yet — per spec section 32, they are simply
 * not shown, not shipped as disabled fake controls.
 */
type ScreenState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; preview: WorkoutPreviewV1 }
  | { status: "starting"; preview: WorkoutPreviewV1 }
  | { status: "start-error"; message: string; preview: WorkoutPreviewV1 };

export default function WorkoutPreviewScreen(): React.JSX.Element {
  const { plannedWorkoutId } = useLocalSearchParams<{ plannedWorkoutId: string }>();
  const router = useRouter();
  const [state, setState] = useState<ScreenState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    getPlanApplicationService()
      .getWorkoutPreview(plannedWorkoutId)
      .then((preview) => {
        if (!cancelled) setState({ status: "ready", preview });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [plannedWorkoutId]);

  const onStartWorkout = useCallback(async () => {
    if (state.status !== "ready" && state.status !== "start-error") return;
    const { preview } = state;
    setState({ status: "starting", preview });
    try {
      // The real chain (spec section 33): the already-fetched
      // WorkoutPrescriptionV1 goes straight to WDI's real
      // startWorkoutSession — encrypted SQLite, durable outbox. WDI's own
      // guard resolves ALREADY_ACTIVE vs STARTED explicitly below; both
      // outcomes land on Active Workout — an already-active session is a
      // resume, never a hang.
      const outcome = await getPlanApplicationService().startWorkout(preview);
      // START is durable locally now; syncing it is fire-and-forget.
      if (outcome.status === "STARTED") getWorkoutSyncCoordinator().requestSync("mutation");
      if (outcome.status === "STARTED" || outcome.status === "ALREADY_ACTIVE") {
        // `replace`, not `push`: this screen must not remain underneath
        // Active Workout on the navigation stack. With `push`, returning
        // here via back/gesture would land on a stale "starting" render
        // that nothing ever resets — the exact stuck-CTA bug this fixes.
        router.replace("/active-workout");
        return;
      }
    } catch (error: unknown) {
      setState({ status: "start-error", message: error instanceof Error ? error.message : String(error), preview });
    }
  }, [state, router]);

  const currentPreview = state.status === "ready" || state.status === "starting" || state.status === "start-error" ? state.preview : undefined;

  return (
    <SafeAreaView style={styles.safeArea} edges={["top", "bottom"]}>
      <View style={styles.navRow}>
        <Pressable
          onPress={() => router.back()}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={8}
        >
          <Text style={styles.backButtonText}>‹ Back</Text>
        </Pressable>
      </View>
      <ScrollView style={styles.flex} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        {state.status === "loading" ? <Text style={styles.secondaryText}>Loading workout…</Text> : null}
        {state.status === "error" ? <Text style={styles.errorText}>{state.message}</Text> : null}
        {state.status === "start-error" ? <Text style={styles.errorText}>{state.message}</Text> : null}
        {currentPreview !== undefined ? <PreviewContent preview={currentPreview} /> : null}
      </ScrollView>
      {currentPreview !== undefined ? (
        <View style={styles.footer}>
          <Pressable
            disabled={state.status === "starting"}
            onPress={onStartWorkout}
            style={({ pressed }) => [styles.startButton, pressed && styles.startButtonPressed, state.status === "starting" && styles.startButtonDisabled]}
            accessibilityRole="button"
            accessibilityLabel="Start Workout"
          >
            <Text style={styles.startButtonText}>{state.status === "starting" ? "Starting…" : "Start Workout"}</Text>
          </Pressable>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

function PreviewContent({ preview }: { preview: WorkoutPreviewV1 }): React.JSX.Element {
  return (
    <View style={styles.content}>
      <Text style={styles.workoutName}>{preview.name}</Text>
      {preview.focus !== null ? <Text style={styles.workoutFocus}>{preview.focus}</Text> : null}
      {preview.estimatedDurationMinutes !== null ? (
        <Text style={styles.workoutDuration}>{preview.estimatedDurationMinutes} min</Text>
      ) : null}

      <View style={styles.exerciseList}>
        {preview.exercises.map((exercise) => (
          <ExerciseCard key={exercise.plannedExerciseId} exercise={exercise} />
        ))}
      </View>
    </View>
  );
}

function ExerciseCard({ exercise }: { exercise: WorkoutPreviewExerciseV1 }): React.JSX.Element {
  return (
    <View style={styles.exerciseCard}>
      <Text style={styles.exerciseName}>{exercise.displayName}</Text>
      {exercise.sets.map((set) => (
        <Text key={set.plannedSetId} style={styles.setLine}>
          {formatRepTarget(set.targetReps)}
          {set.targetLoad !== null ? ` · ${formatLoad(set.targetLoad)}` : ""}
        </Text>
      ))}
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
  secondaryText: { ...typography.body, color: colors.textSecondary, padding: spacing.lg },
  errorText: { ...typography.body, color: colors.danger, padding: spacing.lg },
  workoutName: { ...typography.title, color: colors.textPrimary },
  workoutFocus: { ...typography.body, color: colors.textSecondary },
  workoutDuration: { ...typography.caption, color: colors.textTertiary },
  exerciseList: { gap: spacing.md, marginTop: spacing.md },
  exerciseCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    gap: spacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  exerciseName: { ...typography.bodyStrong, color: colors.textPrimary, marginBottom: spacing.xs },
  setLine: { ...typography.body, color: colors.textSecondary },
  footer: {
    padding: spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  startButton: {
    backgroundColor: colors.signal,
    borderRadius: radius.pill,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  startButtonPressed: { opacity: 0.85 },
  startButtonDisabled: { opacity: 0.6 },
  startButtonText: { ...typography.bodyStrong, color: colors.signalText },
});
