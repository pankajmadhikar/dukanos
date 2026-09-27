import { createHash, randomBytes, randomInt } from "node:crypto";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function issueSessionToken(userId: string): { raw: string; hash: string } {
  const secret = randomBytes(32).toString("base64url");
  const raw = `v1.${userId}.${secret}`;
  return { raw, hash: hashSessionToken(raw) };
}

export function hashSessionToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * The user id prefix lets us set app.user_id before the session lookup.
 * Sessions are invisible until that GUC is set. The hash still covers the
 * whole token, so a swapped user id does not match a stored session.
 */
export function userIdFromSessionToken(raw: string): string | null {
  const parts = raw.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") {
    return null;
  }
  const userId = parts[1];
  const secret = parts[2];
  if (!userId || !UUID.test(userId) || !secret || secret.length < 20) {
    return null;
  }
  return userId;
}

export function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}
