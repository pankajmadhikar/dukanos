import { Controller, Get, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiForbiddenResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from "@nestjs/swagger";
import { CurrentTenant, CurrentTenantPrincipal } from "../common/decorators/current-tenant.decorator";
import { CurrentUser, CurrentUserPrincipal } from "../common/decorators/current-user.decorator";
import { RequiresTenant } from "../common/decorators/requires-tenant.decorator";
import { RequestContextService } from "../context/request-context.service";
import { ExpenseSummaryQuery } from "../expenses/dto/expense.dto";
import { reportActor } from "./report-access";
import { FinanceReportService } from "./finance-report.service";

@ApiTags("reports")
@ApiBearerAuth("session")
@ApiUnauthorizedResponse({ description: "AUTH_REQUIRED when the session is missing." })
@ApiForbiddenResponse({ description: "TENANT_NOT_SELECTED when no shop is selected." })
@RequiresTenant()
@Controller({ path: "reports", version: "1" })
export class FinanceReportController {
  constructor(
    private readonly finance: FinanceReportService,
    private readonly context: RequestContextService,
  ) {}

  @Get("finance-summary")
  @ApiOperation({
    summary: "Finance summary",
    description:
      "Reads sales, returns, sale costs, expenses, and payments. Customer receipts and supplier payments are not profit. Purchases are not expenses and are not cost of goods sold. Cashiers do not receive cost or profit. Stock keepers do not receive cost of goods sold or profit.",
  })
  async financeSummary(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: ExpenseSummaryQuery,
  ) {
    const actor = reportActor(user, tenant);
    const data = await this.finance.summary(actor, query);
    return { data, requestId: this.context.current()?.requestId ?? null };
  }
}
