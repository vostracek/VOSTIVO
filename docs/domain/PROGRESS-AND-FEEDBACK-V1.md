# Vostivo — Progress & Feedback V1

**Status:** Scope APPROVED (2026-10-18). Slice A — Progress Read Model:
CLOSED / tech-lead approved (2026-10-18, §8). Slice B — Mobile Progress
MVP: CLOSED / tech-lead approved (2026-10-18, §9; human/visual acceptance
deferred to Slice E). Slice C — Progression feedback + next exposure:
CLOSED / tech-lead approved (2026-10-19, §10). Slice D — Completed workout
semantics: CLOSED / tech-lead approved (2026-10-19, §11, §11.1). Slice E —
Human acceptance + final E2E: CLOSED / human acceptance PASS (2026-10-19,
§12). **Progress & Feedback V1 — FULLY CLOSED (2026-10-19).**

**Answers:** *"Am I getting better?"* — interpret, don't dump data. Every
item states what happened, what it means, and what to do next.

## 1. Reality at baseline (inspected in code)

| Surface | Today |
|---|---|
| Progress tab | Not implemented. `src/ui/bottom-nav.tsx` renders "Progress"/"Profile" with `target: null` (disabled, "not available yet"). No route under `apps/mobile/app/`. |
| Profile tab | Not implemented (same). Only the one-time time-zone bootstrap (`src/profile/`). |
| Plan (`app/plan.tsx`) | Current (or presentation-fallback) cycle only (`PlanReadService.getCurrentPlan`, `plan-read.service.ts:106-140`). Every non-rest row, including `COMPLETED`, opens Workout Preview. |
| Workout Preview (`app/workout/[plannedWorkoutId].tsx`) | Always renders **Start Workout** (no status check). `canStart` is informational only (`!hasActiveSession`). |
| Today after completion (`app/index.tsx`, `src/plan/today-derivation.ts`) | No `TODAY` row is left, so the Hero falls back to `rest` → "Rest day · Next workout …". |
| Post-workout summary (`active-workout.tsx` `SummaryView`) | Name, duration, working sets done / planned. No progression (decided later by the worker). |
| Athlete Memory | Does not exist (no store, no derivation). |
| Design | `src/design/tokens.ts`: Refined Dark base keys + `aw*` Foundations V1 keys (Active Workout). No shared component library (only `bottom-nav.tsx`). No Archivo font. The approved Progress canvas is **not in the repo** (Claude Design project). |

## 2. Data that exists — what is truthful today

| Source | Truthful athlete-facing information |
|---|---|
| `workout_sessions` (`started_at`, `completed_at`, `status`, `prescription_snapshot`) | Completed workouts, date, wall-clock duration (includes pauses), workout name, what was prescribed (incl. `substitution` provenance). |
| `performed_exercises` / `performed_sets` | Performed identity (`exercise_ref`), load (value/unit/basis), reps, set type, completion. **No RIR/effort is stored.** Full vs partial = completed working sets vs snapshot working sets. |
| `planned_workout_occurrence_claims` | Which session is CANONICAL for a planned workout (SECONDARY sessions exist but are not "the" workout). |
| Plan hierarchy + effective schedule overlay | Current block / cycle (`Week X of N`), planned workouts per cycle on their EFFECTIVE dates, carryover ("needs a training day"). No pause/lifecycle model. |
| `available_time_applications`, `equipment_adaptation_applications` | Whether a completed workout was shortened or equipment-adapted. |
| `progression_decisions` | Per exercise exposure: decision, reason code, evidence strength, `progression_stalled` (3-exposure deterministic signal), normalized input (performed sets). |
| `progression_applications` | Applied load changes: `expected_effective_load → applied_load`, actor (SYSTEM/ATHLETE), `applied_at`, status (APPLIED / KEPT_ORIGINAL / PENDING_REVIEW / SUPERSEDED / STALE). |
| Effective load resolver | The progressed target of any future occurrence (`resolveEffectiveWorkingLoadForOccurrence`, source `APPLIED_HISTORY` + application id). |
| Exercise catalog | Canonical display names for catalog refs. |

## 3. Existing APIs (all under `/api/v1`)

`GET me`, `PUT me/training-time-zone`, `GET plan/current`,
`GET plan/workouts/:id`, the three adaptation preview/apply groups,
`GET progression/applications/pending`, `GET …/:id/proposal`,
`POST …/apply|keep-original`, `GET progression/guided-loading-setup/…`,
`POST sync/workout-commands`. **No history, completed-workout, exercise or
progress read exists over HTTP.** `WorkoutHistoryService
.getRecentWorkingExposures` (user-scoped, by `exerciseRef`, limit 40/100)
exists server-side for the engine only.

## 4. Capability verdicts

- **Completed workout history:** YES — date, name, duration, full/partial,
  exercises (with substitute flag), adaptations, progression events of that
  session. Not available: RIR, effort, notes.
- **Exercise history:** YES by performed `exerciseRef` (substitutes stay
  separate by construction). Needs a new owned read; existing index
  `performed_exercises(exercise_ref)` + join on `workout_sessions(user_id)`
  is sufficient at V1 scale.
