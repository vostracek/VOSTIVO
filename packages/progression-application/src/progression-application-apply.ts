import { and, eq } from "drizzle-orm";
import {
  athleteProfiles,
  programVersions,
  progressionApplicationCommands,
  progressionApplications,
  PROGRESSION_APPLICATION_COMMAND_REJECTION_REASON_VALUES,
  type Database,
  type ExpectedEffectiveLoadRow,
  type LoadingCapabilitySnapshotRow,
} from "@vostivo/database";
import { resolveNextLoadFromCapability, type LoadingCapabilityV1 } from "@vostivo/domain";
import type { ProgressionActorV1 } from "./actor.js";
import { resolveExerciseDisplayName } from "./exercise-display-name.js";
import { findDefaultGymProfileForAthlete } from "./gym-profile.js";
import { resolveBoundCapability, resolveBoundCapabilityForUpdate } from "./loading-capability-lookup.js";
import {
  computeRevalidation,
  findCommandReceipt,
  loadOwnedApplication,
  loadsEqual,
  toProgressionApplicationRecord,
  type ProgressionApplicationRecord,
  type ProgressionApplicationStatus,
} from "./progression-application.js";

/**
 * Progression Application V1 — Slice D (task §43) — the one mechanical
 * transaction core's actor discriminant. `ATHLETE` carries a real `userId`
 * (BOLA-checked against the application's own owner); `SYSTEM` (GUIDED
 * auto-apply) carries none — there is no real `User` row for it, and the
 * application's own canonical `userId` is used throughout instead,
 * exactly as the pre-existing capability/resolver calls already did
 * (never trusted from a caller either way).
 */
export type ApplyCoreActor = { readonly kind: "ATHLETE"; readonly userId: string } | { readonly kind: "SYSTEM" };

/**
 * Task §48 — loads the application, applying BOLA ownership only for
 * `ATHLETE`. `SYSTEM` is the internally-trusted worker (task §48: "the
 * worker has internal trusted application authority to request SYSTEM
 * action... the Progression Application service itself still derives
 * application owner ... from DB") — there is no caller-supplied identity
 * to check against, so it loads by id alone, with no ownership filter.
 */
async function loadApplicationForActor(db: Database, actor: ApplyCoreActor, applicationId: string): Promise<ProgressionApplicationRecord | null> {
  if (actor.kind === "ATHLETE") {
    return loadOwnedApplication(db, actor.userId, applicationId);
  }
  const [row] = await db.select().from(progressionApplications).where(eq(progressionApplications.id, applicationId)).limit(1);
  return row === undefined ? null : toProgressionApplicationRecord(row);
}

/**
 * Progression Application V1 — Slice C (`docs/domain/
 * PROGRESSION-APPLICATION-V1.md`, implementation task "Slice C — Numeric
 * Apply + Effective Overlay"). The numeric Apply transaction: the first
 * code path allowed to write `status = 'APPLIED'` and make a progression
 * actually affect a future effective prescription. `progression_applications`
 * itself is the domain-specific effective-value overlay (task §2) — no
 * second generic "plan overrides" table exists; `ProgramVersion`/
 * `PlannedExercise`/`PlannedSet` are never mutated (task §3).
 */

export type ApplyRejectionReason =
  | "STALE"
  | "SUPERSEDED"
  | "KEPT_ORIGINAL"
  | "PROPOSAL_REFRESH_REQUIRED"
  | "NO_CURRENT_LOAD"
  | "LOADING_CAPABILITY_UNAVAILABLE"
  | "LOADING_CAPABILITY_INVALID"
  | "CAPABILITY_INCOMPATIBLE"
  | "CURRENT_LOAD_UNSUPPORTED"
  | "NO_SUITABLE_INCREMENT";

