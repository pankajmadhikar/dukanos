import { Controller, Get, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiForbiddenResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from "@nestjs/swagger";
import { CurrentTenant, CurrentTenantPrincipal } from "../common/decorators/current-tenant.decorator";
import { CurrentUser, CurrentUserPrincipal } from "../common/decorators/current-user.decorator";
import { RequiresTenant } from "../common/decorators/requires-tenant.decorator";
import { RequestContextService } from "../context/request-context.service";
import { ViewExpenses } from "../expenses/expense-access";
import { ExpenseSummaryQuery } from "../expenses/dto/expense.dto";
import { ExpenseService } from "../expenses/expense.service";
import {
  InactiveStockQuery,
  MovementReportQuery,
  PageQuery,
  ProductReportQuery,
  StockListQuery,
  StockSummaryQuery,
  TopProductQuery,
} from "./dto/report.dto";
import { PartyReportService } from "./party-report.service";
import { ProductReportService } from "./product-report.service";
import { reportActor } from "./report-access";
import { SalesReportService } from "./sales-report.service";
import { StockReportService } from "./stock-report.service";

@ApiTags("reports")
@ApiBearerAuth("session")
@ApiUnauthorizedResponse({ description: "AUTH_REQUIRED when the session is missing." })
@ApiForbiddenResponse({ description: "TENANT_NOT_SELECTED when no shop is selected." })
@RequiresTenant()
@Controller({ path: "reports", version: "1" })
export class ShopReportController {
  constructor(
    private readonly sales: SalesReportService,
    private readonly products: ProductReportService,
    private readonly parties: PartyReportService,
    private readonly stock: StockReportService,
    private readonly expenses: ExpenseService,
    private readonly context: RequestContextService,
  ) {}

  @Get("sales/daily")
  @ApiOperation({ summary: "Daily sales trend", description: "Net sales by shop business date. Empty days are zero." })
  async salesDaily(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: ExpenseSummaryQuery,
  ) {
    const data = await this.sales.daily(reportActor(user, tenant), query);
    return { data, requestId: this.requestId() };
  }

  @Get("sales")
  @ApiOperation({
    summary: "Sales report",
    description: "Average bill value is net sales divided by completed sales. Zero sales produce 0.00, not an error.",
  })
  async salesSummary(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: ExpenseSummaryQuery,
  ) {
    const data = await this.sales.summary(reportActor(user, tenant), query);
    return { data, requestId: this.requestId() };
  }

  @Get("products/top")
  @ApiOperation({ summary: "Ranked products", description: "Ranking by quantity, revenue, or gross profit. This is an ordering, not a judgment." })
  async topProducts(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: TopProductQuery,
  ) {
    const page = await this.products.top(reportActor(user, tenant), {
      period: query.period,
      from: query.from,
      to: query.to,
      sort: query.sort,
      categoryId: query.categoryId,
      limit: query.limit ?? 10,
    });
    return {
      data: page.data,
      sort: page.sort,
      limit: page.limit,
      period: page.period,
      from: page.from,
      to: page.to,
      requestId: this.requestId(),
    };
  }

  @Get("products")
  @ApiOperation({ summary: "Product performance" })
  async productsReport(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: ProductReportQuery,
  ) {
    const page = await this.products.list(reportActor(user, tenant), {
      period: query.period,
      from: query.from,
      to: query.to,
      sort: query.sort,
      categoryId: query.categoryId,
      search: query.search,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
    return { data: page.data, pagination: page.pagination, period: page.period, from: page.from, to: page.to, requestId: this.requestId() };
  }

  @Get("customers/outstanding")
  @ApiOperation({ summary: "Customer outstanding", description: "Active customers with a receivable above zero, sorted by the current balance." })
  async customerOutstanding(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: PageQuery,
  ) {
    const page = await this.parties.customerOutstanding(reportActor(user, tenant), {
      search: query.search,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
    return { data: page.data, pagination: page.pagination, requestId: this.requestId() };
  }

  @Get("customers")
  @ApiOperation({ summary: "Customer sales", description: "Walk-in sales are a separate total. They are not stored as a customer." })
  async customers(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: PageQuery,
  ) {
    const page = await this.parties.customers(reportActor(user, tenant), {
      period: query.period,
      from: query.from,
      to: query.to,
      search: query.search,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
    return {
      data: { walkIn: page.walkIn, customers: page.data },
      pagination: page.pagination,
      period: page.period,
      from: page.from,
      to: page.to,
      requestId: this.requestId(),
    };
  }

  @Get("suppliers/outstanding")
  @ApiOperation({ summary: "Supplier outstanding" })
  async supplierOutstanding(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: PageQuery,
  ) {
    const page = await this.parties.supplierOutstanding(reportActor(user, tenant), {
      search: query.search,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
    return { data: page.data, pagination: page.pagination, requestId: this.requestId() };
  }

  @Get("suppliers")
  @ApiOperation({ summary: "Supplier report", description: "Purchase totals and supplier payments are separate." })
  async suppliers(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: PageQuery,
  ) {
    const page = await this.parties.suppliers(reportActor(user, tenant), {
      period: query.period,
      from: query.from,
      to: query.to,
      search: query.search,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
    return { data: page.data, pagination: page.pagination, period: page.period, from: page.from, to: page.to, requestId: this.requestId() };
  }

  @Get("expenses")
  @ViewExpenses()
  @ApiOperation({ summary: "Expense report", description: "Same totals as the expense summary, including the daily trend." })
  async expensesReport(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: ExpenseSummaryQuery,
  ) {
    const data = await this.expenses.summary(reportActor(user, tenant), query);
    return { data, requestId: this.requestId() };
  }

  @Get("stock/low")
  @ApiOperation({ summary: "Low stock", description: "Quantity is above zero and at or below the product minimum. Zero is out of stock." })
  async lowStock(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: StockListQuery,
  ) {
    const page = await this.stock.low(reportActor(user, tenant), pageOf(query));
    return { data: page.data, pagination: page.pagination, requestId: this.requestId() };
  }

  @Get("stock/out-of-stock")
  @ApiOperation({ summary: "Out of stock" })
  async outOfStock(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: StockListQuery,
  ) {
    const page = await this.stock.outOfStock(reportActor(user, tenant), pageOf(query));
    return { data: page.data, pagination: page.pagination, requestId: this.requestId() };
  }

  @Get("stock/inactive")
  @ApiOperation({
    summary: "Stock without recent sales",
    description:
      "Current stock is above zero and the product has no completed sale in the last daysWithoutSale shop days. The default window is 30. This list is not split into slow and dead stock.",
  })
  async inactiveStock(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: InactiveStockQuery,
  ) {
    const page = await this.stock.inactive(reportActor(user, tenant), {
      ...pageOf(query),
      daysWithoutSale: query.daysWithoutSale,
    });
    return { data: page.data, daysWithoutSale: page.daysWithoutSale, pagination: page.pagination, requestId: this.requestId() };
  }

  @Get("stock")
  @ApiOperation({
    summary: "Stock summary",
    description: "Stock value is on-hand quantity times inventory average cost. Catalog purchase price is not used. Lines with no average cost are left out of the value.",
  })
  async stockSummary(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: StockSummaryQuery,
  ) {
    const data = await this.stock.summary(reportActor(user, tenant), query.locationId);
    return { data, requestId: this.requestId() };
  }

  @Get("inventory-movements")
  @ApiOperation({ summary: "Inventory movement report", description: "Reads the append-only inventory ledger." })
  async movements(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: MovementReportQuery,
  ) {
    const page = await this.stock.movements(reportActor(user, tenant), {
      period: query.period,
      from: query.from,
      to: query.to,
      productId: query.productId,
      locationId: query.locationId,
      movementType: query.movementType,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
    return { data: page.data, pagination: page.pagination, period: page.period, from: page.from, to: page.to, requestId: this.requestId() };
  }

  private requestId(): string | null {
    return this.context.current()?.requestId ?? null;
  }
}

function pageOf(query: StockListQuery) {
  return {
    search: query.search,
    categoryId: query.categoryId,
    locationId: query.locationId,
    page: query.page ?? 1,
    limit: query.limit ?? 20,
  };
}
