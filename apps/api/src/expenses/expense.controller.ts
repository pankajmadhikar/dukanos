import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { CurrentTenant, CurrentTenantPrincipal } from "../common/decorators/current-tenant.decorator";
import { CurrentUser, CurrentUserPrincipal } from "../common/decorators/current-user.decorator";
import { RequiresTenant } from "../common/decorators/requires-tenant.decorator";
import { RequestContextService } from "../context/request-context.service";
import { expenseActor, ManageExpenses, ViewExpenses } from "./expense-access";
import { ExpenseCategoryService } from "./expense-category.service";
import { ExpenseService } from "./expense.service";
import {
  CreateExpenseCategoryDto,
  CreateExpenseDto,
  ExpenseSummaryQuery,
  ListExpenseCategoriesQuery,
  ListExpensesQuery,
  UpdateExpenseCategoryDto,
} from "./dto/expense.dto";

@ApiTags("expenses")
@ApiBearerAuth("session")
@ApiUnauthorizedResponse({ description: "AUTH_REQUIRED when the session is missing." })
@ApiForbiddenResponse({ description: "EXPENSE_ACCESS_DENIED for a cashier, or for a stock keeper on a change." })
@RequiresTenant()
@Controller({ path: "expenses", version: "1" })
export class ExpenseController {
  constructor(
    private readonly categories: ExpenseCategoryService,
    private readonly expenses: ExpenseService,
    private readonly context: RequestContextService,
  ) {}

  @Post("categories")
  @ManageExpenses()
  @HttpCode(201)
  @ApiOperation({ summary: "Create an expense category" })
  @ApiConflictResponse({ description: "CONFLICT when the name already exists in this shop." })
  async createCategory(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Body() body: CreateExpenseCategoryDto,
  ) {
    const actor = expenseActor(user, tenant);
    const data = await this.categories.create(actor, body);
    return { data, requestId: this.requestId() };
  }

  @Get("categories")
  @ViewExpenses()
  @ApiOperation({ summary: "List expense categories", description: "Defaults to active categories." })
  async listCategories(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: ListExpenseCategoriesQuery,
  ) {
    const actor = expenseActor(user, tenant);
    const data = await this.categories.list(actor, query.isActive);
    return { data, requestId: this.requestId() };
  }

  @Patch("categories/:categoryId")
  @ManageExpenses()
  @ApiOperation({ summary: "Rename an expense category" })
  @ApiNotFoundResponse({ description: "EXPENSE_CATEGORY_NOT_FOUND" })
  async updateCategory(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("categoryId") categoryId: string,
    @Body() body: UpdateExpenseCategoryDto,
  ) {
    const actor = expenseActor(user, tenant);
    const data = await this.categories.update(actor, categoryId, body);
    return { data, requestId: this.requestId() };
  }

  @Post("categories/:categoryId/deactivate")
  @ManageExpenses()
  @HttpCode(200)
  @ApiOperation({
    summary: "Deactivate an expense category",
    description: "Historical expenses keep the category. A new expense cannot use an inactive category.",
  })
  async deactivateCategory(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("categoryId") categoryId: string,
  ) {
    const actor = expenseActor(user, tenant);
    const data = await this.categories.deactivate(actor, categoryId);
    return { data, requestId: this.requestId() };
  }

  @Post()
  @ManageExpenses()
  @HttpCode(201)
  @ApiOperation({
    summary: "Record an expense",
    description:
      "Records a shop operating cost paid by cash or UPI. The shopkeeper confirms UPI by hand. This reduces net profit. It is not a sale and it is not a supplier payment. Posted expenses are not edited. The same Idempotency-Key returns the original expense.",
  })
  @ApiHeader({ name: "Idempotency-Key", required: false })
  @ApiConflictResponse({ description: "EXPENSE_CATEGORY_INACTIVE or IDEMPOTENCY_CONFLICT." })
  @ApiNotFoundResponse({ description: "EXPENSE_CATEGORY_NOT_FOUND" })
  async create(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Body() body: CreateExpenseDto,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    const actor = expenseActor(user, tenant);
    const data = await this.expenses.create(actor, body, idempotencyKey);
    return { data, requestId: this.requestId() };
  }

  @Get("summary")
  @ViewExpenses()
  @ApiOperation({
    summary: "Summarize expenses",
    description: "Totals for today, this week, this month, this year, or a custom shop business-date range.",
  })
  async summary(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: ExpenseSummaryQuery,
  ) {
    const actor = expenseActor(user, tenant);
    const data = await this.expenses.summary(actor, query);
    return { data, requestId: this.requestId() };
  }

  @Get()
  @ViewExpenses()
  @ApiOperation({ summary: "List expenses" })
  async list(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: ListExpensesQuery,
  ) {
    const actor = expenseActor(user, tenant);
    const page = await this.expenses.list(actor, {
      from: query.from,
      to: query.to,
      categoryId: query.categoryId,
      paymentMethod: query.paymentMethod,
      search: query.search,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
    return { data: page.data, pagination: page.pagination, requestId: this.requestId() };
  }

  @Get(":expenseId")
  @ViewExpenses()
  @ApiOperation({ summary: "Expense detail" })
  @ApiNotFoundResponse({ description: "EXPENSE_NOT_FOUND" })
  async get(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("expenseId") expenseId: string,
  ) {
    const actor = expenseActor(user, tenant);
    const data = await this.expenses.get(actor, expenseId);
    return { data, requestId: this.requestId() };
  }

  private requestId(): string | null {
    return this.context.current()?.requestId ?? null;
  }
}
