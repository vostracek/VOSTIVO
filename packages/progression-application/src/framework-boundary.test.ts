import { describe, expect, it } from "vitest";
import type { Database } from "@vostivo/database";
import { ProgressionEvaluationService } from "./progression-evaluation.service.js";
import { WorkoutHistoryService } from "./workout-history.service.js";

/**
 * Orchestration V1 framework-boundary cleanup — proves this package is
 * genuinely framework-agnostic server application logic, not merely "Nest
 * decorators that happen to also work when constructed manually."
 */
describe("progression-application is framework-agnostic", () => {
  it("constructs WorkoutHistoryService with a plain object — no Nest container, no DI resolution", () => {
    const fakeDb = {} as Database;
    const service = new WorkoutHistoryService(fakeDb);
    expect(service).toBeInstanceOf(WorkoutHistoryService);
  });

  it("constructs ProgressionEvaluationService with plain objects — no Nest container, no DI resolution", () => {
    const fakeDb = {} as Database;
    const historyService = new WorkoutHistoryService(fakeDb);
    const service = new ProgressionEvaluationService(fakeDb, historyService);
    expect(service).toBeInstanceOf(ProgressionEvaluationService);
  });

  it("never installs the reflect-metadata polyfill — nothing in this package requires Reflect.getMetadata to exist", () => {
    // This vitest process only ever imports this package's own source (and
    // its @vostivo/database/@vostivo/domain/@vostivo/training-engine
    // dependencies, none of which touch Nest either) — if anything here
    // still needed Nest decorator metadata, `reflect-metadata` would have
    // had to be imported somewhere in this module graph to make
    // `Reflect.getMetadata` callable at all, and it would show up here.
    expect((Reflect as unknown as { getMetadata?: unknown }).getMetadata).toBeUndefined();
  });
});
