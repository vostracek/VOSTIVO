/**
 * Vostivo mobile design tokens — Design System Foundations V1
 * (`~/VostivoDesignArchive/athlete-v1/canvases/Vostivo Design System Foundations.dc.html`,
 * "Premium performance / refined dark", 21 August 2026).
 *
 * Two layers, as Foundations §17 prescribes:
 * - `primitives` hold raw values and are never referenced by components;
 * - `semantic` holds intent (bg / surface / text / border / state). Components
 *   consume semantic tokens only, so a Light theme is a swap of this one
 *   object, not a redesign.
 *
 * Appearance: Foundations V1 defines only the dark semantic layer ("Dark is
 * the product theme, not a brand mandate"; light mode is "prep" only, no
 * approved light values). The app therefore renders the dark theme in every
 * system appearance until a light semantic layer is designed and tested —
 * this is a documented gap, not a claim of light parity.
 *
 * Locked product rule: `signal` (#CDF24E) means active / current / focus —
 * never success, improvement or a large fill. Success and attention are
 * separate semantic families. The white primary action appears once per
 * screen.
 */

const primitives = {
  graphite950: "#08090A",
  graphite900: "#0B0D0F",
  graphite850: "#0D1012",
  graphite800: "#0E1113",
  graphite700: "#15181B",
  graphite750: "#101315",
  lime500: "#CDF24E",
  lime600: "#B7DC3F",
  green500: "#56D298",
  green300: "#78C79B",
  amber500: "#E0B463",
  amber600: "#C99E52",
  red400: "#D9736F",
  white: "#FFFFFF",
  offWhite: "#EFF2F0",
} as const;

/** The dark semantic layer — the only approved theme in Foundations V1. */
export const semantic = {
  bgCanvas: primitives.graphite950,
  bgApp: primitives.graphite900,
  bgChrome: primitives.graphite850,
  surfacePanel: primitives.graphite800,
  surfaceRaisedStart: primitives.graphite700,
  surfaceRaisedEnd: primitives.graphite750,
  surfaceInteractive: "rgba(255,255,255,0.035)",
  surfacePressed: "rgba(255,255,255,0.06)",
  surfaceTint: "rgba(255,255,255,0.03)",
  surfaceHighlight: "rgba(255,255,255,0.045)",

  borderHairline: "rgba(255,255,255,0.06)",
  borderDefault: "rgba(255,255,255,0.065)",
  borderMicro: "rgba(255,255,255,0.09)",
  borderStrong: "rgba(255,255,255,0.16)",
  borderDisabled: "rgba(255,255,255,0.07)",

  textPrimary: "#F8FAF9",
  textSecondary: "#C1C8CC",
  textTertiary: "#A2AAB0",
  textMuted: "#8B9399",
  textDisabled: "#565E63",
  textInverse: "#0A0C0D",
  /** Decorative only (Foundations §02): never a label or a value. */
  ornamentFaint: "#6E777D",
  ornamentChevron: "#4E565B",
  ornamentDot: "#424950",

  signal: primitives.lime500,
  signalPressed: primitives.lime600,
  signalTint: "rgba(205,242,78,0.10)",

  successMarker: primitives.green500,
  successText: primitives.green300,
  attentionMarker: primitives.amber500,
  attentionText: primitives.amber600,
  neutralMarker: "#8B9399",
  critical: primitives.red400,
  criticalBorder: "rgba(217,115,111,0.30)",

  primaryFillStart: primitives.white,
  primaryFillEnd: primitives.offWhite,
  scrim: "rgba(3,4,5,0.72)",
  navActive: "#F4F6F5",
  navInactive: "#697278",
} as const;

export type SemanticColors = typeof semantic;

/**
 * Legacy keys used by screens that predate Foundations V1 (and the AW
 * alignment-pass `aw*` keys). Every value now resolves to the semantic
 * layer above — kept so un-restyled screens keep compiling, and so the
 * Active Workout tests' source checks stay valid.
 */
