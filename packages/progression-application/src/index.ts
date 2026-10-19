export type { ProgressionActorV1 } from "./actor.js";
export {
  classifyComparability,
  reconstructPrescriptionContext,
  type HistoricalExposureCandidate,
  type ReconstructedPrescriptionContext,
} from "./progression-evidence.js";
export {
  canonicalStringify,
  computeEvidenceFingerprint,
  type EvidenceFingerprintInput,
  type ProgressionEvidenceRefV1,
} from "./progression-fingerprint.js";
export { WorkoutHistoryService, type PerformedSetExposureV1 } from "./workout-history.service.js";
export {
  ProgressionEvaluationService,
  type PersistedProgressionDecision,
  type ProgressionEvaluationOutcome,
} from "./progression-evaluation.service.js";
export {
  PROGRESSION_EVALUATE_SESSION_QUEUE_V1,
  PROGRESSION_EVALUATE_SESSION_DEAD_LETTER_QUEUE_V1,
  PROGRESSION_EVALUATE_SESSION_QUEUE_OPTIONS,
  progressionEvaluateSessionJobPayloadV1Schema,
  enqueueProgressionEvaluateSession,
  ensureProgressionEvaluateSessionQueues,
  type ProgressionEvaluateSessionJobPayloadV1,
} from "./progression-queue.js";
export {
  getOrCreateDefaultGymProfileForAthlete,
  findDefaultGymProfileForAthlete,
  type GymProfileRecord,
} from "./gym-profile.js";
export {
  resolveBoundCapability,
  resolveBoundCapabilityForUpdate,
  type LoadingCapabilityLookupResult,
} from "./loading-capability-lookup.js";
export {
  createLoadingCapability,
  updateLoadingCapabilityPayload,
  bindExerciseToCapability,
  type CreateLoadingCapabilityInput,
  type CreateLoadingCapabilityResult,
  type UpdateLoadingCapabilityInput,
  type UpdateLoadingCapabilityResult,
  type BindExerciseToCapabilityResult,
} from "./loading-capability-write.js";
export {
  ensureApplicationForDecision,
  revalidatePendingApplication,
  keepOriginal,
  isLegalSliceBTransition,
  loadsEqual,
  type ProgressionApplicationStatus,
  type ProgressionApplicationActorType,
  type ProgressionApplicationRecord,
  type EnsureApplicationOutcome,
  type RevalidateOutcome,
  type KeepOriginalOutcome,
  type KeepOriginalInput,
} from "./progression-application.js";
export {
  resolveEffectiveWorkingLoadForOccurrence,
  deriveUniformWorkingLoad,
  type EffectiveLoadResolutionParams,
  type EffectiveLoadResolution,
  type WorkingSetLoadRow,
} from "./effective-load-resolver.js";
export {
  applyProgression,
  applySystemProgression,
  resolveApplicationProposal,
  type ApplyOutcome,
  type ApplyInput,
  type ApplySystemInput,
  type ApplyCoreActor,
  type ApplyExpectedProposal,
  type ApplyRejectionReason,
  type ApplicationProposalOutcome,
} from "./progression-application-apply.js";
export { resolveProgressionAuthority, type ProgressionAuthority, type ResolveProgressionAuthorityInput } from "./progression-authority.js";
export { listPendingProgressionApplications, type PendingProgressionApplicationItem } from "./progression-review.js";
export {
  RECOVERABLE_LOADING_SETUP_REASONS,
  getGuidedLoadingSetupAttention,
  getLoadingSetupContext,
  saveGuidedLoadingSetup,
  type RecoverableLoadingSetupReason,
  type GuidedLoadingSetupAttentionItem,
  type LoadingSetupContext,
  type LoadingSetupContextOutcome,
  type SaveLoadingSetupInput,
  type SaveGuidedLoadingSetupOutcome,
} from "./guided-loading-setup.js";
export {
  PROGRESSION_APPLICATION_DISPATCH_QUEUE_V1,
  PROGRESSION_APPLICATION_DISPATCH_DEAD_LETTER_QUEUE_V1,
  PROGRESSION_APPLICATION_DISPATCH_QUEUE_OPTIONS,
  progressionApplicationDispatchJobPayloadV1Schema,
  enqueueProgressionApplicationDispatch,
  ensureProgressionApplicationDispatchQueues,
  type ProgressionApplicationDispatchJobPayloadV1,
} from "./progression-application-dispatch-queue.js";
export {
  claimPlannedOccurrence,
  findCanonicalOccurrenceSessions,
  resolveOccurrenceSessionRoles,
  extractPrescriptionId,
  type OccurrenceClaimResult,
  type CanonicalOccurrenceSession,
} from "./planned-occurrence-authority.js";
export { resolveExerciseDisplayName, type ProgramSlotIdentityRef } from "./exercise-display-name.js";
