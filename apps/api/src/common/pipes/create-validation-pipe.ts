import { HttpStatus, ValidationError, ValidationPipe } from "@nestjs/common";
import { AppException, FieldError } from "../errors/app.exception";
import { ErrorCode } from "../errors/error-codes";

/**
 * Unknown JSON properties are rejected. Input is not trusted.
 * Type conversion happens only where a DTO declares @Type().
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    exceptionFactory: (errors: ValidationError[]) =>
      new AppException(
        ErrorCode.VALIDATION_ERROR,
        "Request validation failed.",
        HttpStatus.BAD_REQUEST,
        flattenValidationErrors(errors),
      ),
  });
}

export function flattenValidationErrors(
  errors: ValidationError[],
  parent = "",
): FieldError[] {
  const details: FieldError[] = [];
  for (const error of errors) {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const messages = error.constraints ? Object.values(error.constraints) : [];
    if (messages.length > 0) {
      details.push({ field, messages });
    }
    if (error.children && error.children.length > 0) {
      details.push(...flattenValidationErrors(error.children, field));
    }
  }
  return details;
}