export const colors = {
  background: semantic.bgApp,
  surface: semantic.surfacePanel,
  surfaceElevated: semantic.surfaceRaisedStart,
  border: semantic.borderDefault,
  textPrimary: semantic.textPrimary,
  textSecondary: semantic.textMuted,
  textTertiary: semantic.textMuted,
  signal: semantic.signal,
  signalText: semantic.textInverse,
  success: semantic.successMarker,
  danger: semantic.critical,
  /** Foundations §07 primary action fill (white) and its inverse label — replaces the old lime-filled buttons. */
  primaryAction: semantic.primaryFillStart,
  primaryActionText: semantic.textInverse,
  successText: semantic.successText,

  awBackgroundCanvas: semantic.bgCanvas,
  awChrome: semantic.bgChrome,
  awSurfacePanel: semantic.surfacePanel,
  awSurfaceCardGradientStart: semantic.surfaceRaisedStart,
  awSurfaceCardGradientEnd: semantic.surfaceRaisedEnd,
  awSurfaceCardGradientStartActive: "#14171A",
  awSurfaceCardGradientEndActive: "#0F1214",
  awSurfaceInteractive: semantic.surfaceInteractive,
  awSurfaceInteractivePressed: semantic.surfacePressed,
  awSurfaceRowNow: "#191D21",
  awSurfaceWellFocused: semantic.bgCanvas,
  awBorderHairline: semantic.borderHairline,
  awBorderDefault: semantic.borderDefault,
  awBorderStrong: semantic.borderStrong,
  awBorderMicro: semantic.borderMicro,
  awTextPrimary: semantic.textPrimary,
  awTextSecondary: semantic.textSecondary,
  awTextTertiary: semantic.textTertiary,
  awTextMuted: semantic.textMuted,
  awTextFaint: semantic.ornamentFaint,
  awTextFainter: "#767F86",
  awTextDisabled: semantic.textDisabled,
  awTextInverse: semantic.textInverse,
  awSignal: semantic.signal,
  awSignalMutedLabel: "#98A66B",
  awChevronCompleted: "#9AA1A6",
  awPrevText: "#646D73",
  awPrevTextNow: "#8A9196",
  awFutureValueText: semantic.ornamentFaint,
  awFutureDivider: "#3A4145",
  awReopenChipBg: "#282D31",
  awReopenIcon: "#DCE2E5",
  awSuccessMarker: semantic.successMarker,
} as const;

/** Foundations §04: production scale + the three permanent semantic aliases. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  s20: 20,
  xl: 24,
  xxl: 32,
  s40: 40,
  s48: 48,
  s56: 56,
  screenGutter: 22,
  sectionRhythm: 26,
  aw20: 20,
  aw36: 36,
  aw38: 38,
  /** Scroll containers clear the fixed nav / home indicator (Foundations §16: 40–56). */
  bottomClearance: 48,
} as const;

/** Foundations §05. `pill` is kept only for markers/avatars. */
export const radius = {
  sm: 8,
  md: 10,
  lg: 14,
  pill: 999,
  awMicro: 6,
  input: 8,
  awControl: 9,
  control: 10,
  awSurface: 14,
  surface: 14,
  sheet: 22,
} as const;

/**
 * Archivo (SIL OFL 1.1) is bundled as static 400/500/600/700 files and
 * registered natively by the `expo-font` config plugin as ONE family, so
 * `fontWeight` selects the right file on Android and iOS.
 */
export const fontFamily = "Archivo";

/** em → RN letterSpacing (px) at a given size. */
function em(value: number, fontSize: number): number {
  return Math.round(value * fontSize * 100) / 100;
}

const tabular = { fontVariant: ["tabular-nums" as const] };

