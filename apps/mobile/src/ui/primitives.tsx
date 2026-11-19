import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { radius, semantic, spacing, touchTarget, type } from "../design/tokens";

/**
 * Shared Foundations V1 components (§06–§12). Screens compose these instead
 * of re-declaring the card / button / row grammar, so every approved screen
 * and every Foundations-derived state speaks the same visual language.
 */

/** The faint top light of every approved canvas: `linear-gradient(180deg, rgba(255,255,255,.035), transparent)` over 300px. */
export function TopGlow(): React.JSX.Element {
  return (
    <LinearGradient
      pointerEvents="none"
      colors={["rgba(255,255,255,0.035)", "rgba(255,255,255,0)"]}
      style={styles.topGlow}
    />
  );
}

export function Wordmark(): React.JSX.Element {
  return (
    <Text style={styles.wordmark} accessibilityRole="header" accessibilityLabel="Vostivo">
      VOSTIVO
    </Text>
  );
}

/** Section eyebrow: 600 · 9 · +.18em · uppercase, at the #8B9399 informative floor. */
export function Eyebrow({ children, tone = "muted" }: { children: string; tone?: "muted" | "attention" | "signal" }): React.JSX.Element {
  return <Text style={[styles.eyebrow, tone === "attention" && styles.eyebrowAttention, tone === "signal" && styles.eyebrowSignal]}>{children}</Text>;
}

export function SectionHeader({ label, trailing }: { label: string; trailing?: string }): React.JSX.Element {
  return (
    <View style={styles.sectionHeader}>
      <Eyebrow>{label}</Eyebrow>
      {trailing !== undefined ? <Text style={styles.sectionTrailing}>{trailing}</Text> : null}
    </View>
  );
}

export function Hairline({ style }: { style?: StyleProp<ViewStyle> }): React.JSX.Element {
  return <View style={[styles.hairline, style]} />;
}

/** A semantic state: the dot is a locator, the word is the message (Foundations §09). */
export function StatusMarker({ tone, label }: { tone: "success" | "attention" | "neutral" | "signal" | "offline"; label: string }): React.JSX.Element {
  return (
    <View style={styles.markerRow}>
      <View
        style={[
          styles.markerDot,
          tone === "success" && { backgroundColor: semantic.successMarker },
          tone === "attention" && { backgroundColor: semantic.attentionMarker },
          tone === "neutral" && { backgroundColor: semantic.neutralMarker },
          tone === "signal" && { backgroundColor: semantic.signal },
          tone === "offline" && styles.markerHollow,
        ]}
      />
      <Text
        style={[
          styles.markerLabel,
          tone === "success" && { color: semantic.successText },
          tone === "attention" && { color: semantic.attentionText },
          tone === "signal" && { color: semantic.signal },
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

/**
 * The one white primary action per screen (Foundations §07): white
 * gradient, inverse 700 · 15 · +.13em uppercase label, radius 14, h60. A
 * disabled primary loses the fill entirely; loading keeps the label (width
 * locked) with a small arc before it.
 */
export function PrimaryButton({
  label,
  sublabel,
  onPress,
  disabled = false,
  loading = false,
  accessibilityLabel,
}: {
  label: string;
  sublabel?: string | null;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  accessibilityLabel?: string;
}): React.JSX.Element {
  const inactive = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: inactive, busy: loading }}
      style={({ pressed }) => [styles.primaryOuter, !disabled && !pressed && styles.primaryShadow]}
    >
      {({ pressed }) =>
        disabled ? (
          <View style={[styles.primaryFill, styles.primaryDisabled]}>
            <Text style={[styles.primaryLabel, styles.primaryLabelDisabled]}>{label}</Text>
          </View>
        ) : (
          <LinearGradient
            colors={pressed ? [semantic.primaryFillEnd, semantic.primaryFillEnd] : [semantic.primaryFillStart, semantic.primaryFillEnd]}
            style={styles.primaryFill}
          >
            <View style={styles.primaryHighlight} />
            <View style={styles.primaryLabelRow}>
              {loading ? <ActivityIndicator size="small" color={semantic.textInverse} /> : null}
              <Text style={styles.primaryLabel}>{label}</Text>
            </View>
            {sublabel ? <Text style={styles.primarySub}>{sublabel}</Text> : null}
          </LinearGradient>
        )
      }
    </Pressable>
  );
}

/** Secondary: 1px .16 outline, no fill, radius 10, min-height 44; sentence-case 600 · 13. */
export function SecondaryButton({
  label,
  onPress,
  disabled = false,
  loading = false,
  tone = "default",
  accessibilityLabel,
  style,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  tone?: "default" | "critical";
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const inactive = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: inactive, busy: loading }}
      style={({ pressed }) => [
        styles.secondary,
        tone === "critical" && styles.secondaryCritical,
        pressed && styles.secondaryPressed,
        disabled && styles.secondaryDisabled,
        style,
      ]}
    >
      <View style={styles.primaryLabelRow}>
        {loading ? <ActivityIndicator size="small" color={semantic.textSecondary} /> : null}
        <Text style={[styles.secondaryLabel, tone === "critical" && styles.secondaryLabelCritical, disabled && styles.secondaryLabelDisabled]}>{label}</Text>
      </View>
    </Pressable>
  );
}

