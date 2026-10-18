import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { HealthModule } from "./health/health.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { PgBossProducerModule } from "./queue/pgboss-producer.module.js";
import { MeModule } from "./me/me.module.js";
import { WorkoutModule } from "./workout/workout.module.js";
import { PlanModule } from "./plan/plan.module.js";
import { ProgressionModule } from "./progression/progression.module.js";
import { loadApiConfig } from "./common/config/api-config.js";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Fail fast on boot if required env vars are missing/invalid, rather
      // than starting with broken config (spec: "fail fast for required
      // server variables").
      load: [() => loadApiConfig()],
    }),
    DatabaseModule,
    PgBossProducerModule,
    HealthModule,
    MeModule,
    WorkoutModule,
    PlanModule,
    ProgressionModule,
  ],
})
export class AppModule {}
