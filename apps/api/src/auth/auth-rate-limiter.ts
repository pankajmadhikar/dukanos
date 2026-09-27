import { HttpStatus, Injectable } from "@nestjs/common";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";

/**
 * Single-process window limiter. It is not shared across API instances.
 * Production should replace this with a shared store before more than one
 * process serves login traffic.
 */
@Injectable()
export class AuthRateLimiter {
  private readonly hits = new Map<string, number[]>();

  consume(key: string, limit: number, windowMs: number): void {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < windowMs);
    if (recent.length >= limit) {
      throw new AppException(
        ErrorCode.AUTH_RATE_LIMITED,
        "Too many attempts. Try again later.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    recent.push(now);
    this.hits.set(key, recent);
  }
}
