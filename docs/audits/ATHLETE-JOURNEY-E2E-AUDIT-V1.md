# Vostivo — Full Athlete Journey E2E Audit V1 (2026-10-17)

**Result:** AUDIT COMPLETE — PRODUCT GAPS FOUND. One correctness issue was
found and fixed during the audit (§6). No open correctness blocker remains
at the implemented scope.

## 1. Method

- Real `apps/api` (:4000) and real `apps/worker` (pg-boss) against
  `vostivo_manual`, each journey on a **dedicated new athlete** (JWT subject
  `e2e-journey-{a,b}-<ts>`, created through `GET /api/v1/me`). The human
  acceptance athlete was not touched.
- A temporary driver (deleted after the audit) sent exactly the mobile
  client's wire commands (`START_WORKOUT_SESSION_V1` with the Workout
  Preview prescription verbatim, `COMPLETE_SET_V1` with snapshot ids and
  orders, `FINISH_WORKOUT_SESSION_V1` with `finishSeq`) and built the
  equipment + Available-Time START with the same shared helpers the app uses
  (`availableTimeApplicationFromPreview`, `selectAvailableTimePrescription`).
- Fixture: `EQUIPMENT_ADAPTATION_FIXTURE=true ATHLETE_JOURNEY_FIXTURE=true`
  (new opt-in flag: the same week is repeated in the next cycle so a
  progression has a real next exposure) + `dev:seed-loading-capability`
  (bench-press, 2.5 kg). GUIDED, Europe/Prague.
- The device-local part (SQLite, outbox, process death, retry) is covered by
  existing real-SQLite mobile tests and earlier native verification; it was
  not re-driven through the UI in this audit.

## 2. Product map (inspected in code, 2026-10-17)

| Surface | Status |
|---|---|
| Today (Hero, Start/Resume, Adjust time, Equipment, Missed Workout card, Progression review / Set Up Loading cards) | IMPLEMENTED |
| Plan (current cycle list, effective schedule, status badges) | IMPLEMENTED — current cycle only |
| Workout Preview (`/workout/[id]`) | IMPLEMENTED |
| Available-Time / Missed Workout / Temporary Equipment | IMPLEMENTED, HUMAN-ACCEPTED |
| Start Workout, Active Workout, local SQLite, outbox, sync/retry | IMPLEMENTED, HUMAN/NATIVE-VERIFIED |
| Finish Workout + summary (name, duration, working sets done / planned) | IMPLEMENTED |
| Server canonical session, occurrence authority | IMPLEMENTED |
| Worker: progression evaluation + application dispatch | IMPLEMENTED (not started by `pnpm dev`; needs `apps/worker/.env` loaded) |
| Progression Review (ADAPTIVE/EXPERT) / GUIDED auto-apply / Set Up Loading | IMPLEMENTED, not human-accepted |
| Plan after progression (effective load) | IMPLEMENTED in Workout Preview; next cycle not listed in Plan |
| Progress tab | NOT IMPLEMENTED (nav item, `target: null`) |
| Exercise history drill-down | NOT IMPLEMENTED (only "PREV" inside Active Workout) |
| Profile tab | NOT IMPLEMENTED (only the one-time time-zone bootstrap) |
| Sign-in UX | NOT IMPLEMENTED (dev JWT only) |

## 3. Journey A — normal workout → progression → next exposure

Upper Body A today (Bench Press 3 × 8–12 @ 60 kg, Overhead Press 2 × 8–12 @
30 kg):

- START (online) APPLIED; Today shows the occurrence `IN_PROGRESS`.
- Offline batch: reconnect #1 delivered 2 sets (ACK "lost"); reconnect #2
  re-delivered all sets + FINISH → 2 DUPLICATE + 4 APPLIED; a full outbox
  replay → 7 DUPLICATE.
- Canonical session COMPLETED, `finish_seq` 5, snapshot byte-identical to
  the Workout Preview prescription.
- Worker: bench-press `INCREASE_LOAD` / `TOP_OF_RANGE_ACHIEVED`;
  overhead-press `NO_CHANGE` / `SINGLE_EXPOSURE_ONLY`. Dispatch: GUIDED →
  SYSTEM apply, `APPLIED`, 60 kg → 62.5 kg.
- **Next exposure:** next week's Upper Body A Workout Preview shows Bench
  Press 3 × 62.5 kg (OHP unchanged 30 kg). The authored planned sets are
  still 60 kg. Today's own completed workout still previews 60 kg (an
  application never affects its own source occurrence).

| | Bench Press |
|---|---|
| Authored target | 60 kg × 3 (8–12) |
| Performed | 60 kg × 12, 12, 12 |
| Decision | INCREASE_LOAD (TOP_OF_RANGE_ACHIEVED) |
| Applied | 62.5 kg (FIXED_INCREMENT 2.5 kg, SYSTEM) |
| Next effective target | 62.5 kg × 3 (8–12), 2026-10-24 |

## 4. Journey B — Temporary Equipment + Available-Time on one occurrence

- Equipment apply (dumbbells, flat bench, adjustable bench) → ADJUST;
  replay idempotent. Effective preview: Dumbbell Bench Press 3 sets,
  Seated Dumbbell Overhead Press 2 sets, no prescribed load.
