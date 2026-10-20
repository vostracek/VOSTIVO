import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import type { WorkoutHistoryDetailV1 } from "@vostivo/contracts";
import { logTechnicalFailure } from "../../../src/plan/plan-runtime";
import { useAthleteRuntime } from "../../../src/identity/athlete-runtime-context";
import { ProgressReadController, type ProgressReadState } from "../../../src/progress/progress-read-controller";
import { workoutDetailView, type WorkoutExerciseView } from "../../../src/progress/progress-presentation";
import { exerciseHistoryHref } from "../../../src/progress/progress-routes";
import { BackHeader, HistoryItemUnavailable, LoadingBlocks, StateMessage, progressStyles as styles } from "../../../src/progress/progress-ui";

/**
 * Progress & Feedback V1 — Slice B: one completed workout, read only — no
 * Start, no editing. Completed sets only (the server returns nothing
 * else), adaptation provenance and progression events only when returned.
 * A 404 (unknown, foreign or non-visible) is one generic state.
 */
export default function WorkoutHistoryDetailScreen(): React.JSX.Element {
  const { progressApiClient } = useAthleteRuntime();
  const router = useRouter();
  const { workoutSessionId } = useLocalSearchParams<{ workoutSessionId: string }>();
  const [state, setState] = useState<ProgressReadState<WorkoutHistoryDetailV1>>({ kind: "LOADING" });
  const controller = useMemo(
    () => new ProgressReadController(() => progressApiClient.getWorkoutDetail(workoutSessionId), { onStateChange: setState, logFailure: logTechnicalFailure }),
    [progressApiClient, workoutSessionId],
  );
  useEffect(() => {
    void controller.load();
    return () => controller.dispose();
  }, [controller]);

  return (
    <SafeAreaView style={styles.safeArea} edges={["top", "bottom"]}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <BackHeader />
        {state.kind === "LOADING" ? <LoadingBlocks count={3} label="Loading workout" /> : null}
        {state.kind === "ERROR" ? <StateMessage title="Couldn't load this workout" actionLabel="Retry" onAction={() => void controller.load()} /> : null}
        {state.kind === "NOT_AVAILABLE" ? <HistoryItemUnavailable /> : null}
        {state.kind === "READY" ? <ReadyDetail detail={state.data} onOpenExercise={(exerciseRef) => router.push(exerciseHistoryHref(exerciseRef))} /> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function ReadyDetail({ detail, onOpenExercise }: { detail: WorkoutHistoryDetailV1; onOpenExercise: (exerciseRef: string) => void }): React.JSX.Element {
  const view = workoutDetailView(detail);
  return (
    <>
      <View style={styles.section}>
        <Text style={styles.screenTitle} accessibilityRole="header">
          {view.title}
        </Text>
        <Text style={styles.captionText}>{view.meta}</Text>
        <Text style={styles.secondaryText}>{view.summary}</Text>
        {view.provenance.length === 0 ? null : (
          <View style={styles.chips}>
            {view.provenance.map((line) => (
              <View key={line} style={styles.chip}>
                <Text style={styles.chipText}>{line}</Text>
              </View>
            ))}
          </View>
        )}
      </View>

      {view.progression.length === 0 ? null : (
        <View style={styles.card}>
          <Text style={styles.rowTitle}>From this workout</Text>
          {view.progression.map((line) => (
            <Text key={line} style={styles.secondaryText}>
              {line}
            </Text>
          ))}
        </View>
      )}

      <View style={styles.section}>
        <Text style={styles.sectionHeading} accessibilityRole="header">
          Exercises
        </Text>
        {view.exercises.map((exercise) => (
          <ExerciseBlock key={exercise.key} exercise={exercise} onOpen={onOpenExercise} />
        ))}
      </View>
    </>
  );
}

function ExerciseBlock({ exercise, onOpen }: { exercise: WorkoutExerciseView; onOpen: (exerciseRef: string) => void }): React.JSX.Element {
  const body = (
    <>
      <View style={styles.rowHeader}>
        <Text style={styles.rowTitle}>{exercise.title}</Text>
        {exercise.exerciseRef === null ? null : <Text style={styles.rowMeta}>History ›</Text>}
      </View>
      {exercise.note === null ? null : <Text style={styles.tertiaryText}>{exercise.note}</Text>}
      {exercise.sets.map((line) => (
        <Text key={line} style={styles.captionText}>
          {line}
        </Text>
      ))}
      {exercise.emptyLabel === null ? null : <Text style={styles.tertiaryText}>{exercise.emptyLabel}</Text>}
    </>
  );
  const ref = exercise.exerciseRef;
  if (ref === null) return <View style={styles.row}>{body}</View>;
  return (
    <Pressable
      onPress={() => onOpen(ref)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={`${exercise.title}${exercise.note === null ? "" : `, ${exercise.note}`}. ${exercise.sets.join(". ")}. Opens exercise history`}
    >
      {body}
    </Pressable>
  );
}
