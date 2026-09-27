import { Controller, Get, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiForbiddenResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from "@nestjs/swagger";
import { CurrentTenant, CurrentTenantPrincipal } from "../common/decorators/current-tenant.decorator";
import { CurrentUser, CurrentUserPrincipal } from "../common/decorators/current-user.decorator";
import { RequiresTenant } from "../common/decorators/requires-tenant.decorator";
import { RequestContextService } from "../context/request-context.service";
import { DashboardService } from "./dashboard.service";
import { ComparisonQuery } from "./dto/report.dto";
import { reportActor } from "./report-access";

@ApiTags("dashboard")
@ApiBearerAuth("session")
@ApiUnauthorizedResponse({ description: "AUTH_REQUIRED when the session is missing." })
@ApiForbiddenResponse({ description: "TENANT_NOT_SELECTED when no shop is selected." })
@RequiresTenant()
@Controller({ path: "dashboard", version: "1" })
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly context: RequestContextService,
  ) {}

  @Get("today")
  @ApiOperation({
    summary: "Today dashboard",
    description:
      "Shop business date in the shop timezone. Sales, profit, collections, supplier payments, and expenses stay separate. Cashiers do not receive cost, profit, or supplier figures.",
  })
  async today(@CurrentUser() user: CurrentUserPrincipal, @CurrentTenant() tenant: CurrentTenantPrincipal) {
    const data = await this.dashboard.today(reportActor(user, tenant));
    return { data, requestId: this.requestId() };
  }

  @Get("comparison")
  @ApiOperation({
    summary: "Period comparison",
    description: "Today against yesterday, this week against last week, or this month against last month. Weeks run Monday through Sunday. Change is a measurement, not a judgment.",
  })
  async comparison(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: ComparisonQuery,
  ) {
    const data = await this.dashboard.comparison(reportActor(user, tenant), query.period ?? "today");
    return { data, requestId: this.requestId() };
  }

  private requestId(): string | null {
    return this.context.current()?.requestId ?? null;
  }
}
