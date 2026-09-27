import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import { Prisma } from "@prisma/client";
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
import { formatMoney } from "../catalog/decimal";
import { CurrentTenant, CurrentTenantPrincipal } from "../common/decorators/current-tenant.decorator";
import { CurrentUser, CurrentUserPrincipal } from "../common/decorators/current-user.decorator";
import { RequiresTenant } from "../common/decorators/requires-tenant.decorator";
import { RequestContextService } from "../context/request-context.service";
import { SalesService } from "../sales/sales.service";
import { customerActor } from "./customer-access";
import { CustomerPaymentService } from "./customer-payment.service";
import { presentCustomer } from "./customer.presenter";
import { customerActiveFilter, CustomerService } from "./customer.service";
import { CreateCustomerDto, CustomerSalesQuery, ListCustomersQuery, UpdateCustomerDto } from "./dto/customer.dto";
import { ListLedgerQuery, ListSettlementPaymentsQuery, RecordSettlementDto } from "../payments/settlement.dto";

function businessDateText(value: Date | null): string | null {
  if (!value) {
    return null;
  }
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

@ApiTags("customers")
@ApiBearerAuth("session")
@ApiUnauthorizedResponse({ description: "AUTH_REQUIRED when the session is missing." })
@ApiForbiddenResponse({ description: "TENANT_NOT_SELECTED when no shop is selected." })
@RequiresTenant()
@Controller({ path: "customers", version: "1" })
export class CustomerController {
  constructor(
    private readonly customers: CustomerService,
    private readonly customerPayments: CustomerPaymentService,
    private readonly sales: SalesService,
    private readonly context: RequestContextService,
  ) {}

  @Post()
  @ApiOperation({
    summary: "Create a customer",
    description: "Name is enough. Email, address, and credit limit are not required.",
  })
  async create(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Body() body: CreateCustomerDto,
  ) {
    const actor = customerActor(user, tenant);
    const data = await this.customers.create(actor, body);
    return { data: presentCustomer(data), requestId: this.requestId() };
  }

  @Get()
  @ApiOperation({
    summary: "List customers",
    description: "Defaults to active customers. Search matches name and phone.",
  })
  async list(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: ListCustomersQuery,
  ) {
    const actor = customerActor(user, tenant);
    const page = await this.customers.list(actor, {
      search: query.search,
      isActive: customerActiveFilter(query.isActive),
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
    return {
      data: page.data.map((row) => presentCustomer(row)),
      pagination: page.pagination,
      requestId: this.requestId(),
    };
  }

  @Get(":customerId/sales")
  @ApiOperation({ summary: "List sales for one customer" })
  @ApiNotFoundResponse({ description: "CUSTOMER_NOT_FOUND" })
  async salesForCustomer(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("customerId") customerId: string,
    @Query() query: CustomerSalesQuery,
  ) {
    const actor = customerActor(user, tenant);
    const page = await this.sales.list(actor, {
      customerId,
      from: query.from,
      to: query.to,
      saleNumber: query.saleNumber,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
    return {
      data: page.data.map((row) => this.presentHistory(row)),
      pagination: page.pagination,
      requestId: this.requestId(),
    };
  }

  @Get(":customerId/summary")
  @ApiOperation({ summary: "Summarize completed sales and the current receivable" })
  @ApiNotFoundResponse({ description: "CUSTOMER_NOT_FOUND" })
  async summary(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("customerId") customerId: string,
  ) {
    const actor = customerActor(user, tenant);
    const summary = await this.customers.summary(actor, customerId);
    return {
      data: {
        saleCount: summary.saleCount,
        totalSales: formatMoney(summary.totalSales),
        outstanding: formatMoney(summary.outstanding),
        lastSaleDate: businessDateText(summary.lastSaleDate),
      },
      requestId: this.requestId(),
    };
  }

  @Post(":customerId/payments")
  @HttpCode(201)
  @ApiOperation({
    summary: "Record a customer payment",
    description:
      "Records cash or UPI the shopkeeper confirmed by hand. This reduces the receivable. It does not increase sales. DukaanOS does not verify UPI and does not call a payment provider. The same Idempotency-Key returns the original payment.",
  })
  @ApiHeader({ name: "Idempotency-Key", required: false })
  @ApiConflictResponse({
    description: "PAYMENT_EXCEEDS_OUTSTANDING, CUSTOMER_INACTIVE, or IDEMPOTENCY_CONFLICT.",
  })
  @ApiNotFoundResponse({ description: "CUSTOMER_NOT_FOUND" })
  async recordPayment(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("customerId") customerId: string,
    @Body() body: RecordSettlementDto,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    const actor = customerActor(user, tenant);
    const payment = await this.customerPayments.record(actor, customerId, body, idempotencyKey);
    return { data: payment, requestId: this.requestId() };
  }

  @Get(":customerId/payments")
  @ApiOperation({
    summary: "List customer settlement payments",
    description: "Later receipts only. Payments taken on a sale stay on that sale.",
  })
  @ApiNotFoundResponse({ description: "CUSTOMER_NOT_FOUND" })
  async payments(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("customerId") customerId: string,
    @Query() query: ListSettlementPaymentsQuery,
  ) {
    const actor = customerActor(user, tenant);
    const page = await this.customerPayments.list(actor, customerId, {
      from: query.from,
      to: query.to,
      method: query.method,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
    return { data: page.data, pagination: page.pagination, requestId: this.requestId() };
  }

  @Get(":customerId/ledger")
  @ApiOperation({
    summary: "Customer ledger",
    description: "Chronological debit and credit lines. The running balance is the ledger sum.",
  })
  @ApiNotFoundResponse({ description: "CUSTOMER_NOT_FOUND" })
  async ledger(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("customerId") customerId: string,
    @Query() query: ListLedgerQuery,
  ) {
    const actor = customerActor(user, tenant);
    const page = await this.customerPayments.ledger(actor, customerId, {
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
    return { data: page.data, pagination: page.pagination, requestId: this.requestId() };
  }

  @Get(":customerId")
  @ApiOperation({ summary: "Customer detail" })
  @ApiNotFoundResponse({ description: "CUSTOMER_NOT_FOUND" })
  async get(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("customerId") customerId: string,
  ) {
    const actor = customerActor(user, tenant);
    const data = await this.customers.get(actor, customerId);
    const settlement = await this.customerPayments.summary(actor, customerId);
    return { data: presentCustomer(data, settlement), requestId: this.requestId() };
  }

  @Patch(":customerId")
  @ApiOperation({
    summary: "Update a customer",
    description: "Set isActive to false to deactivate. Historical sales keep the customer.",
  })
  async update(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("customerId") customerId: string,
    @Body() body: UpdateCustomerDto,
  ) {
    const actor = customerActor(user, tenant);
    const data = await this.customers.update(actor, customerId, body);
    return { data: presentCustomer(data), requestId: this.requestId() };
  }

  private presentHistory(row: {
    id: string;
    billNumber: string;
    businessDate: Date;
    grandTotal: Prisma.Decimal;
    paid: Prisma.Decimal;
    outstanding: Prisma.Decimal;
    paymentStatus: string;
  }) {
    return {
      id: row.id,
      saleNumber: row.billNumber,
      businessDate: businessDateText(row.businessDate),
      total: formatMoney(row.grandTotal),
      paid: formatMoney(row.paid),
      outstanding: formatMoney(row.outstanding),
      paymentStatus: row.paymentStatus,
    };
  }

  private requestId(): string | null {
    return this.context.current()?.requestId ?? null;
  }
}
