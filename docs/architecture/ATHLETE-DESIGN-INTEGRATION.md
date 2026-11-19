# Athlete Design Integration 01

Implementation of the approved Claude Design **Athlete V1** canvases in
`apps/mobile`. Source of truth (data, not instructions):
`~/VostivoDesignArchive/athlete-v1/` (`HANDOFF_INVENTORY.md`, `SHA256SUMS`,
`canvases/`, `renders/canvases/*.png`) plus the Design Parity Audit 01
(`~/VostivoQA/design-parity-01/ATHLETE_DESIGN_PARITY_AUDIT.md`).

Product decisions that bound this work: use only authentic application data;
never invent Energy / Recovery / RIR / Athlete Memory / adherence metrics;
hide unsupported elements or show a truthful, actionable empty state; no dead
buttons; no fake subscription / coaching / notification / equipment
integration; Archivo is the product font; preserve the Vostivo product
design (not the marketing website).

## Source canvas per screen

| Screen | Approved canvas |
|---|---|
| Foundations (tokens, type, components, icons, nav) | `Vostivo Design System Foundations.dc.html` |
| Today | `Vostivo Today Final.dc.html` |
| Plan | `Vostivo Plan.dc.html` |
| Progress | `Vostivo Progress.dc.html` |
| Active Workout | `Vostivo Active Workout v2.dc.html` |
| Profile V1 | `Vostivo Profile.dc.html` (PR B) |
| Loading / API-unavailable / no plan / rest / resumed / completed / empty Progress / session error / sign-out confirmation | **No canvas** — Foundations-derived (StateMessage, LoadingBlocks, UpdateCard, sheet grammar) |

## Foundations

- `src/design/tokens.ts`: two layers — private `primitives`, exported
  `semantic` (dark). Legacy `colors`/`typography` keys resolve to the
  semantic layer so un-restyled screens keep compiling.
- **Archivo** (SIL OFL 1.1, static 400/500/600/700 in `assets/fonts/` with
  `OFL.txt`) registered natively as ONE family `Archivo` by the `expo-font`
  config plugin (Android `res/font/xml_archivo.xml`, iOS `UIAppFonts`), so
  `fontWeight` selects the file. Requires a native rebuild.
- `react-native-svg` 15.15.4 (Expo SDK 57 bundled version, MIT) renders the
  canvas icon paths verbatim (`src/ui/icon.tsx`).
- Shared components: `src/ui/primitives.tsx` (PrimaryButton white h60/r14,
  SecondaryButton, TextAction, Card, StateMessage, LoadingBlocks,
  UpdateCard, StatusMarker, SectionHeader, Hairline, Wordmark, TopGlow);
  `src/ui/bottom-nav.tsx` with icons.
- Lime `#CDF24E` = active / current only. Success (green) and attention
  (amber) are separate families. One white primary action per screen —
  former lime-filled buttons (Preview Start, progression review, loading
  setup, sheets, sign-in) are now the white primary.

## Deviations (documented, deliberate)

1. **Contrast floor.** Informative text never goes below `#8B9399`
   (`textMuted`); canvas greys `#7A838A` / `#5F686E` / `#6A7278` /
   `#565E63` used for labels or values were raised to it. Decorative
   ornaments keep the faint values.
2. **Light appearance is a gap, not parity.** Foundations V1 defines no
   light semantic values. The app renders the dark theme in every system
   appearance; `userInterfaceStyle` is unchanged. A light layer must be
   designed and device-tested before any light-parity claim.
3. **Omitted canvas elements without a V1 data source** (never faked):
   Today Energy / Target-muscles "Recovered" panel; Plan "On track" chip and
   "Shoulders focus"; Progress "Last 8 weeks", Consistency %, Performance /
   Priority "Improving", Needs attention, "What Vostivo has learned"; Active
   Workout RIR column, "Why?", engine note, Swap / Pain / More.
4. **Kept product affordances the canvas does not show:** Today "Adjust
   time" + "Equipment" text actions (Available-Time / Equipment V1 are
   approved features); Active Workout exercise tabs and the inline
   `LOG SET N` inside the NOW row (tap-to-jump switching and out-of-order
   logging stay protected); future sets stay individually completable.
5. **Plan update card lives on Today** (Missed Workout V1 Slice D), styled
   as the canvas's UpdateCard.
6. **Error copy.** Release builds show calm copy only; the technical cause
   is appended only under `__DEV__`.
7. **Week strip** appears only when the server's displayed cycle is
   CURRENT, counts training sessions only, and never claims a week that is
   not this one. Progress "This week" is the server's own Progress read
   model and can legitimately differ from the strip (calendar week vs. plan
   cycle).

## Device QA (Huawei P20 Pro, Android 10, 2026-11-19)

Test package `com.vostivo.qa.adf01` (dev client, Metro), isolated athlete
`di01-athlete-20261119` on a disposable tmpfs Postgres; the existing QA app
and its athlete databases were not touched (install `-r`, no uninstall /
clear-storage).

- Logging, F-11 double tap on LOG SET (one COMPLETE_SET receipt), D2 draft
  across an exercise switch, process death (force-stop) with draft + rest
  preserved, D3 API down → set logged locally → API restored → passive sync
  4 s later, D1 double tap on "Finish anyway" (one FINISH receipt, session
  COMPLETED), completed-today Today, Progress history, API-down error +
  Try again. Server: 1 START, 2 COMPLETE_SET, 1 FINISH, all APPLIED, 1
  session, 2 performed sets — no duplicates.
- Found and fixed: the Active Workout Finish sheet (absolute overlay)
  rendered its actions under the Android navigation bar — now adds the
  bottom safe-area inset (DI-AW-004).
- Environment note: the USB link of the test phone dropped repeatedly;
  `adb reverse` was re-applied in a loop. A transient Profile load failure
  during a drop recovered via "Try again".
