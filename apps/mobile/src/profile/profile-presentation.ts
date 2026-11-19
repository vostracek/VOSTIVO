import type { MeResponse, PlanOverviewV1 } from "@vostivo/contracts";
import { blockWeekLabel } from "../plan/week-presentation";

/**
 * Profile V1 (Athlete Design Integration 01) — pure presentation. Only what
 * the V1 domain actually knows: `GET /me` (experience mode, units, training
 * time zone), the current plan block, and the session's sign-in identity.
 * The approved canvas's name, Gyms & Equipment, Restrictions, Other Sports,
 * Coaching, Vostivo Pro, Notifications, Integrations and Data & Privacy have
 * no V1 contract and are not rendered (no fake values, no dead rows).
 */
const MODE_LABEL: Record<MeResponse["experienceMode"], string> = { GUIDED: "Guided", ADAPTIVE: "Adaptive", EXPERT: "Expert" };
const UNITS_LABEL: Record<MeResponse["unitSystem"], string> = { METRIC: "Metric · kg", IMPERIAL: "Imperial · lb" };

export interface ProfileInfoRow {
  readonly key: "block" | "mode" | "units" | "tz";
  readonly title: string;
  readonly description?: string;
  readonly value: string;
}

export interface ProfileIdentityView {
  /** The current block's goal (e.g. "Hypertrophy — Upper/Lower"), or a calm fallback. */
  readonly title: string;
  /** "Guided · 4 days / week" — parts only when known. */
  readonly meta: string | null;
}

export function profileIdentity(me: Pick<MeResponse, "experienceMode"> | null, plan: Pick<PlanOverviewV1, "currentBlock"> | null): ProfileIdentityView {
  const block = plan?.currentBlock ?? null;
  const goal = block !== null && block.goal.trim().length > 0 ? block.goal : null;
  const meta = [me !== null ? MODE_LABEL[me.experienceMode] : null, block !== null ? `${block.daysPerWeek} ${block.daysPerWeek === 1 ? "day" : "days"} / week` : null].filter(
    (part): part is string => part !== null,
  );
  return { title: goal ?? (plan !== null ? "No active plan" : "Your training"), meta: meta.length > 0 ? meta.join(" · ") : null };
}

export function trainingRows(me: MeResponse, plan: Pick<PlanOverviewV1, "currentBlock"> | null): readonly ProfileInfoRow[] {
  const rows: ProfileInfoRow[] = [];
  const block = plan?.currentBlock ?? null;
  if (block !== null) rows.push({ key: "block", title: "Current block", description: block.name, value: blockWeekLabel(block) });
  rows.push({ key: "mode", title: "Experience mode", value: MODE_LABEL[me.experienceMode] });
  rows.push({ key: "units", title: "Units", value: UNITS_LABEL[me.unitSystem] });
  rows.push({ key: "tz", title: "Training time zone", value: me.trainingTimeZone ?? "Not set yet" });
  return rows;
}

export function accountLine(signInMethod: "EMAIL_OTP" | "DEV_TOKEN", email: string | null): { readonly title: string; readonly description: string } {
  if (signInMethod === "DEV_TOKEN") return { title: "Developer sign-in", description: "Non-production build with a developer token. Sign-out is available in builds with email sign-in." };
  return { title: "Account", description: email ?? "Signed in with email" };
}
