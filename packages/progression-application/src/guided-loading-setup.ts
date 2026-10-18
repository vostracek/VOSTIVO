import { and, asc, desc, eq } from "drizzle-orm";
import {
  athleteProfiles,
  progressionApplicationCommands,
  progressionApplications,
  type Database,
  type ExpectedEffectiveLoadRow,
} from "@vostivo/database";
import { createEntityId, validateEnumeratedListLoads, type EnumeratedListValidationError, type LoadingCapabilityV1 } from "@vostivo/domain";
import type { ProgressionActorV1 } from "./actor.js";
import { resolveExerciseDisplayName } from "./exercise-display-name.js";
import { findDefaultGymProfileForAthlete, getOrCreateDefaultGymProfileForAthlete } from "./gym-profile.js";
import { resolveBoundCapability, resolveBoundCapabilityForUpdate } from "./loading-capability-lookup.js";
import { bindExerciseToCapability, createLoadingCapability } from "./loading-capability-write.js";
import { applySystemProgression, type ApplyOutcome, type ApplyRejectionReason } from "./progression-application-apply.js";
import { computeRevalidation, loadOwnedApplication, type ProgressionApplicationRecord } from "./progression-application.js";
import { resolveProgressionAuthority } from "./progression-authority.js";

/**
 * Progression Application V1 — Slice F (Guided Blocked-Capability
 * Recovery / Contextual Loading Setup V1). Task §0's core distinction,
 * load-bearing throughout this whole module: the athlete here is
 * configuring PHYSICAL EQUIPMENT TRUTH, never approving a progression
 * recommendation. GUIDED remains fully automatic — this module never
 * calls the human `applyProgression`/`keepOriginal` paths, and a GUIDED
 * application blocked this way is never converted into an
 * Apply/Keep-Original review item (that remains exclusively ADAPTIVE/
 * EXPERT's own Slice-E surface).
 *
 * Task §1's exhaustive recoverable set — a SYSTEM Apply rejection is only
 * ever a loading-CONFIGURATION problem for these five reasons.
 * `NO_CURRENT_LOAD` (Plan/prescription truth, not equipment), `STALE`/
 * `SUPERSEDED` (workflow state) are deliberately excluded.
 */
export const RECOVERABLE_LOADING_SETUP_REASONS = [
  "LOADING_CAPABILITY_UNAVAILABLE",
  "LOADING_CAPABILITY_INVALID",
  "CAPABILITY_INCOMPATIBLE",
  "CURRENT_LOAD_UNSUPPORTED",
  "NO_SUITABLE_INCREMENT",
] as const;
export type RecoverableLoadingSetupReason = (typeof RECOVERABLE_LOADING_SETUP_REASONS)[number];

function isRecoverableReason(reason: ApplyRejectionReason): reason is RecoverableLoadingSetupReason {
  return (RECOVERABLE_LOADING_SETUP_REASONS as readonly string[]).includes(reason);
}

async function resolveCurrentAuthority(db: Database, userId: string): Promise<"SYSTEM_AUTO_APPLY" | "ATHLETE_REVIEW" | null> {
  const [row] = await db.select({ experienceMode: athleteProfiles.experienceMode }).from(athleteProfiles).where(eq(athleteProfiles.userId, userId)).limit(1);
  if (row === undefined) return null;
  return resolveProgressionAuthority({ experienceMode: row.experienceMode });
}

async function resolveAthleteProfileId(db: Database, userId: string): Promise<string | null> {
  const [row] = await db.select({ athleteProfileId: athleteProfiles.id }).from(athleteProfiles).where(eq(athleteProfiles.userId, userId)).limit(1);
  return row?.athleteProfileId ?? null;
}

/**
 * "Latest relevant SYSTEM APPLY receipt" (task §2) — the most recent
 * `SYSTEM`-actor `APPLY` command receipt for this application, by
 * `commandId` (UUIDv7 — this codebase's own established real time order).
 * Returns the reason only when that latest receipt is itself `REJECTED`
 * AND its reason is in the approved recoverable set — an `APPLIED`
 * receipt, no receipt at all, or a non-recoverable reason all correctly
 * produce `null` here.
 */
