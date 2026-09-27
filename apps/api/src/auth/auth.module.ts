import { Module } from "@nestjs/common";
import { AppConfigService } from "../common/config/app-config.service";
import { AppLogger } from "../common/logging/app-logger.service";
import { AuditModule } from "../audit/audit.module";
import { DatabaseModule } from "../database/database.module";
import { TenantsModule } from "../tenants/tenants.module";
import { AuthContextService } from "./auth-context.service";
import { AuthController } from "./auth.controller";
import { AuthRateLimiter } from "./auth-rate-limiter";
import { AuthService } from "./auth.service";
import { CapturingOtpSender } from "./capturing-otp-sender";
import { ConsoleOtpSender } from "./console-otp-sender";
import { AuthenticationGuard } from "./guards/authentication.guard";
import { OTP_SENDER, OtpSender } from "./otp-sender";
import { SessionService } from "./session.service";
import { UnconfiguredOtpSender } from "./unconfigured-otp-sender";

@Module({
  imports: [DatabaseModule, AuditModule, TenantsModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionService,
    AuthContextService,
    AuthRateLimiter,
    AuthenticationGuard,
    {
      provide: OTP_SENDER,
      useFactory: (config: AppConfigService, logger: AppLogger): OtpSender => {
        if (config.otpProvider === "capture") {
          return new CapturingOtpSender();
        }
        if (config.otpProvider === "console") {
          return new ConsoleOtpSender(logger);
        }
        return new UnconfiguredOtpSender();
      },
      inject: [AppConfigService, AppLogger],
    },
  ],
  exports: [AuthenticationGuard, AuthContextService],
})
export class AuthModule {}
