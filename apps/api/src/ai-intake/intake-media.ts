import { randomUUID } from "node:crypto";
import { HttpStatus } from "@nestjs/common";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";
import { ObjectHead } from "./object-storage";

const ALLOWED: Record<string, readonly string[]> = {
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
};

export const PENDING_MEDIA = "pending";
const HEADER_BYTES = 32;

export function assertUpload(
  fileName: string,
  contentType: string,
  size: number,
  maxBytes: number,
): { contentType: string; extension: string } {
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
    throw new AppException(ErrorCode.VALIDATION_ERROR, "Use a JPEG, PNG, or WEBP image.", HttpStatus.BAD_REQUEST);
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
  if (!Number.isInteger(size) || size < 1) {
    throw new AppException(ErrorCode.VALIDATION_ERROR, "Enter an image size.", HttpStatus.BAD_REQUEST);
  }
  if (size > maxBytes) {
    throw new AppException(ErrorCode.VALIDATION_ERROR, "Image must be 10 MB or smaller.", HttpStatus.BAD_REQUEST);
  }
  return { contentType: type, extension };
}

/** Server-generated key. The client file name is not part of the path. */
export function intakeObjectKey(tenantId: string, sessionId: string, extension: string): string {
  return `tenants/${tenantId}/ai-intake/${sessionId}/${randomUUID()}${extension}`;
}

export function objectKeyPrefix(tenantId: string, intakeId: string): string {
  return `tenants/${tenantId}/ai-intake/${intakeId}/`;
}

export function assertTenantObjectKey(tenantId: string, intakeId: string, objectKey: string): void {
  const prefix = objectKeyPrefix(tenantId, intakeId);
  const rest = objectKey.slice(prefix.length);
  if (!objectKey.startsWith(prefix) || rest.length === 0 || rest.includes("/") || rest.includes("..")) {
    throw new AppException(
      ErrorCode.AI_INTAKE_MEDIA_INVALID,
      "This image cannot be processed.",
      HttpStatus.BAD_REQUEST,
    );
  }
}

export function matchesImageSignature(bytes: Buffer, contentType: string): boolean {
  if (contentType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (contentType === "image/png") {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (contentType === "image/webp") {
    return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  }
  return false;
}

export function imageSignatureSample(contentType: string, size: number): Buffer {
  const bytes = Buffer.alloc(Math.max(size, HEADER_BYTES), 0);
  if (contentType === "image/png") {
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  } else if (contentType === "image/webp") {
    bytes.write("RIFF", 0, "ascii");
    bytes.write("WEBP", 8, "ascii");
  } else {
    bytes[0] = 0xff;
    bytes[1] = 0xd8;
    bytes[2] = 0xff;
  }
  return bytes.subarray(0, size);
}

export function assertStoredObject(input: {
  tenantId: string;
  intakeId: string;
  objectKey: string;
  declaredType: string;
  declaredSize: number;
  head: ObjectHead | null;
  header: Buffer | null;
  maxBytes: number;
}): void {
  assertTenantObjectKey(input.tenantId, input.intakeId, input.objectKey);
  if (!input.head || !input.header) {
    throw new AppException(
      ErrorCode.AI_INTAKE_UPLOAD_NOT_VERIFIED,
      "Upload the image before processing.",
      HttpStatus.CONFLICT,
    );
  }
  const type = input.declaredType.trim().toLowerCase();
  if (input.head.contentType !== type || !ALLOWED[type]) {
    throw new AppException(
      ErrorCode.AI_INTAKE_MEDIA_INVALID,
      "This image cannot be processed.",
      HttpStatus.BAD_REQUEST,
    );
  }
  if (input.head.size !== input.declaredSize || input.head.size > input.maxBytes || input.head.size < 1) {
    throw new AppException(
      ErrorCode.AI_INTAKE_MEDIA_INVALID,
      "This image cannot be processed.",
      HttpStatus.BAD_REQUEST,
    );
  }
  if (!matchesImageSignature(input.header, type)) {
    throw new AppException(
      ErrorCode.AI_INTAKE_MEDIA_INVALID,
      "This image cannot be processed.",
      HttpStatus.BAD_REQUEST,
    );
  }
}
