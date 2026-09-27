import { HttpStatus } from "@nestjs/common";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";

const ALLOWED: Record<string, readonly string[]> = {
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
};

export const PENDING_MEDIA = "pending";

export function assertUpload(fileName: string, contentType: string, size: number, maxBytes: number): {
  contentType: string;
  extension: string;
} {
  const type = contentType.trim().toLowerCase();
  if (type.startsWith("video/")) {
    throw new AppException(
      ErrorCode.VALIDATION_ERROR,
      "Video processing is not enabled in this phase.",
      HttpStatus.BAD_REQUEST,
    );
  }
  const extensions = ALLOWED[type];
  if (!extensions) {
    throw new AppException(
      ErrorCode.VALIDATION_ERROR,
      "Use a JPEG, PNG, or WEBP image.",
      HttpStatus.BAD_REQUEST,
    );
  }
  if (fileName.includes("/") || fileName.includes("\\") || fileName.includes("\0")) {
    throw new AppException(ErrorCode.VALIDATION_ERROR, "Enter a file name.", HttpStatus.BAD_REQUEST);
  }
  const extension = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  if (!extensions.includes(extension)) {
    throw new AppException(
      ErrorCode.VALIDATION_ERROR,
      "The file extension does not match the image type.",
      HttpStatus.BAD_REQUEST,
    );
  }
  if (size > maxBytes) {
    throw new AppException(
      ErrorCode.VALIDATION_ERROR,
      "Image must be 10 MB or smaller.",
      HttpStatus.BAD_REQUEST,
    );
  }
  return { contentType: type, extension };
}

export function intakeObjectKey(tenantId: string, sessionId: string, fileName: string): string {
  const safe = fileName.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return `shops/${tenantId}/intake/${sessionId}/${safe}`;
}
