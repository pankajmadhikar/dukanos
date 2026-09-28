import { z } from "zod";

const nodeEnvironments = ["development", "test", "production"] as const;
const appEnvironments = ["development", "test", "staging", "production"] as const;
const logLevels = ["fatal", "error", "warn", "info", "debug", "trace"] as const;

export type NodeEnvironment = (typeof nodeEnvironments)[number];
export type AppEnvironment = (typeof appEnvironments)[number];
export type LogLevel = (typeof logLevels)[number];

export type OtpProviderName = "console" | "capture" | "unconfigured";
export type AiProviderName = "mock" | "openai";
export type StorageProviderName = "mock" | "s3";

export interface AiConfig {
  provider: AiProviderName;
  model: string;
  apiKey: string;
  baseUrl: string;
}

export interface StorageConfig {
  provider: StorageProviderName;
  bucket: string;
  region: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface AppConfig {
  nodeEnv: NodeEnvironment;
  appEnv: AppEnvironment;
  port: number;
  jsonBodyLimit: string;
  dbPoolSize: number;
  rateLimitStore: "memory";
  databaseUrl: string;
  apiPrefix: string;
  logLevel: LogLevel;
  corsOrigins: readonly string[];
  databaseAppRole: string;
  swaggerEnabled: boolean;
  sessionTtlDays: number;
  sessionSecret: string;
  otpPepper: string;
  otpTtlSeconds: number;
  otpMaxAttempts: number;
  otpProvider: OtpProviderName;
  otpRequestLimit: number;
  otpRequestWindowSeconds: number;
  otpIpLimit: number;
  ai: AiConfig;
  storage: StorageConfig;
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(nodeEnvironments, {
    error: "NODE_ENV must be development, test, or production.",
  }),
  APP_ENV: z.enum(appEnvironments).optional(),
  RATE_LIMIT_STORE: z.string().optional(),
  JSON_BODY_LIMIT: z.string().optional(),
  DB_POOL_SIZE: z.string().regex(/^\d+$/).optional(),
  PORT: z.string().regex(/^\d+$/, "PORT must be an integer.").optional(),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required."),
  API_PREFIX: z
    .string()
    .regex(
      /^[a-z0-9]+(?:\/[a-z0-9]+)*$/,
      "API_PREFIX must be a lowercase path segment.",
    )
    .optional(),
  LOG_LEVEL: z.enum(logLevels).optional(),
  CORS_ORIGINS: z.string().optional(),
  DATABASE_APP_ROLE: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/, "DATABASE_APP_ROLE is invalid.")
    .optional(),
  SESSION_SECRET: z.string().min(16),
  OTP_PEPPER: z.string().min(16),
  SESSION_TTL_DAYS: z.string().regex(/^\d+$/).optional(),
  OTP_TTL_SECONDS: z.string().regex(/^\d+$/).optional(),
  OTP_MAX_ATTEMPTS: z.string().regex(/^\d+$/).optional(),
  OTP_PROVIDER: z.string().optional(),
  OTP_REQUEST_LIMIT: z.string().regex(/^\d+$/).optional(),
  OTP_REQUEST_WINDOW_SECONDS: z.string().regex(/^\d+$/).optional(),
  OTP_IP_LIMIT: z.string().regex(/^\d+$/).optional(),
});

const DEVELOPMENT_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:3000",
] as const;

/**
 * Validates process environment. Failure messages never include the URL or password.
 */
