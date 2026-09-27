import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Request, Response } from "express";
import { AppConfigService } from "../common/config/app-config.service";
import { Public } from "../common/decorators/public.decorator";
import { RequestContextService } from "../context/request-context.service";
import { TenantService } from "../tenants/tenant.service";
import { AuthService } from "./auth.service";
import { RequestOtpDto, VerifyOtpDto } from "./dto/auth.dto";
import { SessionService } from "./session.service";
import { clearShopCookie } from "./shop-cookie";

@ApiTags("auth")
@ApiBearerAuth("session")
@Controller({ path: "auth", version: "1" })
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly tenants: TenantService,
    private readonly context: RequestContextService,
    private readonly config: AppConfigService,
  ) {}

  @Public()
  @Post("request-otp")
  @HttpCode(200)
  @ApiOperation({ summary: "Send a login verification code" })
  @ApiOkResponse({
    schema: { example: { data: { status: "accepted" }, requestId: "..." } },
  })
  async requestOtp(@Body() body: RequestOtpDto, @Req() request: Request) {
    await this.auth.requestOtp(body.phone, request.ip ?? "unknown");
    return { data: { status: "accepted" }, requestId: this.requestId() };
  }

  @Public()
  @Post("verify-otp")
  @HttpCode(200)
  @ApiOperation({ summary: "Verify a login code and open a session" })
  async verifyOtp(@Body() body: VerifyOtpDto, @Req() request: Request) {
    const login = await this.auth.verifyOtp(body.phone, body.code, request.ip ?? "unknown");
    return { data: login, requestId: this.requestId() };
  }

  @Post("logout")
  @HttpCode(200)
  @ApiOperation({ summary: "Revoke the current session" })
  async logout(@Res({ passthrough: true }) response: Response) {
    const store = this.context.current();
    if (!store?.userId || !store.sessionId) {
      return { data: { status: "signed-out" }, requestId: this.requestId() };
    }
    await this.sessions.revoke(store.userId, store.sessionId, store.tenantId);
    response.append(
      "Set-Cookie",
      clearShopCookie(this.config.nodeEnv === "production"),
    );
    return { data: { status: "signed-out" }, requestId: this.requestId() };
  }

  @Get("me")
  @ApiOperation({ summary: "Current user and selected shop" })
  async me() {
    const store = this.context.current();
    const userId = store?.userId;
    if (!userId) {
      return { data: null, requestId: this.requestId() };
    }
    const profile = await this.sessions.profile(userId);
    const selectedTenant = store?.tenantId
      ? await this.tenants.current(userId, store.tenantId)
      : null;
    return {
      data: { ...profile, selectedTenant },
      requestId: this.requestId(),
    };
  }

  private requestId(): string | null {
    return this.context.current()?.requestId ?? null;
  }
}