async function findLatestRecoverableSystemRejection(db: Database, applicationId: string): Promise<RecoverableLoadingSetupReason | null> {
  const [row] = await db
    .select({ outcome: progressionApplicationCommands.outcome, rejectionReason: progressionApplicationCommands.rejectionReason })
    .from(progressionApplicationCommands)
    .where(
      and(
        eq(progressionApplicationCommands.applicationId, applicationId),
        eq(progressionApplicationCommands.actorType, "SYSTEM"),
        eq(progressionApplicationCommands.action, "APPLY"),
      ),
    )
    .orderBy(desc(progressionApplicationCommands.commandId))
    .limit(1);

  if (row === undefined || row.outcome !== "REJECTED" || row.rejectionReason === null) return null;
  return isRecoverableReason(row.rejectionReason) ? row.rejectionReason : null;
}

export interface GuidedLoadingSetupAttentionItem {
  readonly applicationId: string;
  readonly exerciseDisplayName: string;
  readonly currentEffectiveLoad: ExpectedEffectiveLoadRow;
  readonly recoverableReason: RecoverableLoadingSetupReason;
}

/**
 * Task §2/§30 — `getGuidedLoadingSetupAttention`: one item, or `null`.
 * Never trusts client mode (re-reads `athlete_profiles.experience_mode`
 * fresh); never exposes raw `exerciseRef` (an unresolvable canonical
 * exercise name is treated exactly like Slice E's own presentation-
 * integrity gate — omitted, never substituted). Oldest-first (`id ASC`,
 * task §30's explicit V1 fallback — same reasoning as Slice E's pending
 * list: "nearest future occurrence" is not cheaply derivable here either).
 */
export async function getGuidedLoadingSetupAttention(db: Database, actor: ProgressionActorV1): Promise<GuidedLoadingSetupAttentionItem | null> {
  const authority = await resolveCurrentAuthority(db, actor.userId);
  if (authority !== "SYSTEM_AUTO_APPLY") return null;

  const rows = await db
    .select({
      id: progressionApplications.id,
      exerciseRef: progressionApplications.exerciseRef,
      programVersionId: progressionApplications.programVersionId,
      trainingBlockId: progressionApplications.trainingBlockId,
      workoutOrderIndex: progressionApplications.workoutOrderIndex,
      exerciseOrderIndex: progressionApplications.exerciseOrderIndex,
    })
    .from(progressionApplications)
    .where(and(eq(progressionApplications.userId, actor.userId), eq(progressionApplications.status, "PENDING_REVIEW")))
    .orderBy(asc(progressionApplications.id));

  for (const row of rows) {
    const recoverableReason = await findLatestRecoverableSystemRejection(db, row.id);
    if (recoverableReason === null) continue;

    const app = await loadOwnedApplication(db, actor.userId, row.id);
    if (app === null) continue;
    const revalidation = await computeRevalidation(db, app);
    if (revalidation.verdict !== "VALID") continue;

    const exerciseDisplayName = await resolveExerciseDisplayName(db, row);
    if (exerciseDisplayName === null) continue;

    return { applicationId: row.id, exerciseDisplayName, currentEffectiveLoad: revalidation.currentEffectiveLoad, recoverableReason };
  }

  return null;
}

type RecoveryContextOutcome =
  | {
      readonly status: "AVAILABLE";
      readonly app: ProgressionApplicationRecord;
      readonly currentEffectiveLoad: ExpectedEffectiveLoadRow;
      readonly exerciseDisplayName: string;
      readonly recoverableReason: RecoverableLoadingSetupReason;
    }
  | { readonly status: "NOT_FOUND" }
  | { readonly status: "MODE_ACTION_NOT_ALLOWED" }
  | { readonly status: "NOT_RECOVERABLE" };