/**
 * The subset of `ApplyRejectionReason` that is actually persisted to
 * `progression_application_commands.rejection_reason` (task §36's own
 * closed DB vocabulary). `KEPT_ORIGINAL` is a real, useful outcome at the
 * TypeScript API level (task §57's Apply-vs-KeepOriginal race) but is not
 * itself a "resolution failure" reason the DB enum tracks — the command's
 * own `outcome = 'REJECTED'` plus the returned `application.status` already
 * says everything the caller needs; persisting `NULL` here loses no
 * information.
 */
type PersistableRejectionReason = (typeof PROGRESSION_APPLICATION_COMMAND_REJECTION_REASON_VALUES)[number];

const PERSISTABLE_REJECTION_REASONS: ReadonlySet<string> = new Set(PROGRESSION_APPLICATION_COMMAND_REJECTION_REASON_VALUES);

function toPersistableRejectionReason(reason: ApplyRejectionReason): PersistableRejectionReason | null {
  return PERSISTABLE_REJECTION_REASONS.has(reason) ? (reason as PersistableRejectionReason) : null;
}

export type ApplyOutcome =
  | { readonly status: "APPLIED"; readonly application: ProgressionApplicationRecord }
  | { readonly status: "NOT_APPLIED"; readonly reason: ApplyRejectionReason; readonly application: ProgressionApplicationRecord }
  | { readonly status: "NOT_FOUND" }
  | { readonly status: "COMMAND_CONFLICT" };

/**
 * Task §32 — the "this is the proposal the athlete believes they are
 * confirming" precondition. NEVER authority: the server always
 * independently re-resolves every one of these values inside the Apply
 * transaction (task §32's own explicit framing); a mismatch against any
 * supplied field is `PROPOSAL_REFRESH_REQUIRED` (task §33), never a
 * silently-applied different value.
 */
export interface ApplyExpectedProposal {
  readonly expectedCurrentEffectiveLoad?: ExpectedEffectiveLoadRow;
  readonly expectedLoadingCapabilityId?: string;
  readonly expectedLoadingCapabilityRevision?: number;
  readonly expectedResolverProposedLoad?: ExpectedEffectiveLoadRow;
}

export interface ApplyInput {
  readonly applicationId: string;
  readonly commandId: string;
  readonly expectedProposal?: ApplyExpectedProposal;
}

function reasonFromTerminalStatus(status: ProgressionApplicationStatus): ApplyRejectionReason {
  if (status === "STALE") return "STALE";
  if (status === "SUPERSEDED") return "SUPERSEDED";
  if (status === "KEPT_ORIGINAL") return "KEPT_ORIGINAL";
  return "STALE"; // defensive — unreachable (APPLIED is handled separately, PENDING_REVIEW never reaches this function)
}

function classifyExistingApplication(app: ProgressionApplicationRecord): ApplyOutcome {
  if (app.status === "APPLIED") return { status: "APPLIED", application: app };
  return { status: "NOT_APPLIED", reason: reasonFromTerminalStatus(app.status), application: app };
}

class ApplyCommandRaceLoss extends Error {}

/** Task §57 — a concurrent `KEEP_ORIGINAL` (or, in a later slice, another actor-driven transition) won the race for this exact application row. Thrown to force a full transaction rollback (see the throw site's own doc comment), never caught silently. */
class ApplyLostToConcurrentDecision extends Error {}

/**
 * task §14/§40 — the pure computation shared by both the read-only
 * proposal preview (`resolveApplicationProposal`) and the numeric Apply
 * transaction itself: given an already-resolved current effective load
 * and capability, call the one approved pure Load Resolver
 * (`resolveNextLoadFromCapability`, `@vostivo/domain`) and map its result
 * onto this feature's own outcome vocabulary — never re-implementing
 * `FIXED_INCREMENT`/`ENUMERATED_LIST` arithmetic here (task §40).
 */