export function loadAppConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => safeEnvMessage(issue)).join(" ");
    throw new Error(`Invalid environment. ${fields}`);
  }

  const nodeEnv = parsed.data.NODE_ENV;
  const appEnv = resolveAppEnv(nodeEnv, parsed.data.APP_ENV);
  const databaseAppRole = parsed.data.DATABASE_APP_ROLE ?? "dukaan_app";
  const port = parsed.data.PORT ? Number(parsed.data.PORT) : 3000;
  if (port < 1 || port > 65535) {
    throw new Error("PORT must be between 1 and 65535.");
  }

  assertDatabaseUrl(parsed.data.DATABASE_URL, databaseAppRole, appEnv);
  if (parsed.data.SESSION_SECRET === parsed.data.OTP_PEPPER) {
    throw new Error("SESSION_SECRET and OTP_PEPPER must be different.");
  }

  const corsOrigins = parseCorsOrigins(appEnv, parsed.data.CORS_ORIGINS);
  const rateLimitStore = resolveRateLimitStore(appEnv, parsed.data.RATE_LIMIT_STORE);
  const otpProvider = resolveOtpProvider(nodeEnv, parsed.data.OTP_PROVIDER);
  const ai = resolveAi(nodeEnv, env);
  const storage = resolveStorage(nodeEnv, env);

  return {
    nodeEnv,
    appEnv,
    port,
    jsonBodyLimit: resolveJsonBodyLimit(parsed.data.JSON_BODY_LIMIT),
    dbPoolSize: boundedInt(parsed.data.DB_POOL_SIZE, appEnv === "production" || appEnv === "staging" ? 10 : 5, 1, 20, "DB_POOL_SIZE"),
    rateLimitStore,
    databaseUrl: parsed.data.DATABASE_URL,
    apiPrefix: parsed.data.API_PREFIX ?? "api",
    logLevel: parsed.data.LOG_LEVEL ?? "info",
    corsOrigins,
    databaseAppRole,
    swaggerEnabled: appEnv !== "production" && appEnv !== "staging",
    sessionTtlDays: boundedInt(parsed.data.SESSION_TTL_DAYS, 30, 1, 365, "SESSION_TTL_DAYS"),
    sessionSecret: parsed.data.SESSION_SECRET,
    otpPepper: parsed.data.OTP_PEPPER,
    otpTtlSeconds: boundedInt(parsed.data.OTP_TTL_SECONDS, 300, 30, 3600, "OTP_TTL_SECONDS"),
    otpMaxAttempts: boundedInt(parsed.data.OTP_MAX_ATTEMPTS, 5, 1, 10, "OTP_MAX_ATTEMPTS"),
    otpProvider,
    otpRequestLimit: boundedInt(parsed.data.OTP_REQUEST_LIMIT, 5, 1, 100, "OTP_REQUEST_LIMIT"),
    otpRequestWindowSeconds: boundedInt(
      parsed.data.OTP_REQUEST_WINDOW_SECONDS,
      600,
      30,
      86400,
      "OTP_REQUEST_WINDOW_SECONDS",
    ),
    otpIpLimit: boundedInt(parsed.data.OTP_IP_LIMIT, 30, 1, 1000, "OTP_IP_LIMIT"),
    ai,
    storage,
  };
}

function safeEnvMessage(issue: { path: PropertyKey[]; message: string }): string {
  const path = issue.path.join(".");
  if (path === "DATABASE_URL") {
    return "DATABASE_URL is required.";
  }
  if (path === "NODE_ENV") {
    return "NODE_ENV must be development, test, or production.";
  }
  if (path === "PORT") {
    return "PORT must be an integer.";
  }
  if (path === "SESSION_SECRET" || path === "OTP_PEPPER") {
    return `${path} is required and must be at least 16 characters.`;
  }
  return issue.message;
}

function boundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (value < min || value > max) {
    throw new Error(`${name} is out of range.`);
  }
  return value;
}

function resolveAi(nodeEnv: NodeEnvironment, env: NodeJS.ProcessEnv): AiConfig {
  const mock = { provider: "mock" as const, model: "", apiKey: "", baseUrl: "" };
  if (nodeEnv === "test") {
    return mock;
  }
  const raw = (env.AI_PROVIDER ?? "").trim().toLowerCase();
  if (nodeEnv === "production") {
    if (raw !== "openai") {
      throw new Error("AI_PROVIDER must be openai in production.");
    }
  } else if (raw.length === 0 || raw === "mock") {
    return mock;
  }
  if (raw !== "openai") {
    throw new Error("AI_PROVIDER is invalid.");
  }
  const apiKey = env.AI_API_KEY?.trim() ?? "";
  const model = env.AI_VISION_MODEL?.trim() ?? "";
  const baseUrl = env.AI_API_BASE_URL?.trim() ?? "";
  if (apiKey.length < 8 || model.length === 0 || baseUrl.length === 0) {
    throw new Error("AI_API_KEY, AI_VISION_MODEL, and AI_API_BASE_URL are required when AI_PROVIDER is openai.");
  }
  return { provider: "openai", model, apiKey, baseUrl };
}

function resolveStorage(nodeEnv: NodeEnvironment, env: NodeJS.ProcessEnv): StorageConfig {
  const mock = {
    provider: "mock" as const,
    bucket: "",
    region: "",
    endpoint: "",
    accessKeyId: "",
    secretAccessKey: "",
  };
  if (nodeEnv === "test") {
    return mock;
  }
  const raw = (env.OBJECT_STORAGE_PROVIDER ?? "").trim().toLowerCase();
  if (nodeEnv === "production") {
    if (raw !== "s3") {
      throw new Error("OBJECT_STORAGE_PROVIDER must be s3 in production.");
    }
  } else if (raw.length === 0 || raw === "mock") {
    return mock;
  }
  if (raw !== "s3") {
    throw new Error("OBJECT_STORAGE_PROVIDER is invalid.");
  }
  const bucket = env.OBJECT_STORAGE_BUCKET?.trim() ?? "";
  const region = env.OBJECT_STORAGE_REGION?.trim() ?? "";
  const endpoint = env.OBJECT_STORAGE_ENDPOINT?.trim() ?? "";
  const accessKeyId = env.OBJECT_STORAGE_ACCESS_KEY?.trim() ?? "";
  const secretAccessKey = env.OBJECT_STORAGE_SECRET_KEY?.trim() ?? "";
  if (bucket.length === 0 || region.length === 0 || accessKeyId.length < 8 || secretAccessKey.length < 8) {
    throw new Error(
      "OBJECT_STORAGE_BUCKET, OBJECT_STORAGE_REGION, OBJECT_STORAGE_ACCESS_KEY, and OBJECT_STORAGE_SECRET_KEY are required.",
    );
  }
  return { provider: "s3", bucket, region, endpoint, accessKeyId, secretAccessKey };
}

