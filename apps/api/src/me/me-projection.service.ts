import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { athleteProfiles, users, type Database } from "@vostivo/database";
import { normalizeTrainingTimeZone } from "@vostivo/domain";
import type { MeResponse } from "@vostivo/contracts";
import { DATABASE } from "../database/database.module.js";
import type { AuthenticatedActor } from "../auth/authenticated-actor.js";

/**
 * Builds the explicit `/me` DTO fresh from the database at request time —
 * `AuthenticatedActor` intentionally carries only `userId`/
 * `athleteProfileId` (spec section 18), not the full profile, so this is
 * a small dedicated read, not a reuse of guard-time data.
 */
@Injectable()
export class MeProjectionService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async getSafeProjection(actor: AuthenticatedActor): Promise<MeResponse> {
    const [row] = await this.db
      .select({
        userId: users.id,
        status: users.status,
        athleteProfileId: athleteProfiles.id,
        experienceMode: athleteProfiles.experienceMode,
        unitSystem: athleteProfiles.unitSystem,
        trainingTimeZone: athleteProfiles.trainingTimeZone,
      })
      .from(users)
      .innerJoin(athleteProfiles, eq(athleteProfiles.userId, users.id))
      .where(eq(users.id, actor.userId))
      .limit(1);

    if (row === undefined) {
      throw new Error("Authenticated actor has no resolvable identity projection");
    }

    return row;
  }

  /**
   * Explicitly sets the athlete's IANA training time zone (Missed Workout /
   * Schedule Adaptation V1 Slice B). Only ever changes on an explicit
   * request — nothing sets or overwrites it automatically. The stored value
   * is the canonical IANA id.
   */
  async setTrainingTimeZone(actor: AuthenticatedActor, value: string): Promise<MeResponse> {
    if (actor.athleteProfileId === undefined) throw new NotFoundException("Athlete profile not found");
    const trainingTimeZone = normalizeTrainingTimeZone(value);
    if (trainingTimeZone === null) throw new BadRequestException("INVALID_TRAINING_TIME_ZONE");
    await this.db
      .update(athleteProfiles)
      .set({ trainingTimeZone, updatedAt: new Date() })
      .where(and(eq(athleteProfiles.id, actor.athleteProfileId), eq(athleteProfiles.userId, actor.userId)));
    return this.getSafeProjection(actor);
  }
}