- Available-Time 7 min → ADJUST (540 s → 420 s), removes one OHP set.
- START snapshot = substitutes with 3 + 1 sets; session snapshot identical.
- Equipment application CONSUMED by this session; Available-Time
  application VERIFIED; one claim; no ACTIVE application left.
- Performed history carries the substitute `exerciseRef`s; zero progression
  decisions (substitutes = `TEMPORARY_SUBSTITUTION_NOT_EVALUATED`); zero
  decisions for bench-press/overhead-press.

## 5. Data-integrity counts (per journey athlete, after the fix)

| | Journey A | Journey B |
|---|---|---|
| Sessions / ACTIVE | 1 / 0 | 1 / 0 |
| Occurrence claims | 1 | 1 |
| Performed exercises / sets | 2 / 5 | 2 / 4 |
| Duplicate performed exercises / sets | 0 / 0 | 0 / 0 |
| Command receipts | 7 | 7 (+1 rejected probe) |
| Decisions / orphan decisions | 2 / 0 | 0 / 0 |
| Progression applications | 1 (APPLIED) | 0 |
| ACTIVE equipment applications | 0 | 0 |
| Available-Time / Missed Workout applications | 0 / 0 | 1 VERIFIED / 0 |
| pg-boss progression jobs | all `completed` | — |

## 6. Correctness issue found and fixed

**Invariant violated:** performed reality could diverge from the session's
immutable prescription snapshot. `COMPLETE_SET_V1` only checked ownership,
load validity and the Finish causal boundary. A client could therefore:

- complete a set that Available-Time had removed (reproduced live: the
  probe was `APPLIED`, the session ended with 2 OHP sets against a 1-set
  snapshot);
- re-point a planned slot to another `exerciseRef` after START, which would
  file that exercise's history (and a decision) under the wrong identity —
  e.g. barbell Bench Press work becoming "own history" of the dumbbell
  substitute, contradicting the no-load-transfer rule.

Only the owner's own data was reachable (BOLA holds), and the mobile app
never sends such commands, but it bypassed the START identity rule one
layer further down.

**Fix (smallest):** `matchesSessionPrescription` in
`apps/api/src/workout/workout-command-processing.ts` rejects a
`COMPLETE_SET_V1` whose slot, identity or planned set is not in the
session's own snapshot, an unplanned exercise claiming a planned set, and
an existing performed exercise re-pointed at another slot. Legacy slots
without an `exerciseRef` keep the earlier behavior. Regression test
WDI-SYNC-011 (fails without the fix). After the fix, the same probe is
`REJECTED` and the session holds exactly 3 + 1 sets.

## 7. Finish, Today, Plan, Progress

- **Finish:** a confirm sheet only when sets are incomplete; no survey;
  partial finish supported; idempotent (DUPLICATE); FINISH enqueues
  evaluation once. The summary shows workout name, duration and working
  sets done/planned — no progression outcome (the decision is made later
  by the worker).
- **Today after completion:** no Start/Resume and no adaptation actions
  for the completed occurrence; the Hero falls back to **"Rest day · Next
  workout Lower Body A"**.
- **Plan after completion:** today's row `COMPLETED`, upcoming rows
  `PLANNED`. Only the current cycle is listed, so next week's workout
  carrying 62.5 kg is not reachable from Plan until that cycle becomes
  current. A `COMPLETED` row still opens Workout Preview with **Start
  Workout** (the server would accept it as a SECONDARY session).
- **Progress:** no screen; the athlete cannot see the completed workout,
  exercise history or any progression explanation outside Active Workout
  "PREV" and (ADAPTIVE/EXPERT only) the review card.

## 8. Error / recovery

- API down on Today → "Could not load today" + Retry; a local active
  session still shows Resume.
- API down during Active Workout → logging continues locally; the
  coordinator retries 2/5/10/30 s and on launch, foreground and network
  regain (tests + Manual Test #4).
- Stale adaptation → re-preview + explicit second confirmation (all three
  adaptations).
- Expired JWT → sync stays retryable (never REJECTED), but Today stays on
  the error state: there is no sign-in flow (dev JWT only).
- Missing time zone → one-time bootstrap from the device zone.

## 9. Product gaps

| Gap | Class |
|---|---|
| Progress tab not implemented (no history, no progression interpretation) | IMPORTANT PRODUCT GAP |
| GUIDED progression is invisible until the next exposure becomes current (no card, next cycle not in Plan) | IMPORTANT PRODUCT GAP |
| Workout Preview offers Start Workout for a COMPLETED occurrence (creates a SECONDARY session) | IMPORTANT PRODUCT GAP |
| Today after finishing shows "Rest day" instead of a completed state | POLISH |
| Finish summary does not mention progression | FUTURE V1.1 |
| No sign-in UX; expired token ends in a Retry-only Today | IMPORTANT PRODUCT GAP (pre-beta) |
| Profile tab not implemented | FUTURE V1.1 |
| Worker needs its env loaded explicitly for local runs (`pnpm --filter @vostivo/worker dev` fails config) | POLISH (dev tooling) |
| Fixtures repeat no future cycles by default (only `ATHLETE_JOURNEY_FIXTURE`) | POLISH (dev tooling) |

## 10. Regression

Before and after the fix: turbo lint/typecheck/test/build 46/46,
boundaries 0 violations, API integration 282 → 283, worker integration
19/19, progression-application integration 82/82 (serial; the parallel run
still exhausts Postgres connections — known harness issue, not product).
