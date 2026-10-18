import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing, touchTarget, typography } from "../design/tokens";
import { COPY, type MissedWorkoutCard as MissedWorkoutCardModel } from "./missed-workout-flow";

/**
 * Missed Workout V1 Slice D — Today's compact, calm adaptation card (below
 * the Workout Hero; it never replaces the Hero's primary action). Neutral
 * surface — the signal color appears only on the action text, never as a
 * lime or red card. Renders only `missedWorkoutCard(state)`; no logic.
 */
export function MissedWorkoutCard(props: {
  readonly card: MissedWorkoutCardModel;
  readonly onReview: () => void;
  readonly onViewPlan: () => void;
  readonly onRetryTimeZone: () => void;
}): React.JSX.Element {
  const { card } = props;
  switch (card.kind) {
    case "RECOMMENDATION":
      return (
        <Pressable onPress={props.onReview} style={({ pressed }) => [styles.card, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel={`${card.title}. ${COPY.reviewCta}`}>
          <Text style={styles.eyebrow}>{COPY.eyebrow}</Text>
          <Text style={styles.title}>{card.title}</Text>
          <Text style={styles.body}>{card.body}</Text>
          <Text style={styles.cta}>{COPY.reviewCta}</Text>
        </Pressable>
      );
    case "REVIEW_REQUIRED":
      return (
        <Pressable onPress={props.onViewPlan} style={({ pressed }) => [styles.card, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel={`${COPY.reviewRequiredTitle}. ${COPY.viewPlan}`}>
          <Text style={styles.eyebrow}>{COPY.eyebrow}</Text>
          <Text style={styles.title}>{COPY.reviewRequiredTitle}</Text>
          <Text style={styles.body}>{COPY.reviewRequiredBody}</Text>
          {card.reason !== null ? <Text style={styles.quiet}>{card.reason}</Text> : null}
          <Text style={styles.cta}>{COPY.viewPlan}</Text>
        </Pressable>
      );
    case "TIMEZONE_REQUIRED":
      return (
        <View style={styles.card}>
          <Text style={styles.eyebrow}>{COPY.eyebrow}</Text>
          <Text style={styles.body}>{COPY.timeZoneRequired}</Text>
          <Pressable
            onPress={props.onRetryTimeZone}
            disabled={card.retrying}
            hitSlop={{ top: 8, bottom: 8 }}
            style={styles.inlineAction}
            accessibilityRole="button"
            accessibilityLabel={COPY.tryAgain}
            accessibilityState={{ disabled: card.retrying, busy: card.retrying }}
          >
            <Text style={styles.cta}>{card.retrying ? "Trying…" : COPY.tryAgain}</Text>
          </Pressable>
        </View>
      );
  }
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: 2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  pressed: { opacity: 0.85 },
  eyebrow: { ...typography.tiny, color: colors.textTertiary, textTransform: "uppercase" },
  title: { ...typography.heading, color: colors.textPrimary, marginTop: spacing.xs },
  body: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  quiet: { ...typography.caption, color: colors.textTertiary, marginTop: 2 },
  cta: { ...typography.bodyStrong, color: colors.signal, marginTop: spacing.sm },
  inlineAction: { alignSelf: "flex-start", minHeight: touchTarget.minHeight, justifyContent: "center" },
});
