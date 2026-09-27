import { createHmac, timingSafeEqual } from "node:crypto";

export interface ShopGrant {
  sessionId: string;
  userId: string;
  tenantId: string;
  expiresAt: number;
}

/**
 * Opaque proof that this server already checked membership for this session.
 * It is not a tenant id. A client-supplied shop id is never accepted in its place.
 */
export function issueShopGrant(grant: ShopGrant, secret: string): string {
  const body = Buffer.from(JSON.stringify(grant), "utf8").toString("base64url");
  const signature = sign(body, secret);
  return `${body}.${signature}`;
}

export function readShopGrant(token: string, secret: string): ShopGrant | null {
  const separator = token.lastIndexOf(".");
  if (separator <= 0) {
    return null;
  }
  const body = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = sign(body, secret);
  const actualBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!isGrant(parsed)) {
      return null;
    }
    if (parsed.expiresAt <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function isGrant(value: unknown): value is ShopGrant {
  if (!value || typeof value !== "object") {
    return false;
  }
  const grant = value as Partial<ShopGrant>;
  return (
    typeof grant.sessionId === "string" &&
    typeof grant.userId === "string" &&
    typeof grant.tenantId === "string" &&
    typeof grant.expiresAt === "number"
  );
}
