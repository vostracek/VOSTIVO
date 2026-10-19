import { useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import type { ExerciseExposureV1 } from "@vostivo/contracts";
import { getProgressApiClient, logTechnicalFailure } from "../../../src/plan/plan-runtime";
import { PagedHistoryController, type PagedHistoryState } from "../../../src/progress/paged-history-controller";
import { exerciseExposureKey, exerciseHistoryPages, type ExerciseHistoryHeader } from "../../../src/progress/progress-history";
import { exerciseHistoryHeaderView, exposureView } from "../../../src/progress/progress-presentation";
import { LoadMoreFooter } from "../../../src/progress/load-more-footer";
import { BackHeader, HistoryItemUnavailable, LoadingBlocks, StateMessage, progressStyles as styles } from "../../../src/progress/progress-ui";

/**
 * Progress & Feedback V1 — Slice B: the history of ONE performed exercise
 * identity (a temporary substitute is its own identity — never merged into
 * the authored exercise). Factual rows only: date, workout, load × reps.
 * No graph, e1RM or tonnage. "Load more" with the server's cursor.
 */
export default function ExerciseHistoryScreen(): React.JSX.Element {
  const { exerciseRef } = useLocalSearchParams<{ exerciseRef: string }>();
  const [state, setState] = useState<PagedHistoryState<ExerciseExposureV1, ExerciseHistoryHeader>>({ kind: "LOADING" });
  const controller = useMemo(
    () => new PagedHistoryController(exerciseHistoryPages(getProgressApiClient(), exerciseRef), exerciseExposureKey, { onStateChange: setState, logFailure: logTechnicalFailure }),
    [exerciseRef],
  );
  useEffect(() => {
    void controller.load();
    return () => controller.dispose();
  }, [controller]);

  return (
    <SafeAreaView style={styles.safeArea} edges={["top", "bottom"]}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <BackHeader />
        {state.kind === "LOADING" ? <LoadingBlocks count={4} label="Loading exercise history" /> : null}
        {state.kind === "ERROR_INITIAL" ? <StateMessage title="Couldn't load exercise history" actionLabel="Retry" onAction={() => void controller.load()} /> : null}
        {state.kind === "NOT_AVAILABLE" ? <HistoryItemUnavailable /> : null}
        {state.kind === "READY" ? <ReadyHistory state={state} onLoadMore={() => void controller.loadMore()} /> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function ReadyHistory({ state, onLoadMore }: { state: Extract<PagedHistoryState<ExerciseExposureV1, ExerciseHistoryHeader>, { kind: "READY" }>; onLoadMore: () => void }): React.JSX.Element {
  const header = exerciseHistoryHeaderView(state.header, state.items);
  return (
    <>
      <View style={styles.section}>
        <Text style={styles.screenTitle} accessibilityRole="header">
          {header.title}
        </Text>
        {header.interpretation === null ? null : <Text style={styles.secondaryText}>{header.interpretation}</Text>}
      </View>
      <View style={styles.section}>
        {state.items.map((exposure) => {
          const row = exposureView(exposure);
          return (
            <View key={row.key} style={styles.row} accessible accessibilityLabel={row.accessibilityLabel}>
              <Text style={styles.rowTitle}>{row.dateLabel}</Text>
              <Text style={styles.captionText}>{row.context}</Text>
              <Text style={styles.secondaryText}>{row.sets}</Text>
            </View>
          );
        })}
        <LoadMoreFooter state={state} onLoadMore={onLoadMore} endLabel="That's the full history for this exercise." />
      </View>
    </>
  );
}
