import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Database } from "@vostivo/database";
import { getGuidedLoadingSetupAttention, getLoadingSetupContext, saveGuidedLoadingSetup, type SaveLoadingSetupInput } from "@vostivo/progression-application";
import type { GuidedLoadingSetupAttentionResponseV1, LoadingSetupContextResponseV1, SaveLoadingSetupResultResponseV1 } from "@vostivo/contracts";
import { DATABASE } from "../database/database.module.js";
import type { AuthenticatedActor } from "../auth/authenticated-actor.js";
import type { SaveLoadingSetupRequestDto } from "./dto/save-loading-setup.dto.js";

/**
 * Narrows the validated DTO (whose `incrementAmountMilli`/`loadsMilli`
 * are structurally optional, since only one applies per `kind`) into the
 * package's own exact discriminated union — `class-validator`'s
 * `@ValidateIf` already guarantees the right field is present and
 * well-formed for whichever `kind` was sent; this is a type-level
 * narrowing step only, not a second validation pass.
 */
function toSaveLoadingSetupInput(dto: SaveLoadingSetupRequestDto): SaveLoadingSetupInput {
  if (dto.kind === "FIXED_INCREMENT") {
    if (dto.incrementAmountMilli === undefined) throw new BadRequestException("incrementAmountMilli is required for FIXED_INCREMENT");
    return { kind: "FIXED_INCREMENT", incrementAmountMilli: dto.incrementAmountMilli };
  }
  if (dto.loadsMilli === undefined) throw new BadRequestException("loadsMilli is required for ENUMERATED_LIST");
  return { kind: "ENUMERATED_LIST", loadsMilli: dto.loadsMilli };
}

/**
 * Progression Application V1 — Slice F (Guided Blocked-Capability
 * Recovery / Contextual Loading Setup V1) — keeps the controller thin,
 * mirroring `ProgressionReviewService`'s own convention exactly. Never
 * duplicates the Guided-mode/revalidation/recoverable-reason logic here —
 * that all lives in `@vostivo/progression-application`'s
 * `guided-loading-setup.ts`, callable identically from `apps/api` or
 * `apps/worker`.
 *
 * Deliberately a SEPARATE service/controller from `ProgressionReviewService`
 * (task §0's own hard product distinction: this is equipment
 * configuration, never Apply/Keep-Original review) — never merged into
 * that surface.
 */
@Injectable()
export class GuidedLoadingSetupService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async getAttention(actor: AuthenticatedActor): Promise<GuidedLoadingSetupAttentionResponseV1> {
    const item = await getGuidedLoadingSetupAttention(this.db, actor);
    return { item };
  }

  /** `NOT_RECOVERABLE` is a normal 200 OK domain outcome (task §37 — a deterministic non-actionable result, same convention as Slice E's own `GET proposal` UNAVAILABLE); only BOLA and a real mode change are HTTP errors. */
  async getContext(actor: AuthenticatedActor, applicationId: string): Promise<LoadingSetupContextResponseV1> {
    const outcome = await getLoadingSetupContext(this.db, actor, applicationId);
    if (outcome.status === "NOT_FOUND") throw new NotFoundException("Progression application not found");
    if (outcome.status === "MODE_ACTION_NOT_ALLOWED") throw new ConflictException("MODE_ACTION_NOT_ALLOWED");
    return outcome;
  }

  async save(actor: AuthenticatedActor, applicationId: string, request: SaveLoadingSetupRequestDto): Promise<SaveLoadingSetupResultResponseV1> {
    const outcome = await saveGuidedLoadingSetup(this.db, actor, applicationId, toSaveLoadingSetupInput(request));
    if (outcome.status === "NOT_FOUND") throw new NotFoundException("Progression application not found");
    if (outcome.status === "MODE_ACTION_NOT_ALLOWED") throw new ConflictException("MODE_ACTION_NOT_ALLOWED");
    return outcome;
  }
}
