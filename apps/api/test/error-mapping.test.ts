import assert from "node:assert/strict";
import { describe, it } from "@jest/globals";
import { HttpStatus } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { redact } from "../src/common/logging/redact";
import { mapDatabaseError } from "../src/common/errors/map-database-error";
import { clientErrorBody } from "../src/common/errors/to-client-error";
import { ErrorCode } from "../src/common/errors/error-codes";
import { AppException } from "../src/common/errors/app.exception";

describe("database error mapping", () => {
  it("maps a unique violation to CONFLICT and hides the driver message", () => {
    const error = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed on the fields: (`phone`)",
      { code: "P2002", clientVersion: "test", meta: { target: ["phone"] } },
    );
    const mapped = mapDatabaseError(error);
    assert.ok(mapped);
    assert.equal(mapped.code, ErrorCode.CONFLICT);
    assert.equal(mapped.clientMessage.includes("phone"), false);
    assert.equal(mapped.clientMessage.includes("Unique constraint"), false);
  });

  it("maps an idempotency unique violation separately", () => {
    const error = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
      meta: { target: ["tenantId", "key"], modelName: "IdempotencyKey" },
    });
    const mapped = mapDatabaseError(error);
    assert.equal(mapped?.code, ErrorCode.IDEMPOTENCY_CONFLICT);
  });

  it("maps foreign key, check, and deadlock states", () => {
    const foreignKey = known("P2003", "23503");
    const check = known("P2010", "23514");
    const deadlock = known("P2010", "40P01");
    assert.equal(mapDatabaseError(foreignKey)?.code, ErrorCode.INVALID_BUSINESS_OPERATION);
    assert.equal(mapDatabaseError(check)?.code, ErrorCode.INVALID_BUSINESS_OPERATION);
    assert.equal(mapDatabaseError(deadlock)?.getStatus(), HttpStatus.SERVICE_UNAVAILABLE);
  });

  it("builds the error envelope with the request id", () => {
    const body = clientErrorBody(
      new AppException(ErrorCode.NOT_FOUND, "Missing product.", HttpStatus.NOT_FOUND),
      "request-99",
    );
    assert.equal(body.status, 404);
    assert.deepEqual(body.body, {
      success: false,
      error: {
        code: "NOT_FOUND",
        message: "Missing product.",
        requestId: "request-99",
      },
    });
  });

  it("redacts database urls and secret assignments", () => {
    const cleaned = redact(
      "connect postgresql://dukaan_app:dukaan_app_dev_only@localhost/dukaanos password=secret",
    );
    assert.equal(cleaned.includes("dukaan_app_dev_only"), false);
    assert.equal(cleaned.includes("secret"), false);
  });
});

function known(code: string, sqlState: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("database said something sensitive", {
    code,
    clientVersion: "test",
    meta: { code: sqlState, message: "SQLSTATE detail with a token=abc" },
  });
}
