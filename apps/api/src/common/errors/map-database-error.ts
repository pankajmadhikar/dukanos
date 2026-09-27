import { HttpStatus } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AppException } from "./app.exception";
import { ErrorCode } from "./error-codes";

/**
 * Maps Prisma and PostgreSQL failures onto application errors.
 * The original database message is used only to classify the failure.
 * It is never copied into the client payload.
 */
export function mapDatabaseError(error: unknown): AppException | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return mapKnownRequest(error);
  }
  if (error instanceof Prisma.PrismaClientInitializationError) {
    return new AppException(
      ErrorCode.DATABASE_ERROR,
      "Database is unavailable.",
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
  if (
    error instanceof Prisma.PrismaClientUnknownRequestError ||
    error instanceof Prisma.PrismaClientRustPanicError ||
    error instanceof Prisma.PrismaClientValidationError
  ) {
    return new AppException(
      ErrorCode.DATABASE_ERROR,
      "Database request failed.",
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
  return null;
}

function mapKnownRequest(
  error: Prisma.PrismaClientKnownRequestError,
): AppException {
  const sqlState = readSqlState(error.meta);
  const hint = constraintHint(error);

  if (error.code === "P2002" || sqlState === "23505") {
    if (hint.includes("idempotency")) {
      return new AppException(
        ErrorCode.IDEMPOTENCY_CONFLICT,
        "This request was already processed.",
        HttpStatus.CONFLICT,
      );
    }
    return new AppException(
      ErrorCode.CONFLICT,
      "A record with these values already exists.",
      HttpStatus.CONFLICT,
    );
  }

  if (error.code === "P2003" || sqlState === "23503") {
    return new AppException(
      ErrorCode.INVALID_BUSINESS_OPERATION,
      "The referenced record does not exist in this shop.",
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  if (error.code === "P2025") {
    return new AppException(
      ErrorCode.NOT_FOUND,
      "The requested record was not found.",
      HttpStatus.NOT_FOUND,
    );
  }

  if (sqlState === "23514") {
    return new AppException(
      ErrorCode.INVALID_BUSINESS_OPERATION,
      "The operation breaks a business rule.",
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  if (sqlState === "40001" || sqlState === "40P01") {
    return new AppException(
      ErrorCode.DATABASE_ERROR,
      "The operation could not be completed. Retry.",
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  return new AppException(
    ErrorCode.DATABASE_ERROR,
    "Database request failed.",
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}

function readSqlState(meta: unknown): string | null {
  if (!meta || typeof meta !== "object" || !("code" in meta)) {
    return null;
  }
  const code = (meta as { code?: unknown }).code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

function constraintHint(error: Prisma.PrismaClientKnownRequestError): string {
  const parts: string[] = [error.message];
  const meta = error.meta;
  if (meta && typeof meta === "object") {
    for (const value of Object.values(meta)) {
      if (typeof value === "string") {
        parts.push(value);
      } else if (Array.isArray(value)) {
        parts.push(value.filter((item) => typeof item === "string").join(" "));
      }
    }
  }
  return parts.join(" ").toLowerCase();
}
