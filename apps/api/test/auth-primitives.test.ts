import assert from "node:assert/strict";
import { describe, it } from "@jest/globals";
import { AuthRateLimiter } from "../src/auth/auth-rate-limiter";
import { hashOtp, otpMatches } from "../src/auth/otp-hash";
import { normalizeIndianPhone } from "../src/auth/phone";
import { issueSessionToken, userIdFromSessionToken } from "../src/auth/session-token";
import { issueShopGrant, readShopGrant } from "../src/auth/shop-grant";
import { AppException } from "../src/common/errors/app.exception";
import { ErrorCode } from "../src/common/errors/error-codes";

const userId = "00000000-0000-4000-8000-0000000000aa";
const sessionId = "00000000-0000-4000-8000-0000000000bb";
const tenantId = "00000000-0000-4000-8000-0000000000cc";

describe("phone normalization", () => {
  it("maps Indian formats onto one canonical number", () => {
    const expected = "+919876543210";
    assert.equal(normalizeIndianPhone("9876543210"), expected);
    assert.equal(normalizeIndianPhone("+91 98765-43210"), expected);
    assert.equal(normalizeIndianPhone("919876543210"), expected);
    assert.equal(normalizeIndianPhone("09876543210"), expected);
    assert.throws(() => normalizeIndianPhone("12345"), /invalid phone/);
    assert.throws(() => normalizeIndianPhone("+14155552671"), /invalid phone/);
  });
});

describe("otp and session secrets", () => {
  it("stores a peppered hash and compares it in constant time", () => {
    const hash = hashOtp("123456", "pepper-value-long");
    assert.notEqual(hash, "123456");
    assert.equal(otpMatches("123456", "pepper-value-long", hash), true);
    assert.equal(otpMatches("000000", "pepper-value-long", hash), false);
  });

  it("keeps the raw session token out of the hash", () => {
    const issued = issueSessionToken(userId);
    assert.equal(userIdFromSessionToken(issued.raw), userId);
    assert.notEqual(issued.hash, issued.raw);
    assert.equal(issued.hash.includes(issued.raw), false);
    assert.equal(userIdFromSessionToken(`v1.${sessionId}.not-the-secret`), null);
  });

  it("rejects a shop grant with a bad signature or an expiry", () => {
    const secret = "session-secret-value";
    const token = issueShopGrant(
      { sessionId, userId, tenantId, expiresAt: Math.floor(Date.now() / 1000) + 60 },
      secret,
    );
    assert.deepEqual(readShopGrant(token, secret)?.tenantId, tenantId);
    assert.equal(readShopGrant(`${token}x`, secret), null);
    assert.equal(readShopGrant(tenantId, secret), null);
    const expired = issueShopGrant(
      { sessionId, userId, tenantId, expiresAt: Math.floor(Date.now() / 1000) - 10 },
      secret,
    );
    assert.equal(readShopGrant(expired, secret), null);
  });
});

describe("auth rate limiter", () => {
  it("allows a window and then rejects", () => {
    const limiter = new AuthRateLimiter();
    limiter.consume("phone", 2, 60_000);
    limiter.consume("phone", 2, 60_000);
    assert.throws(
      () => limiter.consume("phone", 2, 60_000),
      (error: unknown) =>
        error instanceof AppException && error.code === ErrorCode.AUTH_RATE_LIMITED,
    );
  });
});
