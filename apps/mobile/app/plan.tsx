import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useFocusEffect, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import type { PlanOverviewV1, PlanSessionSummaryV1 } from "@vostivo/contracts";
import { useAthleteRuntime } from "../src/identity/athlete-runtime-context";
import { BottomNav } from "../src/ui/bottom-nav";
import { planRowAccessibilityLabel, planRowTarget, sessionProgressionNote, sessionScheduleNote, type PlanRowTarget } from "../src/plan/plan-session-schedule";
import { blockMetaLine, isCurrentSession, planStatusLabel, sessionWeekday } from "../src/plan/week-presentation";
import { radius, semantic, spacing, type } from "../src/design/tokens";
import { Hairline, LoadingBlocks, SecondaryButton, SectionHeader, StateMessage, TopGlow } from "../src/ui/primitives";

/**
 * The Athlete Plan screen (spec section 27): Current Block -> This
 * Week's sessions -> Weekly Focus. "Kam můj trénink směřuje?" — the
 * athlete should understand the direction of training in a few seconds,
 * not read a calendar (spec section 1/2).
 *
 * Moved here from `app/index.tsx` verbatim (Today V1 Foundation task
 * §1/§20) — `/` is now the Today screen; this route is `/plan`.
 *
 * Visuals: the approved Claude Design `Vostivo Plan` canvas (Athlete
 * Design Integration 01) — block header + segmented week rail, hairline
 * week rows with the current session as the screen's ONE card, Weekly
 * Focus as hairline rows. Omitted because V1 has no data for them: the
 * "On track" chip and "Shoulders focus" meta. The canvas's Plan update
 * card is Today's missed-workout flow and stays on Today. Behaviour,
 * routing (`planRowTarget`) and schedule notes are unchanged.
 */

type ScreenState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "no-program" }
  | { status: "ready"; overview: PlanOverviewV1 };

