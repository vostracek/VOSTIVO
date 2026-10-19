import { useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import type { WorkoutHistoryItemV1 } from "@vostivo/contracts";
import { getProgressApiClient, logTechnicalFailure } from "../../../src/plan/plan-runtime";
import { PagedHistoryController, type PagedHistoryState } from "../../../src/progress/paged-history-controller";
import { workoutHistoryKey, workoutHistoryPages } from "../../../src/progress/progress-history";
import { workoutRowView } from "../../../src/progress/progress-presentation";
import { workoutDetailHref } from "../../../src/progress/progress-routes";
import { BackHeader, HistoryItemUnavailable, LoadingBlocks, StateMessage, WorkoutRow, progressStyles as styles } from "../../../src/progress/progress-ui";
import { LoadMoreFooter } from "../../../src/progress/load-more-footer";

/**
 * Progress & Feedback V1 — Slice B: every completed workout, newest first,
 * "Load more" with the server's cursor. History is immutable, so it loads
 * once per visit (no focus refetch that would reset the loaded pages).
 */
export default function WorkoutHistoryScreen(): React.JSX.Element {
  const router = useRouter();
  const [state, setState] = useState<PagedHistoryState<WorkoutHistoryItemV1, null>>({ kind: "LOADING" });
  const controller = useMemo(
    () => new PagedHistoryController(workoutHistoryPages(getProgressApiClient()), workoutHistoryKey, { onStateChange: setState, logFailure: logTechnicalFailure }),
    [],
  );
  useEffect(() => {
    void controller.load();
    return () => controller.dispose();
  }, [controller]);

  return (
    <SafeAreaView style={styles.safeArea} edges={["top", "bottom"]}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <BackHeader />
        <Text style={styles.screenTitle} accessibilityRole="header">
          Workout history
        </Text>
        {state.kind === "LOADING" ? <LoadingBlocks count={4} label="Loading workout history" /> : null}
        {state.kind === "ERROR_INITIAL" ? <StateMessage title="Couldn't load workout history" actionLabel="Retry" onAction={() => void controller.load()} /> : null}
        {state.kind === "NOT_AVAILABLE" ? <HistoryItemUnavailable /> : null}
        {state.kind === "READY" ? (
          <View style={styles.section}>
            {state.items.length === 0 ? <Text style={styles.captionText}>No completed workouts yet.</Text> : null}
            {state.items.map((item) => {
              const row = workoutRowView(item);
              return <WorkoutRow key={row.key} row={row} onPress={() => router.push(workoutDetailHref(row.workoutSessionId))} />;
            })}
            <LoadMoreFooter state={state} onLoadMore={() => void controller.loadMore()} endLabel="That's all your completed workouts." />
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

