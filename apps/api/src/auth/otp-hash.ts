import { createHmac, timingSafeEqual } from "node:crypto";

export function hashOtp(code: string, pepper: string): string {
  return createHmac("sha256", pepper).update(code).digest("hex");
}

export function otpMatches(code: string, pepper: string, storedHash: string): boolean {
  const actual = Buffer.from(hashOtp(code, pepper), "utf8");
  const expected = Buffer.from(storedHash, "utf8");
  if (actual.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(actual, expected);
}
