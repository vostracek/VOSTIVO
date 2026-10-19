-- Auth & Local Athlete Boundary V1 Slice A — owner-scoped workout command idempotency.
-- The receipt identity becomes (user_id, command_id) instead of a global command_id.
-- user_id has been NOT NULL and set to the authenticated actor since the table was created
-- (0002), so every existing row is already in its submitter's namespace: no row is
-- reassigned, backfilled, deleted or rewritten. The old key was globally unique on
-- command_id, which implies uniqueness of (user_id, command_id), so this cannot fail on
-- existing data. Nothing references this primary key.
ALTER TABLE "app"."workout_command_receipts" DROP CONSTRAINT "workout_command_receipts_pkey";--> statement-breakpoint
ALTER TABLE "app"."workout_command_receipts" ADD CONSTRAINT "workout_command_receipts_pkey" PRIMARY KEY("user_id","command_id");
