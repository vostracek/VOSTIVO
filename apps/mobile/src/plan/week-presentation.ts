import type { PlanCurrentBlockV1, PlanOverviewV1, PlanSessionSummaryV1 } from "@vostivo/contracts";

/**
 * Athlete Design Integration 01 — pure presentation for the approved Today
 * Final week strip / hero meta and the approved Plan rows. Every string here
 * is derived from the server's Plan overview (or the Workout Preview's real
 * exercise list); nothing is estimated, scored or invented. Framework-free so
 * it is unit-tested.
 */

const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** "Week 4 / 6" — the block's real cycle position (Today Final hero, Plan header). */
export function blockWeekLabel(block: Pick<PlanCurrentBlockV1, "currentCycleOrder" | "cycleCount">): string {
  return `Week ${block.currentCycleOrder} / ${block.cycleCount}`;
}

/** "Week 4 / 6 · 4 days / week" — Plan header meta (the canvas's "Shoulders focus" has no V1 source and is omitted). */
export function blockMetaLine(block: Pick<PlanCurrentBlockV1, "currentCycleOrder" | "cycleCount" | "daysPerWeek">): string {
  return `${blockWeekLabel(block)} · ${block.daysPerWeek} ${block.daysPerWeek === 1 ? "day" : "days"} / week`;
}

/** "Mon" from the server's effective local date; `null` when the session has no date. */
export function sessionWeekday(session: Pick<PlanSessionSummaryV1, "scheduledDate">): string | null {
  if (session.scheduledDate === null) return null;
  const [year, month, day] = session.scheduledDate.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return null;
  return WEEKDAYS_SHORT[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] ?? null;
}

const STATUS_LABEL: Record<PlanSessionSummaryV1["displayStatus"], string> = {
  TODAY: "Today",
  IN_PROGRESS: "In progress",
  COMPLETED: "Completed",
  SKIPPED: "Skipped",
  RESCHEDULED: "Rescheduled",
  CANCELLED: "Cancelled",
  PLANNED: "Planned",
  REST: "Rest",
};

/** The trailing word of a Plan row (Foundations §09: every state carries a word). */
export function planStatusLabel(status: PlanSessionSummaryV1["displayStatus"]): string {
  return STATUS_LABEL[status];
}

export function isCurrentSession(session: Pick<PlanSessionSummaryV1, "displayStatus">): boolean {
  return session.displayStatus === "TODAY" || session.displayStatus === "IN_PROGRESS";
}

export type WeekStripTone = "done" | "today" | "planned";

export interface WeekStripDay {
  readonly key: string;
  readonly day: string;
  readonly tone: WeekStripTone;
  readonly statusLabel: string;
}

export interface WeekStripView {
  /** "3 of 4 sessions" — completed training sessions of this displayed week. */
  readonly summary: string;
  readonly days: readonly WeekStripDay[];
  readonly accessibilityLabel: string;
}

/**
 * Today Final "This week" strip: one column per TRAINING session of the
 * server's CURRENT cycle (rest days are not sessions). Hidden (`null`) when
 * the overview only shows a presentation fallback cycle, or has no training
 * session — the strip must never claim a week that is not this one.
 */
export function weekStrip(overview: Pick<PlanOverviewV1, "sessions" | "schedule">): WeekStripView | null {
  if (overview.schedule.displayedCycle !== "CURRENT") return null;
  const training = overview.sessions.filter((session) => session.plannedWorkoutId !== null);
  if (training.length === 0) return null;
  const done = training.filter((session) => session.displayStatus === "COMPLETED").length;
  const days = training.map((session): WeekStripDay => {
    const tone: WeekStripTone = session.displayStatus === "COMPLETED" ? "done" : isCurrentSession(session) ? "today" : "planned";
    const statusLabel = session.displayStatus === "COMPLETED" ? "Done" : planStatusLabel(session.displayStatus);
    return { key: session.plannedWorkoutId ?? String(session.order), day: sessionWeekday(session) ?? "—", tone, statusLabel };
  });
  const summary = `${done} of ${training.length} ${training.length === 1 ? "session" : "sessions"}`;
  return {
    summary,
    days,
    accessibilityLabel: `This week: ${summary}. ${days.map((day) => `${day.day} ${day.statusLabel}`).join(", ")}.`,
  };
}

/** Today Final meta row: focus · "5 exercises" · "~58 min" — each part only when the server knows it. */
export function todayMetaParts(session: Pick<PlanSessionSummaryV1, "focus" | "estimatedDurationMinutes">, exerciseCount: number | null): {
  readonly focus: string | null;
  readonly details: readonly string[];
} {
  const details: string[] = [];
  if (exerciseCount !== null && exerciseCount > 0) details.push(`${exerciseCount} ${exerciseCount === 1 ? "exercise" : "exercises"}`);
  if (session.estimatedDurationMinutes !== null) details.push(`~${session.estimatedDurationMinutes} min`);
  return { focus: session.focus, details };
}
