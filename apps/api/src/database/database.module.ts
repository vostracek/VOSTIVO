import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createDatabaseClient, type Database } from "@vostivo/database";
import type { ApiConfig } from "../common/config/api-config.js";

export const DATABASE = Symbol("DATABASE");

/**
 * Global so any feature module can inject `DATABASE` without re-declaring
 * this wiring. Reads the already-validated config via `ConfigService`
 * rather than calling `loadApiConfig()` again — config is loaded and
 * validated exactly once, in `AppModule`.
 */
@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      useFactory: (configService: ConfigService<ApiConfig, true>): Database =>
        createDatabaseClient(configService.get("DATABASE_URL", { infer: true })),
      inject: [ConfigService],
    },
  ],
  exports: [DATABASE],
})
export class DatabaseModule {}
