import type { ExternalWeightLoad } from "@vostivo/domain";

/**
 * Progression Application V1 — Slice D (task §46) — the minimal
 * authenticated athlete API contracts (task §23). Never imports API/Nest
 * types (task §46) — plain, versionable data shapes only, exactly the
 * same convention as `plan-overview.ts`/`workout-preview.ts`.
 *
 * "Machine codes, never athlete-facing copy" (task §45): every `reason`/
 * `code` field below is one of this feature's own internal closed
 * vocabularies (task §36's rejection reasons, this contract's own
 * `MODE_ACTION_NOT_ALLOWED`) — a future UI layer maps each to plain
 * language; this contract never carries free text.
 */

export interface PendingProgressionApplicationV1 {
  readonly applicationId: string;
  readonly exerciseRef: string;
  /** Presentation-safe human-readable exercise name (Slice E task §7) — the athlete-facing name to render; `exerciseRef` remains for callers that still need the raw identity. */
  readonly exerciseDisplayName: string;
  readonly currentEffectiveLoad: ExternalWeightLoad;
  readonly proposalAvailable: boolean;
  readonly resolverProposedLoad: ExternalWeightLoad | null;
  /** Populated iff `proposalAvailable` is `false` — one of `ApplyRejectionReason`'s persistable values, or `revalidation.verdict` (`"STALE"`). */
  readonly proposalUnavailableReason: string | null;
}

export interface PendingProgressionApplicationsResponseV1 {
  readonly applications: readonly PendingProgressionApplicationV1[];
}

export type ProgressionApplicationProposalResponseV1 =
  | {
      readonly status: "AVAILABLE";
      readonly applicationId: string;
      /** Presentation-safe, canonical exercise name (Slice E final presentation-integrity gate) — resolved server-side from this application's own locked Program Slot Identity. Never a raw internal identifier; mobile must render this, never a route/navigation parameter. */
      readonly exerciseDisplayName: string;
      readonly currentEffectiveLoad: ExternalWeightLoad;
      readonly loadingCapabilityId: string;
      readonly loadingCapabilityRevision: number;
      readonly resolverProposedLoad: ExternalWeightLoad;
    }
  | { readonly status: "UNAVAILABLE"; readonly reason: string };

/**
 * Task §26 — required input only: `commandId` + the full proposal
 * precondition (task §32's four comparison-only fields — "these are
 * comparison/precondition values only, never client authority"; the
 * server always independently re-resolves and re-verifies every one of
 * them inside the locked Apply transaction). No `userId`/mode/
 * `exerciseRef`/capability-authoritative-data/`appliedLoad`/`status` field
 * exists on this DTO at all — there is nothing here for a client to spoof.
 */
export interface ApplyProgressionApplicationRequestV1 {
  readonly commandId: string;
  readonly expectedCurrentEffectiveLoad: ExternalWeightLoad;
  readonly expectedLoadingCapabilityId: string;
  readonly expectedLoadingCapabilityRevision: number;
  readonly expectedResolverProposedLoad: ExternalWeightLoad;
}

export interface KeepOriginalProgressionApplicationRequestV1 {
  readonly commandId: string;
}

/** The durable domain outcome of an Apply/Keep-Original command — 200 OK either way; only BOLA/command-identity/mode-authority failures are mapped to HTTP error statuses (task §45), never this body. */
export type ProgressionApplicationCommandResponseV1 =
  | { readonly status: "APPLIED" }
  | { readonly status: "KEPT_ORIGINAL" }
  | { readonly status: "NOT_APPLIED"; readonly reason: string };

/**
 * Progression Application V1 — Slice F (Guided Blocked-Capability
 * Recovery / Contextual Loading Setup V1). Task §0's core distinction:
 * this whole surface is the athlete configuring PHYSICAL EQUIPMENT
 * TRUTH, never approving a progression recommendation — it is
 * deliberately NOT the Slice-E Apply/Keep-Original review surface, and
 * never appears for ADAPTIVE/EXPERT.
 */
export interface GuidedLoadingSetupAttentionV1 {
  readonly applicationId: string;
  readonly exerciseDisplayName: string;
  readonly currentEffectiveLoad: ExternalWeightLoad;
  /** One of `RECOVERABLE_LOADING_SETUP_REASONS` (task §1) — a closed machine vocabulary, never athlete-facing copy directly. */
  readonly recoverableReason: string;
}

export interface GuidedLoadingSetupAttentionResponseV1 {
  readonly item: GuidedLoadingSetupAttentionV1 | null;
}

/** Task §6 — exactly two V1 configuration types; unit/basis are never part of this shape (task §7/§8 — always server-derived, never client authority). */
export type LoadingCapabilityConfigurationV1 =
  | { readonly kind: "FIXED_INCREMENT"; readonly incrementAmountMilli: number }
  | { readonly kind: "ENUMERATED_LIST"; readonly loadsMilli: readonly number[] };

/** Task §13 GET — presentation-safe canonical context. `currentConfiguration` reflects the athlete's already-bound capability, if any (never created merely by this read, task §12). */
export type LoadingSetupContextResponseV1 =
  | {
      readonly status: "AVAILABLE";
      readonly applicationId: string;
      readonly exerciseDisplayName: string;
      readonly currentEffectiveLoad: ExternalWeightLoad;
      readonly recoverableReason: string;
      readonly currentConfiguration: LoadingCapabilityConfigurationV1 | null;
    }
  | { readonly status: "NOT_RECOVERABLE" };

/** Task §13 POST/PUT — configuration payload only. No `userId`/`exerciseRef`/`gymProfileId`/`loadingCapabilityId`/unit/basis/mode/application-status field exists here — there is nothing for a client to spoof. */
export type SaveLoadingSetupRequestV1 = LoadingCapabilityConfigurationV1;

/**
 * Task §21/§37 — the possible 200 OK outcomes of a Save attempt (same
 * "domain outcome, not an HTTP error" convention as
 * `ProgressionApplicationCommandResponseV1`'s own `NOT_APPLIED`).
 * `NOT_RECOVERABLE` covers task §37's "the Plan changed / this is no
 * longer current" case — a deterministic non-actionable result, never
 * configured through blindly. Only BOLA (`NOT_FOUND` -> 404) and a real
 * mode-authority change (`MODE_ACTION_NOT_ALLOWED` -> 409) are mapped to
 * HTTP error statuses instead, never this body.
 */
export type SaveLoadingSetupResultResponseV1 =
  | { readonly status: "APPLIED" }
  | { readonly status: "SAVED_STILL_BLOCKED"; readonly reason: string }
  | { readonly status: "SAVED_RETRY_FAILED" }
  | { readonly status: "INVALID_FIXED_INCREMENT" }
  | { readonly status: "INVALID_ENUMERATED_LIST"; readonly reason: string }
  | { readonly status: "NOT_RECOVERABLE" };