/** Foundations §03 type roles. Every role carries the product family. */
export const type = {
  wordmark: { fontFamily, fontSize: 12, fontWeight: "700" as const, letterSpacing: em(0.32, 12) },
  display: { fontFamily, fontSize: 41, lineHeight: 43, fontWeight: "700" as const, letterSpacing: em(-0.032, 41) },
  pageTitle: { fontFamily, fontSize: 28, lineHeight: 30, fontWeight: "700" as const, letterSpacing: em(-0.026, 28) },
  blockTitle: { fontFamily, fontSize: 34, lineHeight: 37, fontWeight: "700" as const, letterSpacing: em(-0.03, 34) },
  exerciseTitle: { fontFamily, fontSize: 27, lineHeight: 30, fontWeight: "700" as const, letterSpacing: em(-0.028, 27) },
  sessionTitle: { fontFamily, fontSize: 20, lineHeight: 22, fontWeight: "700" as const, letterSpacing: em(-0.02, 20) },
  rowTitle: { fontFamily, fontSize: 15, lineHeight: 20, fontWeight: "600" as const },
  bodyStrong: { fontFamily, fontSize: 14, lineHeight: 19, fontWeight: "600" as const },
  body: { fontFamily, fontSize: 13, lineHeight: 19, fontWeight: "500" as const },
  labelValue: { fontFamily, fontSize: 12, lineHeight: 16, fontWeight: "500" as const },
  microLabel: { fontFamily, fontSize: 9, lineHeight: 12, fontWeight: "600" as const, letterSpacing: em(0.18, 9), textTransform: "uppercase" as const },
  tableHeader: { fontFamily, fontSize: 10, lineHeight: 13, fontWeight: "600" as const, letterSpacing: em(0.14, 10), textTransform: "uppercase" as const },
  eyebrow: { fontFamily, fontSize: 11, lineHeight: 14, fontWeight: "600" as const, letterSpacing: em(0.24, 11), textTransform: "uppercase" as const },
  numeric: { fontFamily, fontSize: 17, fontWeight: "600" as const, ...tabular },
  numericSmall: { fontFamily, fontSize: 14, fontWeight: "600" as const, ...tabular },
  buttonPrimary: { fontFamily, fontSize: 15, fontWeight: "700" as const, letterSpacing: em(0.13, 15), textTransform: "uppercase" as const },
  button: { fontFamily, fontSize: 13, fontWeight: "600" as const },
  navLabel: { fontFamily, fontSize: 10, fontWeight: "500" as const, letterSpacing: em(0.03, 10) },
} as const;

/** Legacy role names (pre-Foundations screens + AW alignment pass), now on Archivo. */
export const typography = {
  title: type.pageTitle,
  heading: { fontFamily, fontSize: 18, fontWeight: "600" as const },
  body: { fontFamily, fontSize: 15, fontWeight: "400" as const },
  bodyStrong: { fontFamily, fontSize: 15, fontWeight: "600" as const },
  caption: { fontFamily, fontSize: 13, fontWeight: "500" as const },
  tiny: { fontFamily, fontSize: 11, fontWeight: "500" as const },

  awExerciseTitle: type.exerciseTitle,
  awSessionEyebrow: { fontFamily, fontSize: 11, fontWeight: "700" as const, letterSpacing: 2.6, textTransform: "uppercase" as const },
  awNumeric: type.numeric,
  awNumericCompleted: type.numericSmall,
  awLabelValue: { fontFamily, fontSize: 13, fontWeight: "600" as const, ...tabular },
  awBody: { fontFamily, fontSize: 13, fontWeight: "500" as const },
  awMicroLabel: type.microLabel,
  awTableHeader: type.tableHeader,
  awButtonLabelPrimary: { fontFamily, fontSize: 15, fontWeight: "700" as const, letterSpacing: 1.8 },
  awButtonLabelPrimarySub: { fontFamily, fontSize: 11, fontWeight: "600" as const, ...tabular },
} as const;

export const touchTarget = {
  minHeight: 44,
  logging: 48,
  primary: 60,
} as const;
