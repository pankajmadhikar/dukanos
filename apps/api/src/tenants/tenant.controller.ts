import { Body, Controller, Get, HttpCode, Param, Post, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Response } from "express";
import { AppConfigService } from "../common/config/app-config.service";
import { RequiresTenant } from "../common/decorators/requires-tenant.decorator";
import { RequestContextService } from "../context/request-context.service";
import { CreateTenantDto, SelectTenantDto } from "./dto/tenant.dto";
import { shopCookie } from "../auth/shop-cookie";
import { TenantService } from "./tenant.service";

@ApiTags("tenants")
@ApiBearerAuth("session")
@Controller({ path: "tenants", version: "1" })
export class TenantController {
  constructor(
    private readonly tenants: TenantService,
    private readonly context: RequestContextService,
    private readonly config: AppConfigService,
  ) {}

  @Get()
  @ApiOperation({ summary: "Shops where the signed-in user has an active membership" })
  async list() {
    const userId = this.userId();
    const shops = await this.tenants.list(userId);
    return { data: shops, requestId: this.requestId() };
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: "Create a shop and become its owner" })
  async create(
    @Body() body: CreateTenantDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const created = await this.tenants.create(this.userId(), this.sessionId(), {
      name: body.name,
      businessType: body.businessType,
      phone: body.phone,
      email: body.email,
      address: body.address,
      city: body.city,
      state: body.state,
      pincode: body.pincode,
    });
    this.setShopCookie(response, created.shopContext);
    return {
      data: {
        id: created.id,
        name: created.name,
        role: created.role,
        shopContext: created.shopContext,
      },
      requestId: this.requestId(),
    };
  }

  @Post(":tenantId/select")
  @HttpCode(200)
  @ApiOperation({ summary: "Select a shop after membership is verified" })
  async select(
    @Param("tenantId") tenantId: string,
    @Body() _body: SelectTenantDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const selected = await this.tenants.select(this.userId(), this.sessionId(), tenantId);
    this.setShopCookie(response, selected.shopContext);
    return { data: selected, requestId: this.requestId() };
  }

  @Get("current")
  @RequiresTenant()
  @ApiOperation({ summary: "The shop selected for this session" })
  async current() {
    const store = this.context.current();
    const shop = await this.tenants.current(this.userId(), store?.tenantId ?? "");
    return { data: shop, requestId: this.requestId() };
  }

  private setShopCookie(response: Response, value: string): void {
    const maxAge = this.config.sessionTtlDays * 24 * 60 * 60;
    response.append(
      "Set-Cookie",
      shopCookie(value, this.config.nodeEnv === "production", maxAge),
    );
  }

  private userId(): string {
    const userId = this.context.current()?.userId;
    if (!userId) {
      throw new Error("Authenticated route without a user.");
    }
    return userId;
  }

  private sessionId(): string {
    const sessionId = this.context.current()?.sessionId;
    if (!sessionId) {
      throw new Error("Authenticated route without a session.");
    }
    return sessionId;
  }

  private requestId(): string | null {
    return this.context.current()?.requestId ?? null;
  }
}
