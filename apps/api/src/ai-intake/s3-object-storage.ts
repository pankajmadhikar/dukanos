import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ObjectHead, ObjectStorage, PresignedDownload, PresignedUpload, UploadRequest } from "./object-storage";

export interface S3StorageOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * S3-compatible private bucket. Objects are not public.
 * This class is constructed only when object storage is configured for S3.
 */
export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;

  constructor(private readonly options: S3StorageOptions) {
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: Boolean(options.endpoint),
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  async createUploadUrl(input: UploadRequest): Promise<PresignedUpload> {
    const command = new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: input.objectKey,
      ContentType: input.contentType,
      ContentLength: input.size,
    });
    const url = await this.sign(command, input.expiresInSeconds);
    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000);
    return {
      url,
      method: "PUT",
      headers: { "content-type": input.contentType },
      expiresAt: expiresAt.toISOString(),
    };
  }

  async headObject(objectKey: string): Promise<ObjectHead | null> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: objectKey }),
      );
      const size = head.ContentLength;
      const contentType = head.ContentType?.split(";")[0]?.trim().toLowerCase();
      if (size === undefined || !contentType) {
        return null;
      }
      return { contentType, size };
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw storageFailure();
    }
  }

  async readHeader(objectKey: string, maxBytes: number): Promise<Buffer | null> {
    try {
      const object = await this.client.send(
        new GetObjectCommand({
          Bucket: this.options.bucket,
          Key: objectKey,
          Range: `bytes=0-${Math.max(0, maxBytes - 1)}`,
        }),
      );
      if (!object.Body) {
        return null;
      }
      const bytes = await object.Body.transformToByteArray();
      return Buffer.from(bytes.subarray(0, maxBytes));
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw storageFailure();
    }
  }

  async createDownloadUrl(input: { objectKey: string; expiresInSeconds: number }): Promise<PresignedDownload> {
    const command = new GetObjectCommand({ Bucket: this.options.bucket, Key: input.objectKey });
    const url = await this.sign(command, input.expiresInSeconds);
    return {
      url,
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000).toISOString(),
    };
  }

  async deleteObject(objectKey: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: objectKey }));
    } catch (error) {
      if (isMissing(error)) {
        return;
      }
      throw storageFailure();
    }
  }

  async exists(objectKey: string): Promise<boolean> {
    return (await this.headObject(objectKey)) !== null;
  }

  private async sign(command: PutObjectCommand | GetObjectCommand, expiresInSeconds: number): Promise<string> {
    try {
      return await getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
    } catch {
      throw storageFailure();
    }
  }
}

function isMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const row = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return row.name === "NotFound" || row.name === "NoSuchKey" || row.$metadata?.httpStatusCode === 404;
}

function storageFailure(): Error {
  return new Error("Object storage request failed.");
}
