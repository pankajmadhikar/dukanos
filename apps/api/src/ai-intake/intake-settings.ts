/**
 * Intake limits live here so services do not each pick a different number.
 * Environment values override the defaults. Invalid values fall back.
 */
export interface IntakeSettings {
  confidenceThreshold: number;
  maxBytes: number;
  providerTimeoutMs: number;
  uploadUrlTtlSeconds: number;
}

const DEFAULT_CONFIDENCE = 0.85;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export function intakeSettings(): IntakeSettings {
  return {
    confidenceThreshold: readUnit("AI_INTAKE_CONFIDENCE_THRESHOLD", DEFAULT_CONFIDENCE),
    maxBytes: readPositiveInt("AI_INTAKE_MAX_UPLOAD_BYTES", DEFAULT_MAX_BYTES),
    providerTimeoutMs: readPositiveInt("AI_INTAKE_PROVIDER_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    uploadUrlTtlSeconds: 900,
  };
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