function computeResolverProposal(
  currentEffectiveLoad: ExpectedEffectiveLoadRow,
  capability: LoadingCapabilityV1,
): { readonly ok: true; readonly resolverProposedLoad: ExpectedEffectiveLoadRow } | { readonly ok: false; readonly reason: ApplyRejectionReason } {
  const resolution = resolveNextLoadFromCapability(
    { kind: "EXTERNAL_WEIGHT", amountMilli: currentEffectiveLoad.amountMilli, unit: currentEffectiveLoad.unit, basis: currentEffectiveLoad.basis },
    capability,
  );

  if (resolution.status === "INVALID_CAPABILITY") {
    // task §37: a malformed persisted capability fails closed as
    // MALFORMED_CAPABILITY — mapped here, never crashing, never inventing
    // a load. UNIT_MISMATCH/BASIS_MISMATCH/OVERFLOW are all "this specific
    // capability cannot resolve this specific current value" (task §39).
    return { ok: false, reason: resolution.reason === "MALFORMED_CAPABILITY" ? "LOADING_CAPABILITY_INVALID" : "CAPABILITY_INCOMPATIBLE" };
  }
  if (resolution.status === "CURRENT_LOAD_UNSUPPORTED") return { ok: false, reason: "CURRENT_LOAD_UNSUPPORTED" };
  if (resolution.status === "NO_SUITABLE_INCREMENT") return { ok: false, reason: "NO_SUITABLE_INCREMENT" };

  return {
    ok: true,
    resolverProposedLoad: { kind: "EXTERNAL_WEIGHT", amountMilli: resolution.load.amountMilli, unit: resolution.load.unit, basis: resolution.load.basis },
  };
}

function toCapabilitySnapshot(capability: LoadingCapabilityV1): LoadingCapabilitySnapshotRow {
  return capability.kind === "FIXED_INCREMENT"
    ? { kind: "FIXED_INCREMENT", unit: capability.unit, basis: capability.basis, incrementAmountMilli: capability.incrementAmountMilli }
    : { kind: "ENUMERATED_LIST", unit: capability.unit, basis: capability.basis, loadsMilli: capability.loadsMilli };
}

/**
 * Task §53's canonical capability-ownership chain: application owner
 * (`userId`) -> `AthleteProfile` -> default `GymProfile` -> explicit
 * binding -> `LoadingCapability`. Never accepts a caller-supplied
 * `athleteProfileId`/`gymProfileId` — both are always re-derived
 * server-side from the application's own canonical `userId`.
 */
async function resolveOwnedDefaultGymProfileId(db: Database, userId: string): Promise<string | null> {
  const [athleteRow] = await db.select({ athleteProfileId: athleteProfiles.id }).from(athleteProfiles).where(eq(athleteProfiles.userId, userId)).limit(1);
  if (athleteRow === undefined) return null;
  const gymProfile = await findDefaultGymProfileForAthlete(db, athleteRow.athleteProfileId);
  return gymProfile === null ? null : gymProfile.id;
}

export type ApplicationProposalOutcome =
  | {
      readonly status: "AVAILABLE";
      readonly applicationId: string;
      /** Presentation-safe, canonical exercise name (Slice E final gate) — resolved fresh, server-side, from the exact same locked Program Slot Identity this proposal itself was just revalidated against. Never a raw `exerciseRef`. */
      readonly exerciseDisplayName: string;
      readonly currentEffectiveLoad: ExpectedEffectiveLoadRow;
      readonly loadingCapabilityId: string;
      readonly loadingCapabilityRevision: number;
      readonly resolverProposedLoad: ExpectedEffectiveLoadRow;
    }
  | { readonly status: "UNAVAILABLE"; readonly reason: ApplyRejectionReason }
  | { readonly status: "NOT_FOUND" };

/**
 * Task §31 — a read-only, framework-neutral preview. No persistence: a
 * `PENDING_REVIEW` card's numeric preview is computed fresh on every call,
 * always reflecting live state, exactly as
 * `PROGRESSION-APPLICATION-V1.md` §8.1.1 requires. Uses the UNLOCKED
 * capability lookup (`resolveBoundCapability`, not the `...ForUpdate`
 * variant) — there is no Apply transaction in progress here to protect.
 */
