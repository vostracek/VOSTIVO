import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ValidationPipe } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "@fastify/helmet";
import { createLogger } from "@vostivo/observability";
import { assertDataEnvironment } from "@vostivo/database";
import { AppModule } from "./app.module.js";
import { ErrorEnvelopeFilter } from "./common/filters/error-envelope.filter.js";
import { registerCorrelationIdHook } from "./common/correlation-id.hook.js";
import { registerRateLimit } from "./common/rate-limit.js";
import { loadApiConfig } from "./common/config/api-config.js";

async function bootstrap(): Promise<void> {
  const config = loadApiConfig();
  const logger = createLogger({ serviceName: "vostivo-api" });

  // Dogfood Environment V1 — before any module connects: the declared data
  // environment and the database's own name/marker must agree both ways.
  await assertDataEnvironment(config.VOSTIVO_DATA_ENV, config.DATABASE_URL);

  // `trustProxy` defaults to false (see api-config.ts) — `request.ip`
  // (what the rate limiter below keys on) is the direct TCP peer address
  // until a real reverse-proxy topology is chosen and this is
  // deliberately reconfigured, never a client-spoofable header.
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: config.TRUST_PROXY }),
    { bufferLogs: true },
  );

  await app.register(helmet);
  await registerRateLimit(app, config);
  registerCorrelationIdHook(app.getHttpAdapter().getInstance());

  // Health checks are an infra concern, not part of the versioned API
  // contract — kept unprefixed, along with the docs UI itself.
  app.setGlobalPrefix("api/v1", { exclude: ["health/live", "health/ready", "docs"] });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new ErrorEnvelopeFilter(logger));

  // Browsable OpenAPI UI/JSON is a development convenience, not a public
  // release surface (Engineering Quality & Security Baseline Audit, spec
  // section 12/45 config-hardening review) — it stays mounted for every
  // non-production environment (local/development/staging) and is never
  // registered at all in production, rather than merely hidden from a
  // sitemap.
  if (config.NODE_ENV !== "production") {
    const openApiConfig = new DocumentBuilder()
      .setTitle("Vostivo API")
      .setDescription("Vostivo API — identity/auth foundation (no product endpoints yet)")
      .setVersion("0.0.0")
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, openApiConfig);
    SwaggerModule.setup("docs", app, document);
  }

  await app.listen(config.PORT, config.HOST);
  logger.info("Vostivo API listening", { host: config.HOST, port: config.PORT, env: config.NODE_ENV, dataEnv: config.VOSTIVO_DATA_ENV ?? "unset" });
}

bootstrap().catch((error: unknown) => {
  console.error("Fatal error during bootstrap", error);
  process.exit(1);
});
