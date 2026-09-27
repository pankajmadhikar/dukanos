import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { OtpPurpose } from "@prisma/client";
import { AppConfigService } from "../common/config/app-config.service";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";
import { TenantTransactionService } from "../database/tenant-transaction.service";
import { AuditRecorder } from "../audit/audit-recorder";
import { AuthRateLimiter } from "./auth-rate-limiter";
import { hashOtp, otpMatches } from "./otp-hash";
import { OTP_SENDER, OtpSender } from "./otp-sender";
import { normalizeIndianPhone } from "./phone";
import { generateOtpCode, issueSessionToken } from "./session-token";

export interface VerifiedLogin {
  token: string;
  expiresAt: string;
  user: {
    id: string;
    name: string;
    phone: string;
    email: string | null;
  };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly config: AppConfigService,
    private readonly transactions: TenantTransactionService,
    @Inject(OTP_SENDER) private readonly otpSender: OtpSender,
    private readonly limiter: AuthRateLimiter,
    private readonly audit: AuditRecorder,
  ) {}

  async requestOtp(phoneInput: string, ip: string): Promise<void> {
    const phone = this.phone(phoneInput);
    const windowMs = this.config.otpRequestWindowSeconds * 1000;
    this.limiter.consume(`otp-ip:${ip}`, this.config.otpIpLimit, windowMs);
    this.limiter.consume(`otp-phone:${phone}`, this.config.otpRequestLimit, windowMs);

    const code = generateOtpCode();
    await this.otpSender.sendOtp(phone, code);
    const expiresAt = new Date(Date.now() + this.config.otpTtlSeconds * 1000);
    await this.transactions.runPlatform(async (tx) => {
      await tx.otpChallenge.create({
        data: {
          phone,
          purpose: OtpPurpose.LOGIN,
          codeHash: hashOtp(code, this.config.otpPepper),
          expiresAt,
        },
      });
    });
  }

  async verifyOtp(phoneInput: string, code: string, ip: string): Promise<VerifiedLogin> {
    const phone = this.phone(phoneInput);
    const windowMs = this.config.otpRequestWindowSeconds * 1000;
    this.limiter.consume(`otp-verify-ip:${ip}`, this.config.otpIpLimit, windowMs);
    if (!/^\d{6}$/.test(code)) {
      throw new AppException(
        ErrorCode.AUTH_INVALID_OTP,
        "The verification code is not valid.",
        HttpStatus.UNAUTHORIZED,
      );
    }

    const user = await this.transactions.runPlatform(async (tx) => {
      const challenge = await tx.otpChallenge.findFirst({
        where: { phone, purpose: OtpPurpose.LOGIN },
        orderBy: { createdAt: "desc" },
      });
      if (!challenge) {
        throw new AppException(
          ErrorCode.AUTH_INVALID_OTP,
          "The verification code is not valid.",
          HttpStatus.UNAUTHORIZED,
        );
      }
      if (challenge.consumedAt) {
        throw new AppException(
          ErrorCode.AUTH_OTP_CONSUMED,
          "This verification code was already used.",
          HttpStatus.UNAUTHORIZED,
        );
      }
      if (challenge.expiresAt.getTime() <= Date.now()) {
        throw new AppException(
          ErrorCode.AUTH_OTP_EXPIRED,
          "This verification code has expired.",
          HttpStatus.UNAUTHORIZED,
        );
      }
      if (challenge.attemptCount >= this.config.otpMaxAttempts) {
        throw new AppException(
          ErrorCode.AUTH_OTP_TOO_MANY_ATTEMPTS,
          "Too many attempts. Request a new verification code.",
          HttpStatus.UNAUTHORIZED,
        );
      }
      if (!otpMatches(code, this.config.otpPepper, challenge.codeHash)) {
        const attempts = challenge.attemptCount + 1;
        await tx.otpChallenge.update({
          where: { id: challenge.id },
          data: { attemptCount: attempts },
        });
        return { status: "invalid" as const, attempts };
      }
      const consumed = await tx.otpChallenge.updateMany({
        where: { id: challenge.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      if (consumed.count !== 1) {
        throw new AppException(
          ErrorCode.AUTH_OTP_CONSUMED,
          "This verification code was already used.",
          HttpStatus.UNAUTHORIZED,
        );
      }
      const existing = await tx.user.findUnique({
        where: { phone },
        select: { id: true, name: true, phone: true, email: true, isActive: true },
      });
      if (existing) {
        return { status: "user" as const, user: existing };
      }
      const created = await tx.user.create({
        data: { phone, name: "Owner" },
        select: { id: true, name: true, phone: true, email: true, isActive: true },
      });
      return { status: "user" as const, user: created };
    });

    if (user.status === "invalid") {
      if (user.attempts >= this.config.otpMaxAttempts) {
        throw new AppException(
          ErrorCode.AUTH_OTP_TOO_MANY_ATTEMPTS,
          "Too many attempts. Request a new verification code.",
          HttpStatus.UNAUTHORIZED,
        );
      }
      throw new AppException(
        ErrorCode.AUTH_INVALID_OTP,
        "The verification code is not valid.",
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (!user.user.isActive) {
      throw new AppException(
        ErrorCode.AUTH_INVALID_SESSION,
        "This account cannot sign in.",
        HttpStatus.UNAUTHORIZED,
      );
    }

    const account = user.user;

    const issued = issueSessionToken(account.id);
    const expiresAt = new Date(Date.now() + this.config.sessionTtlDays * 24 * 60 * 60 * 1000);
    await this.transactions.runAsUser(account.id, async (tx) => {
      await tx.session.create({
        data: {
          userId: account.id,
          tokenHash: issued.hash,
          expiresAt,
        },
      });
    });
    this.audit.platform("auth.login", account.id);
    return {
      token: issued.raw,
      expiresAt: expiresAt.toISOString(),
      user: {
        id: account.id,
        name: account.name,
        phone: account.phone,
        email: account.email,
      },
    };
  }

  private phone(input: string): string {
    try {
      return normalizeIndianPhone(input);
    } catch {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        "Enter a valid Indian mobile number.",
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}
