import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { athleteProfiles, type Database } from "@vostivo/database";
import {
  applyProgression,
  keepOriginal,
  listPendingProgressionApplications,
  resolveApplicationProposal,
  resolveProgressionAuthority,
} from "@vostivo/progression-application";
import type {
  ApplyProgressionApplicationRequestV1,
  KeepOriginalProgressionApplicationRequestV1,
  PendingProgressionApplicationsResponseV1,
  ProgressionApplicationCommandResponseV1,
  ProgressionApplicationProposalResponseV1,
} from "@vostivo/contracts";
import { DATABASE } from "../database/database.module.js";
import type { AuthenticatedActor } from "../auth/authenticated-actor.js";

/**
 * Progression Application V1 — Slice D (task §52) — keeps the controller
 * thin: authenticated actor in, domain result out, no duplicated mode
 * policy or Apply/Keep-Original logic here. Current canonical mode
 * authority is re-derived FRESH on every mode-gated call (task §2/§25 —
 * never trusted from the client, never cached from a prior request).
 */
@Injectable()
export class ProgressionReviewService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  private async resolveCurrentAuthority(userId: string): Promise<"SYSTEM_AUTO_APPLY" | "ATHLETE_REVIEW"> {
    const [athleteRow] = await this.db.select({ experienceMode: athleteProfiles.experienceMode }).from(athleteProfiles).where(eq(athleteProfiles.userId, userId)).limit(1);
    // No athlete profile at all -> nothing to review, treat as the
    // conservative default (ATHLETE_REVIEW never auto-mutates anything).
    if (athleteRow === undefined) return "ATHLETE_REVIEW";
    return resolveProgressionAuthority({ experienceMode: athleteRow.experienceMode });
  }

  /**
   * Task §28: the underlying `listPendingProgressionApplications` primitive
   * is mode-agnostic (it may include a GUIDED application left
   * `PENDING_REVIEW` by a failed system apply — real domain state), but
   * this PUBLIC athlete-facing endpoint only ever exposes actionable
   * review items when current authority is `ATHLETE_REVIEW`. A GUIDED
   * athlete's own list is always empty here — no "why is this pending"
   * configuration-fix UI exists yet (task §28's own explicit deferral).
   */
  async getPending(actor: AuthenticatedActor): Promise<PendingProgressionApplicationsResponseV1> {
    const authority = await this.resolveCurrentAuthority(actor.userId);
    if (authority !== "ATHLETE_REVIEW") {
      return { applications: [] };
    }

    const items = await listPendingProgressionApplications(this.db, { userId: actor.userId });
    return {
      applications: items.map((item) => ({
        applicationId: item.applicationId,
        exerciseRef: item.exerciseRef,
        exerciseDisplayName: item.exerciseDisplayName,
        currentEffectiveLoad: item.expectedEffectiveLoad,
        proposalAvailable: item.proposal.status === "AVAILABLE",
        resolverProposedLoad: item.proposal.status === "AVAILABLE" ? item.proposal.resolverProposedLoad : null,
        proposalUnavailableReason: item.proposal.status === "UNAVAILABLE" ? item.proposal.reason : null,
      })),
    };
  }

  /** GET proposal is never mode-gated (task §24 only gates the two POST actions) — an ADAPTIVE/EXPERT/GUIDED athlete may always preview. */
  async getProposal(actor: AuthenticatedActor, applicationId: string): Promise<ProgressionApplicationProposalResponseV1> {
    const outcome = await resolveApplicationProposal(this.db, { userId: actor.userId }, applicationId);
    if (outcome.status === "NOT_FOUND") {
      throw new NotFoundException("Progression application not found");
    }
    if (outcome.status === "UNAVAILABLE") {
      return { status: "UNAVAILABLE", reason: outcome.reason };
    }
    return {
      status: "AVAILABLE",
      applicationId: outcome.applicationId,
      exerciseDisplayName: outcome.exerciseDisplayName,
      currentEffectiveLoad: outcome.currentEffectiveLoad,
      loadingCapabilityId: outcome.loadingCapabilityId,
      loadingCapabilityRevision: outcome.loadingCapabilityRevision,
      resolverProposedLoad: outcome.resolverProposedLoad,
    };
  }

  /** Task §24/§26 — the exact Slice-C human Apply path; current mode must be ATHLETE_REVIEW or this is rejected before ever touching the application (never a stale, client-supplied mode). */
  async apply(actor: AuthenticatedActor, applicationId: string, request: ApplyProgressionApplicationRequestV1): Promise<ProgressionApplicationCommandResponseV1> {
    const authority = await this.resolveCurrentAuthority(actor.userId);
    if (authority !== "ATHLETE_REVIEW") {
      throw new ConflictException("MODE_ACTION_NOT_ALLOWED");
    }

    const outcome = await applyProgression(this.db, { userId: actor.userId }, {
      applicationId,
      commandId: request.commandId,
      expectedProposal: {
        expectedCurrentEffectiveLoad: request.expectedCurrentEffectiveLoad,
        expectedLoadingCapabilityId: request.expectedLoadingCapabilityId,
        expectedLoadingCapabilityRevision: request.expectedLoadingCapabilityRevision,
        expectedResolverProposedLoad: request.expectedResolverProposedLoad,
      },
    });

    if (outcome.status === "NOT_FOUND") throw new NotFoundException("Progression application not found");
    if (outcome.status === "COMMAND_CONFLICT") throw new ConflictException("COMMAND_CONFLICT");
    if (outcome.status === "APPLIED") return { status: "APPLIED" };
    return { status: "NOT_APPLIED", reason: outcome.reason };
  }

  /** Task §24/§27 — existing Slice-B `KEEP_ORIGINAL` mechanics, unchanged; same mode gate as Apply. */
  async keepOriginal(actor: AuthenticatedActor, applicationId: string, request: KeepOriginalProgressionApplicationRequestV1): Promise<ProgressionApplicationCommandResponseV1> {
    const authority = await this.resolveCurrentAuthority(actor.userId);
    if (authority !== "ATHLETE_REVIEW") {
      throw new ConflictException("MODE_ACTION_NOT_ALLOWED");
    }

    const outcome = await keepOriginal(this.db, { userId: actor.userId }, { applicationId, commandId: request.commandId });

    if (outcome.status === "NOT_FOUND") throw new NotFoundException("Progression application not found");
    if (outcome.status === "COMMAND_CONFLICT") throw new ConflictException("COMMAND_CONFLICT");
    if (outcome.status === "KEPT_ORIGINAL") return { status: "KEPT_ORIGINAL" };
    return { status: "NOT_APPLIED", reason: outcome.reason };
  }
}
