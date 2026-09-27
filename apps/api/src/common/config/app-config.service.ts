import { Injectable } from "@nestjs/common";
import {
  AppConfig,
  loadAppConfig,
  LogLevel,
  NodeEnvironment,
  OtpProviderName,
} from "./load-app-config";

@Injectable()
export class AppConfigService {
  readonly nodeEnv: NodeEnvironment;
  readonly port: number;
  readonly databaseUrl: string;
  readonly apiPrefix: string;
  readonly logLevel: LogLevel;
  readonly corsOrigins: readonly string[];
  readonly databaseAppRole: string;
  readonly swaggerEnabled: boolean;
  readonly sessionTtlDays: number;
  readonly sessionSecret: string;
  readonly otpPepper: string;
  readonly otpTtlSeconds: number;
  readonly otpMaxAttempts: number;
  readonly otpProvider: OtpProviderName;
  readonly otpRequestLimit: number;
  readonly otpRequestWindowSeconds: number;
  readonly otpIpLimit: number;

  constructor() {
    const loaded: AppConfig = loadAppConfig(process.env);
    this.nodeEnv = loaded.nodeEnv;
    this.port = loaded.port;
    this.databaseUrl = loaded.databaseUrl;
    this.apiPrefix = loaded.apiPrefix;
    this.logLevel = loaded.logLevel;
    this.corsOrigins = loaded.corsOrigins;
    this.databaseAppRole = loaded.databaseAppRole;
    this.swaggerEnabled = loaded.swaggerEnabled;
    this.sessionTtlDays = loaded.sessionTtlDays;
    this.sessionSecret = loaded.sessionSecret;
    this.otpPepper = loaded.otpPepper;
    this.otpTtlSeconds = loaded.otpTtlSeconds;
    this.otpMaxAttempts = loaded.otpMaxAttempts;
    this.otpProvider = loaded.otpProvider;
    this.otpRequestLimit = loaded.otpRequestLimit;
    this.otpRequestWindowSeconds = loaded.otpRequestWindowSeconds;
    this.otpIpLimit = loaded.otpIpLimit;
  }
}