/** Tertiary / text action: muted label, no border, optional leading icon or trailing chevron, 44px target. */
export function TextAction({
  label,
  onPress,
  leading,
  chevron = false,
  disabled = false,
  underline = false,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  leading?: React.ReactNode;
  chevron?: boolean;
  disabled?: boolean;
  underline?: boolean;
  accessibilityLabel?: string;
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      hitSlop={4}
      style={({ pressed }) => [styles.textAction, pressed && styles.textActionPressed]}
    >
      {leading}
      <Text style={[styles.textActionLabel, underline && styles.textActionUnderline, disabled && styles.secondaryLabelDisabled]}>{label}</Text>
      {chevron ? <Text style={styles.chevron}>›</Text> : null}
    </Pressable>
  );
}

/**
 * A card is a claim that the content is ONE object with its own action
 * (Foundations §12): graphite gradient, .065 border, radius 14, 1px inset
 * top highlight. `footer` renders the split action row.
 */
export function Card({ children, footer, style }: { children: React.ReactNode; footer?: React.ReactNode; style?: StyleProp<ViewStyle> }): React.JSX.Element {
  return (
    <LinearGradient colors={[semantic.surfaceRaisedStart, semantic.surfaceRaisedEnd]} style={[styles.card, style]}>
      <View style={styles.cardHighlight} />
      <View style={styles.cardBody}>{children}</View>
      {footer !== undefined ? (
        <>
          <Hairline />
          {footer}
        </>
      ) : null}
    </LinearGradient>
  );
}

/** "Review change ›" — the footer action row of a card. */
export function CardFooterAction({ label, onPress, disabled = false, loading = false }: { label: string; onPress: () => void; disabled?: boolean; loading?: boolean }): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      style={({ pressed }) => [styles.cardFooter, pressed && styles.textActionPressed]}
    >
      <Text style={[styles.cardFooterLabel, disabled && styles.secondaryLabelDisabled]}>{label}</Text>
      {loading ? <ActivityIndicator size="small" color={semantic.textMuted} /> : <Text style={styles.chevron}>›</Text>}
    </Pressable>
  );
}

/** Calm full-width message for empty / error / unavailable states (Foundations-derived). */
export function StateMessage({ title, body, children }: { title: string; body?: string | null; children?: React.ReactNode }): React.JSX.Element {
  return (
    <View style={styles.stateMessage}>
      <Text style={styles.stateTitle} accessibilityRole="header">
        {title}
      </Text>
      {body ? <Text style={styles.stateBody}>{body}</Text> : null}
      {children !== undefined ? <View style={styles.stateActions}>{children}</View> : null}
    </View>
  );
}

