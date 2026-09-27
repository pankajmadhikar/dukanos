import { Injectable } from "@nestjs/common";

export interface UploadRequest {
  objectKey: string;
  contentType: string;
  size: number;
  expiresInSeconds: number;
}

export interface PresignedUpload {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string;
}

/**
 * Object storage port. Implementations must not put credentials in the URL
 * response or in the database. A production adapter checks that the object
 * exists after the client uploads it. The mock records the issued key so
 * tests can process without a network PUT.
 */
export interface ObjectStorage {
  createUploadUrl(input: UploadRequest): Promise<PresignedUpload>;
  exists(objectKey: string): Promise<boolean>;
}

export const OBJECT_STORAGE = Symbol("OBJECT_STORAGE");

@Injectable()
export class MockObjectStorage implements ObjectStorage {
  private readonly objects = new Map<string, { contentType: string; size: number }>();

  async createUploadUrl(input: UploadRequest): Promise<PresignedUpload> {
    this.objects.set(input.objectKey, {
      contentType: input.contentType,
      size: input.size,
    });
    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000);
    return {
      url: `http://127.0.0.1/mock-storage/${encodeURIComponent(input.objectKey)}`,
      method: "PUT",
      headers: { "content-type": input.contentType },
      expiresAt: expiresAt.toISOString(),
    };
  }

  async exists(objectKey: string): Promise<boolean> {
    return this.objects.has(objectKey);
  }
}