/**
 * Shared revalidation used by BOTH the GET context and the SAVE
 * transaction (task §14) — owner, current GUIDED mode, `PENDING_REVIEW`,
 * still-current (`computeRevalidation` VALID), and a recoverable prior
 * SYSTEM rejection. Never mutates anything.
 */
async function resolveGuidedRecoveryContext(db: Database, actor: ProgressionActorV1, applicationId: string): Promise<RecoveryContextOutcome> {
  const app = await loadOwnedApplication(db, actor.userId, applicationId);
  if (app === null) return { status: "NOT_FOUND" };

  const authority = await resolveCurrentAuthority(db, actor.userId);
  if (authority !== "SYSTEM_AUTO_APPLY") return { status: "MODE_ACTION_NOT_ALLOWED" };

  if (app.status !== "PENDING_REVIEW") return { status: "NOT_RECOVERABLE" };

  const revalidation = await computeRevalidation(db, app);
  if (revalidation.verdict !== "VALID") return { status: "NOT_RECOVERABLE" };

  const recoverableReason = await findLatestRecoverableSystemRejection(db, applicationId);
  if (recoverableReason === null) return { status: "NOT_RECOVERABLE" };

  const exerciseDisplayName = await resolveExerciseDisplayName(db, app);
  if (exerciseDisplayName === null) return { status: "NOT_RECOVERABLE" };

  return { status: "AVAILABLE", app, currentEffectiveLoad: revalidation.currentEffectiveLoad, exerciseDisplayName, recoverableReason };
}

export interface LoadingSetupContext {
  readonly applicationId: string;
  readonly exerciseDisplayName: string;
  readonly currentEffectiveLoad: ExpectedEffectiveLoadRow;
  readonly recoverableReason: RecoverableLoadingSetupReason;
  /** The exact exercise's currently-bound capability, if any — lets the setup screen pre-fill an edit rather than assuming a first-time configuration. Never created merely by this read (task §12). */
  readonly currentConfiguration: LoadingCapabilityV1 | null;
}

export type LoadingSetupContextOutcome =
  | ({ readonly status: "AVAILABLE" } & LoadingSetupContext)
  | { readonly status: "NOT_FOUND" }
  | { readonly status: "MODE_ACTION_NOT_ALLOWED" }
  | { readonly status: "NOT_RECOVERABLE" };

/** Task §13 GET — presentation-safe canonical context. Never creates a GymProfile (task §12) — a read-only lookup only. */
export async function getLoadingSetupContext(db: Database, actor: ProgressionActorV1, applicationId: string): Promise<LoadingSetupContextOutcome> {
  const context = await resolveGuidedRecoveryContext(db, actor, applicationId);
  if (context.status !== "AVAILABLE") return context;

  const athleteProfileId = await resolveAthleteProfileId(db, actor.userId);
  const gym = athleteProfileId === null ? null : await findDefaultGymProfileForAthlete(db, athleteProfileId);
  const bound = gym === null ? null : await resolveBoundCapability(db, gym.id, context.app.exerciseRef);
  const currentConfiguration = bound !== null && bound.status === "RESOLVED" ? bound.capability : null;

  return {
    status: "AVAILABLE",
    applicationId: context.app.id,
    exerciseDisplayName: context.exerciseDisplayName,
    currentEffectiveLoad: context.currentEffectiveLoad,
    recoverableReason: context.recoverableReason,
    currentConfiguration,
  };
}

export type SaveLoadingSetupInput =
  | { readonly kind: "FIXED_INCREMENT"; readonly incrementAmountMilli: number }
  | { readonly kind: "ENUMERATED_LIST"; readonly loadsMilli: readonly number[] };

export type SaveGuidedLoadingSetupOutcome =
  | { readonly status: "NOT_FOUND" }
  | { readonly status: "MODE_ACTION_NOT_ALLOWED" }
  | { readonly status: "NOT_RECOVERABLE" }
  | { readonly status: "INVALID_FIXED_INCREMENT" }
  | { readonly status: "INVALID_ENUMERATED_LIST"; readonly reason: EnumeratedListValidationError["reason"] }
  | { readonly status: "APPLIED" }
  | { readonly status: "SAVED_STILL_BLOCKED"; readonly reason: string }
  | { readonly status: "SAVED_RETRY_FAILED" };