/** Quiet loading placeholders — tinted surfaces, no shimmer, no spinner overlay. */
export function LoadingBlocks({ label, rows = 3 }: { label: string; rows?: number }): React.JSX.Element {
  return (
    <View style={styles.loading} accessible accessibilityLabel={label} accessibilityState={{ busy: true }}>
      <View style={[styles.loadingBar, { width: "38%", height: 10 }]} />
      <View style={[styles.loadingBar, { width: "72%", height: 30 }]} />
      {Array.from({ length: rows }, (_, index) => (
        <View key={index} style={[styles.loadingBar, { width: "100%", height: 44 }]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  topGlow: { position: "absolute", top: 0, left: 0, right: 0, height: 300 },
  wordmark: { ...type.wordmark, color: "#F4F6F5" },
  eyebrow: { ...type.microLabel, color: semantic.textMuted },
  eyebrowAttention: { color: semantic.attentionText },
  eyebrowSignal: { color: semantic.signal },
  sectionHeader: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: spacing.md },
  sectionTrailing: { ...type.labelValue, fontSize: 11, color: semantic.textMuted, fontVariant: ["tabular-nums"] },
  hairline: { height: StyleSheet.hairlineWidth, backgroundColor: semantic.borderHairline },

  markerRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  markerDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: semantic.neutralMarker },
  markerHollow: { backgroundColor: "transparent", borderWidth: 1, borderColor: semantic.textMuted },
  markerLabel: { ...type.labelValue, fontWeight: "600", color: semantic.textMuted },

  primaryOuter: { borderRadius: radius.surface },
  primaryShadow: { boxShadow: "0px 16px 36px rgba(0,0,0,0.45)" },
  primaryFill: {
    minHeight: touchTarget.primary,
    borderRadius: radius.surface,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.s20,
    paddingVertical: spacing.md,
    gap: 3,
    overflow: "hidden",
  },
  primaryHighlight: { position: "absolute", top: 0, left: 0, right: 0, height: 1, backgroundColor: "rgba(255,255,255,0.9)" },
  primaryDisabled: { borderWidth: 1, borderColor: semantic.borderDisabled },
  primaryLabelRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm },
  primaryLabel: { ...type.buttonPrimary, color: semantic.textInverse, textAlign: "center" },
  primaryLabelDisabled: { color: semantic.textDisabled },
  primarySub: { ...type.labelValue, fontSize: 11, fontWeight: "600", color: "rgba(10,12,13,0.5)", fontVariant: ["tabular-nums"] },

  secondary: {
    minHeight: touchTarget.minHeight,
    borderRadius: radius.control,
    borderWidth: 1,
    borderColor: semantic.borderStrong,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
  },
  secondaryCritical: { borderColor: semantic.criticalBorder },
  secondaryPressed: { backgroundColor: semantic.surfacePressed },
  secondaryDisabled: { borderColor: semantic.borderDisabled },
  secondaryLabel: { ...type.button, color: semantic.textPrimary, textAlign: "center" },
  secondaryLabelCritical: { color: semantic.critical },
  secondaryLabelDisabled: { color: semantic.textDisabled },

  textAction: { flexDirection: "row", alignItems: "center", gap: 7, minHeight: touchTarget.minHeight, alignSelf: "flex-start" },
  textActionPressed: { opacity: 0.7 },
  textActionLabel: { ...type.button, color: semantic.textSecondary },
  textActionUnderline: { textDecorationLine: "underline", textDecorationColor: "rgba(255,255,255,0.2)" },
  chevron: { ...type.button, fontSize: 15, color: semantic.ornamentFaint },

  card: { borderRadius: radius.surface, borderWidth: 1, borderColor: semantic.borderDefault, overflow: "hidden" },
  cardHighlight: { position: "absolute", top: 0, left: 0, right: 0, height: 1, backgroundColor: semantic.surfaceHighlight },
  cardBody: { paddingHorizontal: 18, paddingTop: spacing.lg, paddingBottom: 15, gap: 11 },
  cardFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingVertical: 13,
    minHeight: touchTarget.minHeight,
  },
  cardFooterLabel: { ...type.button, color: "#EDEFEE" },

  stateMessage: { gap: spacing.sm, paddingVertical: spacing.xl },
  stateTitle: { ...type.sessionTitle, color: semantic.textPrimary },
  stateBody: { ...type.body, color: semantic.textMuted },
  stateActions: { marginTop: spacing.md, gap: spacing.md },

  loading: { gap: spacing.md, paddingTop: spacing.xl },
  loadingBar: { borderRadius: radius.input, backgroundColor: semantic.surfaceInteractive },
});

/**
 * Today Final "Plan update" card anatomy, reused for every recommendation /
 * review object on Today and Plan: marker + eyebrow, title, body, optional
 * evidence line, then the split footer action ("Review change ›").
 */
export function UpdateCard({
  eyebrow,
  tone,
  title,
  body,
  detail,
  actionLabel,
  onAction,
  actionLoading = false,
  actionDisabled = false,
  children,
}: {
  eyebrow: string;
  tone: "attention" | "success" | "neutral";
  title?: string | null;
  body?: string | null;
  detail?: string | null;
  actionLabel?: string;
  onAction?: () => void;
  actionLoading?: boolean;
  actionDisabled?: boolean;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <Card
      footer={
        actionLabel !== undefined && onAction !== undefined ? (
          <CardFooterAction label={actionLabel} onPress={onAction} loading={actionLoading} disabled={actionDisabled} />
        ) : undefined
      }
    >
      <View style={updateStyles.eyebrowRow}>
        <View
          style={[
            updateStyles.dot,
            tone === "success" && { backgroundColor: semantic.successMarker },
            tone === "neutral" && { backgroundColor: semantic.neutralMarker },
          ]}
        />
        <Text style={[styles.eyebrow, tone === "attention" && styles.eyebrowAttention, tone === "success" && { color: semantic.successText }]}>{eyebrow}</Text>
      </View>
      {title ? <Text style={updateStyles.title}>{title}</Text> : null}
      {body ? <Text style={updateStyles.body}>{body}</Text> : null}
      {detail ? <Text style={updateStyles.detail}>{detail}</Text> : null}
      {children}
    </Card>
  );
}

const updateStyles = StyleSheet.create({
  eyebrowRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: semantic.attentionMarker },
  title: { ...type.rowTitle, lineHeight: 19.5, color: "#F1F3F2" },
  body: { ...type.body, color: semantic.textMuted },
  detail: { ...type.labelValue, color: semantic.textTertiary, fontVariant: ["tabular-nums"] },
});
