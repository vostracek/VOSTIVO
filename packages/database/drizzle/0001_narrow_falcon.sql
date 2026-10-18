CREATE SCHEMA "app";
--> statement-breakpoint
CREATE TYPE "app"."auth_provider" AS ENUM('supabase');--> statement-breakpoint
CREATE TYPE "app"."experience_mode" AS ENUM('GUIDED', 'ADAPTIVE', 'EXPERT');--> statement-breakpoint
CREATE TYPE "app"."unit_system" AS ENUM('METRIC', 'IMPERIAL');--> statement-breakpoint
CREATE TYPE "app"."user_status" AS ENUM('ACTIVE', 'DELETION_PENDING', 'SUSPENDED', 'DELETED');--> statement-breakpoint
CREATE TABLE "app"."athlete_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"experience_mode" "app"."experience_mode" NOT NULL,
	"unit_system" "app"."unit_system" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "athlete_profiles_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "app"."auth_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "app"."auth_provider" NOT NULL,
	"provider_subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "auth_identities_provider_provider_subject_unique" UNIQUE("provider","provider_subject")
);
--> statement-breakpoint
CREATE TABLE "app"."users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"status" "app"."user_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."athlete_profiles" ADD CONSTRAINT "athlete_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."auth_identities" ADD CONSTRAINT "auth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;