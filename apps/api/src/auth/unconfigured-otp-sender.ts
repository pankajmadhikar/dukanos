import { HttpStatus, Injectable } from "@nestjs/common";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";
import { OtpSender } from "./otp-sender";

@Injectable()
export class UnconfiguredOtpSender implements OtpSender {
  async sendOtp(): Promise<void> {
    throw new AppException(
      ErrorCode.AUTH_OTP_UNAVAILABLE,
      "Verification codes cannot be delivered right now.",
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