- **Consistency / adherence:** PARTIAL. Truthful today: *"This week: N of M
  planned workouts done"* for the current cycle on the effective schedule
  (M = workouts whose effective date ≤ athlete-local today, plus today's).
  A multi-week percentage is **not** truthful yet: past uncompleted
  workouts still project as `PLANNED` (no MISSED status), and there is no
  pause/lifecycle model, so absence cannot be told from failure.
- **Progression evidence ("What's improving"):** YES — APPLIED
  applications (e.g. Bench Press 60 → 62.5 kg, based on 60 kg × 12/12/12
  from the decision's evidence). Performed-history comparisons
  ("32 × 10 → 38 × 9") would need a new comparison rule (top set? e1RM?) —
  out of V1 unless the tech lead locks one.
- **Needs attention:** WEAK. The only deterministic signal is
  `progression_stalled` (all 3 window exposures without progress). The
  engine spec reserves it as input for a future Fatigue/Adaptation Engine.
  Recommended: **omit the section in V1**.
- **Athlete Memory:** none → **section OMITTED, not placeholder.**

## 5. Recommended V1 product shape

**Progress screen (GUIDED-first, one screen, progressive disclosure):**

1. *Snapshot* — at most 2 signals: `Week X of N · <block name>` and
   `This week: N of M workouts done`. No scores, streaks, tonnage.
2. *What's improving* — latest applied progressions: "Bench Press ·
   60 → 62.5 kg · from 60 kg × 12/12/12 · next on Sat 24 Oct". Tap → next
   occurrence's Workout Preview.
3. *Recent workouts* — completed canonical sessions (date, name, duration,
   full/partial, "Adjusted"/"Equipment" tags) → workout detail.
4. *Exercise history* — from workout detail or an improving item: recent
   performances of that performed identity (date, sets load × reps), with a
   substitute note when relevant.
5. Needs attention and Athlete Memory are omitted until real evidence exists.

**GUIDED feedback (no celebration, no unread state):** the Progress
"What's improving" list + Workout Preview of the next occurrence showing
"62.5 kg · up from 60 kg" (additive provenance from the effective load
resolver). The Finish summary keeps claiming nothing about progression
(the worker decides asynchronously) — at most a neutral "Vostivo will
review this workout for your next targets."

**Next exposure:** reached from the progression item (deep link to the
next occurrence) and visible in Workout Preview. Plan stays a single
current-cycle view in V1; an optional compact "Next week" peek is a
tech-lead decision.

**Completed planned workout:** Workout Preview for `COMPLETED` shows the
result (read-only) and no Start; `IN_PROGRESS` shows Resume. SECONDARY
sessions stay a backend capability (multi-device/offline), with no
ordinary UI entry.

**Today after completion:** "Workout complete · Upper Body A · Next:
Lower Body A · Mon 19 Oct", tap → workout detail. Requires an additive
server-owned athlete-local date (or `isToday`) on `PlanOverviewV1` — the
app must not use the device date.

## 6. Recommended API (one purpose-built read model, `apps/api/src/progress/`)

All owner-scoped from `AuthenticatedActor`; no `athleteId` parameter;
unknown/foreign ids → 404. Canonical sessions only (claims), SECONDARY
excluded from progress signals.

```text
GET /api/v1/progress
  -> { schemaVersion, athleteLocalDate,
       snapshot: { block: {name, cycleOrder, cycleCount} | null,
                   thisWeek: {completed, due} | null },
       improving: [{ applicationId, exerciseRef, exerciseDisplayName,
                     fromLoad, toLoad, appliedAt, actor,
                     basedOn: {workoutSessionId, sets:[{reps, load}]},
                     nextExposure: {plannedWorkoutId, scheduledDate,
                                    workoutName} | null }]  (latest 5),
       recentWorkouts: [WorkoutHistoryItemV1] (latest 5) }

GET /api/v1/progress/workouts?before=<cursor>&limit=20
  -> { items: WorkoutHistoryItemV1[], nextCursor }   // keyset (completed_at, id)

GET /api/v1/progress/workouts/:workoutSessionId
  -> { session summary, exercises: [{ exerciseRef, displayName,
       substitution: {authoredDisplayName} | null,
       sets: [{order, setType, reps, load, completed}] }],
       adaptations: {availableTime, equipment}, progressionEvents[] }

GET /api/v1/progress/exercises/:exerciseRef?before=<cursor>&limit=20
  -> { exerciseRef, displayName, exposures: [{ workoutSessionId,
       completedAt, workoutName, isSubstitute, sets[] }], nextCursor }
```

Plus two additive fields: `PlanOverviewV1.athleteLocalDate` and a
Workout Preview per-exercise `progression: {previousLoad,
applicationId} | null`.

Performance: no new tables, no materialization. Start with a 12-week
window for the overview; keyset pagination elsewhere. Add indexes
(`workout_sessions(user_id, completed_at desc)`) only after EXPLAIN on
realistic data shows the need.

## 7. Slice plan

| Slice | Job | Key acceptance |
|---|---|---|
| A — Progress Read Model | `progress` module + contracts + the 4 reads + 2 additive fields; no UI | Owner-only (BOLA 404), canonical-only, substitutes never merged, applied events match `progression_applications`, real-Postgres tests incl. Journey A/B data |
| B — Mobile Progress MVP | Progress route + enabled tab, snapshot, improving, recent workouts, workout detail, exercise history; approved canvas | Renders only server facts; empty states; offline = calm error + retry; controller tests; human acceptance |
| C — Progression feedback + next exposure | Improving deep link, Workout Preview "up from" provenance, optional Plan "Next week" peek | GUIDED athlete sees 60 → 62.5 and the next target without hunting; no claim before the worker decided |
| D — Completed-workout semantics | Today completed state, Preview read-only for COMPLETED / Resume for IN_PROGRESS, stale comment in `session-status-projection.ts` | No ordinary Start for a completed occurrence; no device-date logic |
| E — Human acceptance + E2E | Full journey on Vostivo_Light with `ATHLETE_JOURNEY_FIXTURE` | complete → progression applies → improvement visible → next target visible → history reachable → no accidental restart |

Out of scope: Athlete Memory, pain, Swap, body metrics, photos,
wearables, Coach progress, sharing, streaks, calories, AI text, sign-in.

## 8. Slice A — Progress Read Model: implementation evidence (2026-10-18) — CLOSED

Tech-lead accepted (2026-10-18): `progression` stays OPTIONAL; detail
returns COMPLETED sets only; history stays available with a null snapshot;
the `due` semantics as written; no new index (EXPLAIN on realistic volume
before beta).

**Code.** `apps/api/src/progress/` (`ProgressModule`, `ProgressController`,
`ProgressReadService`, `progress-cursor.ts`, `dto/progress-page-query.dto.ts`);
contracts `packages/contracts/src/progress.ts`. No migration, no new table,
no new index, no write path, no mobile UI.

**Endpoints** (all `AuthGuard`, no `athleteId` parameter):

| Route | Answer |
|---|---|
| `GET /api/v1/progress` | `ProgressOverviewV1`: `athleteLocalDate`, snapshot, latest 5 improvements, latest 5 workouts |
| `GET /api/v1/progress/workouts?before&limit` | `WorkoutHistoryPageV1` (limit 1–50, default 20) |
| `GET /api/v1/progress/workouts/:workoutSessionId` | `WorkoutHistoryDetailV1`; 400 non-UUID, 404 unknown/foreign/SECONDARY |
| `GET /api/v1/progress/exercises/:exerciseRef?before&limit` | `ExerciseHistoryPageV1`; 404 when the caller has no history of that identity |

Malformed `before` → 400 `INVALID_CURSOR`; unknown query parameter → 400.

**Locked semantics as implemented.**
- *Canonical-only:* a session counts only via its own occurrence claim
  (`claim.canonical_workout_session_id = session.id`, same `user_id`), status
  `COMPLETED`. SECONDARY and unclaimed sessions never appear anywhere.
- *Completion:* `plannedWorkingSets` = snapshot sets that are not `WARM_UP`
  (legacy snapshots without `setType` count as WORKING, same rule as the
  mobile read compat); `completedWorkingSets` = COMPLETED WORKING performed
  sets; FULL iff completed ≥ planned. Shown sets are COMPLETED only — a set
  left REOPENED was un-done.
- *Adaptation tags:* Available-Time = an `available_time_applications` row
  for the session (any verification status — the session was started
  adjusted); Equipment = a snapshot exercise with `substitution`.
- *Improvements:* `progression_applications` with `applied_at` set, status
  APPLIED or SUPERSEDED (the effective-load resolver's own eligibility).
  `fromLoad` = `expected_effective_load`, `toLoad` = `applied_load`, actor =
  `decided_by_actor_type`. `basedOn` = the COMPLETED WORKING sets of the
  decision's source performed exercise. Name = live canonical slot name
  (`resolveExerciseDisplayName`, now exported), else the name the athlete
  logged — never the raw ref. PENDING_REVIEW / KEPT_ORIGINAL / STALE are
  never shown.
- *Next exposure:* the earliest later-cycle occurrence of the same Program
  Slot (same block, workout order, exercise order + ref) that is
  PLANNED/AVAILABLE, has no canonical session, and whose effective date is
  ≥ athlete-local today (or carryover) — returned only if the effective
  load resolver says THIS application governs it and the program version is
  the athlete's ACTIVE one; otherwise `null`.
- *Snapshot:* from `PlanReadService.readCurrentPlan` (one schedule
  authority), only when `displayedCycle = CURRENT`. `due` = cycle workouts
  in TODAY/PLANNED/IN_PROGRESS with effective date ≤ today, plus completed
  ones; carryover not due until completed. A schedule configuration defect
  (Plan's 409) nulls the snapshot; history stays readable.
- *Exercise history:* keyed by the PERFORMED `exerciseRef`; substitutes
  stay separate (`isSubstitute` flag). Name = catalog name, else the newest
  logged name.
- *Keyset cursor:* opaque base64url of `(completed_at::text, id)` —
  Postgres' microsecond text, never a JS `Date` (a millisecond cursor skips
  rows completed in the same millisecond; tested). Not an authorization
  token: every page stays scoped to the actor.

**Additive contract fields.** `PlanOverviewV1.athleteLocalDate: string |
null` (server athlete-local date; `null` only without an athlete profile).
`WorkoutPreviewExerciseV1.progression?: {applicationId, previousLoad}` —
optional (same convention as `substitution`) rather than `| null`: present
only when the WORKING target comes from an applied application and the
exercise is not a substitute; `previousLoad` is that application's
`expected_effective_load`.

**Deviations from §6 (deliberate, small).** Detail sets carry no
`completed` flag (only COMPLETED sets are returned). Detail `adaptations`
is the history item's boolean pair plus `availableTime.availableMinutes`.

**Verification.** `progress-read.service.integration.test.ts` (8 tests,
real Postgres, Journey A fixture: Bench 60 kg × 12/12/12 → real GUIDED
`applySystemProgression` → 62.5 kg; a SECONDARY session of the same
occurrence; an equipment-substitute + Available-Time session; a pending OHP
recommendation; a second athlete): overview, applied events equal the
`progression_applications` row, Preview provenance on the next exposure
(and none on the source occurrence or warm-up), detail, SECONDARY/foreign/
unknown 404, substitutes never merged, microsecond keyset paging, cursor
400s and foreign-cursor isolation, empty state. `progress-cursor.test.ts`
and `progress.controller.test.ts` (401 per route, 400 validation, 404/400
mapping, actor-only ownership). Performance: queries filter on
`workout_sessions(user_id)` (existing index) and the claim's unique
canonical-session index; no index added — revisit with EXPLAIN on
realistic volume before beta (§6).

## 9. Slice B — Mobile Progress MVP: implementation evidence (2026-10-18)

**Reused, nothing new introduced:** Expo Router `Stack` routes (no Tabs
navigator — tabs `router.replace`, drill-downs `router.push`); the
hand-written fetch client + `AuthTokenProvider` boundary (like
`FetchPlanApiClient`) composed in `plan-runtime.ts`; framework-free
controllers + `useState`/`useMemo` (like the Today flows); focus refetch
via `useFocusEffect` (the app has no pull-to-refresh anywhere, so none was
added); Refined Dark base tokens from `tokens.ts`; `formatLoad`
(`format-target.ts`) and `shortDayLabel` (server `athleteLocalDate`
relative day, `missed-workout-flow.ts`); detail convention of Workout
Preview (`‹ Back`, no bottom nav, top+bottom safe area); vitest node tests
with scripted ports. No new dependency, state or UI framework.

**Routes.** `/progress` (tab, bottom nav active), `/progress/workouts`
(history, "Load more"), `/progress/workouts/[workoutSessionId]` (detail),
`/progress/exercises/[exerciseRef]` (exercise history). Bottom nav
destinations moved to `src/ui/bottom-nav-items.ts` (pure, tested); Progress
is now a real destination; Profile stays visible-but-disabled.

**Code.** `apps/mobile/src/progress/`: `progress-api-client.ts` (4 reads,
`ProgressApiFailure`, cursor passed verbatim as `before`),
`progress-read-controller.ts` (LOADING / READY / NOT_AVAILABLE / ERROR; a
refetch never blanks READY data), `paged-history-controller.ts` (LOADING /
READY{more: IDLE|LOADING|ERROR} / NOT_AVAILABLE / ERROR_INITIAL; single
request in flight, rows kept on a failed page, retry re-sends the same
cursor, rows de-duplicated), `progress-history.ts` (page adapters),
`progress-presentation.ts` (all copy), `progress-routes.ts`,
`progress-ui.tsx`, `load-more-footer.tsx`.

**Screen rules as implemented.**
- Interpretation: "You're making progress" + "<names> is/are moving
  forward." only when `improving` is non-empty; otherwise "Building your
  progress picture" (not a failure). Never "stronger", score or percentage.
- Snapshot: "Week X of N" + block name and "N of M planned workouts
  completed" exactly from the server; both null → a quiet "Current plan
  progress unavailable" line; the rest of the screen is unaffected.
- What's improving: name, "60kg → 62.5kg", "From 60kg × 12, 12, 12" (the
  server's `basedOn`), "Next time · 62.5kg · Upper A, Mon" only when the
  server returned `nextExposure`. Tap → history of the exact `exerciseRef`
  (a substitute's own ref). Empty: "No progression changes yet".
- Recent workouts: name, completion day, "4 of 5 working sets · Partial",
  "Time adjusted"/"Equipment adjusted" chips only from server flags. "View
  workout history" only when the capped (5) preview may be truncated.
- Workout detail: name, day · duration, summary, provenance chips, "From
  this workout" progression lines only when returned, exercises with
  completed sets only ("Not performed" when none), substitute note
  "Instead of …", performed exercises tap through to their own history.
  No Start, no editing.
- Exercise history: name, "Last performed <day> · <working sets>", rows
  of day / workout (+ "equipment substitute") / load × reps. No graph, e1RM,
  tonnage or trend.
- 404 anywhere: "This history item isn't available." + "Back to Progress"
  (`router.dismissTo("/progress")`). Root failure: "Couldn't load
  progress" + Retry, bottom nav still usable. Loading: shape-only blocks,
  no numbers, no fake zero state.
- Accessibility: ≥44 pt targets, a full spoken label on every tappable
  row/card, Full/Partial and adaptations as text (never color alone),
  names wrap (no truncation), scroll content clears the bottom nav /
  bottom safe area. Lime only as the current-week marker.

**Tests.** `progress-presentation.test.ts`, `progress-read-controller.test.ts`,
`paged-history-controller.test.ts`, `progress-api-client.test.ts`,
`progress-scope.test.ts` (source guard: no Athlete Memory / Needs Attention
placeholder, no streak / e1RM / tonnage / readiness / chart, no Start or
editing in history), `src/ui/bottom-nav-items.test.ts`. No backend or
contract change.

**Known limitations.** Screen rendering itself is not unit-tested (the repo has no RN render test
harness) — covered by human acceptance. Archivo still absent (system
font).

**Human acceptance preparation (not performed).** Non-destructive option
(recommended): `vostivo_manual` already holds the E2E audit's Journey A
athlete `e2e-journey-a-1792259143037` — one canonical COMPLETED Upper Body
A (Bench Press 60 kg × 12/12/12), Bench Press APPLIED 60 → 62.5 kg by
SYSTEM, no SECONDARY session (verified read-only 2026-10-18). Mint a local
JWT for that subject (`LOCAL_DEV_JWT_SUBJECT=e2e-journey-a-1792259143037
SUPABASE_URL=… pnpm --filter @vostivo/api auth:local:mint-jwt`, see
`docs/development/SETUP.md`), set it as `EXPO_PUBLIC_DEV_JWT`, run the
API against `vostivo_manual` and open Progress. Journey B athletes
(`e2e-journey-b-*`) show the equipment-substitute + Available-Time history.
The human athlete `local-manual-athlete-001` has no completed workout; to
use it instead, complete Upper Body A in the app with all Bench Press
working sets at 12 reps (worker running) — no wipe needed. Do not run
`db:manual:reset`.

### 9.1 Slice B closure fix — athlete-local history date authority (2026-10-18)

**Locked rule:** ATHLETE CALENDAR MEANING COMES FROM THE ATHLETE TRAINING
TIME ZONE, NOT THE PHONE'S CURRENT TIME ZONE. A travelling athlete's old
workouts never move to another calendar day.

- **Previous issue:** mobile labelled history days by converting
  `completedAt` with the device zone (`getDay()/getDate()`).
- **Server:** additive `completedLocalDate: YYYY-MM-DD` on
  `WorkoutHistoryItemV1` (so also `WorkoutHistoryDetailV1.workout`) and
  `ExerciseExposureV1`, derived in `ProgressReadService` from the canonical
  session's `completed_at` + `athlete_profiles.training_time_zone` through
  the Schedule Calendar Authority's `resolveScheduleDateContext` (no new
  time-zone code; no zone yet → its ordinary-read legacy UTC fallback, same
  as Today/Plan). An exposure uses its parent session's day, so workout
  history, detail and exercise history always agree. Never the authored or
  effective scheduled date. `completedAt` stays as the audit instant. No
  migration. The current profile zone is used (it is never auto-overwritten).
- **Mobile:** `formatCompletedDay(instant)` replaced by
  `formatLocalDay(YYYY-MM-DD)` (UTC-midnight calendar arithmetic, UTC
  getters only). History labels stay absolute ("Mon 19 Oct") — no relative
  labels on drill-downs, which carry no server "today".
- **Proof:** `PROGRESS-B-TZ-001` (real Postgres): completed
  2026-10-18T22:30:00Z → Europe/Prague `2026-10-19`, America/New_York
  `2026-10-18`, no zone `2026-10-18`, identical across overview, history,
  detail and exercise history; never the scheduled date. Mobile tests: the
  same instant with server day `2026-10-19` renders "Mon 19 Oct" in every
  view, month/year edges, and a source guard against local date getters.

## 10. Slice C — Progression feedback + next exposure: implementation evidence (2026-10-18)

**Authority reused, nothing recomputed.** `WorkoutPreviewExerciseV1.progression`
(Slice A) and `ProgressImprovementV1.nextExposure` were sufficient for
Preview and Progress. The ONE effective-prescription authority stays
`PlanReadService.getWorkoutPreview` (progression overlay via
`resolveEffectiveWorkingLoadForOccurrence`, then TODAY_ONLY equipment
substitution that never carries authored progression; Available-Time
selects set ids from that same prescription at START). No new engine,
read model or migration.

**Visibility hierarchy (locked):** 1. Workout Preview — the definitive
"up from"; 2. Progress — evidence + next exposure; 3. Plan — one restrained
session signal; 4. Today — unchanged.

- **Workout Preview:** an exercise with server `progression` shows its
  effective WORKING target as primary ("62.5kg") and "Up from 60kg" as
  caption context, plus the set lines as before. The target is read from
  `preview.prescription` (the exact snapshot START uses); a substitute or a
  non-uniform working target fails closed (no "up from"). No ids, rule
  names, scores or celebration. Screen-reader label: "Bench Press, 4 sets:
  …. Target 62.5 kilograms, up from 60 kilograms." Pure presentation in
  `apps/mobile/src/workout/workout-preview-presentation.ts`.
- **Today:** no change — no new card; the hero stays START / Adjust time /
  Equipment. The athlete meets the progression in Preview and Active Workout.
- **Plan:** additive `PlanSessionSummaryV1.hasAppliedProgression: boolean`,
  computed server-side by reading each TODAY/PLANNED occurrence's own Workout
  Preview (`exercises.some(progression)`) — never a second calculation;
  always `false` for rest / COMPLETED / IN_PROGRESS / SKIPPED / RESCHEDULED /
  CANCELLED rows. The row shows a quiet "Progression applied" line (no
  exercise detail, no lime); tap still opens Workout Preview. Cost: one
  preview per open workout in the displayed cycle (≤ ~5) — acceptable at V1
  scale, revisit with the pre-beta EXPLAIN pass.
- **Progress:** the improvement card is two sibling targets (never nested
  buttons): the evidence opens exercise history; the "Next time · 62.5kg ·
  Upper A, Mon / View next workout ›" row opens the EXACT server
  `nextExposure.plannedWorkoutId` as `/workout/<id>?source=progress`. No
  next exposure → no affordance.
- **Future Workout Preview:** the existing route/API already previews any
  owned `plannedWorkoutId` (BOLA 404 otherwise), including one outside the
  displayed cycle, with the same resolver. Opened from Progress it is READ
  ONLY: no Start action (a "Preview only · start this workout from Today or
  Plan" footer) — a navigation-path rule, not mobile startability logic.
  TODAY_ONLY equipment applications only ever target today's occurrence, so
  a future preview never picks up another day's adaptation.
- **Plan future visibility (§16):** option A is not supported (Plan reads
  only the date-containing / presentation cycle; no adjacent-cycle
  selection exists). Implemented option B: Progress `nextExposure` → exact
  future Workout Preview. Full cycle navigation deferred.
- **Interop:** Available-Time keeps 62.5 kg on retained Bench sets and
  drops a fully removed exercise (shared `selectAvailableTimePrescription`);
  an equipment substitute shows neither the authored target nor "up from"
  (and Plan's signal turns off); a missed-workout move keeps the
  occurrence's progression (identity, not date) and next exposure / Plan
  use the effective date. Substitutes cannot carry their own APPLIED
  progression in V1 (the evaluator skips them —
  `TEMPORARY_SUBSTITUTION_NOT_EVALUATED`), so test #11 asserts absence.
- **Stale claims:** "up from" exists only while the server returns
  `progression` for the effective target; a non-APPLIED (pending) decision
  never produces it (PROGRESS-A-002), and an older application whose slot is
  governed by a newer one gets `nextExposure: null` (Slice A resolver check).

**Tests.** Real Postgres (`progress-read.service.integration.test.ts`):
PROGRESS-C-001 (Progress 60→62.5 = future preview 62.5 = START prescription
62.5; foreign preview undefined), C-002 (Plan signal only on the progressed
next-week workout; none this week / rest / completed), C-003 (Available-Time),
C-004 (equipment substitute), C-005 (missed-workout move). Mobile:
`workout-preview-presentation.test.ts` (#1–7, substitute, fail-closed,
read-only source guard), Progress next-workout navigation, Plan signal
passthrough.

**Human acceptance preparation (not performed).** Journey A athlete
`e2e-journey-a-1792259143037` in `vostivo_manual` (see §9): Progress shows
60kg → 62.5kg → "View next workout" opens next week's Upper Body A
(preview-only) showing "62.5kg · Up from 60kg"; Plan shows "Progression
applied" on that row once its cycle is current; when it is the athlete's
Today, START → Active Workout target 62.5kg.

## 11. Slice D — Completed workout semantics: implementation evidence (2026-10-19)

**Locked rule:** HISTORICAL REALITY WINS. Once the CANONICAL session of a
planned occurrence is COMPLETED, Today acknowledges it, Plan shows it as
completed, opening it is a history/review action, and the ordinary
planned-workout path never offers Start again. Nothing is deleted: the
SECONDARY-session capability stays in the domain.

**Authority reused.** The Planned Workout Occurrence Authority claim
(`findCanonicalOccurrenceSessions`) already resolved the canonical session
for Plan/Preview; it now joins the session on the claimant's own `user_id`
(defence in depth). The
displayed status stays `deriveSessionDisplayStatus` (its stale
"COMPLETED is unreachable" note is replaced). The athlete-local completion
day uses the same `resolveScheduleDateContext` as Progress history (§9.1).
No migration, table or index.

**Additive contract fields (server-derived, owner-scoped, no athleteId).**
- `PlanSessionSummaryV1.completedWorkoutSessionId?` — present ONLY when the
  occurrence's canonical session is COMPLETED; absent for planned/active/rest rows, SECONDARY-only
  or unclaimed sessions, and never another athlete's id.
- `WorkoutPreviewV1.completedWorkoutSessionId?` (same rule) and
  `canStart = (no canonical session)` — previously `!hasActiveSession`, so a
  COMPLETED occurrence was "startable".

**Mobile.**
- *Today:* new `completed-today` hero state in `deriveTodayHeroState`
  (precedence resume > training-day > completed-today > rest), chosen from
  the server's `PlanOverviewV1.completedToday` fact (§11.1); a still-open
  TODAY workout keeps the primary job. Copy (`today-completed-presentation.ts`): "Workout complete ·
  Upper Body A · Today's training is saved." + secondary "View workout"
  (exact canonical id) + "Next Lower Body A · Thu" only for the first
  PLANNED row with an effective date after today in the displayed plan
  (never a missed past row, a carryover or a guessed date). No Start,
  Resume, Adjust time, Equipment, missed-workout card, celebration or streak.
- *Plan:* `planRowTarget` — COMPLETED with an id → `/progress/workouts/:id`
  (Slice B detail, no new screen); rest → not tappable; every other row
  unchanged (IN_PROGRESS still opens Preview, whose Start resolves to the
  active session). Spoken label "Upper Body A, completed" + hint "Opens
  workout history"; completed rows slightly de-emphasised; the Slice C
  marker is already `false` server-side for COMPLETED.
- *Workout Preview:* `previewFooter` — COMPLETED (server `displayStatus`)
  → "Workout completed" + "View workout" (when the id is present); the
  Start handler refuses anything but the START footer, so old/deep links
  cannot start a completed occurrence. `?source=progress` stays "Preview
  only" for open workouts. The Preview has no Adjust time / Equipment / repeat
  actions.

**Partial finish.** An explicitly FINISHed partial session is the canonical
COMPLETED session like any other (Today "Workout complete", Plan COMPLETED);
"Partial" stays a history detail (Slice B).

**Interop.** Available-Time / Equipment: completion of an adapted workout
maps to the same canonical id; the history detail keeps Available-Time and
substitute provenance; Today's adjust actions key off `training-day` only,
so none remain. Missed Workout: a moved occurrence is completed on its
effective day under the same `plannedWorkoutId`, one row, no duplicate.

**Secondary-session boundary.** Ordinary UX cannot start a completed
occurrence (Preview `canStart: false`, no Start footer, Plan routes to
history, Today has no Start). The sync `START_WORKOUT_SESSION_V1` command is
unchanged: a deliberate second START is still accepted as SECONDARY, and it
never replaces the canonical id anywhere (PROGRESS-D-SEC).

**Tests.** Real Postgres: PROGRESS-D-001 (canonical id on Plan
and Preview, `canStart` false/true, rest/planned absent, SECONDARY id
never present, adapted completion → history detail with provenance),
D-002 (SECONDARY-only does not complete the occurrence; foreign athlete
gets none of the ids), D-003 (missed-workout move completed on its new
day; yesterday's completion keeps yesterday's day), D-004 (training time
zone decides the completion day), PROGRESS-D-SEC in
`occurrence-authority.integration.test.ts` (partial FINISH via real sync
commands → COMPLETED + `canStart: false`; an explicit second START still
APPLIED as SECONDARY and never surfaces). Mobile: `today-derivation.test.ts`
(#16–30 + precedence/edge cases), `today-completed-presentation.test.ts`
(copy, next line, source guard of the hero block), `plan-session-schedule
.test.ts` (#9–15), `workout-preview-presentation.test.ts` (#31–36).

**Performance note (unchanged, not a Slice D blocker).** Slice C's
`hasAppliedProgression` still reads one Workout Preview per open workout in
the displayed cycle. Before beta, inspect Plan read performance / query
count with a realistic program size.

**Known limitations.** Screen rendering is not unit-tested (no RN render harness) — covered by
Slice E human acceptance.

**Human acceptance preparation (Slice E, not performed).** Non-destructive,
on `vostivo_manual`: complete today's workout as the athlete (worker
running) → Today "Workout complete · <name>" + View workout → Plan row
"Completed" opens that workout's history (no Start) → Progress 60 → 62.5 →
"View next workout" shows "62.5kg · Up from 60kg" → history stays truthful.
The Journey A athlete `e2e-journey-a-1792259143037` already proves the
Plan → history and Progress parts (its Upper Body A is COMPLETED, not
today). Do not run `db:manual:reset`.

### 11.1 Slice D closure fix — cycle-independent completed-today (2026-10-19)

**Issue found in review.** Today derived `completed-today` only from rows of
the displayed Plan cycle, so a previous-cycle occurrence (e.g. a missed
workout rolled forward, or simply finished late) completed today — absent
from `sessions` — could leave Today on "Rest day".

**Locked rule:** COMPLETED-TODAY IS SERVER-AUTHORITATIVE AND INDEPENDENT OF
THE DISPLAYED PLAN CYCLE. The mobile never searches history, previous
cycles, names or dates.

**Server.** `findCompletedToday` (`apps/api/src/plan/completed-today.ts`),
called once per Plan/Today read: occurrence claims → their CANONICAL session
(same `user_id`) → status COMPLETED → the planned workout must belong to the
caller's own program (`programs.athlete_profile_id`). Completion day =
`resolveScheduleDateContext(trainingTimeZone, completedAt)` — the same rule
as Progress history — compared with the server's athlete-local today. One
bounded query: a UTC window `[today − 1 day, today + 2 days)` (contains
every instant of the local day in any IANA zone), exact local-day match per
row. Never the authored/effective date, the displayed cycle, the name, the
device zone, a SECONDARY, unclaimed or foreign session. No migration, no
new index, no N+1.

**Multiple completions (V1 rule).** If several canonical planned
occurrences were completed on the athlete-local today, the hero shows the
MOST RECENTLY completed one (`completedAt` desc, session id tie-break) —
never combined, never a list; the others remain in Progress history.

**Contract (additive).** `PlanOverviewV1.completedToday?:
PlanCompletedTodayV1 { plannedWorkoutId, workoutSessionId, workoutName,
completedLocalDate }` — a Today decision fact, not a history list; no claim
or application ids. The per-row `PlanSessionSummaryV1.completedLocalDate`
(introduced in §11, consumed only by Today) was removed so Today has ONE
authority; `completedWorkoutSessionId` on rows (Plan → history) is unchanged.
Plan's visible list is unchanged — the old occurrence is never copied into
the current cycle.

**Mobile.** `deriveTodayHeroState` reads `overview.completedToday` as-is
(ignored if its day ≠ the server's `athleteLocalDate`; no date → never).
Precedence unchanged: resume > open TODAY workout > completed-today > rest.
"Next" still comes only from trustworthy future rows of the current Plan
overview (omitted otherwise); the completed-today hero stays valid without
it. Presentation unchanged ("Workout complete · <name> · Today's training
is saved." + View workout with the exact canonical id).

**Tests.** Real Postgres: D-001 (#1 current cycle), PROGRESS-D-CT-001 (#2/#4
previous-cycle occurrence, absent from Cycle 2 `sessions`, history detail
opens), D-CT-002 (#3 missed/rolled-forward occurrence, Preview read-only),
D-CT-003 (#5 yesterday, #7 unclaimed, nothing), D-CT-004 (#8 another
athlete's completion and a forged claim on another athlete's planned
workout), D-CT-005 (#10 most recent of three, stable on repeat), D-CT-006
(#11 one instant = Wednesday in Prague / Tuesday in New York), D-002 (a
later unclaimed session never wins), D-003 (moved workout = that day's
fact), D-004, PROGRESS-D-SEC (#6/#9 partial FINISH is the fact; a later
SECONDARY never replaces it). Mobile `today-derivation.test.ts` (#12–18).

## 12. Slice E — Human acceptance + final E2E: evidence (2026-10-19) — PASS

**Result:** PASS. The locked journey ran end to end in the real app:
workout → FINISH → canonical COMPLETED → Today acknowledges it → Plan is
historical → GUIDED progression APPLIED → Progress explains it → next
exposure opens the exact future workout → its Preview shows the progressed
target, which START would snapshot.

**Environment.** Real `apps/api` + real `apps/worker` (pg-boss) against
`vostivo_manual`; Expo dev build (`app-debug.apk`, 2026-10-04, incl.
`expo-network`) + Metro on a NEW dedicated AVD `Vostivo_Progress_E2E`
(Pixel 7, API 35). `Vostivo_Light` and `Pixel_7_Vostivo_Clean` were left
untouched: both hold an ACTIVE local session from earlier acceptance runs
(Today shows Resume there); nothing was wiped. Local auth: ES256 JWT minted
with `auth:local:mint-jwt` (`LOCAL_DEV_JWT_SUBJECT`), set in the
git-ignored `apps/mobile/.env`. For request observation only, a temporary
logging proxy sat on :4000 in front of the API on :4001 (no code change).
The app was driven through the UI with `adb` taps/keyboard input.

**Acceptance athlete.** New subject `progress-e2e-1792424330` (athlete
profile `01a154d0-c605-7644-bb55-4e18bf1e5382`), created via `GET
/api/v1/me`; `db:seed:dev-plan` with `EQUIPMENT_ADAPTATION_FIXTURE=true
ATHLETE_JOURNEY_FIXTURE=true` (GUIDED, Europe/Prague, Upper Body A today =
Bench Press 3 × 8–12 @ 60 kg + OHP 2 × 8–12 @ 30 kg, same week repeated
next cycle) + `dev:seed-loading-capability` (bench-press, +2.5 kg). No other
athlete was touched.

**Observed journey.**
1. *Before:* Today "Upper Body A" + Start Workout (Adjust time / Equipment
   present, no progression claim); Plan row "Today"; Preview Bench 3 × 60 kg,
   no "Up from".
2. *Start (UI):* Active Workout opened, bottom nav hidden, Bench "TODAY
   60kg · aim 8–12 reps"; START APPLIED, one CANONICAL claim; session
   snapshot == the pre-start Preview prescription (JSON-equal).
3. *Logged (UI):* Bench 60 × 12, 12, 12; OHP 30 × 10, 10; Finish → summary
   "Workout complete · Upper Body A · 5/5". Sync: 7 attempts succeeded,
   0 rejected / conflicted; receipts START 1, COMPLETE_SET 5, FINISH 1 — all
   APPLIED.
4. *Today:* "WORKOUT COMPLETE · Upper Body A · Today's training is saved." +
   View workout + "Next Lower Body A · Wed" — no Rest day, Start, Resume,
   Adjust time, Equipment, missed card, streak or celebration. View workout
   opened `/progress/workouts/01a1557b-6017-7838-aa23-cbda31ec3c1f` (the
   canonical session; server `completedToday` names the same id).
5. *Plan:* Upper Body A "Completed", de-emphasised, no "Progression
   applied"; tap → history detail (Bench 3 × 60 kg × 12, OHP 2 × 30 × 10,
   "Completed in full", "From this workout · Next target raised · 60kg →
   62.5kg", no adaptations, no Start).
6. *Deep link* `vostivo://workout/<completed occurrence>`: "Workout
   completed" + View workout, NO Start; the occurrence itself still shows
   60 kg (an application never changes its own source).
7. *Progression (read-only DB):* decisions bench-press INCREASE_LOAD /
   TOP_OF_RANGE_ACHIEVED and overhead-press NO_CHANGE / SINGLE_EXPOSURE_ONLY,
   both sourced from the canonical session; exactly one application, APPLIED,
   `decided_by_actor_type = SYSTEM` (no borrowed user id), expected 60 kg →
   applied 62.5 kg; evaluate + dispatch jobs `completed`.
8. *Progress root:* "You're making progress · Bench Press is moving
   forward." → snapshot "Week 4 of 6 · Hypertrophy Block 1 · 1 of 1 planned
   workout completed" (server `thisWeek {completed 1, due 1}`) → What's
   improving "Bench Press 60kg → 62.5kg · From 60kg × 12, 12, 12 · Next time
   · 62.5kg · Upper Body A, Mon 26 Oct · View next workout" → Recent
   workouts "Upper Body A · 5 of 5 working sets · Full · Mon 19 Oct". No
   score, percentage, graph, e1RM, tonnage, streak or placeholder cards.
9. *Workout history* (list + detail): only the canonical workout, "That's
   all your completed workouts.", no edit / Start. *Exercise history* Bench
   Press: one exposure Mon 19 Oct, 60kg × 12, 12, 12, exact `bench-press`
   (not a substitute), "That's the full history for this exercise."
10. *View next workout:* request `GET /plan/workouts/01a154d0-d9eb-…` =
    server `nextExposure.plannedWorkoutId`; Bench "62.5kg · Up from 60kg",
    3 × 62.5 kg, OHP 30 kg; footer "Preview only · start this workout from
    Today or Plan" (no Start).
11. *Plan future signal:* the progressed Upper Body A (2026-10-26) is in
    the NEXT cycle, outside the displayed Plan — the accepted Slice C case
    (reachable through Progress → exact next Workout Preview).
12. *START target consistency (option B — no clock change on shared
    `vostivo_manual`):* that occurrence's Preview `prescription` (exactly
    what mobile hands to START, `plan-application-service.ts`) carries Bench
    WORKING 62.5 / 62.5 / 62.5 kg; this session proved START snapshot ==
    Preview prescription; PROGRESS-C-001 proves the same on real Postgres.
13. *Athlete-local date:* API `completedAt 2026-10-19T18:46:32Z`,
    `completedLocalDate 2026-10-19` (20:46 Prague) = mobile "Mon 19 Oct" in
    the detail, history list and exercise history. The cross-zone boundary
    itself is covered by PROGRESS-B-TZ-001 / D-CT-006 (this completion was
    not near midnight).
14. *Cross-cycle completed-today:* not forced manually; D-CT-001..006 green
    in the regression below.

**Spot checks.** Progress refocus → exactly one `GET /progress`, no
duplicated rows; Back works through every drill-down (including a
deep-linked stack); bottom nav only on Today / Plan / Progress, never on
Preview, Active Workout or any detail; no broken copy/layout. A dev-only
LogBox toast appeared once after the API was restarted mid-session (not a
product surface).

**Visual (human judgement, not pixel comparison).** Refined Dark, readable
hierarchy within seconds; the interpretation leads, metrics are secondary;
cards restrained and spaced like Today / Plan; lime only on the active tab,
primary actions and the current-week dot; drill-downs feel like the same
product. Not exercised: a history long enough to scroll under the bottom
nav (one workout). Typography is still the system font — **Archivo
integration remains a later design-alignment task** and does not block this
closure.

**Performance observation (no refactor).** Through the proxy: Progress
focus = 1 request (32 ms). Plan focus = 2 × `GET /plan/current` (23–27 ms);
Today focus = 2 × each of `plan/current`, `progression/applications/
pending`, `guided-loading-setup/attention`, `missed-workout-preview`. Cause
(pre-existing since Today V1 / Plan, not introduced by Progress): the
mount-time `useEffect([reloadToken])` fetch plus `useFocusEffect(reload)`
on the first focus, and tabs switch via `router.replace` (remount); the
first result is discarded by its `cancelled` flag. Bounded (always 2×), no
loop, zero requests while idle (30 s). Server side, each Plan read still
does one Workout Preview read per open workout (3 here) for
`hasAppliedProgression`. Both belong to the pre-beta realistic-volume
performance check.

**Data integrity (read-only, after acceptance).** Sessions 1 (0 ACTIVE),
claims 1 → that session, no SECONDARY; performed exercises 2 / sets 5, no
duplicates, 0 orphan sets anywhere; decisions 2, applications 1 APPLIED;
equipment / Available-Time / Missed Workout applications 0; rejected
receipts 0; pg-boss jobs for the journey `completed`.

**Evidence location (outside the repo):**
`~/Desktop/dev/vostivo-acceptance-evidence/progress-feedback-v1-slice-e/`
— 30 screenshots (01–24 in journey order, back-1..3) and `api/` JSON
snapshots (plan before/after, previews, progress, START snapshot).

**Automated regression (after acceptance).** `turbo typecheck lint test
build` 46/46; `boundaries:check` 0 violations (626 modules); API real
Postgres 308/308 (19 files, incl. PROGRESS-A/B/C/D, D-CT, D-SEC, Missed
Workout cross-feature, Equipment / Available-Time); worker integration
19/19; progression-application integration 82/82 SERIAL
(`--no-file-parallelism`; the parallel run hit the known `53300 remaining
connection slots` harness exhaustion); `expo export --platform android` OK.
Honest note: the first API run after the machine reboot failed with
timeouts — an orphaned vitest worker held 58 connections and the new AVD's
first boot saturated the disk (Postgres waiting on `WalSync`); after
killing the orphan and shutting the emulator down, the unchanged suite
passed 308/308.

**Known non-blocking follow-ups (outside this closure).** Archivo font;
realistic-volume Plan/Today query + double-fetch check; adjacent-cycle Plan
navigation; the device-local SQLite is not scoped to the signed-in identity
(another athlete's local ACTIVE session shows Resume — sign-in / auth phase);
Athlete Memory; Needs Attention; body metrics / photos; sign-in / auth
recovery; Profile; Coach Web; website; billing.
