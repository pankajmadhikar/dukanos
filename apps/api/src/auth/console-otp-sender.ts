import { Injectable } from "@nestjs/common";
import { AppLogger } from "../common/logging/app-logger.service";
import { OtpSender } from "./otp-sender";

/**
 * Development delivery only. The code is written to the server log so a
 * developer can sign in without SMS. Production startup rejects this provider.
 */
@Injectable()
export class ConsoleOtpSender implements OtpSender {
  constructor(private readonly logger: AppLogger) {}

  async sendOtp(phone: string, code: string): Promise<void> {
    this.logger.write({
      level: "info",
      message: `development verification code ${code} for ${phone}`,
      module: "auth",
      operation: "otp.console",
    });
  }
}
