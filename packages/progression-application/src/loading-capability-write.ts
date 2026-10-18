import { eq, sql } from "drizzle-orm";
import { exerciseLoadingCapabilityBindings, loadingCapabilities, type Database } from "@vostivo/database";
import { createEntityId } from "@vostivo/domain";
import type { LoadUnit, LoadBasisV1 } from "@vostivo/domain";
import { validateEnumeratedListLoads, type EnumeratedListValidationError } from "@vostivo/domain";

/**
 * Loading Capability V1 — the narrow internal create/update/bind
 * primitive needed to prove the model end-to-end (`docs/domain/
 * LOADING-CAPABILITY-V1.md` §17 of the implementation task). No HTTP, no
 * Profile settings UX, no bulk equipment survey — exactly the three
 * operations a future write surface (or this slice's own tests) needs.
 *
 * Domain validation (`validateEnumeratedListLoads`) always runs BEFORE
 * any INSERT/UPDATE reaches Postgres — this is the actual enforcement
 * boundary for "strictly ascending, unique" (`loading-capability.ts`'s own
 * schema doc comment explains why the database itself cannot express that
 * rule as a plain `CHECK`).
 */

export type CreateLoadingCapabilityInput =
  | {
      readonly kind: "FIXED_INCREMENT";
      readonly gymProfileId: string;
      readonly unit: LoadUnit;
      readonly basis: LoadBasisV1;
      readonly incrementAmountMilli: number;
    }
  | {
      readonly kind: "ENUMERATED_LIST";
      readonly gymProfileId: string;
      readonly unit: LoadUnit;
      readonly basis: LoadBasisV1;
      readonly loadsMilli: readonly number[];
    };

export type CreateLoadingCapabilityResult =
  | { readonly status: "CREATED"; readonly loadingCapabilityId: string; readonly revision: number }
  | { readonly status: "INVALID_ENUMERATED_LIST"; readonly reason: EnumeratedListValidationError["reason"] };

/** Always `revision = 1` on creation (`loading_capabilities_revision_positive` — the DB's own floor). */
export async function createLoadingCapability(
  db: Database,
  input: CreateLoadingCapabilityInput,
): Promise<CreateLoadingCapabilityResult> {
  if (input.kind === "ENUMERATED_LIST") {
    const validated = validateEnumeratedListLoads(input.loadsMilli);
    if (!validated.ok) {
      return { status: "INVALID_ENUMERATED_LIST", reason: validated.error.reason };
    }
  }

  const id = createEntityId<"LoadingCapability">();
  await db.insert(loadingCapabilities).values({
    id,
    gymProfileId: input.gymProfileId,
    unit: input.unit,
    basis: input.basis,
    kind: input.kind,
    revision: 1,
    fixedIncrementAmountMilli: input.kind === "FIXED_INCREMENT" ? input.incrementAmountMilli : null,
    enumeratedLoadsMilli: input.kind === "ENUMERATED_LIST" ? [...input.loadsMilli] : null,
  });

  return { status: "CREATED", loadingCapabilityId: id, revision: 1 };
}

export type UpdateLoadingCapabilityInput =
  | { readonly kind: "FIXED_INCREMENT"; readonly incrementAmountMilli: number }
  | { readonly kind: "ENUMERATED_LIST"; readonly loadsMilli: readonly number[] };

export type UpdateLoadingCapabilityResult =
  | { readonly status: "UPDATED"; readonly revision: number }
  | { readonly status: "INVALID_ENUMERATED_LIST"; readonly reason: EnumeratedListValidationError["reason"] }
  | { readonly status: "NOT_FOUND" };

/**
 * Any resolver-relevant change increments `revision` — never left to
 * `updatedAt` (`docs/domain/LOADING-CAPABILITY-V1.md` §7.1). `unit`/
 * `basis` are deliberately not editable here (changing them would change
 * which exercises the capability is even compatible with — out of this
 * slice's minimal write surface; a real settings feature would model that
 * as a new capability + rebinding, not an in-place unit/basis edit).
 */
export async function updateLoadingCapabilityPayload(
  db: Database,
  loadingCapabilityId: string,
  input: UpdateLoadingCapabilityInput,
): Promise<UpdateLoadingCapabilityResult> {
  if (input.kind === "ENUMERATED_LIST") {
    const validated = validateEnumeratedListLoads(input.loadsMilli);
    if (!validated.ok) {
      return { status: "INVALID_ENUMERATED_LIST", reason: validated.error.reason };
    }
  }

  const [updated] = await db
    .update(loadingCapabilities)
    .set({
      kind: input.kind,
      fixedIncrementAmountMilli: input.kind === "FIXED_INCREMENT" ? input.incrementAmountMilli : null,
      enumeratedLoadsMilli: input.kind === "ENUMERATED_LIST" ? [...input.loadsMilli] : null,
      revision: sql`${loadingCapabilities.revision} + 1`,
      updatedAt: sql`now()`,
    })
    .where(eq(loadingCapabilities.id, loadingCapabilityId))
    .returning({ revision: loadingCapabilities.revision });

  if (updated === undefined) {
    return { status: "NOT_FOUND" };
  }
  return { status: "UPDATED", revision: updated.revision };
}

export type BindExerciseToCapabilityResult =
  | { readonly status: "BOUND" }
  /** The same-gym invariant (`exercise_loading_capability_bindings_same_gym_fkey`) rejected this — `loadingCapabilityId` belongs to a different GymProfile than `gymProfileId`. */
  | { readonly status: "CROSS_GYM_CAPABILITY" };

/** Idempotent rebind: a second call for the same `(gymProfileId, exerciseRef)` updates the existing binding in place — no binding-history table in V1 (`docs/domain/LOADING-CAPABILITY-V1.md` §7.2). */
export async function bindExerciseToCapability(
  db: Database,
  gymProfileId: string,
  exerciseRef: string,
  loadingCapabilityId: string,
): Promise<BindExerciseToCapabilityResult> {
  try {
    await db
      .insert(exerciseLoadingCapabilityBindings)
      .values({ id: createEntityId<"ExerciseLoadingCapabilityBinding">(), gymProfileId, exerciseRef, loadingCapabilityId })
      .onConflictDoUpdate({
        target: [exerciseLoadingCapabilityBindings.gymProfileId, exerciseLoadingCapabilityBindings.exerciseRef],
        set: { loadingCapabilityId, updatedAt: sql`now()` },
      });
    return { status: "BOUND" };
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      return { status: "CROSS_GYM_CAPABILITY" };
    }
    throw error;
  }
}

/**
 * Distinguishes a genuine Postgres FK violation (SQLSTATE 23503) from any
 * other failure — the same `.cause`-traversal pattern
 * `workout-command-processing.ts`'s `isPostgresUniqueViolation` already
 * established for 23505, applied to the FK code this module's own
 * same-gym invariant can raise.
 */
function isForeignKeyViolation(error: unknown): boolean {
  return hasForeignKeyViolationCode(error) || hasForeignKeyViolationCode(getCause(error));
}

function hasForeignKeyViolationCode(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23503";
}

function getCause(error: unknown): unknown {
  return typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined;
}