export async function resolveApplicationProposal(
  db: Database,
  actor: ProgressionActorV1,
  applicationId: string,
): Promise<ApplicationProposalOutcome> {
  const app = await loadOwnedApplication(db, actor.userId, applicationId);
  if (app === null) return { status: "NOT_FOUND" };
  if (app.status !== "PENDING_REVIEW") return { status: "UNAVAILABLE", reason: reasonFromTerminalStatus(app.status) };

  const revalidation = await computeRevalidation(db, app);
  if (revalidation.verdict !== "VALID") return { status: "UNAVAILABLE", reason: revalidation.verdict };
  const { currentEffectiveLoad } = revalidation;

  const gymProfileId = await resolveOwnedDefaultGymProfileId(db, app.userId);
  if (gymProfileId === null) return { status: "UNAVAILABLE", reason: "LOADING_CAPABILITY_UNAVAILABLE" };

  const capabilityLookup = await resolveBoundCapability(db, gymProfileId, app.exerciseRef);
  if (capabilityLookup.status === "LOADING_CAPABILITY_UNAVAILABLE") return { status: "UNAVAILABLE", reason: "LOADING_CAPABILITY_UNAVAILABLE" };

  const proposal = computeResolverProposal(currentEffectiveLoad, capabilityLookup.capability);
  if (!proposal.ok) return { status: "UNAVAILABLE", reason: proposal.reason };

  // Presentation-integrity gate (Slice E final gate, task §4): resolved
  // fresh here, never carried over from `computeRevalidation`'s own
  // internal slot check — never a raw `exerciseRef` fallback. `VALID`
  // above already implies this slot exists, so `null` here would mean a
  // genuine race between revalidation and this read; treated exactly like
  // `computeRevalidation`'s own "slot vanished" verdict.
  const exerciseDisplayName = await resolveExerciseDisplayName(db, app);
  if (exerciseDisplayName === null) return { status: "UNAVAILABLE", reason: "STALE" };

  return {
    status: "AVAILABLE",
    applicationId: app.id,
    exerciseDisplayName,
    currentEffectiveLoad,
    loadingCapabilityId: capabilityLookup.loadingCapabilityId,
    loadingCapabilityRevision: capabilityLookup.revision,
    resolverProposedLoad: proposal.resolverProposedLoad,
  };
}

/** Task §13 — the truthful actor fields for a command receipt: `ATHLETE` carries a real `userId`, `SYSTEM` carries `null` (no real `User` row exists for it — never the application owner's id relabeled). */
function commandActorFields(actor: ApplyCoreActor): { readonly userId: string | null; readonly actorType: "ATHLETE" | "SYSTEM" } {
  return actor.kind === "ATHLETE" ? { userId: actor.userId, actorType: "ATHLETE" } : { userId: null, actorType: "SYSTEM" };
}

/**
 * Persists a `REJECTED` `APPLY` command receipt for an application that
 * remains exactly as it was (still `PENDING_REVIEW`) — task §41: a
 * physical/capability resolution failure never invalidates the
 * `progression_decisions` evidence, and the application stays reviewable.
 */
async function rejectApply(
  tx: Database,
  actor: ApplyCoreActor,
  input: ApplyInput,
  app: ProgressionApplicationRecord,
  reason: ApplyRejectionReason,
): Promise<ApplyOutcome> {
  const receiptInsert = await tx
    .insert(progressionApplicationCommands)
    .values({
      commandId: input.commandId,
      applicationId: app.id,
      ...commandActorFields(actor),
      action: "APPLY",
      outcome: "REJECTED",
      rejectionReason: toPersistableRejectionReason(reason),
    })
    .onConflictDoNothing({ target: progressionApplicationCommands.commandId })
    .returning({ commandId: progressionApplicationCommands.commandId });

  if (receiptInsert.length === 0) {
    throw new ApplyCommandRaceLoss();
  }

  return { status: "NOT_APPLIED", reason, application: app };
}

