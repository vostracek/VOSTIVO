import { and, eq, inArray } from "drizzle-orm";
import { plannedWorkoutOccurrenceClaims, workoutSessions, type Database } from "@vostivo/database";
import { createEntityId, type OccurrenceSessionRole } from "@vostivo/domain";

/**
 * Planned Workout Occurrence Authority V1 — the ONE implementation of
 * "which WorkoutSession represents this athlete's planned occurrence",
 * shared by the START handler and Plan/Today reads (apps/api) and planned
 * progression (apps/worker via ProgressionEvaluationService).
 *
 * FIRST VALID SERVER-ACCEPTED START CLAIMS THE OCCURRENCE (CANONICAL). A
 * later, distinct valid START of the same occurrence is SECONDARY — accepted,
 * preserved, never promoted, never merged. A session's role is always
 * derived from the claim (`session.id === canonicalWorkoutSessionId`), never
 * stored, so the two can never disagree. Unplanned sessions have no claim
 * and no role.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OccurrenceClaimResult {
  readonly role: OccurrenceSessionRole;
  readonly canonicalWorkoutSessionId: string;
  /** True only for the START that created the claim (observability). */
  readonly claimCreated: boolean;
}

/**
 * Establishes or observes the claim, INSIDE the caller's START transaction
 * (after its session row exists — the claim FK points at it). Concurrency:
 * `INSERT ... ON CONFLICT DO NOTHING` on the unique (user, planned workout)
 * index — a concurrent START of the same occurrence blocks on that index
 * until the first commits (or rolls back), then either sees the winner's
 * claim (SECONDARY) or inserts its own (CANONICAL). The expected race is
 * never an error, never a deadlock (each START only locks its own session
 * row plus this one index entry), and works across API instances.
 */
export async function claimPlannedOccurrence(
  tx: Database,
  input: { readonly userId: string; readonly plannedWorkoutId: string; readonly workoutSessionId: string },
): Promise<OccurrenceClaimResult> {
  const created = await tx
    .insert(plannedWorkoutOccurrenceClaims)
    .values({ id: createEntityId(), userId: input.userId, plannedWorkoutId: input.plannedWorkoutId, canonicalWorkoutSessionId: input.workoutSessionId })
    .onConflictDoNothing()
    .returning({ canonicalWorkoutSessionId: plannedWorkoutOccurrenceClaims.canonicalWorkoutSessionId });
  if (created.length > 0) return { role: "CANONICAL", canonicalWorkoutSessionId: input.workoutSessionId, claimCreated: true };

  const [existing] = await tx
    .select({ canonicalWorkoutSessionId: plannedWorkoutOccurrenceClaims.canonicalWorkoutSessionId })
    .from(plannedWorkoutOccurrenceClaims)
    .where(and(eq(plannedWorkoutOccurrenceClaims.userId, input.userId), eq(plannedWorkoutOccurrenceClaims.plannedWorkoutId, input.plannedWorkoutId)))
    .limit(1);
  // A conflict without a claim for this occurrence is impossible (the only
  // other unique index is the canonical session, and this session is new) —
  // a genuine failure, surfaced so the START transaction rolls back.
  if (existing === undefined) throw new Error("Occurrence claim conflict without an existing claim");
  return {
    role: existing.canonicalWorkoutSessionId === input.workoutSessionId ? "CANONICAL" : "SECONDARY",
    canonicalWorkoutSessionId: existing.canonicalWorkoutSessionId,
    claimCreated: false,
  };
}

export interface CanonicalOccurrenceSession {
  readonly plannedWorkoutId: string;
  readonly workoutSessionId: string;
  readonly status: "ACTIVE" | "COMPLETED";
}

/**
 * Plan/Today: the canonical session (if any) of each planned workout —
 * deterministic, independent of how many secondary sessions exist, their
 * statuses, set counts or insertion order.
 */
export async function findCanonicalOccurrenceSessions(
  db: Database,
  userId: string,
  plannedWorkoutIds: readonly string[],
): Promise<Map<string, CanonicalOccurrenceSession>> {
  const result = new Map<string, CanonicalOccurrenceSession>();
  if (plannedWorkoutIds.length === 0) return result;
  const rows = await db
    .select({
      plannedWorkoutId: plannedWorkoutOccurrenceClaims.plannedWorkoutId,
      workoutSessionId: workoutSessions.id,
      status: workoutSessions.status,
    })
    .from(plannedWorkoutOccurrenceClaims)
    .innerJoin(workoutSessions, eq(workoutSessions.id, plannedWorkoutOccurrenceClaims.canonicalWorkoutSessionId))
    .where(and(eq(plannedWorkoutOccurrenceClaims.userId, userId), inArray(plannedWorkoutOccurrenceClaims.plannedWorkoutId, [...plannedWorkoutIds])));
  for (const row of rows) result.set(row.plannedWorkoutId, row);
  return result;
}

/** `prescriptionSnapshot.prescriptionId` of an (opaque, stored) session snapshot. */
export function extractPrescriptionId(prescriptionSnapshot: unknown): string | undefined {
  if (
    typeof prescriptionSnapshot === "object" &&
    prescriptionSnapshot !== null &&
    "prescriptionId" in prescriptionSnapshot &&
    typeof prescriptionSnapshot.prescriptionId === "string"
  ) {
    return prescriptionSnapshot.prescriptionId;
  }
  return undefined;
}

/**
 * Role of each given session of one user: CANONICAL / SECONDARY when its
 * snapshot's planned workout has a claim, `null` when it has none (an
 * unplanned session — no occurrence semantics at all).
 */
export async function resolveOccurrenceSessionRoles(
  db: Database,
  userId: string,
  sessions: readonly { readonly id: string; readonly prescriptionSnapshot: unknown }[],
): Promise<Map<string, OccurrenceSessionRole | null>> {
  // Only a UUID can be a claimed planned workout; ad-hoc ids (e.g. "presc-1") never are.
  const prescriptionIds = [
    ...new Set(sessions.map((s) => extractPrescriptionId(s.prescriptionSnapshot)).filter((id): id is string => id !== undefined && UUID_PATTERN.test(id))),
  ];
  const claims =
    prescriptionIds.length === 0
      ? []
      : await db
          .select({ plannedWorkoutId: plannedWorkoutOccurrenceClaims.plannedWorkoutId, canonical: plannedWorkoutOccurrenceClaims.canonicalWorkoutSessionId })
          .from(plannedWorkoutOccurrenceClaims)
          .where(
            and(
              eq(plannedWorkoutOccurrenceClaims.userId, userId),
              inArray(plannedWorkoutOccurrenceClaims.plannedWorkoutId, prescriptionIds),
            ),
          );
  const canonicalByWorkout = new Map(claims.map((claim) => [claim.plannedWorkoutId, claim.canonical]));
  return new Map(
    sessions.map((session) => {
      const prescriptionId = extractPrescriptionId(session.prescriptionSnapshot);
      const canonical = prescriptionId === undefined ? undefined : canonicalByWorkout.get(prescriptionId);
      return [session.id, canonical === undefined ? null : canonical === session.id ? "CANONICAL" : "SECONDARY"];
    }),
  );
}
