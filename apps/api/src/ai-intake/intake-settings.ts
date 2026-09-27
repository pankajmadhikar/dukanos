/**
 * Intake limits live here so services do not each pick a different number.
 * Environment values override the defaults. Invalid values fall back.
 * These are read on each call so a test can tighten a limit without restarting.
 */
export interface IntakeSettings {
  confidenceThreshold: number;
  maxBytes: number;
  providerTimeoutMs: number;
  maxRetries: number;
  processingTimeoutMinutes: number;
  mediaRetentionDays: number;
  maxPerMinute: number;
  maxDailyProcesses: number;
  uploadUrlTtlSeconds: number;
  downloadUrlTtlSeconds: number;
}

const DEFAULT_CONFIDENCE = 0.85;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export function intakeSettings(): IntakeSettings {
  return {
    confidenceThreshold: readUnit(
      "AI_CONFIDENCE_THRESHOLD",
      readUnit("AI_INTAKE_CONFIDENCE_THRESHOLD", DEFAULT_CONFIDENCE),
    ),
    maxBytes: readPositiveInt("AI_INTAKE_MAX_UPLOAD_BYTES", DEFAULT_MAX_BYTES),
    providerTimeoutMs: readPositiveInt(
      "AI_REQUEST_TIMEOUT_MS",
      readPositiveInt("AI_INTAKE_PROVIDER_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    ),
    maxRetries: readNonNegativeInt("AI_MAX_RETRIES", 2),
    processingTimeoutMinutes: readNonNegativeInt("AI_INTAKE_PROCESSING_TIMEOUT_MINUTES", 10),
    mediaRetentionDays: readNonNegativeInt("AI_INTAKE_MEDIA_RETENTION_DAYS", 30),
    maxPerMinute: readPositiveInt("AI_INTAKE_MAX_REQUESTS_PER_MINUTE", 60),
    maxDailyProcesses: readPositiveInt("AI_INTAKE_MAX_DAILY_PROCESSES", 500),
    uploadUrlTtlSeconds: 900,
    downloadUrlTtlSeconds: 120,
  };
}

export function retryDelayMs(attempt: number): number {
  if (process.env.NODE_ENV === "test") {
    return 0;
  }
  const shift = Math.max(0, attempt - 1);
  return Math.min(1000 * 2 ** shift, 30_000);
}

function readUnit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    return fallback;
  }
  return value;
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function readNonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    return fallback;
  }
  return value;
}