/**
 * Task §11 — the tech-lead-locked write semantics: reuse the existing
 * bound capability verbatim if semantically identical (same kind/unit/
 * basis/payload), never create a duplicate; otherwise fork a NEW
 * capability and rebind ONLY this exact exercise — never mutate a
 * capability that may be shared by other exact exercise bindings, so
 * their own resolver behavior can never be silently changed by this
 * single-exercise contextual edit.
 */
function isSemanticallyIdenticalCapability(existing: LoadingCapabilityV1, submitted: LoadingCapabilityV1): boolean {
  if (existing.kind !== submitted.kind || existing.unit !== submitted.unit || existing.basis !== submitted.basis) return false;
  if (existing.kind === "FIXED_INCREMENT" && submitted.kind === "FIXED_INCREMENT") {
    return existing.incrementAmountMilli === submitted.incrementAmountMilli;
  }
  if (existing.kind === "ENUMERATED_LIST" && submitted.kind === "ENUMERATED_LIST") {
    return existing.loadsMilli.length === submitted.loadsMilli.length && existing.loadsMilli.every((amount, index) => amount === submitted.loadsMilli[index]);
  }
  return false;
}

type ConfigurationSaveResult =
  | { readonly outcome: "SAVED" }
  | { readonly outcome: "NOT_FOUND" }
  | { readonly outcome: "MODE_ACTION_NOT_ALLOWED" }
  | { readonly outcome: "NOT_RECOVERABLE" };

/**
 * Task §15/§17/§18/§19 — the full contextual recovery flow.
 *
 * 1. Pre-validate the submitted configuration itself (domain rules —
 *    never reaches Postgres if malformed).
 * 2. ATOMIC configuration transaction: re-derive owner/mode/status/
 *    currency (task §14), get-or-create the default GymProfile, lock the
 *    exact exercise's existing binding+capability (`resolveBoundCapabilityForUpdate`
 *    — the ONLY resource this writer locks, so it cannot deadlock against
 *    the numeric Apply transaction's own `ProgramVersion`-first lock
 *    order, task §16), then — MANDATORY, Slice F's own final
 *    serialization gate — re-derive owner/mode/status/currency a SECOND
 *    time, using a plain unlocked read (never `ProgramVersion FOR UPDATE`,
 *    which would invert Apply's own lock order). The transaction may have
 *    waited on the binding/capability lock while a concurrent SYSTEM Apply
 *    committed; under Postgres READ COMMITTED, a fresh statement issued
 *    after that wait is guaranteed to observe the commit. Only once this
 *    SECOND check still says `AVAILABLE` does the writer reuse-or-fork+
 *    rebind. No Plan mutation, no `ProgressionApplication` state mutation
 *    in this transaction either way.
 * 3. AFTER that commit, as a SEPARATE durable step, retry the exact same
 *    SYSTEM auto-apply orchestration (`applySystemProgression` — the same
 *    Slice-C mechanical core, same `SYSTEM` actor, same immutable audit;
 *    never the human Apply endpoint, the athlete is never treated as the
 *    Apply actor). A transient failure here (task §19) never rolls back
 *    the already-committed configuration — `SAVED_RETRY_FAILED` reports
 *    that split honestly rather than pretending the whole operation
 *    failed.
 */