/** For an application already found in a terminal (or freshly-transitioned) state — persists the matching receipt and reports it (task §54's convergence: a fresh commandId arriving after the target state already holds converges safely, never an error). */
async function persistAlreadyDecided(
  tx: Database,
  actor: ApplyCoreActor,
  input: ApplyInput,
  app: ProgressionApplicationRecord,
): Promise<ApplyOutcome> {
  const outcome = classifyExistingApplication(app);
  const receiptInsert = await tx
    .insert(progressionApplicationCommands)
    .values({
      commandId: input.commandId,
      applicationId: app.id,
      ...commandActorFields(actor),
      action: "APPLY",
      outcome: outcome.status === "APPLIED" ? "APPLIED" : "REJECTED",
      rejectionReason: outcome.status === "NOT_APPLIED" ? toPersistableRejectionReason(outcome.reason) : null,
    })
    .onConflictDoNothing({ target: progressionApplicationCommands.commandId })
    .returning({ commandId: progressionApplicationCommands.commandId });

  if (receiptInsert.length === 0) {
    throw new ApplyCommandRaceLoss();
  }

  return outcome;
}

async function transitionToRevalidationVerdict(
  tx: Database,
  app: ProgressionApplicationRecord,
  verdict: "STALE" | "SUPERSEDED",
): Promise<ProgressionApplicationRecord> {
  const [updated] = await tx
    .update(progressionApplications)
    .set({ status: verdict, updatedAt: new Date() })
    .where(and(eq(progressionApplications.id, app.id), eq(progressionApplications.status, "PENDING_REVIEW")))
    .returning();
  if (updated !== undefined) return toProgressionApplicationRecord(updated);

  const fresh = await loadOwnedApplication(tx, app.userId, app.id);
  if (fresh === null) {
    throw new Error("progression_applications row disappeared mid-transaction — should be unreachable");
  }
  return fresh;
}

/**
 * Task §29's exact numeric Apply transaction. One database transaction,
 * the canonical order (adapted from the task's own 23-step description;
 * steps that reduce to the same real DB effect are merged rather than
 * artificially split):
 *
 * 1. inspect existing command receipt (outside the transaction, cheap
 *    replay short-circuit — same pattern as `keepOriginal`/
 *    `processWorkoutCommand`)
 * 2. load application / canonical owner (unlocked, just to learn its
 *    `programVersionId`)
 * 3. acquire `ProgramVersion` `FOR UPDATE` (task §28 — the V1 Apply
 *    serialization lock; this deliberately serializes every concurrent
 *    Apply within one athlete's `ProgramVersion`)
 * 4. re-read the application's canonical state (now safe: any concurrent
 *    Apply for the SAME `ProgramVersion` is blocked behind the lock this
 *    transaction now holds)
 * 5. re-check the command receipt (a concurrent identical-commandId Apply
 *    may have already committed while this transaction waited on the
 *    lock)
 * 6. verify still `PENDING_REVIEW` (task §54/§57 convergence otherwise)
 * 7-9. revalidate decision currency + Plan slot + current effective load,
 *    via the SAME `computeRevalidation` `ensureApplicationForDecision`/
 *    `revalidatePendingApplication` use (task §24 — never a separate
 *    implementation); its `VALID` branch already proves "current
 *    effective load == expectedEffectiveLoad" (task §29 step 9) by
 *    construction
 * 10. resolve the existing default `GymProfile` (read-only — task §25)
 * 11-12. resolve AND LOCK the exact binding + capability (task §27,
 *    `resolveBoundCapabilityForUpdate`)
 * 13-14. validate/compatibility-check the capability (folded into the
 *    pure resolver call itself — task §37/§39, never duplicated here)
 * 15-17. call the pure Load Resolver, compare every supplied proposal
 *    precondition (task §32/§33 — any mismatch is
 *    `PROPOSAL_REFRESH_REQUIRED`, no mutation)
 * 18-19. locate the current `APPLIED` head for the stream and supersede
 *    it FIRST — **this exact order is load-bearing, not stylistic**: the
 *    partial unique index (`progression_applications_one_current_overlay_
 *    per_stream`) is checked at the end of EACH statement, so setting the
 *    new row to `APPLIED` before the old head is superseded would
 *    transiently violate it and be rejected by Postgres itself
 * 20-21. populate the immutable audit group and set the new row to
 *    `APPLIED`
 * 22. persist the `APPLY` command receipt
 * 23. commit (implicit — the whole function body runs inside one
 *    `db.transaction()`; any thrown error rolls back everything,
 *    including the supersession from step 19 — task §30's exact required
 *    proof)
 */
