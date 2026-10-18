import pino, { type Logger as PinoLogger } from "pino";

/**
 * Vendor-agnostic logging boundary. Callers depend on this `Logger` type,
 * never on pino directly, so swapping/adding a sink (e.g. future Sentry)
 * later never touches domain/application code.
 */
export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

class PinoLoggerAdapter implements Logger {
  constructor(private readonly pino: PinoLogger) {}

  info(message: string, context?: Record<string, unknown>): void {
    this.pino.info(context ?? {}, message);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.pino.warn(context ?? {}, message);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.pino.error(context ?? {}, message);
  }

  child(bindings: Record<string, unknown>): Logger {
    return new PinoLoggerAdapter(this.pino.child(bindings));
  }
}

export interface CreateLoggerOptions {
  readonly serviceName: string;
  readonly level?: "debug" | "info" | "warn" | "error";
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const instance = pino({
    name: options.serviceName,
    level: options.level ?? "info",
    // Never log raw request/response bodies or secrets by default;
    // vertical slices must opt in explicitly with an allow-listed shape.
    redact: ["*.password", "*.token", "*.secret", "*.authorization"],
  });
  return new PinoLoggerAdapter(instance);
}
