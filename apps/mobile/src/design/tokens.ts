/**
 * Vostivo mobile design tokens — Premium Performance / Refined Dark.
 *
 * This file is provisional implementation infrastructure, not the
 * product design-system source of truth (Claude Design project "Vostivo
 * visual design exploration"). Existing keys below are load-bearing for
 * Plan/Preview/navigation, already visually approved — their VALUES must
 * not change as a side effect of aligning a different screen. New keys
 * added for the Active Workout Claude Design Alignment Pass are grouped
 * separately below and mirror the approved Foundations V1 values
 * (`Vostivo Design System Foundations.dc.html`) and the approved
 * `Vostivo Active Workout v2.dc.html` canvas exactly — they intentionally
 * do not reuse an existing key name even where a value happens to
 * coincide, so this file stays an honest diff against Foundations rather
 * than a silent renaming of what Plan/Preview already rely on.
 *
 * HONEST GAP (carried over): no Archivo font files exist in this
 * repository to load via `expo-font` — typography still uses the OS
 * system font rather than substituting a random third-party face.
 *
 * Locked product rule: `signal` (#CDF24E) means active/current/focus — it
 * is NEVER used for generic success (`success` is a separate color).
 */
export const colors = {
  // --- Existing, load-bearing for Plan/Preview/bottom-nav — unchanged ---
  background: "#0B0D0F",
  surface: "#17171A",
  surfaceElevated: "#1F1F23",
  border: "#2A2A2F",
  textPrimary: "#F2F2F3",
  textSecondary: "#8B9399",
  textTertiary: "#6B6B72",
  signal: "#CDF24E",
  signalText: "#0B0D0F",
  success: "#34D399",
  danger: "#F87171",

  // --- Foundations V1 — added for the Active Workout alignment pass ---
  awBackgroundCanvas: "#08090A",
  awChrome: "#0D1012",
  awSurfacePanel: "#0E1113",
  awSurfaceCardGradientStart: "#15181B",
  awSurfaceCardGradientEnd: "#101315",
  awSurfaceCardGradientStartActive: "#14171A",
  awSurfaceCardGradientEndActive: "#0F1214",
  awSurfaceInteractive: "rgba(255,255,255,0.035)",
  awSurfaceInteractivePressed: "rgba(255,255,255,0.06)",
  awSurfaceRowNow: "#191D21",
  awSurfaceWellFocused: "#08090A",
  awBorderHairline: "rgba(255,255,255,0.06)",
  awBorderDefault: "rgba(255,255,255,0.065)",
  awBorderStrong: "rgba(255,255,255,0.16)",
  awBorderMicro: "rgba(255,255,255,0.09)",
  awTextPrimary: "#F8FAF9",
  awTextSecondary: "#C1C8CC",
  awTextTertiary: "#A2AAB0",
  awTextMuted: "#8B9399",
  awTextFaint: "#6E777D",
  awTextFainter: "#767F86",
  awTextDisabled: "#565E63",
  awTextInverse: "#0A0C0D",
  awSignal: "#CDF24E",
  awSignalMutedLabel: "#98A66B",
  awChevronCompleted: "#9AA1A6",
  awPrevText: "#646D73",
  awPrevTextNow: "#8A9196",
  awFutureValueText: "#6E777D",
  awFutureDivider: "#3A4145",
  awReopenChipBg: "#282D31",
  awReopenIcon: "#DCE2E5",
  awSuccessMarker: "#56D298",
} as const;

/**
 * `xs`..`xxl` are the pre-existing semantic aliases the Plan/Preview
 * screens already use (kept unchanged). `screenGutter`/`sectionRhythm`
 * are the two locked semantic values this pass's new screen actually
 * needs; `aw20`/`aw36`/`aw38` fill gaps in the locked 4/8/12/16/20/24/
 * 32/40/48/56 scale that only Active Workout's approved canvas uses.
 */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  screenGutter: 22,
  sectionRhythm: 26,
  aw20: 20,
  aw36: 36,
  aw38: 38,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
  awMicro: 6,
  awControl: 9,
  awSurface: 14,
} as const;

export const typography = {
  title: { fontSize: 26, fontWeight: "700" as const },
  heading: { fontSize: 18, fontWeight: "600" as const },
  body: { fontSize: 15, fontWeight: "400" as const },
  bodyStrong: { fontSize: 15, fontWeight: "600" as const },
  caption: { fontSize: 13, fontWeight: "400" as const },
  tiny: { fontSize: 11, fontWeight: "500" as const },

  // Foundations V1 type roles used by Active Workout's approved canvas
  awExerciseTitle: { fontSize: 27, fontWeight: "700" as const, letterSpacing: -0.6 },
  awSessionEyebrow: { fontSize: 11, fontWeight: "700" as const, letterSpacing: 2.6, textTransform: "uppercase" as const },
  awNumeric: { fontSize: 17, fontWeight: "600" as const },
  awNumericCompleted: { fontSize: 14, fontWeight: "600" as const },
  awLabelValue: { fontSize: 13, fontWeight: "600" as const },
  awBody: { fontSize: 13, fontWeight: "500" as const },
  awMicroLabel: { fontSize: 9, fontWeight: "600" as const, letterSpacing: 1.6, textTransform: "uppercase" as const },
  awTableHeader: { fontSize: 10, fontWeight: "600" as const, letterSpacing: 1.4, textTransform: "uppercase" as const },
  awButtonLabelPrimary: { fontSize: 15, fontWeight: "700" as const, letterSpacing: 1.8 },
  awButtonLabelPrimarySub: { fontSize: 11, fontWeight: "600" as const },
} as const;

export const touchTarget = {
  minHeight: 44,
} as const;