async function applyProgressionCore(db: Database, actor: ApplyCoreActor, input: ApplyInput): Promise<ApplyOutcome> {
  const existingReceipt = await findCommandReceipt(db, input.commandId);
  if (existingReceipt !== undefined) {
    if (existingReceipt.applicationId !== input.applicationId || existingReceipt.action !== "APPLY") {
      return { status: "COMMAND_CONFLICT" };
    }
    const app = await loadApplicationForActor(db, actor, input.applicationId);
    if (app === null) return { status: "NOT_FOUND" };
    return classifyExistingApplication(app);
  }

  try {
    return await db.transaction(async (tx): Promise<ApplyOutcome> => {
      const initial = await loadApplicationForActor(tx, actor, input.applicationId);
      if (initial === null) return { status: "NOT_FOUND" };

      // Step 3 (task §28): the V1 Apply serialization lock.
      await tx.select({ id: programVersions.id }).from(programVersions).where(eq(programVersions.id, initial.programVersionId)).for("update");

      // Step 4: canonical reads happen AFTER acquiring the lock (task §55
      // — never apply based on values read before waiting on it).
      const app = await loadApplicationForActor(tx, actor, input.applicationId);
      if (app === null) return { status: "NOT_FOUND" };

      // Step 5.
      const receiptAfterLock = await findCommandReceipt(tx, input.commandId);
      if (receiptAfterLock !== undefined) {
        if (receiptAfterLock.applicationId !== input.applicationId || receiptAfterLock.action !== "APPLY") {
          return { status: "COMMAND_CONFLICT" };
        }
        return classifyExistingApplication(app);
      }

      // Step 6.
      if (app.status !== "PENDING_REVIEW") {
        return await persistAlreadyDecided(tx, actor, input, app);
      }

      // Steps 7-9.
      const revalidation = await computeRevalidation(tx, app);
      if (revalidation.verdict !== "VALID") {
        const transitioned = await transitionToRevalidationVerdict(tx, app, revalidation.verdict);
        return await persistAlreadyDecided(tx, actor, input, transitioned);
      }
      const { currentEffectiveLoad } = revalidation;

      if (
        input.expectedProposal?.expectedCurrentEffectiveLoad !== undefined &&
        !loadsEqual(input.expectedProposal.expectedCurrentEffectiveLoad, currentEffectiveLoad)
      ) {
        return await rejectApply(tx, actor, input, app, "PROPOSAL_REFRESH_REQUIRED");
      }

      // Step 10.
      const [athleteRow] = await tx.select({ athleteProfileId: athleteProfiles.id }).from(athleteProfiles).where(eq(athleteProfiles.userId, app.userId)).limit(1);
      const gymProfile = athleteRow === undefined ? null : await findDefaultGymProfileForAthlete(tx, athleteRow.athleteProfileId);
      if (gymProfile === null) {
        return await rejectApply(tx, actor, input, app, "LOADING_CAPABILITY_UNAVAILABLE");
      }

      // Steps 11-14.
      const capabilityLookup = await resolveBoundCapabilityForUpdate(tx, gymProfile.id, app.exerciseRef);
      if (capabilityLookup.status === "LOADING_CAPABILITY_UNAVAILABLE") {
        return await rejectApply(tx, actor, input, app, "LOADING_CAPABILITY_UNAVAILABLE");
      }

      if (
        input.expectedProposal?.expectedLoadingCapabilityId !== undefined &&
        input.expectedProposal.expectedLoadingCapabilityId !== capabilityLookup.loadingCapabilityId
      ) {
        return await rejectApply(tx, actor, input, app, "PROPOSAL_REFRESH_REQUIRED");
      }
      if (
        input.expectedProposal?.expectedLoadingCapabilityRevision !== undefined &&
        input.expectedProposal.expectedLoadingCapabilityRevision !== capabilityLookup.revision
      ) {
        return await rejectApply(tx, actor, input, app, "PROPOSAL_REFRESH_REQUIRED");
      }

      // Steps 15-16.
      const proposal = computeResolverProposal(currentEffectiveLoad, capabilityLookup.capability);
      if (!proposal.ok) {
        return await rejectApply(tx, actor, input, app, proposal.reason);
      }
      const { resolverProposedLoad } = proposal;

      // Step 17.
      if (
        input.expectedProposal?.expectedResolverProposedLoad !== undefined &&
        !loadsEqual(input.expectedProposal.expectedResolverProposedLoad, resolverProposedLoad)
      ) {
        return await rejectApply(tx, actor, input, app, "PROPOSAL_REFRESH_REQUIRED");
      }

      // Task §16 — Slice C has no manual override: appliedLoad MUST equal resolverProposedLoad.
      const appliedLoad = resolverProposedLoad;
      const appliedAt = new Date();
      const capabilitySnapshot = toCapabilitySnapshot(capabilityLookup.capability);

      // Step 18: locate the current head for the SAME stream.
      const [currentHead] = await tx
        .select({ id: progressionApplications.id })
        .from(progressionApplications)
        .where(
          and(
            eq(progressionApplications.userId, app.userId),
            eq(progressionApplications.programVersionId, app.programVersionId),
            eq(progressionApplications.trainingBlockId, app.trainingBlockId),
            eq(progressionApplications.workoutOrderIndex, app.workoutOrderIndex),
            eq(progressionApplications.exerciseOrderIndex, app.exerciseOrderIndex),
            eq(progressionApplications.status, "APPLIED"),
          ),
        )
        .limit(1);

      // Step 19 — MUST happen before step 21 (see the function doc comment
      // above: the partial unique index would otherwise transiently reject
      // the new row's own APPLIED write).
      if (currentHead !== undefined) {
        await tx
          .update(progressionApplications)
          .set({ status: "SUPERSEDED", supersededByApplicationId: app.id, updatedAt: appliedAt })
          .where(and(eq(progressionApplications.id, currentHead.id), eq(progressionApplications.status, "APPLIED")));
      }

      // Steps 20-21. Task §12/§13/§14: truthful actor audit — SYSTEM never
      // borrows the application owner's userId (decidedBy stays NULL).
      const [updated] = await tx
        .update(progressionApplications)
        .set({
          status: "APPLIED",
          decidedAt: appliedAt,
          decidedByActorType: actor.kind,
          decidedBy: actor.kind === "ATHLETE" ? actor.userId : null,
          loadingCapabilityId: capabilityLookup.loadingCapabilityId,
          loadingCapabilityRevision: capabilityLookup.revision,
          loadingCapabilitySnapshot: capabilitySnapshot,
          resolverProposedLoad,
          appliedLoad,
          appliedAt,
          updatedAt: appliedAt,
        })
        .where(and(eq(progressionApplications.id, app.id), eq(progressionApplications.status, "PENDING_REVIEW")))
        .returning();

      if (updated === undefined) {
        // task §57 (Apply vs KEEP_ORIGINAL): the ProgramVersion lock (step 3)
        // only serializes concurrent Applies against EACH OTHER — it does
        // NOT serialize against `keepOriginal`, which never touches
        // `program_versions` at all. A concurrent KEEP_ORIGINAL can commit
        // in the window between this transaction's own step-4 read (still
        // PENDING_REVIEW) and this final write, losing this race. Throwing
        // here rolls back the ENTIRE transaction — including the
        // just-performed supersession of the old head above, which must
        // never be committed if this row never actually became APPLIED
        // (task §30's "no partial supersession" guarantee applies here
        // too, not just to an artificial failure injection).
        throw new ApplyLostToConcurrentDecision();
      }

      // Step 22.
      const receiptInsert = await tx
        .insert(progressionApplicationCommands)
        .values({ commandId: input.commandId, applicationId: app.id, ...commandActorFields(actor), action: "APPLY", outcome: "APPLIED" })
        .onConflictDoNothing({ target: progressionApplicationCommands.commandId })
        .returning({ commandId: progressionApplicationCommands.commandId });

      if (receiptInsert.length === 0) {
        throw new ApplyCommandRaceLoss();
      }

      return { status: "APPLIED", application: toProgressionApplicationRecord(updated) };
    });
  } catch (error) {
    if (error instanceof ApplyCommandRaceLoss) {
      const winnerReceipt = await findCommandReceipt(db, input.commandId);
      if (winnerReceipt !== undefined) {
        const app = await loadApplicationForActor(db, actor, input.applicationId);
        if (app === null) return { status: "NOT_FOUND" };
        return classifyExistingApplication(app);
      }
    }
    if (error instanceof ApplyLostToConcurrentDecision) {
      // The whole transaction rolled back (no supersession, no audit, no
      // receipt was actually committed) — the winner's own transaction is
      // the sole source of truth now. Re-read fresh and persist THIS
      // command's own receipt against that real outcome, in a new
      // transaction.
      const app = await loadApplicationForActor(db, actor, input.applicationId);
      if (app === null) return { status: "NOT_FOUND" };
      try {
        return await db.transaction((tx) => persistAlreadyDecided(tx, actor, input, app));
      } catch (nestedError) {
        if (nestedError instanceof ApplyCommandRaceLoss) {
          const winnerReceipt = await findCommandReceipt(db, input.commandId);
          if (winnerReceipt !== undefined) {
            const refreshed = await loadApplicationForActor(db, actor, input.applicationId);
            if (refreshed === null) return { status: "NOT_FOUND" };
            return classifyExistingApplication(refreshed);
          }
        }
        throw nestedError;
      }
    }
    throw error;
  }
}

