import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import type { PlanOverviewV1, PlanSessionSummaryV1 } from "@vostivo/contracts";
import { initializeLocalDatabase } from "../src/local-database/client";
import { getPlanApplicationService } from "../src/plan/plan-runtime";
import { BottomNav } from "../src/ui/bottom-nav";
import { planRowAccessibilityLabel, planRowTarget, sessionProgressionNote, sessionScheduleNote, type PlanRowTarget } from "../src/plan/plan-session-schedule";
import { colors, radius, spacing, typography } from "../src/design/tokens";

/**
 * The Athlete Plan screen (spec section 27): Current Block -> This
 * Week's sessions -> Weekly Focus. "Kam můj trénink směřuje?" — the
 * athlete should understand the direction of training in a few seconds,
 * not read a calendar (spec section 1/2).
 *
 * Moved here from `app/index.tsx` verbatim (Today V1 Foundation task
 * §1/§20) — `/` is now the Today screen; this route is `/plan`. No
 * behavior changed by the move.
 */

type ScreenState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "no-program" }
  | { status: "ready"; overview: PlanOverviewV1 };

export default function PlanScreen(): React.JSX.Element {
  const router = useRouter();
  const [state, setState] = useState<ScreenState>({ status: "loading" });
  // Active-session detection is local-only (WDI) and deliberately fetched
  // independently of the Plan overview: a failed Plan network request
  // (spec section 35 — Plan itself is not offline in this slice) must
  // never hide a real Resume path, since that path never needed the
  // network to begin with.
  const [hasActiveSessionAnywhere, setHasActiveSessionAnywhere] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    let cancelled = false;

    initializeLocalDatabase()
      .then(() => getPlanApplicationService().getActiveWorkoutSession())
      .then((activeSession) => {
        if (!cancelled) setHasActiveSessionAnywhere(activeSession !== undefined);
      })
      .catch(() => {
        // Best-effort — the Resume banner simply stays hidden if this
        // fails; it never blocks the rest of the screen.
      });

    getPlanApplicationService()
      .getCurrentPlan()
      .then((overview) => {
        if (cancelled) return;
        setState(overview.currentBlock === null ? { status: "no-program" } : { status: "ready", overview });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  // Re-check on every focus (e.g. returning from Active Workout) so an
  // active session picked up elsewhere is reflected without a full
  // remount — the canonical state still lives in WDI/the read model, this
  // just re-reads it (spec section 40).
  useFocusEffect(reload);

  return (
    <SafeAreaView style={styles.safeArea} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Text style={styles.screenTitle}>Plan</Text>
        {hasActiveSessionAnywhere ? <ResumeBanner onPress={() => router.push("/active-workout")} /> : null}
        {state.status === "loading" ? <Text style={styles.secondaryText}>Loading your plan…</Text> : null}
        {state.status === "error" ? <ErrorState message={state.message} onRetry={reload} /> : null}
        {state.status === "no-program" ? <NoProgramState /> : null}
        {state.status === "ready" ? (
          <ReadyPlan
            overview={state.overview}
            onOpenRow={(target) => {
              if (target.kind !== "NONE") router.push(target.href);
            }}
          />
        ) : null}
      </ScrollView>
      <BottomNav active="plan" />
    </SafeAreaView>
  );
}

function ReadyPlan({
  overview,
  onOpenRow,
}: {
  overview: PlanOverviewV1;
  onOpenRow: (target: PlanRowTarget) => void;
}): React.JSX.Element {
  const block = overview.currentBlock;
  return (
    <View style={styles.content}>
      {block !== null ? (
        <View style={styles.card}>
          <Text style={styles.blockGoal}>{block.goal}</Text>
          <Text style={styles.blockMeta}>
            Week {block.currentCycleOrder} of {block.cycleCount} · {block.daysPerWeek}x/week
          </Text>
        </View>
      ) : null}

      <Text style={styles.sectionHeading}>This Week</Text>
      <View style={styles.sessionList}>
        {overview.sessions.map((session) => (
          <SessionRow key={session.plannedWorkoutId ?? session.scheduledDate ?? session.order} session={session} onPress={onOpenRow} />
        ))}
      </View>

      {overview.weeklyFocus.length > 0 ? (
        <>
          <Text style={styles.sectionHeading}>Weekly Focus</Text>
          <View style={styles.focusRow}>
            {overview.weeklyFocus.map((focus) => (
              <View key={focus.name} style={styles.focusChip}>
                <Text style={styles.focusChipText}>
                  {focus.name} — {focus.emphasis === "PRIORITY" ? "Priority" : "Maintain"}
                </Text>
              </View>
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
}

function SessionRow({
  session,
  onPress,
}: {
  session: PlanSessionSummaryV1;
  onPress: (target: PlanRowTarget) => void;
}): React.JSX.Element {
  const isRest = session.plannedWorkoutId === null;
  // Slice D: COMPLETED -> the canonical workout's history (review), never another Start.
  const target = planRowTarget(session);
  const isEmphasized = session.displayStatus === "TODAY" || session.displayStatus === "IN_PROGRESS";
  const scheduleNote = sessionScheduleNote(session);
  const progressionNote = sessionProgressionNote(session);

  return (
    <Pressable
      disabled={isRest}
      onPress={() => onPress(target)}
      accessibilityRole={isRest ? undefined : "button"}
      accessibilityLabel={planRowAccessibilityLabel(session, progressionNote)}
      accessibilityHint={target.kind === "HISTORY" ? "Opens workout history" : undefined}
      style={({ pressed }) => [
        styles.sessionRow,
        isRest && styles.sessionRowRest,
        isEmphasized && styles.sessionRowToday,
        session.displayStatus === "COMPLETED" && styles.sessionRowCompleted,
        pressed && !isRest && styles.sessionRowPressed,
      ]}
    >
      <View style={styles.sessionRowText}>
        <Text style={[styles.sessionName, isRest && styles.sessionNameRest]}>{session.name}</Text>
        {session.focus !== null ? <Text style={styles.sessionFocus}>{session.focus}</Text> : null}
        {/* Missed Workout Slice D: the server's EFFECTIVE schedule; authored context stays secondary. */}
        {scheduleNote.kind === "ADJUSTED" && scheduleNote.originally !== null ? <Text style={styles.sessionScheduleContext}>{scheduleNote.originally}</Text> : null}
        {scheduleNote.kind === "NEEDS_TRAINING_DAY" ? <Text style={styles.sessionScheduleContext}>{scheduleNote.label}</Text> : null}
        {/* Progress & Feedback Slice C: server signal only; details in Workout Preview. */}
        {progressionNote !== null ? <Text style={styles.sessionScheduleContext}>{progressionNote}</Text> : null}
      </View>
      <View style={styles.sessionRowMeta}>
        {session.estimatedDurationMinutes !== null ? (
          <Text style={styles.sessionDuration}>{session.estimatedDurationMinutes} min</Text>
        ) : null}
        {scheduleNote.kind === "ADJUSTED" ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{scheduleNote.tag}</Text>
          </View>
        ) : null}
        <StatusBadge status={session.displayStatus} />
      </View>
    </Pressable>
  );
}

function StatusBadge({ status }: { status: PlanSessionSummaryV1["displayStatus"] }): React.JSX.Element | null {
  if (status === "PLANNED" || status === "REST") return null;
  const label: Record<string, string> = {
    TODAY: "Today",
    IN_PROGRESS: "In progress",
    COMPLETED: "Completed",
    SKIPPED: "Skipped",
    RESCHEDULED: "Rescheduled",
    CANCELLED: "Cancelled",
  };
  const isSignal = status === "TODAY" || status === "IN_PROGRESS";
  return (
    <View style={[styles.badge, isSignal && styles.badgeSignal]}>
      <Text style={[styles.badgeText, isSignal && styles.badgeTextSignal]}>{label[status] ?? status}</Text>
    </View>
  );
}

function ResumeBanner({ onPress }: { onPress: () => void }): React.JSX.Element {
  return (
    <Pressable onPress={onPress} style={styles.resumeBanner} accessibilityRole="button" accessibilityLabel="Resume your active workout">
      <Text style={styles.resumeBannerText}>You have a workout in progress</Text>
      <Text style={styles.resumeBannerCta}>Resume →</Text>
    </Pressable>
  );
}

function NoProgramState(): React.JSX.Element {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.emptyStateTitle}>No plan yet</Text>
      <Text style={styles.secondaryText}>Get a Vostivo plan to see your training direction here.</Text>
    </View>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }): React.JSX.Element {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.emptyStateTitle}>Could not load your plan</Text>
      <Text style={styles.secondaryText}>{message}</Text>
      <Pressable onPress={onRetry} style={styles.retryButton} accessibilityRole="button" accessibilityLabel="Retry">
        <Text style={styles.retryButtonText}>Retry</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  scrollContent: { flexGrow: 1, paddingBottom: spacing.xl },
  content: { paddingHorizontal: spacing.lg, gap: spacing.lg },
  screenTitle: { ...typography.title, color: colors.textPrimary, paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.sm },
  secondaryText: { ...typography.body, color: colors.textSecondary, paddingHorizontal: spacing.lg },
  sectionHeading: { ...typography.heading, color: colors.textPrimary, marginTop: spacing.sm },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  blockGoal: { ...typography.heading, color: colors.textPrimary },
  blockMeta: { ...typography.caption, color: colors.textSecondary },
  sessionList: { gap: spacing.sm },
  sessionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    minHeight: 44,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  sessionRowToday: { borderColor: colors.signal },
  sessionRowRest: { opacity: 0.55 },
  // Completed stays readable but visually secondary to what is still ahead.
  sessionRowCompleted: { opacity: 0.75 },
  sessionRowPressed: { opacity: 0.8 },
  sessionRowText: { flexShrink: 1, gap: 2 },
  sessionName: { ...typography.bodyStrong, color: colors.textPrimary },
  sessionNameRest: { color: colors.textSecondary, fontWeight: "400" },
  sessionFocus: { ...typography.caption, color: colors.textSecondary },
  sessionScheduleContext: { ...typography.caption, color: colors.textTertiary },
  sessionRowMeta: { alignItems: "flex-end", gap: spacing.xs },
  sessionDuration: { ...typography.tiny, color: colors.textTertiary },
  badge: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: colors.surfaceElevated },
  badgeSignal: { backgroundColor: colors.signal },
  badgeText: { ...typography.tiny, color: colors.textSecondary },
  badgeTextSignal: { color: colors.signalText, fontWeight: "700" },
  focusRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  focusChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  focusChipText: { ...typography.caption, color: colors.textPrimary },
  resumeBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.signal,
    borderRadius: radius.md,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    minHeight: 44,
  },
  resumeBannerText: { ...typography.bodyStrong, color: colors.signalText },
  resumeBannerCta: { ...typography.bodyStrong, color: colors.signalText },
  emptyState: { paddingHorizontal: spacing.lg, paddingTop: spacing.xl, gap: spacing.sm, alignItems: "flex-start" },
  emptyStateTitle: { ...typography.heading, color: colors.textPrimary },
  retryButton: { marginTop: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: radius.pill, backgroundColor: colors.surfaceElevated, minHeight: 44, justifyContent: "center" },
  retryButtonText: { ...typography.bodyStrong, color: colors.textPrimary },
});
