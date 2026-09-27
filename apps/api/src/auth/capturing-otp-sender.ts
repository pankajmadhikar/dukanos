import { Injectable } from "@nestjs/common";
import { OtpSender } from "./otp-sender";

/** Test double. The API response still does not contain the code. */
@Injectable()
export class CapturingOtpSender implements OtpSender {
  private readonly codes = new Map<string, string>();

  async sendOtp(phone: string, code: string): Promise<void> {
    this.codes.set(phone, code);
  }

  latest(phone: string): string | undefined {
    return this.codes.get(phone);
  }
}