/**
 * Task §26 — the exact Slice-C human Apply path, unchanged in behavior
 * (existing signature/semantics preserved so this remains the SAME
 * function Slice C's own tests already exercise). ATHLETE ownership is
 * BOLA-checked against `actor.userId` throughout.
 */
export async function applyProgression(db: Database, actor: ProgressionActorV1, input: ApplyInput): Promise<ApplyOutcome> {
  return applyProgressionCore(db, { kind: "ATHLETE", userId: actor.userId }, input);
}

export interface ApplySystemInput {
  readonly applicationId: string;
  /** Task §15 — generated once at dispatch-job ENQUEUE time; stable across pg-boss job retries because it is part of the persisted job payload. */
  readonly systemCommandId: string;
}

/**
 * Task §10/§11/§43 — GUIDED's system auto-apply. Reuses the EXACT SAME
 * mechanical transaction core as the athlete path (`applyProgressionCore`)
 * — same locks, same capability resolver, same audit, same overlay
 * mutation, same idempotency (task §43's own explicit requirement: "do
 * not copy/paste the transaction"). Never accepts a human proposal
 * precondition (task §11 — "apply the canonical proposal that exists
 * inside this authoritative transaction," not "confirm what I
 * previously saw") and never accepts a caller-supplied `userId` — the
 * application's own canonical owner is used throughout, exactly as the
 * athlete path already does internally.
 */
export async function applySystemProgression(db: Database, input: ApplySystemInput): Promise<ApplyOutcome> {
  return applyProgressionCore(db, { kind: "SYSTEM" }, { applicationId: input.applicationId, commandId: input.systemCommandId });
}
