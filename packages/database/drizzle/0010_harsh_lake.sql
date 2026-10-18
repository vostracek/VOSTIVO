CREATE TYPE "app"."loading_capability_kind" AS ENUM('FIXED_INCREMENT', 'ENUMERATED_LIST');--> statement-breakpoint
CREATE TABLE "app"."exercise_loading_capability_bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_profile_id" uuid NOT NULL,
	"exercise_ref" text NOT NULL,
	"loading_capability_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."gym_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"athlete_profile_id" uuid NOT NULL,
	"name" text DEFAULT 'My Gym' NOT NULL,
	"is_default" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."loading_capabilities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gym_profile_id" uuid NOT NULL,
	"unit" "app"."planned_set_load_unit" NOT NULL,
	"basis" "app"."planned_set_load_basis" NOT NULL,
	"kind" "app"."loading_capability_kind" NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"fixed_increment_amount_milli" integer,
	"enumerated_loads_milli" integer[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loading_capabilities_gym_profile_id_id_unique" UNIQUE("gym_profile_id","id"),
	CONSTRAINT "loading_capabilities_revision_positive" CHECK ("app"."loading_capabilities"."revision" >= 1),
	CONSTRAINT "loading_capabilities_payload_matches_kind" CHECK (("app"."loading_capabilities"."kind" = 'FIXED_INCREMENT' AND "app"."loading_capabilities"."fixed_increment_amount_milli" IS NOT NULL AND "app"."loading_capabilities"."enumerated_loads_milli" IS NULL)
          OR ("app"."loading_capabilities"."kind" = 'ENUMERATED_LIST' AND "app"."loading_capabilities"."enumerated_loads_milli" IS NOT NULL AND "app"."loading_capabilities"."fixed_increment_amount_milli" IS NULL)),
	CONSTRAINT "loading_capabilities_fixed_increment_positive" CHECK ("app"."loading_capabilities"."fixed_increment_amount_milli" IS NULL OR "app"."loading_capabilities"."fixed_increment_amount_milli" > 0),
	CONSTRAINT "loading_capabilities_enumerated_loads_nonempty" CHECK ("app"."loading_capabilities"."enumerated_loads_milli" IS NULL OR array_length("app"."loading_capabilities"."enumerated_loads_milli", 1) >= 1)
);
--> statement-breakpoint
ALTER TABLE "app"."exercise_loading_capability_bindings" ADD CONSTRAINT "exercise_loading_capability_bindings_gym_profile_id_gym_profiles_id_fk" FOREIGN KEY ("gym_profile_id") REFERENCES "app"."gym_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."exercise_loading_capability_bindings" ADD CONSTRAINT "exercise_loading_capability_bindings_same_gym_fkey" FOREIGN KEY ("gym_profile_id","loading_capability_id") REFERENCES "app"."loading_capabilities"("gym_profile_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."gym_profiles" ADD CONSTRAINT "gym_profiles_athlete_profile_id_athlete_profiles_id_fk" FOREIGN KEY ("athlete_profile_id") REFERENCES "app"."athlete_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."loading_capabilities" ADD CONSTRAINT "loading_capabilities_gym_profile_id_gym_profiles_id_fk" FOREIGN KEY ("gym_profile_id") REFERENCES "app"."gym_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "exercise_loading_capability_bindings_one_per_exercise" ON "app"."exercise_loading_capability_bindings" USING btree ("gym_profile_id","exercise_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "gym_profiles_one_default_per_athlete" ON "app"."gym_profiles" USING btree ("athlete_profile_id") WHERE "app"."gym_profiles"."is_default" = true;