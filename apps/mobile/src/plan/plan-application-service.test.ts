import { describe, expect, it } from "vitest";
import type { PlanOverviewV1, WorkoutPreviewV1 } from "@vostivo/contracts";
import { PlanApplicationService, type WorkoutSessionGateway } from "./plan-application-service";
import type { PlanApiClient } from "./plan-api-client";
import type { ActiveWorkoutSession } from "../workout/active-workout-session";
import type { StartWorkoutSessionOutcome } from "../workout/workout-repository";

const EMPTY_OVERVIEW: PlanOverviewV1 = { currentBlock: null, sessions: [], weeklyFocus: [], schedule: { state: "NO_PLAN", displayedCycle: null }, athleteLocalDate: null };

function buildPreview(overrides: Partial<WorkoutPreviewV1> = {}): WorkoutPreviewV1 {
  return {
    plannedWorkoutId: "workout-1",
    name: "Upper Body A",
    focus: "Push emphasis",
    estimatedDurationMinutes: 60,
    displayStatus: "TODAY",
    hasActiveSession: false,
    canStart: true,
    exercises: [],
    prescription: { schemaVersion: 1, prescriptionId: "workout-1", name: "Upper Body A", exercises: [] },
    ...overrides,
  };
}

class FakePlanApiClient implements PlanApiClient {
  overview: PlanOverviewV1 = EMPTY_OVERVIEW;
  preview: WorkoutPreviewV1 = buildPreview();
  lastRequestedWorkoutId: string | undefined;

  getCurrentPlan(): Promise<PlanOverviewV1> {
    return Promise.resolve(this.overview);
  }

  getWorkoutPreview(plannedWorkoutId: string): Promise<WorkoutPreviewV1> {
    this.lastRequestedWorkoutId = plannedWorkoutId;
    return Promise.resolve(this.preview);
  }

  previewAvailableTime(): Promise<never> {
    return Promise.reject(new Error("not used by these tests"));
  }
}

class FakeWorkoutSessionGateway implements WorkoutSessionGateway {
  activeSession: ActiveWorkoutSession | undefined;
  startOutcome: StartWorkoutSessionOutcome;
  lastStartedPrescription: WorkoutPreviewV1["prescription"] | undefined;

  constructor(startOutcome: StartWorkoutSessionOutcome) {
    this.startOutcome = startOutcome;
  }

  getActiveWorkoutSession(): Promise<ActiveWorkoutSession | undefined> {
    return Promise.resolve(this.activeSession);
  }

  startWorkoutSession(prescription: WorkoutPreviewV1["prescription"]): Promise<StartWorkoutSessionOutcome> {
    this.lastStartedPrescription = prescription;
    return Promise.resolve(this.startOutcome);
  }
}

function buildActiveSession(overrides: Partial<ActiveWorkoutSession> = {}): ActiveWorkoutSession {
  return {
    id: "session-1",
    prescription: { schemaVersion: 1, prescriptionId: "workout-1", name: "Upper Body A", exercises: [] },
    startedAt: new Date().toISOString(),
    exercises: [],
    drafts: [],
    restTimer: null,
    availableTimeApplication: null,
    ...overrides,
  };
}

describe("PlanApplicationService", () => {
  it("PLAN-MOB-001: getCurrentPlan returns the read model from the API client, untouched", async () => {
    const overview: PlanOverviewV1 = {
      currentBlock: { trainingBlockId: "b1", name: "Block 1", goal: "Hypertrophy", currentCycleOrder: 4, cycleCount: 6, daysPerWeek: 4 },
      sessions: [],
      weeklyFocus: [], schedule: { state: "IN_CURRENT_BLOCK", displayedCycle: "CURRENT" }, athleteLocalDate: null,
    };
    const apiClient = new FakePlanApiClient();
    apiClient.overview = overview;
    const service = new PlanApplicationService(apiClient, new FakeWorkoutSessionGateway({ status: "STARTED", session: buildActiveSession() }));

    const result = await service.getCurrentPlan();

    expect(result).toBe(overview);
  });

  it("PLAN-MOB-002: getWorkoutPreview requests the exact planned workout id it was given", async () => {
    const apiClient = new FakePlanApiClient();
    const service = new PlanApplicationService(apiClient, new FakeWorkoutSessionGateway({ status: "STARTED", session: buildActiveSession() }));

    await service.getWorkoutPreview("workout-42");

    expect(apiClient.lastRequestedWorkoutId).toBe("workout-42");
  });

  it("PLAN-MOB-003: Start Workout passes the already-fetched WorkoutPrescriptionV1 straight to WDI, with no second network call or re-derivation", async () => {
    const preview = buildPreview({
      prescription: { schemaVersion: 1, prescriptionId: "workout-1", name: "Upper Body A", exercises: [{ prescriptionExerciseId: "ex-1", exerciseRef: null, displayName: "Bench Press", order: 1, sets: [] }] },
    });
    const gateway = new FakeWorkoutSessionGateway({ status: "STARTED", session: buildActiveSession() });
    const service = new PlanApplicationService(new FakePlanApiClient(), gateway);

    await service.startWorkout(preview);

    expect(gateway.lastStartedPrescription).toBe(preview.prescription);
  });

  it("PLAN-MOB-004: an existing active session is surfaced via getActiveWorkoutSession — Start delegates entirely to WDI's own duplicate guard", async () => {
    const existingSession = buildActiveSession({ id: "already-active-session" });
    const gateway = new FakeWorkoutSessionGateway({ status: "ALREADY_ACTIVE", session: existingSession });
    gateway.activeSession = existingSession;
    const service = new PlanApplicationService(new FakePlanApiClient(), gateway);

    const active = await service.getActiveWorkoutSession();
    const outcome = await service.startWorkout(buildPreview());

    expect(active).toBe(existingSession);
    expect(outcome).toEqual({ status: "ALREADY_ACTIVE", session: existingSession });
  });

  it("PLAN-MOB-005: the service holds no canonical state of its own — every call re-reads from its collaborators", async () => {
    const apiClient = new FakePlanApiClient();
    const gateway = new FakeWorkoutSessionGateway({ status: "STARTED", session: buildActiveSession() });
    const service = new PlanApplicationService(apiClient, gateway);

    apiClient.overview = { currentBlock: null, sessions: [], weeklyFocus: [], schedule: { state: "NO_PLAN", displayedCycle: null }, athleteLocalDate: null };
    expect(await service.getCurrentPlan()).toEqual({ currentBlock: null, sessions: [], weeklyFocus: [], schedule: { state: "NO_PLAN", displayedCycle: null }, athleteLocalDate: null });

    const updated: PlanOverviewV1 = {
      currentBlock: { trainingBlockId: "b1", name: "Block 1", goal: "Hypertrophy", currentCycleOrder: 1, cycleCount: 6, daysPerWeek: 4 },
      sessions: [],
      weeklyFocus: [], schedule: { state: "IN_CURRENT_BLOCK", displayedCycle: "CURRENT" }, athleteLocalDate: null,
    };
    apiClient.overview = updated;
    // No caching field on PlanApplicationService — changing the
    // collaborator's data is immediately reflected, proving there is no
    // parallel copy of Plan state living on the service itself.
    expect(await service.getCurrentPlan()).toBe(updated);
  });
});
