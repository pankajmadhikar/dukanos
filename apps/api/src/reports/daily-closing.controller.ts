import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { CurrentTenant, CurrentTenantPrincipal } from "../common/decorators/current-tenant.decorator";
import { CurrentUser, CurrentUserPrincipal } from "../common/decorators/current-user.decorator";
import { RequiresTenant } from "../common/decorators/requires-tenant.decorator";
import { RequestContextService } from "../context/request-context.service";
import { DailyClosingService } from "./daily-closing.service";
import { CloseDayDto, ClosingListQuery } from "./dto/report.dto";
import { CloseTheDay, reportActor } from "./report-access";

@ApiTags("daily-closing")
@ApiBearerAuth("session")
@ApiUnauthorizedResponse({ description: "AUTH_REQUIRED when the session is missing." })
@ApiForbiddenResponse({ description: "DAILY_CLOSING_ACCESS_DENIED when the role cannot close the day." })
@RequiresTenant()
@Controller({ path: "daily-closing", version: "1" })
export class DailyClosingController {
  constructor(
    private readonly closing: DailyClosingService,
    private readonly context: RequestContextService,
  ) {}

  @Post()
  @HttpCode(200)
  @CloseTheDay()
  @ApiOperation({
    summary: "Close a business date",
    description:
      "Calculates the snapshot from sales, returns, expenses, payments, and ledgers, then stores it on daily_summaries. A second close for the same date returns the stored snapshot. Closing does not create sales, payments, expenses, or stock movements.",
  })
  async close(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Body() body: CloseDayDto,
  ) {
    const data = await this.closing.close(reportActor(user, tenant), body.businessDate);
    return { data, requestId: this.requestId() };
  }

  @Get()
  @ApiOperation({ summary: "Daily closing history" })
  async list(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: ClosingListQuery,
  ) {
    const page = await this.closing.list(reportActor(user, tenant), {
      from: query.from,
      to: query.to,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
    return { data: page.data, pagination: page.pagination, requestId: this.requestId() };
  }

  @Post(":businessDate/rebuild")
  @HttpCode(200)
  @CloseTheDay()
  @ApiOperation({
    summary: "Rebuild a daily closing",
    description: "Replaces the stored snapshot for one shop business date from the source documents. Later posting does not change a closed day until this rebuild.",
  })
  async rebuild(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("businessDate") businessDate: string,
  ) {
    const data = await this.closing.rebuild(reportActor(user, tenant), businessDate);
    return { data, requestId: this.requestId() };
  }

  @Get(":businessDate")
  @ApiNotFoundResponse({ description: "DAILY_CLOSING_NOT_FOUND" })
  @ApiOperation({ summary: "Daily closing detail" })
  async get(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("businessDate") businessDate: string,
  ) {
    const data = await this.closing.get(reportActor(user, tenant), businessDate);
    return { data, requestId: this.requestId() };
  }

  private requestId(): string | null {
    return this.context.current()?.requestId ?? null;
  }
}
