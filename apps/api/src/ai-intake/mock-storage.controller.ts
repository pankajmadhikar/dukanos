import { Controller, HttpStatus, Param, Put, Req } from "@nestjs/common";
import { Request } from "express";
import { AppConfigService } from "../common/config/app-config.service";
import { Public } from "../common/decorators/public.decorator";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";
import { intakeSettings } from "./intake-settings";
import { MockObjectStorage } from "./object-storage";

/**
 * Development stand-in for a presigned object-storage PUT.
 * Production storage is S3, and this route answers 404 when that is active.
 * The browser still uploads bytes to the URL from upload-url. It never receives storage keys.
 */
@Controller({ path: "dev/mock-storage", version: "1" })
export class MockStorageController {
  constructor(
    private readonly config: AppConfigService,
    private readonly storage: MockObjectStorage,
  ) {}

  @Put(":objectKey")
  @Public()
  async put(@Param("objectKey") objectKey: string, @Req() request: Request) {
    if (this.config.storage.provider !== "mock") {
      throw new AppException(ErrorCode.NOT_FOUND, "Not found.", HttpStatus.NOT_FOUND);
    }
    const key = decodeURIComponent(objectKey);
    if (!key.startsWith("tenants/") || key.includes("..")) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, "Upload path is invalid.", HttpStatus.BAD_REQUEST);
    }
    const bytes = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const limit = intakeSettings().maxBytes;
    if (bytes.length === 0 || bytes.length > limit) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        "Upload is empty or too large.",
        HttpStatus.BAD_REQUEST,
      );
    }
    const contentType = request.header("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
    await this.storage.put(key, { contentType, bytes });
    return { data: { stored: true } };
  }
}
