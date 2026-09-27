import { Injectable, LoggerService } from "@nestjs/common";
import { AppConfigService } from "../config/app-config.service";
import { LogLevel } from "../config/load-app-config";
import { requestContextStorage } from "../../context/request-store";
import { redact } from "./redact";

export interface LogEntry {
  level: LogLevel;
  message: string;
  module?: string;
  operation?: string;
  durationMs?: number;
  statusCode?: number;
}

const RANK: Record<LogLevel, number> = {
  fatal: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
};

@Injectable()
export class AppLogger implements LoggerService {
  constructor(private readonly config: AppConfigService) {}

  log(message: unknown, context?: string): void {
    this.write({
      level: "info",
      message: asMessage(message),
      module: context,
    });
  }

  error(message: unknown, stack?: string, context?: string): void {
    const stackIsContext = stack !== undefined && !stack.includes("\n") && context === undefined;
    this.write({
      level: "error",
      message: asMessage(message),
      module: stackIsContext ? stack : context,
    });
    if (!stackIsContext && stack) {
      this.write({
        level: "error",
        message: redact(stack),
        module: context ?? "error",
        operation: "stack",
      });
    }
  }

  warn(message: unknown, context?: string): void {
    this.write({
      level: "warn",
      message: asMessage(message),
      module: context,
    });
  }

  debug(message: unknown, context?: string): void {
    this.write({
      level: "debug",
      message: asMessage(message),
      module: context,
    });
  }

  verbose(message: unknown, context?: string): void {
    this.write({
      level: "trace",
      message: asMessage(message),
      module: context,
    });
  }

  write(entry: LogEntry): void {
    if (RANK[entry.level] > RANK[this.config.logLevel]) {
      return;
    }
    const store = requestContextStorage.getStore();
    const line = {
      timestamp: new Date().toISOString(),
      level: entry.level,
      message: redact(entry.message),
      requestId: store?.requestId ?? null,
      userId: store?.userId ?? null,
      tenantId: store?.tenantId ?? null,
      module: entry.module ?? null,
      operation: entry.operation ?? null,
      durationMs: entry.durationMs ?? null,
      statusCode: entry.statusCode ?? null,
    };
    const stream = entry.level === "error" || entry.level === "fatal" ? process.stderr : process.stdout;
    stream.write(`${JSON.stringify(line)}\n`);
  }
}

function asMessage(message: unknown): string {
  if (typeof message === "string") {
    return message;
  }
  if (message instanceof Error) {
    return message.message;
  }
  return "log event";
}
