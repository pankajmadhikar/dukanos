import { Injectable } from "@nestjs/common";
import { AppConfigService } from "../common/config/app-config.service";

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

export interface PresignedDownload {
  url: string;
  expiresAt: string;
}

export interface ObjectHead {
  contentType: string;
  size: number;
}

export interface StoredObject {
  contentType: string;
  bytes: Buffer;
}

/**
 * Private object storage. Clients receive only short-lived URLs.
 * Credentials never appear in the URL response or in the database.
 */
export interface ObjectStorage {
  createUploadUrl(input: UploadRequest): Promise<PresignedUpload>;
  headObject(objectKey: string): Promise<ObjectHead | null>;
  readHeader(objectKey: string, maxBytes: number): Promise<Buffer | null>;
  createDownloadUrl(input: { objectKey: string; expiresInSeconds: number }): Promise<PresignedDownload>;
  deleteObject(objectKey: string): Promise<void>;
  exists(objectKey: string): Promise<boolean>;
}

export const OBJECT_STORAGE = Symbol("OBJECT_STORAGE");

/**
 * In-memory stand-in. A URL is not proof of upload: `exists` stays false
 * until `put` stores the bytes.
 */
@Injectable()
export class MockObjectStorage implements ObjectStorage {
  private readonly objects = new Map<string, { contentType: string; bytes: Buffer }>();

  constructor(private readonly config: AppConfigService) {}

  async createUploadUrl(input: UploadRequest): Promise<PresignedUpload> {
    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000);
    const key = encodeURIComponent(input.objectKey);
    return {
      url: `http://127.0.0.1:${this.config.port}/${this.config.apiPrefix}/v1/dev/mock-storage/${key}`,
      method: "PUT",
      headers: { "content-type": input.contentType },
      expiresAt: expiresAt.toISOString(),
    };
  }

  async put(objectKey: string, object: StoredObject): Promise<void> {
    this.objects.set(objectKey, { contentType: object.contentType, bytes: Buffer.from(object.bytes) });
  }

  async headObject(objectKey: string): Promise<ObjectHead | null> {
    const object = this.objects.get(objectKey);
    if (!object) {
      return null;
    }
    return { contentType: object.contentType, size: object.bytes.length };
  }

  async readHeader(objectKey: string, maxBytes: number): Promise<Buffer | null> {
    const object = this.objects.get(objectKey);
    if (!object) {
      return null;
    }
    return object.bytes.subarray(0, maxBytes);
  }

  async createDownloadUrl(input: { objectKey: string; expiresInSeconds: number }): Promise<PresignedDownload> {
    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000);
    return {
      url: `http://127.0.0.1/mock-storage/download/${encodeURIComponent(input.objectKey)}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async deleteObject(objectKey: string): Promise<void> {
    this.objects.delete(objectKey);
  }

  async exists(objectKey: string): Promise<boolean> {
    return this.objects.has(objectKey);
  }
}