export async function saveGuidedLoadingSetup(
  db: Database,
  actor: ProgressionActorV1,
  applicationId: string,
  input: SaveLoadingSetupInput,
): Promise<SaveGuidedLoadingSetupOutcome> {
  if (input.kind === "FIXED_INCREMENT" && (!Number.isInteger(input.incrementAmountMilli) || input.incrementAmountMilli <= 0)) {
    return { status: "INVALID_FIXED_INCREMENT" };
  }
  if (input.kind === "ENUMERATED_LIST") {
    const validated = validateEnumeratedListLoads(input.loadsMilli);
    if (!validated.ok) return { status: "INVALID_ENUMERATED_LIST", reason: validated.error.reason };
  }

  const saveResult = await db.transaction(async (tx): Promise<ConfigurationSaveResult> => {
    const initialContext = await resolveGuidedRecoveryContext(tx, actor, applicationId);
    if (initialContext.status !== "AVAILABLE") return { outcome: initialContext.status };

    const athleteProfileId = await resolveAthleteProfileId(tx, actor.userId);
    if (athleteProfileId === null) return { outcome: "NOT_RECOVERABLE" };
    const gym = await getOrCreateDefaultGymProfileForAthlete(tx, athleteProfileId);

    // The ONLY lock this writer ever takes — never `ProgramVersion` (task
    // §3/§16), so it cannot invert numeric Apply's own lock order and
    // cannot deadlock against it.
    const existing = await resolveBoundCapabilityForUpdate(tx, gym.id, initialContext.app.exerciseRef);

    // MANDATORY post-lock revalidation (Slice F final serialization gate,
    // task §2) — this transaction may have waited on the lock just
    // acquired while a concurrent SYSTEM Apply committed (Crash-Window-
    // style race, but for a row lock rather than a queue). A plain,
    // UNLOCKED re-read here — deliberately never re-acquiring
    // `ProgramVersion FOR UPDATE` — is guaranteed under READ COMMITTED to
    // see that commit. Only this SECOND result governs whether the write
    // below is allowed to happen at all.
    const context = await resolveGuidedRecoveryContext(tx, actor, applicationId);
    if (context.status !== "AVAILABLE") return { outcome: context.status };

    // Unit/basis are SERVER-derived from the current effective load context
    // (task §7/§8) — never accepted from the submitted payload at all.
    const unit = context.currentEffectiveLoad.unit;
    const basis = context.currentEffectiveLoad.basis;
    const submitted: LoadingCapabilityV1 =
      input.kind === "FIXED_INCREMENT"
        ? { kind: "FIXED_INCREMENT", unit, basis, incrementAmountMilli: input.incrementAmountMilli }
        : { kind: "ENUMERATED_LIST", unit, basis, loadsMilli: input.loadsMilli };

    const identical = existing.status === "RESOLVED" && isSemanticallyIdenticalCapability(existing.capability, submitted);

    if (!identical) {
      const created =
        input.kind === "FIXED_INCREMENT"
          ? await createLoadingCapability(tx, { kind: "FIXED_INCREMENT", gymProfileId: gym.id, unit, basis, incrementAmountMilli: input.incrementAmountMilli })
          : await createLoadingCapability(tx, { kind: "ENUMERATED_LIST", gymProfileId: gym.id, unit, basis, loadsMilli: input.loadsMilli });
      // Already pre-validated above — this branch is structurally
      // unreachable, kept only as a fail-closed guard, never surfaced as a
      // new outcome category.
      if (created.status !== "CREATED") return { outcome: "NOT_RECOVERABLE" };
      await bindExerciseToCapability(tx, gym.id, context.app.exerciseRef, created.loadingCapabilityId);
    }

    return { outcome: "SAVED" };
  });

  if (saveResult.outcome !== "SAVED") return { status: saveResult.outcome };

  let applyOutcome: ApplyOutcome;
  try {
    applyOutcome = await applySystemProgression(db, { applicationId, systemCommandId: createEntityId() });
  } catch {
    return { status: "SAVED_RETRY_FAILED" };
  }

  if (applyOutcome.status === "APPLIED") return { status: "APPLIED" };
  if (applyOutcome.status === "NOT_APPLIED") return { status: "SAVED_STILL_BLOCKED", reason: applyOutcome.reason };
  // NOT_FOUND/COMMAND_CONFLICT are structurally near-impossible here (the
  // application was just confirmed owned/current above, and
  // `systemCommandId` was freshly generated this call) — treated as
  // still-blocked rather than inventing a new outcome category.
  return { status: "SAVED_STILL_BLOCKED", reason: "UNKNOWN" };
}
