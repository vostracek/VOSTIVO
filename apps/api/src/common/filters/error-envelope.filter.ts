import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Logger } from "@vostivo/observability";

/**
 * Safe error envelope (spec section 14): { code, message, requestId, details? }.
 * Production responses must never leak stack traces, DB hosts, secrets, SQL,
 * or filesystem paths — this filter is the single place that boundary is
 * enforced for every HTTP error, so individual controllers never need to
 * worry about accidentally leaking internals.
 */
interface ErrorEnvelope {
  code: string;
  message: string;
  requestId: string;
  details?: unknown;
}

@Catch()
export class ErrorEnvelopeFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();
    const requestId = request.correlationId ?? "unknown";

    const { status, envelope } = this.toEnvelope(exception, requestId);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error("Unhandled request error", {
        requestId,
        error: exception instanceof Error ? exception.message : String(exception),
      });
    }

    void response.status(status).send(envelope);
  }

  private toEnvelope(
    exception: unknown,
    requestId: string,
  ): { status: HttpStatus; envelope: ErrorEnvelope } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message =
        typeof body === "string"
          ? body
          : ((body as { message?: string | string[] }).message ?? exception.message);

      return {
        status,
        envelope: {
          code: HttpStatus[status] ?? "HTTP_ERROR",
          message: Array.isArray(message) ? message.join(", ") : message,
          requestId,
        },
      };
    }

    // Unknown/unexpected failure: never leak `exception.message` or a stack
    // trace to the client, only a generic message + the correlation id
    // needed to find the real error in server-side logs.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      envelope: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
        requestId,
      },
    };
  }
}
