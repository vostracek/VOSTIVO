CREATE INDEX "performed_exercises_exercise_ref_idx" ON "app"."performed_exercises" USING btree ("exercise_ref");--> statement-breakpoint
CREATE INDEX "performed_sets_performed_exercise_id_idx" ON "app"."performed_sets" USING btree ("performed_exercise_id");--> statement-breakpoint
CREATE INDEX "workout_sessions_user_id_idx" ON "app"."workout_sessions" USING btree ("user_id");