import { HttpException, HttpStatus } from "@nestjs/common";
import { AppException, FieldError } from "./app.exception";
import { ErrorCode } from "./error-codes";
import { mapDatabaseError } from "./map-database-error";

export interface ClientErrorBody {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    requestId: string | null;
    details?: FieldError[];
  };
}

interface ResolvedError {
  status: number;
  code: ErrorCode;
  message: string;
  details?: FieldError[];
}

export function toClientError(exception: unknown): ResolvedError {
  if (exception instanceof AppException) {
    return {
      status: exception.getStatus(),
      code: exception.code,
      message: exception.clientMessage,
      details: exception.details,
    };
  }

  const databaseError = mapDatabaseError(exception);
  if (databaseError) {
    return {
      status: databaseError.getStatus(),
      code: databaseError.code,
      message: databaseError.message,
    };
  }

  if (exception instanceof HttpException) {
    const mapped = messageForStatus(exception.getStatus());
    return { status: exception.getStatus(), ...mapped };
  }

  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    code: ErrorCode.INTERNAL_ERROR,
    message: "Internal server error.",
  };
}

export function clientErrorBody(
  exception: unknown,
  requestId: string | null,
): { status: number; body: ClientErrorBody } {
  const resolved = toClientError(exception);
  const error: ClientErrorBody["error"] = {
    code: resolved.code,
    message: resolved.message,
    requestId,
  };
  if (resolved.details && resolved.details.length > 0) {
    error.details = resolved.details;
  }
  return { status: resolved.status, body: { success: false, error } };
}

function messageForStatus(status: number): {
  code: ErrorCode;
  message: string;
} {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return {
        code: ErrorCode.VALIDATION_ERROR,
        message: "Request validation failed.",
      };
    case HttpStatus.UNAUTHORIZED:
      return {
        code: ErrorCode.AUTH_REQUIRED,
        message: "Authentication is required.",
      };
    case HttpStatus.FORBIDDEN:
      return {
        code: ErrorCode.TENANT_ACCESS_DENIED,
        message: "You do not have access to this shop.",
      };
    case HttpStatus.NOT_FOUND:
      return {
        code: ErrorCode.NOT_FOUND,
        message: "The requested resource was not found.",
      };
    case HttpStatus.CONFLICT:
      return {
        code: ErrorCode.CONFLICT,
        message: "The request conflicts with existing data.",
      };
    default:
      if (status >= 500) {
        return {
          code: ErrorCode.INTERNAL_ERROR,
          message: "Internal server error.",
        };
      }
      return {
        code: ErrorCode.VALIDATION_ERROR,
        message: "The request could not be processed.",
      };
  }
}
