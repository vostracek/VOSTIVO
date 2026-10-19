-- Auth & Local Athlete Boundary V1 Slice A closure — owner-scoped progression application
-- command idempotency. The receipt identity becomes (owner_user_id, command_id) instead of a
-- global command_id. owner_user_id is the APPLICATION's canonical owner: every existing row
-- is backfilled from its own NOT NULL application_id FK -> progression_applications.user_id
-- (proven by the FK, never inferred), then pinned by a composite FK. No row is deleted or
-- reassigned; actor columns (user_id / actor_type) are untouched. Nothing references this
-- table's primary key.
ALTER TABLE "app"."progression_applications" ADD CONSTRAINT "progression_applications_id_user_id_unique" UNIQUE("id","user_id");--> statement-breakpoint
ALTER TABLE "app"."progression_application_commands" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
UPDATE "app"."progression_application_commands" AS c SET "owner_user_id" = a."user_id" FROM "app"."progression_applications" AS a WHERE a."id" = c."application_id";--> statement-breakpoint
ALTER TABLE "app"."progression_application_commands" ALTER COLUMN "owner_user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."progression_application_commands" DROP CONSTRAINT "progression_application_commands_pkey";--> statement-breakpoint
ALTER TABLE "app"."progression_application_commands" ADD CONSTRAINT "progression_application_commands_pkey" PRIMARY KEY("owner_user_id","command_id");--> statement-breakpoint
ALTER TABLE "app"."progression_application_commands" ADD CONSTRAINT "progression_application_commands_application_owner_fkey" FOREIGN KEY ("application_id","owner_user_id") REFERENCES "app"."progression_applications"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."progression_application_commands" ADD CONSTRAINT "progression_application_commands_athlete_actor_is_owner" CHECK ("app"."progression_application_commands"."actor_type" <> 'ATHLETE' OR "app"."progression_application_commands"."user_id" = "app"."progression_application_commands"."owner_user_id");
