import { describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import type { Database } from "@vostivo/database";
import { ProgressionEvaluationService, WorkoutHistoryService } from "@vostivo/progression-application";
import { DATABASE } from "../database/database.module.js";

/**
 * Orchestration V1 framework-boundary cleanup — proves apps/api's Nest DI
 * genuinely resolves the plain, undecorated `WorkoutHistoryService`/
 * `ProgressionEvaluationService` classes from `@vostivo/progression-application`
 * via the exact `useFactory` provider shape `workout.module.ts` declares
 * (isolated here from `WorkoutModule`'s full provider graph — which also
 * eagerly constructs `WorkoutSyncController`/`WorkoutSyncService`, pulling
 * in the real pg-boss producer — so this stays a fast, no-real-Postgres
 * unit test of the DI wiring shape itself, not a full app boot).
 */
describe("WorkoutModule's Nest DI wiring for the framework-agnostic progression-application services", () => {
  it("resolves WorkoutHistoryService and ProgressionEvaluationService via useFactory, wired through the real DATABASE token", async () => {
    const fakeDb = { marker: "fake-db-for-di-wiring-test" } as unknown as Database;

    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: DATABASE, useValue: fakeDb },
        {
          provide: WorkoutHistoryService,
          useFactory: (db: Database): WorkoutHistoryService => new WorkoutHistoryService(db),
          inject: [DATABASE],
        },
        {
          provide: ProgressionEvaluationService,
          useFactory: (db: Database, historyService: WorkoutHistoryService): ProgressionEvaluationService =>
            new ProgressionEvaluationService(db, historyService),
          inject: [DATABASE, WorkoutHistoryService],
        },
      ],
    }).compile();

    const historyService = moduleRef.get(WorkoutHistoryService);
    const evaluationService = moduleRef.get(ProgressionEvaluationService);

    expect(historyService).toBeInstanceOf(WorkoutHistoryService);
    expect(evaluationService).toBeInstanceOf(ProgressionEvaluationService);
    // The exact same DATABASE-token value flowed through the factory chain
    // into both services — proving real Nest DI resolution, not a
    // separately-constructed stand-in.
    expect((historyService as unknown as { db: Database }).db).toBe(fakeDb);
    expect((evaluationService as unknown as { db: Database }).db).toBe(fakeDb);
    expect((evaluationService as unknown as { workoutHistoryService: WorkoutHistoryService }).workoutHistoryService).toBe(
      historyService,
    );
  });
});
