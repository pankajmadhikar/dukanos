import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "@jest/globals";
import { IsString } from "class-validator";
import { ArgumentMetadata } from "@nestjs/common";
import { createValidationPipe } from "../src/common/pipes/create-validation-pipe";
import { AppException } from "../src/common/errors/app.exception";
import { ErrorCode } from "../src/common/errors/error-codes";

class NameDto {
  @IsString()
  name!: string;
}

const metadata: ArgumentMetadata = { type: "body", metatype: NameDto };

describe("validation pipe", () => {
  it("rejects properties that are not on the DTO", async () => {
    const pipe = createValidationPipe();
    await assert.rejects(
      () => pipe.transform({ name: "Product", hack: "something" }, metadata),
      (error: unknown) => {
        assert.ok(error instanceof AppException);
        assert.equal(error.code, ErrorCode.VALIDATION_ERROR);
        assert.equal(
          error.details?.some((detail) => detail.field === "hack"),
          true,
        );
        return true;
      },
    );
  });

  it("accepts the declared properties", async () => {
    const pipe = createValidationPipe();
    const value = (await pipe.transform({ name: "Product" }, metadata)) as NameDto;
    assert.equal(value.name, "Product");
    assert.equal(Object.hasOwn(value, "hack"), false);
  });
});
