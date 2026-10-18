# Vostivo — Schedule Calendar Authority V1

**Status:** CLOSED. It was the prerequisite for Missed Workout /
Schedule Adaptation V1 Slice C.

Since Slice C, the per-workout dates that Today, Plan and Workout Preview
show come from the block's EFFECTIVE schedule: authored dates plus the
ACTIVE missed-workout overlay. See
`docs/domain/MISSED-WORKOUT-ADAPTATION-V1.md` §10. Classifying the
current block and cycle still uses the authored cycle date ranges, which
an overlay never changes.

## 1. Locked rules

```text
ONE ATHLETE-LOCAL CALENDAR AUTHORITY.
UTC IS STORAGE/INSTANT CONTEXT, NOT TRAINING-DAY AUTHORITY.
CURRENT MEANS DATE-CONTAINING, NOT NEAREST.
ACTIVE PROGRAM SELECTION MUST BE DETERMINISTIC.
LEGACY_UTC_FALLBACK EXISTS ONLY FOR ORDINARY READ COMPATIBILITY WHILE
  trainingTimeZone IS NULL.
ADAPTATION LOGIC NEVER USES THE LEGACY FALLBACK.
```

Today, Plan, Workout Preview and Missed Workout never answer "what day is
it / which plan / which block and cycle" on their own. They all ask the
one authority below.

## 2. Schedule date context (`packages/domain/src/schedule/schedule-date-context.ts`)

`resolveScheduleDateContext(profile, instant)` returns
`{ localDate, source, trainingTimeZone }`:

| `trainingTimeZone` on the profile | `source` | `localDate` |
|---|---|---|
| valid IANA zone | `ATHLETE_TIME_ZONE` | `resolveAthleteLocalDate(instant, zone)` (DST-correct) |
| `NULL`, or a stored value that is not a usable IANA zone | `LEGACY_UTC_FALLBACK` | `legacyUtcCalendarDate(instant)` = the server's UTC calendar date |

- The fallback is a separately named, isolated function. It is not hidden
  inside `resolveAthleteLocalDate()`, and the returned `source` always
  states it.
- Ordinary reads never write the profile. Nothing persists UTC.
- Adaptation goes through `requireAthleteTimeZoneDate(context)`, which
  returns `null` for the legacy source. Missed Workout maps that to 409
  `TRAINING_TIME_ZONE_REQUIRED`.
- The instant comes from the injected server `Clock`
  (`apps/api/src/common/clock.ts`).
- **Removal:** once onboarding/Profile populates `trainingTimeZone` for
  every athlete, delete `legacyUtcCalendarDate` and the
  `LEGACY_UTC_FALLBACK` branch. No such UI exists yet: mobile has no
  onboarding or time-zone hook, and only `PUT /api/v1/me/training-time-zone`
  plus the dev seed set the zone.

## 3. Active program (`apps/api/src/schedule/athlete-schedule-context.ts` `resolveActiveProgram`)

- **0 ACTIVE programs:** `NONE`, the ordinary no-plan state.
- **Exactly 1 ACTIVE program:** its ACTIVE version, or `NONE` if it has
  none.
- **2+ ACTIVE programs:** `AMBIGUOUS`. This is a configuration defect,
  never `limit(1)`:
  - Plan/Today returns 409 `ACTIVE_PROGRAM_AMBIGUOUS`;
  - Missed Workout returns 409 `CURRENT_TRAINING_BLOCK_UNRESOLVED`.

**Verified constraint scope:** `program_versions_one_active_per_program`
makes two ACTIVE versions of one program impossible. Nothing in the DB
limits an athlete to one ACTIVE program. Both are proven against real
Postgres (SCA-012/013). Historical programs are never altered.

## 4. Calendar classification (`packages/domain/src/schedule/schedule-calendar.ts`)

`classifyScheduleCalendar(cycles of the ACTIVE version, localDate)`:

| State | Meaning | Error? |
|---|---|---|
| `NO_SCHEDULE` | the version has no cycles (contract: `NO_PLAN`) | no |
| `BEFORE_PLAN` | before the first cycle | no |
| `IN_CURRENT_BLOCK` | exactly one cycle's inclusive `[startDate, endDate]` contains the date; its block is the current block | no |
| `GAP` | between cycles, within or between blocks | no |
| `AFTER_PLAN` | after the final cycle; the honest basis for a later Block Complete → review → next recommendation flow | no |
| `AMBIGUOUS` | several cycles contain the date (`OVERLAPPING_CYCLES` / `OVERLAPPING_BLOCKS`) | yes, a configuration defect |

- The **current cycle** exists only in `IN_CURRENT_BLOCK`.
- Outside it, the state carries a separately named `presentationCycle`:
  - `BEFORE_PLAN` / `GAP`: the next cycle;
  - `AFTER_PLAN`: the last cycle overall.
- `presentationCycle` is display context only. It is never "current".
- Row order never matters: rows are sorted by (start, end, block order,
  cycle order, id).
- The old nearest-cycle selector `selectCurrentTrainingCycle` was
  **removed**.

## 5. Read paths

- **Plan / Today** (`GET /plan/current` → `PlanReadService.readCurrentPlan`):
  - Mobile Today derives only from this response's server `displayStatus`.
  - `PlanOverviewV1` gained an additive `schedule: { state, displayedCycle }`,
    where `displayedCycle` is `CURRENT` | `PRESENTATION_FALLBACK` | `null`.
  - Outside a current cycle the screens still show a nearby cycle (same
    product surface), now honestly labelled.
  - Legacy fallback allowed.
- **Workout Preview** `displayStatus` (`TODAY` vs `PLANNED`): same date
  context. Legacy fallback allowed.
- **Missed Workout preview:** same context.
  - Requires `ATHLETE_TIME_ZONE`.
  - Requires the program to be `ACTIVE` and the calendar to be
    `IN_CURRENT_BLOCK` for evaluation.
  - `NONE` / `NO_SCHEDULE` / `BEFORE_PLAN` → `NO_CHANGE`.
  - Everything else → 409 `CURRENT_TRAINING_BLOCK_UNRESOLVED`, unchanged
    from Slice B.

## 6. Evidence

- **Domain:** `schedule-calendar.test.ts`, covering the test matrix 1–8 and
  10, the Prague/New York and DST date context, and legacy fallback
  labelling.
- **Real Postgres:** `apps/api/src/schedule/schedule-calendar-authority.integration.test.ts`
  (SCA-001..021):
  - both sides of UTC midnight for Prague and New York;
  - Prague DST fall-back and spring-forward cycle boundaries;
  - NULL-zone Today/Plan readable under `LEGACY_UTC_FALLBACK` while Missed
    Workout returns 409;
  - setting the zone switches to `ATHLETE_TIME_ZONE` immediately, and
    reads never write the profile;
  - active-program 0/1/2 and insertion order;
  - the DB constraint scope;
  - BEFORE/GAP/AFTER/IN states and overlap ambiguity;
  - cross-path agreement;
  - reversed insertion order.
- **Missed Workout Slice B:** all 44 real-Postgres cases unchanged and
  green.
