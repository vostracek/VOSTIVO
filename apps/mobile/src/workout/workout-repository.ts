import { sql } from "drizzle-orm";
import type { ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite";
import {
  createEntityId,
  validateAvailableTimeApplication,
  validateExternalWeightLoad,
  type AvailableTimeApplicationV1,
  type ExerciseIdentityV1,
  type ExternalWeightLoad,
  type SetType,
  type WorkoutPrescriptionV1,
} from "@vostivo/domain";
import type { WorkoutCommandV1 } from "@vostivo/contracts";
import * as schema from "../local-database/schema";
import { isRowPresent } from "../local-database/row-presence";
import type {
  ActivePerformedExercise,
  ActivePerformedSet,
  ActiveWorkoutSession,
  RestTimerStateV1,
  SetDraftV1,
} from "./active-workout-session";
import type { OutboxCommandRecord, OutboxPort } from "./outbox-port";
import { normalizeStoredPrescription } from "./prescription-compat";

type Db = ExpoSQLiteDatabase<typeof schema>;

/**
 * How the repository reaches its local database. Always injected: in the
 * app it is the ONE athlete database of the runtime that owns this
 * repository (Auth & Local Athlete Boundary V1 Slice B) — the repository
 * itself never chooses a database and never filters by user.
 */
export type LocalDatabaseProvider = () => Promise<Db>;

export interface CompleteSetInput {
  readonly workoutSessionId: string;
  /** Omit to create a new performed exercise; pass back a prior result's id to add another set to the same exercise. */
  readonly performedExerciseId?: string;
  /**
   * Omit for a genuinely new set. Pass an existing `PerformedSet.id` to
   * recomplete a previously reopened set (Active Workout Core Logger V1,
   * section 35: "reopened -> edited -> completed again") — this updates
   * that same row in place with a monotonically incremented revision,
   * rather than inserting a second row for the same planned set (which
   * would leave the original REOPENED row as the one future reads find).
   */
  readonly performedSetId?: string;
  readonly prescriptionExerciseId: string | null;
  /**
   * Snapshotted onto the local performed-exercise row and synchronized to
   * canonical server workout reality — see `ExerciseIdentityV1`.
   * `null` is accepted here (mirroring `PrescribedExerciseV1.exerciseRef`,
   * which is not resolved for every planned exercise), but `completeSet()`
   * rejects it before any write: `CompleteSetCommandV1.exerciseRef` is
   * required server-side (Exercise Ref Legacy Reconciliation) — canonical
   * history must never carry a permanent "unknown exercise" identity.
   */
  readonly exerciseRef: ExerciseIdentityV1 | null;
  readonly exerciseDisplayName: string;
  readonly exerciseOrder: number;
  readonly prescriptionSetId: string | null;
  readonly setOrder: number;
  readonly actualReps: number;
  readonly actualLoad: ExternalWeightLoad;
  /**
   * Required, always explicit (Progression Prerequisites V1,
   * docs/domain/PROGRESSION-ENGINE-V1.md §5) — never inferred, never a
   * nullable default. Today's Active Workout screen has no warm-up
   * control, so every real call site passes the prescription's own
   * (always-`WORKING`-today) `setType` — see `app/active-workout.tsx`.
   */
  readonly setType: SetType;
}

export interface CompleteSetResult {
  readonly performedExerciseId: string;
  readonly performedSetId: string;
  readonly revision: number;
}

export interface ReopenSetResult {
  readonly performedSetId: string;
  readonly revision: number;
}

export interface FinishWorkoutSessionResult {
  readonly workoutSessionId: string;
  readonly completedAt: string;
}

/**
 * The local terminal invariant (Active Workout Finish Causal Boundary
 * Fix, spec section 5): once a `WorkoutSession` is `COMPLETED`, the
 * ordinary Active Workout application boundary refuses to create a new
 * set mutation for it — no performed-reality write, no sessionSeq
 * allocation, no outbox command. This is checked and enforced inside the
 * same transaction as the would-be mutation itself (not left to the UI
 * being unmounted), so `completeSet()`/`reopenSet()` return a typed
 * outcome instead of assuming success.
 */
export type CompleteSetOutcome =
  | { readonly status: "COMPLETED"; readonly result: CompleteSetResult }
  | { readonly status: "SESSION_ALREADY_COMPLETED" };

export type ReopenSetOutcome =
  | { readonly status: "REOPENED"; readonly result: ReopenSetResult }
  | { readonly status: "SESSION_ALREADY_COMPLETED" };

export type FinishWorkoutSessionOutcome =
  | { readonly status: "FINISHED"; readonly result: FinishWorkoutSessionResult }
  | { readonly status: "ALREADY_FINISHED" };

export interface SetDraftInput {
  readonly workoutSessionId: string;
  readonly prescriptionExerciseId: string;
  readonly prescriptionSetId: string;
  readonly draftReps: number | null;
  readonly draftLoad: ExternalWeightLoad | null;
}

export interface PreviousSetPerformance {
  readonly order: number;
  readonly actualReps: number;
  readonly actualLoad: ExternalWeightLoad;
}

export type StartWorkoutSessionOutcome =
  | { readonly status: "STARTED"; readonly session: ActiveWorkoutSession }
  | { readonly status: "ALREADY_ACTIVE"; readonly session: ActiveWorkoutSession };

interface SessionRow {
  id: string;
  prescription_json: string;
  available_time_application_json: string | null;
  started_at: string;
}
interface ExerciseRow {
  id: string;
  prescription_exercise_id: string | null;
  display_name: string;
  order_index: number;
}
interface SetDraftRow {
  prescription_exercise_id: string;
  prescription_set_id: string;
  draft_reps: number | null;
  draft_load_amount_milli: number | null;
  draft_load_unit: string | null;
  draft_load_basis: string | null;
}
interface RestTimerRow {
  started_at: string;
  duration_seconds: number;
}
interface SetRow {
  id: string;
  prescription_set_id: string | null;
  order_index: number;
  actual_reps: number;
  load_kind: string;
  load_amount_milli: number;
  load_unit: string;
  load_basis: string;
  set_type: string;
  completion_state: string;
  completed_at: string | null;
  revision: number;
}

/**
 * Local persistence for the Workout Data Integrity vertical slice.
 * Every method that changes durable state does so via a single SQLite
 * transaction covering both the workout-reality write and its outbox
 * command (spec sections 14-15) — network sync happens strictly after,
 * never as part of, this write (spec section 1). Also implements
 * `OutboxPort` so `SyncEngine` never imports SQLite directly (spec
 * section 30).
 */
export class WorkoutRepository implements OutboxPort {
  /**
   * `openDatabase` is the owner runtime's database (the encrypted
   * expo-sqlite file of one athlete) in the app, and a real (non-native)
   * SQLite engine in tests — the exact same SQL/transaction code either way.
   */
  constructor(private readonly openDatabase: LocalDatabaseProvider) {}

  /**
   * `availableTimeApplication` (Available-Time Adaptation V1 Slice C) is
   * passed only for an adjusted start, in which case `prescription` is
   * already the adjusted snapshot. Session row, immutable snapshot,
   * application metadata and START outbox command are ONE transaction —
   * there is never a session without its START command, nor metadata
   * without its session. An ordinary start writes exactly what it always
   * did (NULL metadata, unchanged START payload).
   */
  async startWorkoutSession(
    prescription: WorkoutPrescriptionV1,
    availableTimeApplication: AvailableTimeApplicationV1 | null = null,
  ): Promise<StartWorkoutSessionOutcome> {
    const db = await this.openDatabase();

    // Single-device duplicate-start guard (spec section 36). Multi-device
    // active-session conflict resolution is deliberately deferred — see
    // docs/architecture/WORKOUT-DATA-INTEGRITY.md.
    const existing = readActiveSession(db);
    if (existing !== undefined) {
      return { status: "ALREADY_ACTIVE", session: existing };
    }

    const workoutSessionId = createEntityId<"WorkoutSession">();
    const nowIso = new Date().toISOString();
    const command: WorkoutCommandV1 = {
      commandId: createEntityId(),
      type: "START_WORKOUT_SESSION_V1",
      schemaVersion: 1,
      createdAt: nowIso,
      workoutSessionId,
      prescription,
      startedAt: nowIso,
      ...(availableTimeApplication === null ? {} : { availableTimeApplication }),
    };
    const applicationJson = availableTimeApplication === null ? null : JSON.stringify(availableTimeApplication);

    db.transaction((tx) => {
      tx.run(
        sql`INSERT INTO local_workout_sessions (id, prescription_json, available_time_application_json, started_at, status, created_at, updated_at)
            VALUES (${workoutSessionId}, ${JSON.stringify(prescription)}, ${applicationJson}, ${nowIso}, 'ACTIVE', ${nowIso}, ${nowIso})`,
      );
      insertOutboxCommand(tx, command, nowIso);
    });

    const session = readActiveSession(db);
    if (session === undefined) throw new Error("Failed to read back the just-started session");
    return { status: "STARTED", session };
  }

  async getActiveWorkoutSession(): Promise<ActiveWorkoutSession | undefined> {
    const db = await this.openDatabase();
    return readActiveSession(db);
  }

  async completeSet(input: CompleteSetInput): Promise<CompleteSetOutcome> {
    const loadValidation = validateExternalWeightLoad(input.actualLoad);
    if (!loadValidation.ok) {
      throw new Error(`Invalid load: ${loadValidation.error.reason}`);
    }
    const load = loadValidation.value;

    // Exercise Ref Legacy Reconciliation: canonical server workout reality
    // must never persist a null exerciseRef, so a set cannot be completed
    // for an exercise whose planned identity is unresolved — same "fail
    // loudly, never write partial reality" precedent as the load-validation
    // guard above, not a new outcome variant.
    const exerciseRef = input.exerciseRef;
    if (exerciseRef === null) {
      throw new Error("Cannot complete a set for an exercise with no resolved exerciseRef");
    }

    const db = await this.openDatabase();
    const performedExerciseId = input.performedExerciseId ?? createEntityId<"PerformedExercise">();
    const nowIso = new Date().toISOString();

    let outcome: CompleteSetOutcome | undefined;

    db.transaction((tx) => {
      // Local terminal invariant (spec section 5): checked and enforced
      // atomically, inside this same transaction — never left to the UI
      // being unmounted. Once COMPLETED, the ordinary Active Workout
      // boundary allocates no sessionSeq, writes no performed reality,
      // and enqueues no outbox command.
      const sessionRow = tx.get<{ status: string; last_issued_session_seq: number }>(
        sql`SELECT status, last_issued_session_seq FROM local_workout_sessions WHERE id = ${input.workoutSessionId}`,
      );
      if (!isRowPresent(sessionRow) || sessionRow.status !== "ACTIVE") {
        outcome = { status: "SESSION_ALREADY_COMPLETED" };
        return;
      }

      const sessionSeq = sessionRow.last_issued_session_seq + 1;
      tx.run(
        sql`UPDATE local_workout_sessions SET last_issued_session_seq = ${sessionSeq}, updated_at = ${nowIso} WHERE id = ${input.workoutSessionId}`,
      );

      // Recompleting an existing (typically just-reopened) set updates
      // that same row with a monotonically incremented revision (spec
      // section 35) — never a second row for the same planned set, which
      // would leave the original row as the one future reads find (spec
      // section 17's out-of-order convergence guarantee, applied locally
      // too).
      let performedSetId: string;
      let revision: number;
      if (input.performedSetId !== undefined) {
        const current = tx.get<{ revision: number }>(
          sql`SELECT revision FROM local_performed_sets WHERE id = ${input.performedSetId}`,
        );
        if (!isRowPresent(current)) {
          throw new Error(`No local performed set found for id ${input.performedSetId}`);
        }
        performedSetId = input.performedSetId;
        revision = current.revision + 1;
      } else {
        performedSetId = createEntityId<"PerformedSet">();
        revision = 1; // first completion of a newly-created set
      }

      const command: WorkoutCommandV1 = {
        commandId: createEntityId(),
        type: "COMPLETE_SET_V1",
        schemaVersion: 1,
        createdAt: nowIso,
        workoutSessionId: input.workoutSessionId,
        performedExerciseId,
        prescriptionExerciseId: input.prescriptionExerciseId,
        exerciseRef,
        exerciseDisplayName: input.exerciseDisplayName,
        exerciseOrder: input.exerciseOrder,
        performedSetId,
        prescriptionSetId: input.prescriptionSetId,
        setOrder: input.setOrder,
        actualReps: input.actualReps,
        actualLoad: load,
        setType: input.setType,
        revision,
        completedAt: nowIso,
        sessionSeq,
      };

      if (input.performedExerciseId === undefined) {
        tx.run(
          sql`INSERT INTO local_performed_exercises (id, workout_session_id, prescription_exercise_id, exercise_ref, display_name, order_index, created_at, updated_at)
              VALUES (${performedExerciseId}, ${input.workoutSessionId}, ${input.prescriptionExerciseId}, ${exerciseRef}, ${input.exerciseDisplayName}, ${input.exerciseOrder}, ${nowIso}, ${nowIso})`,
        );
      }

      if (input.performedSetId !== undefined) {
        tx.run(
          sql`UPDATE local_performed_sets
              SET actual_reps = ${input.actualReps}, load_kind = ${load.kind}, load_amount_milli = ${load.amountMilli},
                  load_unit = ${load.unit}, load_basis = ${load.basis}, set_type = ${input.setType}, completion_state = 'COMPLETED',
                  completed_at = ${nowIso}, revision = ${revision}, updated_at = ${nowIso}
              WHERE id = ${performedSetId}`,
        );
      } else {
        tx.run(
          sql`INSERT INTO local_performed_sets
                (id, performed_exercise_id, prescription_set_id, order_index, actual_reps, load_kind, load_amount_milli, load_unit, load_basis, set_type, completion_state, completed_at, revision, created_at, updated_at)
              VALUES
                (${performedSetId}, ${performedExerciseId}, ${input.prescriptionSetId}, ${input.setOrder}, ${input.actualReps}, ${load.kind}, ${load.amountMilli}, ${load.unit}, ${load.basis}, ${input.setType}, 'COMPLETED', ${nowIso}, ${revision}, ${nowIso}, ${nowIso})`,
        );
      }

      // A completed set's draft input is now superseded by canonical
      // reality (spec section 12/33) — clear it in the same transaction
      // as the completion write.
      if (input.prescriptionExerciseId !== null && input.prescriptionSetId !== null) {
        tx.run(
          sql`DELETE FROM local_set_drafts
              WHERE workout_session_id = ${input.workoutSessionId}
                AND prescription_exercise_id = ${input.prescriptionExerciseId}
                AND prescription_set_id = ${input.prescriptionSetId}`,
        );
      }

      insertOutboxCommand(tx, command, nowIso);

      outcome = { status: "COMPLETED", result: { performedExerciseId, performedSetId, revision } };
    });

    if (outcome === undefined) throw new Error("completeSet transaction did not produce an outcome");
    return outcome;
  }

  async reopenSet(performedSetId: string): Promise<ReopenSetOutcome> {
    const db = await this.openDatabase();
    const nowIso = new Date().toISOString();

    let outcome: ReopenSetOutcome | undefined;

    db.transaction((tx) => {
      const owner = tx.get<{ session_id: string; status: string; last_issued_session_seq: number; revision: number }>(
        sql`SELECT ws.id as session_id, ws.status as status, ws.last_issued_session_seq as last_issued_session_seq, ps.revision as revision
            FROM local_performed_sets ps
            JOIN local_performed_exercises pe ON pe.id = ps.performed_exercise_id
            JOIN local_workout_sessions ws ON ws.id = pe.workout_session_id
            WHERE ps.id = ${performedSetId}`,
      );
      if (!isRowPresent(owner)) {
        throw new Error(`No local performed set found for id ${performedSetId}`);
      }

      // Local terminal invariant (spec section 5) — see completeSet() for
      // the full reasoning.
      if (owner.status !== "ACTIVE") {
        outcome = { status: "SESSION_ALREADY_COMPLETED" };
        return;
      }

      const sessionSeq = owner.last_issued_session_seq + 1;
      tx.run(
        sql`UPDATE local_workout_sessions SET last_issued_session_seq = ${sessionSeq}, updated_at = ${nowIso} WHERE id = ${owner.session_id}`,
      );

      const revision = owner.revision + 1;
      const command: WorkoutCommandV1 = {
        commandId: createEntityId(),
        type: "REOPEN_SET_V1",
        schemaVersion: 1,
        createdAt: nowIso,
        performedSetId,
        revision,
        sessionSeq,
      };

      tx.run(
        sql`UPDATE local_performed_sets
            SET completion_state = 'REOPENED', completed_at = NULL, revision = ${revision}, updated_at = ${nowIso}
            WHERE id = ${performedSetId}`,
      );
      insertOutboxCommand(tx, command, nowIso);

      outcome = { status: "REOPENED", result: { performedSetId, revision } };
    });

    if (outcome === undefined) throw new Error("reopenSet transaction did not produce an outcome");
    return outcome;
  }

  /**
   * The minimum required extension to represent workout completion (spec
   * section 25/26) — local-first, same one-transaction shape as every
   * other WDI mutation. Allowed with incomplete planned sets (spec section
   * 27); never deletes/rewrites performed reality (spec section 29).
   * Reusing `readActiveSession`'s `WHERE status = 'ACTIVE'` filter is what
   * makes a finished session stop being "active" (spec section 29) — no
   * separate filtering logic is needed.
   */
  async finishWorkoutSession(workoutSessionId: string): Promise<FinishWorkoutSessionOutcome> {
    const db = await this.openDatabase();
    const nowIso = new Date().toISOString();

    let outcome: FinishWorkoutSessionOutcome | undefined;

    db.transaction((tx) => {
      const sessionRow = tx.get<{ status: string; last_issued_session_seq: number }>(
        sql`SELECT status, last_issued_session_seq FROM local_workout_sessions WHERE id = ${workoutSessionId}`,
      );
      if (!isRowPresent(sessionRow) || sessionRow.status !== "ACTIVE") {
        outcome = { status: "ALREADY_FINISHED" };
        return;
      }

      // The Finish causal boundary/watermark (Active Workout Finish
      // Causal Boundary Fix): the highest sessionSeq validly issued
      // before this transition — captured atomically, in the same
      // transaction, before the ACTIVE -> COMPLETED write below, so it
      // can never exclude a sessionSeq that a concurrently-committing
      // completeSet()/reopenSet() transaction already allocated (see
      // docs/architecture/ACTIVE-WORKOUT.md's concurrency reasoning).
      const finishSeq = sessionRow.last_issued_session_seq;
      const command: WorkoutCommandV1 = {
        commandId: createEntityId(),
        type: "FINISH_WORKOUT_SESSION_V1",
        schemaVersion: 1,
        createdAt: nowIso,
        workoutSessionId,
        completedAt: nowIso,
        finishSeq,
      };

      tx.run(
        sql`UPDATE local_workout_sessions
            SET status = 'COMPLETED', completed_at = ${nowIso}, finish_seq = ${finishSeq}, updated_at = ${nowIso}
            WHERE id = ${workoutSessionId}`,
      );
      insertOutboxCommand(tx, command, nowIso);

      outcome = { status: "FINISHED", result: { workoutSessionId, completedAt: nowIso } };
    });

    if (outcome === undefined) throw new Error("finishWorkoutSession transaction did not produce an outcome");
    return outcome;
  }

  /**
   * In-progress load/reps input, upserted as the athlete types (spec
   * section 33/34) — never canonical reality, never synced. Keyed by the
   * prescription's own ids, which are stable before any `PerformedSet`
   * exists.
   */
  async saveSetDraft(input: SetDraftInput): Promise<void> {
    const db = await this.openDatabase();
    const nowIso = new Date().toISOString();
    db.run(
      sql`INSERT INTO local_set_drafts
            (workout_session_id, prescription_exercise_id, prescription_set_id, draft_reps, draft_load_amount_milli, draft_load_unit, draft_load_basis, updated_at)
          VALUES
            (${input.workoutSessionId}, ${input.prescriptionExerciseId}, ${input.prescriptionSetId}, ${input.draftReps}, ${input.draftLoad?.amountMilli ?? null}, ${input.draftLoad?.unit ?? null}, ${input.draftLoad?.basis ?? null}, ${nowIso})
          ON CONFLICT (workout_session_id, prescription_exercise_id, prescription_set_id) DO UPDATE SET
            draft_reps = excluded.draft_reps,
            draft_load_amount_milli = excluded.draft_load_amount_milli,
            draft_load_unit = excluded.draft_load_unit,
            draft_load_basis = excluded.draft_load_basis,
            updated_at = excluded.updated_at`,
    );
  }

  /**
   * Starts (or restarts) the rest timer for a session — durable
   * `startedAt`/`durationSeconds`, never a ticking counter (spec section
   * 19). One row per session; a new rest simply overwrites the previous.
   */
  async startRestTimer(workoutSessionId: string, durationSeconds: number): Promise<RestTimerStateV1> {
    const db = await this.openDatabase();
    const nowIso = new Date().toISOString();
    db.run(
      sql`INSERT INTO local_rest_timer_state (workout_session_id, started_at, duration_seconds, updated_at)
          VALUES (${workoutSessionId}, ${nowIso}, ${durationSeconds}, ${nowIso})
          ON CONFLICT (workout_session_id) DO UPDATE SET
            started_at = excluded.started_at,
            duration_seconds = excluded.duration_seconds,
            updated_at = excluded.updated_at`,
    );
    return { startedAt: nowIso, durationSeconds };
  }

  /**
   * Quick +/-15s adjustment (spec section 21) — re-anchors `startedAt` to
   * now and sets `durationSeconds` to the currently-remaining time plus
   * the delta, so the *remaining* time changes by exactly `deltaSeconds`
   * regardless of how much of the rest has already elapsed. Clamped to
   * zero; never negative.
   */
  async adjustRestTimer(workoutSessionId: string, deltaSeconds: number): Promise<RestTimerStateV1 | undefined> {
    const db = await this.openDatabase();
    const current = db.get<RestTimerRow>(
      sql`SELECT started_at, duration_seconds FROM local_rest_timer_state WHERE workout_session_id = ${workoutSessionId}`,
    );
    if (!isRowPresent(current)) return undefined;

    const elapsedSeconds = Math.floor((Date.now() - new Date(current.started_at).getTime()) / 1000);
    const remainingSeconds = Math.max(0, current.duration_seconds - elapsedSeconds);
    const newDurationSeconds = Math.max(0, remainingSeconds + deltaSeconds);
    const nowIso = new Date().toISOString();

    db.run(
      sql`UPDATE local_rest_timer_state
          SET started_at = ${nowIso}, duration_seconds = ${newDurationSeconds}, updated_at = ${nowIso}
          WHERE workout_session_id = ${workoutSessionId}`,
    );
    return { startedAt: nowIso, durationSeconds: newDurationSeconds };
  }

  /**
   * Compact "Previous" context for one exercise (spec section 9) — the
   * most recent OTHER session's performed sets for the same
   * `ExerciseIdentityV1`, ordered. Returns `undefined` (never a fabricated
   * value) when no reliable prior performance exists — including when
   * `exerciseRef` itself is `null`, since matching by display name is
   * explicitly disallowed.
   */
  async getPreviousExercisePerformance(
    exerciseRef: ExerciseIdentityV1 | null,
    excludingSessionId: string,
  ): Promise<readonly PreviousSetPerformance[] | undefined> {
    if (exerciseRef === null) return undefined;

    const db = await this.openDatabase();
    const previousExercise = db.get<{ id: string }>(
      sql`SELECT id FROM local_performed_exercises
          WHERE exercise_ref = ${exerciseRef} AND workout_session_id != ${excludingSessionId}
          ORDER BY created_at DESC LIMIT 1`,
    );
    if (!isRowPresent(previousExercise)) return undefined;

    const setRows = db.all<SetRow>(
      sql`SELECT id, prescription_set_id, order_index, actual_reps, load_kind, load_amount_milli, load_unit, load_basis, completion_state, completed_at, revision
          FROM local_performed_sets WHERE performed_exercise_id = ${previousExercise.id} ORDER BY order_index ASC`,
    );
    if (setRows.length === 0) return undefined;

    return setRows.map((row) => ({
      order: row.order_index,
      actualReps: row.actual_reps,
      actualLoad: {
        kind: "EXTERNAL_WEIGHT",
        amountMilli: row.load_amount_milli,
        unit: row.load_unit as ExternalWeightLoad["unit"],
        basis: row.load_basis as ExternalWeightLoad["basis"],
      },
    }));
  }

  // --- OutboxPort ---

  async getPendingCommands(limit: number): Promise<readonly OutboxCommandRecord[]> {
    const db = await this.openDatabase();
    // 'SYNCING' is included alongside 'PENDING'/'RETRY' (Engineering
    // Quality & Security Baseline Audit, spec section 42): a row can only
    // be 'SYNCING' while a sync request is genuinely in flight in this
    // process. A process restart means that request no longer exists, so
    // any 'SYNCING' row found here is necessarily an orphan from a prior
    // process that was killed between `markSyncing()` and the matching
    // terminal status update — never a real in-flight duplicate. Excluding
    // it would silently and permanently strand that command outside the
    // retry loop, violating the locked "local + outbox must eventually be
    // atomic" guarantee (CLAUDE.md).
    const rows = db.all<{ command_id: string; payload_json: string }>(
      sql`SELECT command_id, payload_json FROM sync_outbox
          WHERE status IN ('PENDING', 'RETRY', 'SYNCING')
          ORDER BY created_at ASC
          LIMIT ${limit}`,
    );
    return rows.map((row) => ({
      commandId: row.command_id,
      payload: JSON.parse(row.payload_json) as WorkoutCommandV1,
    }));
  }

  async markSyncing(commandId: string): Promise<void> {
    await this.setOutboxStatus(commandId, "SYNCING", { incrementAttempt: true });
  }

  async markSynced(commandId: string): Promise<void> {
    await this.setOutboxStatus(commandId, "SYNCED");
  }

  async markRetry(commandId: string): Promise<void> {
    await this.setOutboxStatus(commandId, "RETRY");
  }

  async markConflict(commandId: string): Promise<void> {
    await this.setOutboxStatus(commandId, "CONFLICT");
  }

  async markRejected(commandId: string): Promise<void> {
    await this.setOutboxStatus(commandId, "REJECTED");
  }

  private async setOutboxStatus(
    commandId: string,
    status: string,
    options: { incrementAttempt?: boolean } = {},
  ): Promise<void> {
    const db = await this.openDatabase();
    const nowIso = new Date().toISOString();
    if (options.incrementAttempt === true) {
      db.run(
        sql`UPDATE sync_outbox
            SET status = ${status}, attempt_count = attempt_count + 1, last_attempt_at = ${nowIso}, updated_at = ${nowIso}
            WHERE command_id = ${commandId}`,
      );
    } else {
      db.run(
        sql`UPDATE sync_outbox SET status = ${status}, updated_at = ${nowIso} WHERE command_id = ${commandId}`,
      );
    }
  }
}

function insertOutboxCommand(tx: Db, command: WorkoutCommandV1, nowIso: string): void {
  tx.run(
    sql`INSERT INTO sync_outbox (command_id, command_type, schema_version, payload_json, status, attempt_count, created_at, updated_at)
        VALUES (${command.commandId}, ${command.type}, ${command.schemaVersion}, ${JSON.stringify(command)}, 'PENDING', 0, ${nowIso}, ${nowIso})`,
  );
}

function readActiveSession(db: Db): ActiveWorkoutSession | undefined {
  const sessionRow = db.get<SessionRow>(
    sql`SELECT id, prescription_json, available_time_application_json, started_at FROM local_workout_sessions
        WHERE status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1`,
  );
  if (!isRowPresent(sessionRow)) return undefined;

  const exerciseRows = db.all<ExerciseRow>(
    sql`SELECT id, prescription_exercise_id, display_name, order_index FROM local_performed_exercises
        WHERE workout_session_id = ${sessionRow.id} ORDER BY order_index ASC`,
  );

  const exercises: ActivePerformedExercise[] = exerciseRows.map((exerciseRow) => {
    const setRows = db.all<SetRow>(
      sql`SELECT id, prescription_set_id, order_index, actual_reps, load_kind, load_amount_milli, load_unit, load_basis, set_type, completion_state, completed_at, revision
          FROM local_performed_sets WHERE performed_exercise_id = ${exerciseRow.id} ORDER BY order_index ASC`,
    );

    const sets: ActivePerformedSet[] = setRows.map((setRow) => ({
      id: setRow.id,
      prescriptionSetId: setRow.prescription_set_id,
      order: setRow.order_index,
      actualReps: setRow.actual_reps,
      actualLoad: {
        kind: "EXTERNAL_WEIGHT",
        amountMilli: setRow.load_amount_milli,
        unit: setRow.load_unit as ExternalWeightLoad["unit"],
        basis: setRow.load_basis as ExternalWeightLoad["basis"],
      },
      setType: setRow.set_type as SetType,
      completionState: setRow.completion_state as ActivePerformedSet["completionState"],
      completedAt: setRow.completed_at,
      revision: setRow.revision,
    }));

    return {
      id: exerciseRow.id,
      prescriptionExerciseId: exerciseRow.prescription_exercise_id,
      displayName: exerciseRow.display_name,
      order: exerciseRow.order_index,
      sets,
    };
  });

  const draftRows = db.all<SetDraftRow>(
    sql`SELECT prescription_exercise_id, prescription_set_id, draft_reps, draft_load_amount_milli, draft_load_unit, draft_load_basis
        FROM local_set_drafts WHERE workout_session_id = ${sessionRow.id}`,
  );
  const drafts: SetDraftV1[] = draftRows.map((row) => ({
    prescriptionExerciseId: row.prescription_exercise_id,
    prescriptionSetId: row.prescription_set_id,
    draftReps: row.draft_reps,
    draftLoad:
      row.draft_load_amount_milli === null || row.draft_load_unit === null || row.draft_load_basis === null
        ? null
        : {
            kind: "EXTERNAL_WEIGHT",
            amountMilli: row.draft_load_amount_milli,
            unit: row.draft_load_unit as ExternalWeightLoad["unit"],
            basis: row.draft_load_basis as ExternalWeightLoad["basis"],
          },
  }));

  const restTimerRow = db.get<RestTimerRow>(
    sql`SELECT started_at, duration_seconds FROM local_rest_timer_state WHERE workout_session_id = ${sessionRow.id}`,
  );
  const restTimer: RestTimerStateV1 | null = isRowPresent(restTimerRow)
    ? { startedAt: restTimerRow.started_at, durationSeconds: restTimerRow.duration_seconds }
    : null;

  return {
    id: sessionRow.id,
    prescription: normalizeStoredPrescription(JSON.parse(sessionRow.prescription_json)),
    availableTimeApplication: parseStoredAvailableTimeApplication(sessionRow.available_time_application_json),
    startedAt: sessionRow.started_at,
    exercises,
    drafts,
    restTimer,
  };
}

/**
 * Trusted internal data (validated before it was written, in the same
 * transaction as its session) — an invalid stored value is a corruption
 * signal, never silently dropped.
 */
function parseStoredAvailableTimeApplication(json: string | null): AvailableTimeApplicationV1 | null {
  if (json === null) return null;
  const parsed = validateAvailableTimeApplication(JSON.parse(json));
  if (!parsed.ok) throw new Error(`Stored Available-Time application is corrupt: ${parsed.error}`);
  return parsed.value;
}
