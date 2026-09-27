import { HttpException, HttpStatus } from "@nestjs/common";
import { ErrorCode } from "./error-codes";

export interface FieldError {
  field: string;
  messages: string[];
}

export class AppException extends HttpException {
  readonly code: ErrorCode;
  readonly clientMessage: string;
  readonly details?: FieldError[];

  constructor(
    code: ErrorCode,
    message: string,
    status: HttpStatus,
    details?: FieldError[],
  ) {
    super({ code, message, details }, status);
    this.code = code;
    this.clientMessage = message;
    this.details = details;
  }
}
