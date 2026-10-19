import type { PlanOverviewV1, PlanSessionSummaryV1 } from "@vostivo/contracts";

/**
 * Today V1 Foundation — the ONE place "what should the Workout Hero show
 * right now?" is decided. Pure and framework-free (no fetch, no React) so
 * it can be exhaustively unit-tested the same way `PlanApplicationService`
 * already is — `apps/mobile/app/index.tsx` (Today) only ever renders the
 * `TodayHeroState` this produces, it never re-derives any of this itself.
 *
 * Deliberately reuses only signals the server already owns:
 * `hasActiveSessionAnywhere` (the same WDI-level lookup the Plan screen's
 * own Resume banner already uses) and `PlanOverviewV1.sessions[].
 * displayStatus` (server-derived — see
 * `packages/domain/src/plan/session-status-projection.ts`). This function
 * never looks at a device-local date/weekday to decide what is "today"'s
 * workout — `displayStatus === "TODAY"` is the only authority for that.
 *
 * Progress & Feedback V1 Slice D — HISTORICAL REALITY WINS: the server's
 * `PlanOverviewV1.completedToday` fact (a canonical planned workout
 * COMPLETED on the athlete-local day, from any cycle) is `completed-today`,
 * never disguised as `rest`. It is consumed as-is — never reconstructed from
 * `sessions`, history or timestamps. Precedence: resume > training-day >
 * completed-today > rest — a real active session or a still-open TODAY
 * workout keeps the primary job.
 */

export type TodayOverviewState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly overview: PlanOverviewV1 };

export type TodayHeroState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  /** An active `WorkoutSession` exists somewhere — Resume always wins over any Start affordance (task §12). */
  | { readonly kind: "resume" }
  | { readonly kind: "no-plan" }
  | { readonly kind: "training-day"; readonly session: PlanSessionSummaryV1 }
  /** Today's planned training is done: no Start/Resume/Adjust — history and the next effective session only. */
  | { readonly kind: "completed-today"; readonly completed: CompletedTodayWorkout; readonly nextWorkout: NextPlannedWorkout | null }
  /** Covers both an explicit `REST` day and a date the current cycle simply has no entry for (task §10) — both read as "nothing to do today." */
  | { readonly kind: "rest"; readonly nextWorkout: PlanSessionSummaryV1 | null };

export interface CompletedTodayWorkout {
  readonly name: string;
  /** The canonical session — straight from the server, never searched by name/date. */
  readonly workoutSessionId: string;
}

export interface NextPlannedWorkout {
  readonly session: PlanSessionSummaryV1;
  /** The effective date (server), strictly after the athlete-local today. */
  readonly scheduledDate: string;
  readonly athleteLocalDate: string;
}

export function deriveTodayHeroState(input: {
  readonly hasActiveSessionAnywhere: boolean;
  readonly overview: TodayOverviewState;
}): TodayHeroState {
  // Checked first, and independent of `overview`'s own status: a failed
  // Plan network request must never hide a real Resume path (same
  // reasoning already established for the Plan screen's own banner).
  if (input.hasActiveSessionAnywhere) return { kind: "resume" };

  if (input.overview.status === "loading") return { kind: "loading" };
  if (input.overview.status === "error") return { kind: "error", message: input.overview.message };

  const { overview } = input.overview;
  if (overview.currentBlock === null) return { kind: "no-plan" };

  const todaySession = overview.sessions.find((session) => session.displayStatus === "TODAY");
  if (todaySession !== undefined) return { kind: "training-day", session: todaySession };

  const completed = completedTodayWorkout(overview);
  if (completed !== null) return { kind: "completed-today", completed, nextWorkout: nextPlannedWorkout(overview) };

  const nextWorkout = overview.sessions.find((session) => session.displayStatus === "PLANNED") ?? null;
  return { kind: "rest", nextWorkout };
}

/**
 * The server's completed-today fact, independent of the displayed cycle (the
 * occurrence need not be in `sessions`). A fact for any other day than the
 * server's own `athleteLocalDate` is ignored — never a device-date fallback.
 */
function completedTodayWorkout(overview: PlanOverviewV1): CompletedTodayWorkout | null {
  const fact = overview.completedToday;
  if (fact === undefined || overview.athleteLocalDate === null || fact.completedLocalDate !== overview.athleteLocalDate) return null;
  return { name: fact.workoutName, workoutSessionId: fact.workoutSessionId };
}

/** The next open workout on the effective schedule within the displayed plan; `null` rather than a guessed date. */
function nextPlannedWorkout(overview: PlanOverviewV1): NextPlannedWorkout | null {
  const today = overview.athleteLocalDate;
  if (today === null) return null;
  const next = overview.sessions.find((session) => session.displayStatus === "PLANNED" && session.plannedWorkoutId !== null && session.scheduledDate !== null && session.scheduledDate > today);
  if (next?.scheduledDate === undefined || next.scheduledDate === null) return null;
  return { session: next, scheduledDate: next.scheduledDate, athleteLocalDate: today };
}