function resolveOtpProvider(
  nodeEnv: NodeEnvironment,
  raw: string | undefined,
): OtpProviderName {
  if (nodeEnv === "test") {
    return "capture";
  }
  if (nodeEnv === "production") {
    if (raw === "console" || raw === "capture") {
      throw new Error("OTP_PROVIDER cannot expose verification codes in production.");
    }
    return "unconfigured";
  }
  if (raw === undefined || raw === "console") {
    return "console";
  }
  if (raw === "capture") {
    return "capture";
  }
  throw new Error("OTP_PROVIDER is invalid.");
}

function resolveAppEnv(nodeEnv: NodeEnvironment, raw: AppEnvironment | undefined): AppEnvironment {
  const appEnv = raw ?? (nodeEnv === "production" ? "production" : nodeEnv);
  if (appEnv === "staging" || appEnv === "production") {
    if (nodeEnv !== "production") {
      throw new Error("NODE_ENV must be production when APP_ENV is staging or production.");
    }
  } else if (appEnv !== nodeEnv) {
    throw new Error("APP_ENV must match NODE_ENV outside staging.");
  }
  return appEnv;
}

function resolveRateLimitStore(appEnv: AppEnvironment, raw: string | undefined): "memory" {
  const value = (raw ?? "").trim().toLowerCase();
  if (appEnv === "production" || appEnv === "staging") {
    if (value !== "memory") {
      throw new Error(
        "RATE_LIMIT_STORE=memory is required. Limits are process-local, so production runs one API process.",
      );
    }
    return "memory";
  }
  if (value.length === 0 || value === "memory") {
    return "memory";
  }
  throw new Error("RATE_LIMIT_STORE is invalid.");
}

function resolveJsonBodyLimit(raw: string | undefined): string {
  if (raw === undefined || raw.trim().length === 0) {
    return "256kb";
  }
  if (!/^\d+kb$/.test(raw.trim())) {
    throw new Error("JSON_BODY_LIMIT must look like 256kb.");
  }
  const kb = Number(raw.trim().replace("kb", ""));
  if (kb < 32 || kb > 1024) {
    throw new Error("JSON_BODY_LIMIT is out of range.");
  }
  return `${kb}kb`;
}

function assertDatabaseUrl(databaseUrl: string, expectedRole: string, appEnv: AppEnvironment): void {
  const username = databaseUser(databaseUrl);
  const host = databaseHost(databaseUrl);
  if (
    (appEnv === "production" || appEnv === "staging") &&
    (host === "localhost" || host === "127.0.0.1" || host === "::1")
  ) {
    throw new Error("DATABASE_URL must not point at localhost in staging or production.");
  }
  if (username.length === 0) {
    throw new Error("DATABASE_URL must include the application database user.");
  }
  if (username !== expectedRole) {
    throw new Error(
      `DATABASE_URL user is ${username}. The API must connect as ${expectedRole}.`,
    );
  }
}

function databaseHost(databaseUrl: string): string {
  return databaseUrlParts(databaseUrl).hostname;
}

function databaseUser(databaseUrl: string): string {
  return decodeURIComponent(databaseUrlParts(databaseUrl).username);
}

function databaseUrlParts(databaseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch (error) {
    throw new Error("DATABASE_URL must be a postgresql connection string.", {
      cause: error,
    });
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("DATABASE_URL must be a postgresql connection string.");
  }
  return url;
}

function parseCorsOrigins(appEnv: AppEnvironment, raw: string | undefined): readonly string[] {
  if (raw?.includes("*")) {
    throw new Error(
      "CORS_ORIGINS must list explicit origins. Refusing wildcard.",
    );
  }

  const origins = (raw ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (origins.length === 0) {
    if (appEnv === "production" || appEnv === "staging") {
      throw new Error("CORS_ORIGINS is required in staging and production.");
    }
    return DEVELOPMENT_ORIGINS;
  }

  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`CORS origin is invalid: ${origin}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`CORS origin is invalid: ${origin}`);
    }
    if ((appEnv === "production" || appEnv === "staging") && url.protocol !== "https:") {
      throw new Error("CORS origins must use https in staging and production.");
    }
  }

  return origins;
}