export default function PlanScreen(): React.JSX.Element {
  const { planApplicationService } = useAthleteRuntime();
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

    planApplicationService
      .getActiveWorkoutSession()
      .then((activeSession) => {
        if (!cancelled) setHasActiveSessionAnywhere(activeSession !== undefined);
      })
      .catch(() => {
        // Best-effort — the Resume banner simply stays hidden if this
        // fails; it never blocks the rest of the screen.
      });

    planApplicationService
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
  }, [planApplicationService, reloadToken]);

  // Re-check on every focus (e.g. returning from Active Workout) so an
  // active session picked up elsewhere is reflected without a full
  // remount — the canonical state still lives in WDI/the read model, this
  // just re-reads it (spec section 40).
  useFocusEffect(reload);

  return (
    <SafeAreaView style={styles.safeArea} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <TopGlow />
        <Text style={styles.screenTitle} accessibilityRole="header">
          Plan
        </Text>
        {hasActiveSessionAnywhere ? <ResumeBanner onPress={() => router.push("/active-workout")} /> : null}
        {state.status === "loading" ? <LoadingBlocks label="Loading your plan" rows={5} /> : null}
        {state.status === "error" ? <ErrorState onRetry={reload} message={state.message} /> : null}
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
        <View style={styles.blockHeader} accessible accessibilityLabel={`Current block: ${block.name}. ${blockMetaLine(block)}.`}>
          <Text style={styles.eyebrow}>Current block</Text>
          <Text style={styles.blockName}>{block.name}</Text>
          {block.goal.trim().length > 0 && block.goal !== block.name ? <Text style={styles.blockGoal}>{block.goal}</Text> : null}
          <Text style={styles.blockMeta}>{blockMetaLine(block)}</Text>
          <WeekRail current={block.currentCycleOrder} total={block.cycleCount} />
        </View>
      ) : null}

      <View style={styles.section}>
        <SectionHeader label={overview.schedule.displayedCycle === "CURRENT" ? "This week" : "Upcoming week"} />
        <View>
          {overview.sessions.map((session) => (
            <SessionRow key={session.plannedWorkoutId ?? session.scheduledDate ?? session.order} session={session} onPress={onOpenRow} />
          ))}
        </View>
      </View>

      {overview.weeklyFocus.length > 0 ? (
        <View style={styles.section}>
          <SectionHeader label="Weekly focus" />
          <View>
            {overview.weeklyFocus.map((focus, index) => (
              <View key={focus.name}>
                {index > 0 ? <Hairline /> : null}
                <View style={styles.focusRow} accessible accessibilityLabel={`${focus.name}, ${focus.emphasis === "PRIORITY" ? "priority" : "maintain"}`}>
                  <Text style={[styles.focusName, focus.emphasis === "PRIORITY" && styles.focusNamePriority]}>{focus.name}</Text>
                  <Text style={[styles.focusEmphasis, focus.emphasis === "PRIORITY" && styles.focusEmphasisPriority]}>
                    {focus.emphasis === "PRIORITY" ? "Priority" : "Maintain"}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** Foundations §13 progress rail: 2px, segmented by real weeks; position is not a score (neutral white, no lime). */
function WeekRail({ current, total }: { current: number; total: number }): React.JSX.Element | null {
  if (total < 1 || total > 24) return null;
  return (
    <View style={styles.rail} accessible={false} importantForAccessibility="no-hide-descendants">
      {Array.from({ length: total }, (_, index) => (
        <View key={index} style={[styles.railSegment, index < current && styles.railSegmentPast, index === current - 1 && styles.railSegmentCurrent]} />
      ))}
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
  const isCurrent = isCurrentSession(session);
  const scheduleNote = sessionScheduleNote(session);
  const progressionNote = sessionProgressionNote(session);
  const weekday = sessionWeekday(session) ?? "—";
  const notes = [
    // Missed Workout Slice D: the server's EFFECTIVE schedule; authored context stays secondary.
    scheduleNote.kind === "ADJUSTED" ? [scheduleNote.tag, scheduleNote.originally].filter((part) => part !== null).join(" · ") : null,
    scheduleNote.kind === "NEEDS_TRAINING_DAY" ? scheduleNote.label : null,
    // Progress & Feedback Slice C: server signal only; details in Workout Preview.
    progressionNote,
  ].filter((note): note is string => note !== null && note.length > 0);
  const a11y = {
    accessibilityRole: isRest ? undefined : ("button" as const),
    accessibilityLabel: planRowAccessibilityLabel(session, progressionNote),
    accessibilityHint: target.kind === "HISTORY" ? "Opens workout history" : undefined,
  };

  if (isCurrent) {
    // The ONE card on Plan: today's / the in-progress session.
    const meta = [session.focus, session.estimatedDurationMinutes !== null ? `~${session.estimatedDurationMinutes} min` : null].filter((part) => part !== null).join(" · ");
    return (
      <Pressable onPress={() => onPress(target)} style={({ pressed }) => [styles.todayCardOuter, pressed && styles.pressed]} {...a11y}>
        <LinearGradient colors={[semantic.surfaceRaisedStart, semantic.surfaceRaisedEnd]} style={styles.todayCard}>
          <View style={styles.todayCardText}>
            <View style={styles.todayEyebrowRow}>
              <Text style={styles.todayEyebrow}>{weekday}</Text>
              <View style={styles.signalDot} />
              <Text style={styles.todayEyebrow}>{planStatusLabel(session.displayStatus)}</Text>
            </View>
            <Text style={styles.todayName}>{session.name}</Text>
            {meta.length > 0 ? <Text style={styles.rowMeta}>{meta}</Text> : null}
            {notes.map((note) => (
              <Text key={note} style={styles.rowNote}>
                {note}
              </Text>
            ))}
          </View>
          <Text style={styles.chevron}>›</Text>
        </LinearGradient>
      </Pressable>
    );
  }

  return (
    <Pressable disabled={isRest} onPress={() => onPress(target)} style={({ pressed }) => [styles.row, pressed && !isRest && styles.rowPressed]} {...a11y}>
      <Text style={[styles.rowDay, isRest && styles.rowRestText]}>{weekday}</Text>
      <View style={styles.rowText}>
        <Text style={[styles.rowName, isRest && styles.rowRestText, session.displayStatus === "COMPLETED" && styles.rowNameDone]}>{session.name}</Text>
        {notes.map((note) => (
          <Text key={note} style={styles.rowNote}>
            {note}
          </Text>
        ))}
      </View>
      {isRest ? null : (
        <>
          <Text style={styles.rowStatus}>{planStatusLabel(session.displayStatus)}</Text>
          <Text style={styles.chevron}>›</Text>
        </>
      )}
    </Pressable>
  );
}

/** Foundations-derived (no approved design): a quiet tinted row — never a lime fill. */
function ResumeBanner({ onPress }: { onPress: () => void }): React.JSX.Element {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.resumeBanner, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel="Resume your active workout">
      <View style={styles.signalDot} />
      <Text style={styles.resumeBannerText}>You have a workout in progress</Text>
      <Text style={styles.resumeBannerCta}>Resume</Text>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

function NoProgramState(): React.JSX.Element {
  return <StateMessage title="No plan yet" body="Get a Vostivo plan to see your training direction here." />;
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }): React.JSX.Element {
  return (
    <StateMessage title="Could not load your plan" body={__DEV__ ? `Check your connection and try again. (${message})` : "Check your connection and try again."}>
      <SecondaryButton label="Try again" onPress={onRetry} accessibilityLabel="Retry" style={styles.retry} />
    </StateMessage>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: semantic.bgApp },
  scrollContent: { flexGrow: 1, paddingHorizontal: spacing.screenGutter, paddingBottom: spacing.bottomClearance },
  content: { gap: spacing.sectionRhythm + 4 },
  screenTitle: { ...type.pageTitle, color: semantic.textPrimary, paddingTop: spacing.xl, paddingBottom: spacing.xl },
  pressed: { opacity: 0.8 },

  blockHeader: { gap: spacing.sm },
  eyebrow: { ...type.microLabel, color: semantic.textMuted },
  blockName: { ...type.blockTitle, color: semantic.textPrimary },
  blockGoal: { ...type.bodyStrong, color: semantic.textSecondary },
  blockMeta: { ...type.body, color: semantic.textMuted, fontVariant: ["tabular-nums"] },
  rail: { flexDirection: "row", gap: 4, marginTop: spacing.sm },
  railSegment: { flex: 1, height: 2, borderRadius: 1, backgroundColor: "rgba(255,255,255,0.08)" },
  railSegmentPast: { backgroundColor: "rgba(255,255,255,0.3)" },
  railSegmentCurrent: { backgroundColor: "rgba(255,255,255,0.55)" },

  section: { gap: spacing.md },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 48,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: semantic.borderHairline,
  },
  rowPressed: { backgroundColor: semantic.surfacePressed },
  rowDay: { ...type.bodyStrong, width: 38, color: semantic.textMuted },
  rowText: { flex: 1, gap: 2 },
  rowName: { ...type.bodyStrong, fontSize: 15, color: semantic.textPrimary },
  rowNameDone: { color: semantic.textSecondary },
  rowRestText: { fontWeight: "500", color: semantic.textMuted },
  rowStatus: { ...type.labelValue, color: semantic.textMuted },
  rowMeta: { ...type.body, color: semantic.textMuted, fontVariant: ["tabular-nums"] },
  rowNote: { ...type.labelValue, color: semantic.textTertiary },
  chevron: { ...type.button, fontSize: 17, color: semantic.ornamentFaint },

  todayCardOuter: { marginVertical: spacing.sm, borderRadius: radius.surface },
  todayCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    borderRadius: radius.surface,
    borderWidth: 1,
    borderColor: semantic.borderDefault,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  todayCardText: { flex: 1, gap: 5 },
  todayEyebrowRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  todayEyebrow: { ...type.microLabel, color: semantic.signal },
  signalDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: semantic.signal },
  todayName: { ...type.sessionTitle, color: semantic.textPrimary },

  focusRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 44, paddingVertical: spacing.md },
  focusName: { ...type.bodyStrong, fontWeight: "500", color: semantic.textSecondary },
  focusNamePriority: { fontWeight: "600", color: semantic.textPrimary },
  focusEmphasis: { ...type.labelValue, color: semantic.textMuted },
  focusEmphasisPriority: { fontWeight: "600", color: semantic.textSecondary },

  resumeBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.xl,
    borderRadius: radius.control,
    backgroundColor: semantic.surfaceInteractive,
    borderWidth: 1,
    borderColor: semantic.borderDefault,
  },
  resumeBannerText: { ...type.bodyStrong, flex: 1, color: semantic.textPrimary },
  resumeBannerCta: { ...type.button, color: semantic.textSecondary },
  retry: { alignSelf: "flex-start" },
});
