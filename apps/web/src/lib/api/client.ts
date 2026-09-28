import { asRecord, asText, type Json } from "../json";
import { useSession } from "../../stores/session";

const TIMEOUT_MS = 20_000;

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | null;
  readonly offline: boolean;

  constructor(message: string, code: string, status: number, requestId: string | null, offline: boolean) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.offline = offline;
  }

  shopText(): string {
    if (this.offline) {
      return "You're offline.\nPlease check your internet connection.";
    }
    if (this.requestId) {
      return `${this.message}\nRequest ID: ${this.requestId}`;
    }
    return this.message;
  }
}

export interface RequestOptions {
  method?: string;
  body?: Json;
  idempotencyKey?: string;
  auth?: boolean;
}

export function apiBase(): string {
  const configured = import.meta.env.VITE_API_BASE_URL?.trim();
  return (configured && configured.length > 0 ? configured : "http://localhost:3000").replace(/\/$/, "");
}

export async function request(path: string, options: RequestOptions = {}): Promise<Record<string, Json>> {
  const session = useSession.getState();
  const headers = new Headers();
  headers.set("accept", "application/json");
  headers.set("x-request-id", crypto.randomUUID());
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (options.auth !== false && session.token) {
    headers.set("authorization", `Bearer ${session.token}`);
  }
  if (options.auth !== false && session.shop?.shopContext) {
    headers.set("x-dukaan-shop", session.shop.shopContext);
  }
  if (options.idempotencyKey) {
    headers.set("idempotency-key", options.idempotencyKey);
  }

  let response: Response;
  try {
    response = await fetch(`${apiBase()}${path}`, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    throw new ApiError(
      offline ? "You're offline." : "The shop could not be reached. Please try again.",
      offline ? "OFFLINE" : "NETWORK",
      0,
      null,
      offline,
    );
  }

  const parsed = await readJson(response);
  if (!response.ok) {
    const error = asRecord(asRecord(parsed)?.error);
    const message = asText(error?.message) || "Something went wrong.";
    const requestId = asText(error?.requestId) || null;
    if (response.status === 401) {
      useSession.getState().clear();
    }
    throw new ApiError(message, asText(error?.code) || "UNKNOWN", response.status, requestId, false);
  }
  return asRecord(parsed) ?? {};
}

export function putBytes(
  url: string,
  headers: Record<string, string>,
  file: Blob,
  onProgress?: (ratio: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [name, value] of Object.entries(headers)) {
      xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(event.loaded / event.total);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      reject(new ApiError("The image could not be uploaded.", "UPLOAD_FAILED", xhr.status, null, false));
    };
    xhr.onerror = () => {
      reject(new ApiError("You're offline.", "OFFLINE", 0, null, true));
    };
    xhr.send(file);
  });
}

async function readJson(response: Response): Promise<Json | null> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as Json;
  } catch {
    return null;
  }
}
