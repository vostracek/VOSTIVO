import { Inject, Injectable } from "@nestjs/common";
import type { PgBoss } from "pg-boss";
import type { Database } from "@vostivo/database";
import type {
  SyncWorkoutCommandsResponse,
  WorkoutCommandAcknowledgementV1,
} from "@vostivo/contracts";
import { DATABASE } from "../database/database.module.js";
import { PGBOSS_PRODUCER } from "../queue/pgboss-producer.module.js";
import type { SyncWorkoutCommandsRequestDto } from "./dto/workout-command.dto.js";
import { toWorkoutCommandV1 } from "./workout-command-mapping.js";
import { processWorkoutCommand } from "./workout-command-processing.js";

@Injectable()
export class WorkoutSyncService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(PGBOSS_PRODUCER) private readonly boss: PgBoss,
  ) {}

  async syncCommands(
    userId: string,
    request: SyncWorkoutCommandsRequestDto,
  ): Promise<SyncWorkoutCommandsResponse> {
    const acknowledgements: WorkoutCommandAcknowledgementV1[] = [];

    // Sequential, not Promise.all: commands within one batch may depend on
    // each other (e.g. COMPLETE_SET_V1 referencing a session just created
    // by an earlier START_WORKOUT_SESSION_V1 in the same batch).
    for (const commandDto of request.commands) {
      const command = toWorkoutCommandV1(commandDto);
      if (command === null) {
        acknowledgements.push({
          commandId: commandDto.commandId,
          outcome: "REJECTED",
          reason: "malformed command",
        });
        continue;
      }

      acknowledgements.push(await processWorkoutCommand(this.db, this.boss, userId, command));
    }

    return { acknowledgements };
  }
}
