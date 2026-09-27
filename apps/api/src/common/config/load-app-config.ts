import { z } from "zod";

const nodeEnvironments = ["development", "test", "production"] as const;
const logLevels = ["fatal", "error", "warn", "info", "debug", "trace"] as const;

export type NodeEnvironment = (typeof nodeEnvironments)[number];
export type LogLevel = (typeof logLevels)[number];

export type OtpProviderName = "console" | "capture" | "unconfigured";

export interface AppConfig {
  nodeEnv: NodeEnvironment;
  port: number;
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
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(nodeEnvironments, {
    error: "NODE_ENV must be development, test, or production.",
  }),
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
  const databaseAppRole = parsed.data.DATABASE_APP_ROLE ?? "dukaan_app";
  const port = parsed.data.PORT ? Number(parsed.data.PORT) : 3000;
  if (port < 1 || port > 65535) {
    throw new Error("PORT must be between 1 and 65535.");
  }

  assertDatabaseUrl(parsed.data.DATABASE_URL, databaseAppRole);
  if (parsed.data.SESSION_SECRET === parsed.data.OTP_PEPPER) {
    throw new Error("SESSION_SECRET and OTP_PEPPER must be different.");
  }

  return {
    nodeEnv,
    port,
    databaseUrl: parsed.data.DATABASE_URL,
    apiPrefix: parsed.data.API_PREFIX ?? "api",
    logLevel: parsed.data.LOG_LEVEL ?? "info",
    corsOrigins: parseCorsOrigins(nodeEnv, parsed.data.CORS_ORIGINS),
    databaseAppRole,
    swaggerEnabled: nodeEnv !== "production",
    sessionTtlDays: boundedInt(parsed.data.SESSION_TTL_DAYS, 30, 1, 365, "SESSION_TTL_DAYS"),
    sessionSecret: parsed.data.SESSION_SECRET,
    otpPepper: parsed.data.OTP_PEPPER,
    otpTtlSeconds: boundedInt(parsed.data.OTP_TTL_SECONDS, 300, 30, 3600, "OTP_TTL_SECONDS"),
    otpMaxAttempts: boundedInt(parsed.data.OTP_MAX_ATTEMPTS, 5, 1, 10, "OTP_MAX_ATTEMPTS"),
    otpProvider: resolveOtpProvider(nodeEnv, parsed.data.OTP_PROVIDER),
    otpRequestLimit: boundedInt(parsed.data.OTP_REQUEST_LIMIT, 5, 1, 100, "OTP_REQUEST_LIMIT"),
    otpRequestWindowSeconds: boundedInt(
      parsed.data.OTP_REQUEST_WINDOW_SECONDS,
      600,
      30,
      86400,
      "OTP_REQUEST_WINDOW_SECONDS",
    ),
    otpIpLimit: boundedInt(parsed.data.OTP_IP_LIMIT, 30, 1, 1000, "OTP_IP_LIMIT"),
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

function assertDatabaseUrl(databaseUrl: string, expectedRole: string): void {
  const username = databaseUser(databaseUrl);
  if (username.length === 0) {
    throw new Error("DATABASE_URL must include the application database user.");
  }
  if (username !== expectedRole) {
    throw new Error(
      `DATABASE_URL user is ${username}. The API must connect as ${expectedRole}.`,
    );
  }
}

function databaseUser(databaseUrl: string): string {
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
  return decodeURIComponent(url.username);
}

function parseCorsOrigins(
  nodeEnv: NodeEnvironment,
  raw: string | undefined,
): readonly string[] {
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
    if (nodeEnv === "production") {
      throw new Error("CORS_ORIGINS is required in production.");
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
  }

  return origins;
}
