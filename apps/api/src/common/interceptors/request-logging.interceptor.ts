import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Request, Response } from "express";
import { Observable, tap } from "rxjs";
import { AppLogger } from "../logging/app-logger.service";

@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  constructor(private readonly logger: AppLogger) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") {
      return next.handle();
    }
    const request = context.switchToHttp().getRequest<Request>();
    const started = process.hrtime.bigint();
    const operation = `${request.method} ${request.path}`;
    return next.handle().pipe(
      tap({
        next: () => {
          const response = context.switchToHttp().getResponse<Response>();
          this.logger.write({
            level: "info",
            message: "request completed",
            module: "http",
            operation,
            durationMs: elapsedMs(started),
            statusCode: response.statusCode,
          });
        },
        error: () => {
          this.logger.write({
            level: "warn",
            message: "request failed",
            module: "http",
            operation,
            durationMs: elapsedMs(started),
          });
        },
      }),
    );
  }
}

function elapsedMs(started: bigint): number {
  return Math.round(Number(process.hrtime.bigint() - started) / 1_000_000);
}
