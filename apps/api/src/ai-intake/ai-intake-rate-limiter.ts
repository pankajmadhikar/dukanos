import { HttpStatus, Injectable } from "@nestjs/common";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";

interface WindowHit {
  tenantId: string;
  userId: string;
  ip?: string;
}

/**
 * Per-process window for intake processing. It is not shared across API
 * instances. A daily cap in the database covers the shop even after a restart.
 */
@Injectable()
export class AiIntakeRateLimiter {
  private readonly hits = new Map<string, number[]>();

  assertAllowed(input: WindowHit, perMinute: number): void {
    const now = Date.now();
    const keys = [`tenant:${input.tenantId}`, `user:${input.userId}`];
    if (input.ip && input.ip.length > 0) {
      keys.push(`ip:${input.ip}`);
    }
    for (const key of keys) {
      const recent = this.recent(key, now);
      if (recent.length >= perMinute) {
        throw new AppException(
          ErrorCode.AI_INTAKE_RATE_LIMITED,
          "Too many intake requests. Try again shortly.",
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
    for (const key of keys) {
      const recent = this.recent(key, now);
      recent.push(now);
      this.hits.set(key, recent);
    }
  }

  private recent(key: string, now: number): number[] {
    return (this.hits.get(key) ?? []).filter((stamp) => now - stamp < 60_000);
  }
}
