import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from "@nestjs/common";
import { Response } from "express";
import { RequestWithId } from "../../context/request-context.middleware";
import { requestContextStorage } from "../../context/request-store";
import { AppLogger } from "../logging/app-logger.service";
import { redact } from "../logging/redact";
import { clientErrorBody } from "./to-client-error";

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<RequestWithId>();
    if (response.headersSent) {
      return;
    }

    const requestId =
      requestContextStorage.getStore()?.requestId ?? request.requestId ?? null;
    const { status, body } = clientErrorBody(exception, requestId);
    if (status >= 500) {
      const detail =
        exception instanceof HttpException
          ? exception.message
          : exception instanceof Error
            ? exception.message
            : "unhandled error";
      this.logger.write({
        level: "error",
        message: redact(detail),
        module: "http",
        operation: request.path,
        statusCode: status,
      });
    }

    response.status(status).json(body);
  }
}
