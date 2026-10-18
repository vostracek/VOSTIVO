ALTER TABLE "app"."progression_applications" DROP CONSTRAINT "progression_applications_progression_decision_id_progression_decisions_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."progression_decisions" ADD CONSTRAINT "progression_decisions_id_user_id_unique" UNIQUE("id","user_id");--> statement-breakpoint
ALTER TABLE "app"."progression_applications" ADD CONSTRAINT "progression_applications_decision_owner_fkey" FOREIGN KEY ("progression_decision_id","user_id") REFERENCES "app"."progression_decisions"("id","user_id") ON DELETE no action ON UPDATE no action;