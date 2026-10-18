CREATE TABLE "app"."planned_workout_occurrence_claims" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"planned_workout_id" uuid NOT NULL,
	"canonical_workout_session_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."planned_workout_occurrence_claims" ADD CONSTRAINT "planned_workout_occurrence_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."planned_workout_occurrence_claims" ADD CONSTRAINT "planned_workout_occurrence_claims_canonical_workout_session_id_workout_sessions_id_fk" FOREIGN KEY ("canonical_workout_session_id") REFERENCES "app"."workout_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "planned_workout_occurrence_claims_user_planned_workout_unique" ON "app"."planned_workout_occurrence_claims" USING btree ("user_id","planned_workout_id");--> statement-breakpoint
CREATE UNIQUE INDEX "planned_workout_occurrence_claims_canonical_session_unique" ON "app"."planned_workout_occurrence_claims" USING btree ("canonical_workout_session_id");--> statement-breakpoint
-- Planned Workout Occurrence Authority V1 — MIGRATION COMPATIBILITY BACKFILL.
-- Existing planned sessions get exactly one canonical claim per
-- (user, planned workout): the earliest SERVER-persisted session
-- (`created_at`), `id` as the stable tie-breaker — mirroring the runtime
-- rule "first server-accepted START claims the occurrence". A session is a
-- planned-occurrence session only when its snapshot's `prescriptionId` is a
-- planned workout OWNED by that same user (never inferred from names or
-- order). Every other session for the same occurrence stays untouched and is
-- SECONDARY by derivation; nothing is deleted. Claim ids are UUIDv7, built
-- inline because PostgreSQL 17 has no native uuidv7(). Idempotent.
INSERT INTO "app"."planned_workout_occurrence_claims" ("id", "user_id", "planned_workout_id", "canonical_workout_session_id")
SELECT
  encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid()) PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3) FROM 1 FOR 6), 52, 1), 53, 1), 'hex')::uuid,
  first_session.user_id,
  first_session.planned_workout_id,
  first_session.session_id
FROM (
  SELECT DISTINCT ON (s.user_id, pw.id) s.user_id, pw.id AS planned_workout_id, s.id AS session_id
  FROM "app"."workout_sessions" s
  JOIN "app"."planned_workouts" pw ON pw.id::text = s.prescription_snapshot ->> 'prescriptionId'
  JOIN "app"."training_cycles" tc ON tc.id = pw.training_cycle_id
  JOIN "app"."training_blocks" tb ON tb.id = tc.training_block_id
  JOIN "app"."program_versions" pv ON pv.id = tb.program_version_id
  JOIN "app"."programs" p ON p.id = pv.program_id
  JOIN "app"."athlete_profiles" ap ON ap.id = p.athlete_profile_id AND ap.user_id = s.user_id
  ORDER BY s.user_id, pw.id, s.created_at ASC, s.id ASC
) AS first_session
ON CONFLICT DO NOTHING;
