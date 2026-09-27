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
import { ListLedgerQuery, ListSettlementPaymentsQuery, RecordSettlementDto } from "../payments/settlement.dto";
import { ManagePurchases } from "../purchases/purchase-access";
import { PurchaseService } from "../purchases/purchase.service";
import { canSeeSupplierMoney, ManageSuppliers, supplierActor } from "./supplier-access";
import { SupplierPaymentService } from "./supplier-payment.service";
import { CreateSupplierDto, ListSuppliersQuery, SupplierPurchaseQuery, UpdateSupplierDto } from "./dto/supplier.dto";
import { presentSupplier } from "./supplier.presenter";
import { supplierActiveFilter, SupplierService } from "./supplier.service";

function businessDateText(value: Date | null): string | null {
  if (!value) {
    return null;
  }
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

@ApiTags("suppliers")
@ApiBearerAuth("session")
@ApiUnauthorizedResponse({ description: "AUTH_REQUIRED when the session is missing." })
@ApiForbiddenResponse({ description: "TENANT_NOT_SELECTED or SUPPLIER_ACCESS_DENIED." })
@RequiresTenant()
@Controller({ path: "suppliers", version: "1" })
export class SupplierController {
  constructor(
    private readonly suppliers: SupplierService,
    private readonly supplierPayments: SupplierPaymentService,
    private readonly purchases: PurchaseService,
    private readonly context: RequestContextService,
  ) {}

  @Post()
  @ManageSuppliers()
  @ApiOperation({ summary: "Create a supplier", description: "Name is enough. The supplier belongs to the selected shop." })
  async create(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Body() body: CreateSupplierDto,
  ) {
    const actor = supplierActor(user, tenant);
    const data = await this.suppliers.create(actor, body);
    return { data: presentSupplier(data, actor.role), requestId: this.requestId() };
  }

  @Get()
  @ApiOperation({
    summary: "List suppliers",
    description: "Defaults to active suppliers. Cashiers do not receive the payable balance.",
  })
  async list(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: ListSuppliersQuery,
  ) {
    const actor = supplierActor(user, tenant);
    const page = await this.suppliers.list(actor, {
      search: query.search,
      isActive: supplierActiveFilter(query.isActive),
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
    return {
      data: page.data.map((row) => presentSupplier(row, actor.role)),
      pagination: page.pagination,
      requestId: this.requestId(),
    };
  }

  @Get(":supplierId/purchases")
  @ManagePurchases()
  @ApiOperation({ summary: "List purchases from one supplier" })
  @ApiNotFoundResponse({ description: "SUPPLIER_NOT_FOUND" })
  async purchasesForSupplier(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("supplierId") supplierId: string,
    @Query() query: SupplierPurchaseQuery,
  ) {
    const actor = supplierActor(user, tenant);
    const page = await this.purchases.list(actor, {
      supplierId,
      from: query.from,
      to: query.to,
      search: query.search,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
    return {
      data: page.data.map((row) => this.presentPurchaseList(row, actor.role)),
      pagination: page.pagination,
      requestId: this.requestId(),
    };
  }

  @Get(":supplierId/summary")
  @ManagePurchases()
  @ApiOperation({ summary: "Summarize confirmed purchases from one supplier" })
  async summary(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("supplierId") supplierId: string,
  ) {
    const actor = supplierActor(user, tenant);
    const summary = await this.suppliers.summary(actor, supplierId);
    const data: Record<string, unknown> = {
      purchaseCount: summary.purchaseCount,
      lastPurchaseDate: businessDateText(summary.lastPurchaseDate),
    };
    if (canSeeSupplierMoney(actor.role)) {
      data.totalPurchaseValue = formatMoney(summary.totalPurchaseValue);
    }
    return { data, requestId: this.requestId() };
  }

  @Post(":supplierId/payments")
  @ManageSuppliers()
  @HttpCode(201)
  @ApiOperation({
    summary: "Record a supplier payment",
    description:
      "Records cash or UPI the shopkeeper confirmed by hand. This reduces the payable. It does not change stock or purchases. Cashiers cannot record supplier payments.",
  })
  @ApiHeader({ name: "Idempotency-Key", required: false })
  @ApiConflictResponse({
    description: "PAYMENT_EXCEEDS_OUTSTANDING, SUPPLIER_INACTIVE, or IDEMPOTENCY_CONFLICT.",
  })
  @ApiForbiddenResponse({ description: "SUPPLIER_ACCESS_DENIED for a cashier." })
  @ApiNotFoundResponse({ description: "SUPPLIER_NOT_FOUND" })
  async recordPayment(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("supplierId") supplierId: string,
    @Body() body: RecordSettlementDto,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    const actor = supplierActor(user, tenant);
    const payment = await this.supplierPayments.record(actor, supplierId, body, idempotencyKey);
    return { data: payment, requestId: this.requestId() };
  }

  @Get(":supplierId/payments")
  @ManageSuppliers()
  @ApiOperation({ summary: "List supplier settlement payments" })
  @ApiNotFoundResponse({ description: "SUPPLIER_NOT_FOUND" })
  async payments(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("supplierId") supplierId: string,
    @Query() query: ListSettlementPaymentsQuery,
  ) {
    const actor = supplierActor(user, tenant);
    const page = await this.supplierPayments.list(actor, supplierId, {
      from: query.from,
      to: query.to,
      method: query.method,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
    return { data: page.data, pagination: page.pagination, requestId: this.requestId() };
  }

  @Get(":supplierId/ledger")
  @ManageSuppliers()
  @ApiOperation({
    summary: "Supplier ledger",
    description: "Chronological debit and credit lines. The running balance is the ledger sum.",
  })
  @ApiNotFoundResponse({ description: "SUPPLIER_NOT_FOUND" })
  async ledger(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("supplierId") supplierId: string,
    @Query() query: ListLedgerQuery,
  ) {
    const actor = supplierActor(user, tenant);
    const page = await this.supplierPayments.ledger(actor, supplierId, {
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
    return { data: page.data, pagination: page.pagination, requestId: this.requestId() };
  }

  @Get(":supplierId")
  @ApiOperation({ summary: "Supplier detail" })
  @ApiNotFoundResponse({ description: "SUPPLIER_NOT_FOUND" })
  async get(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("supplierId") supplierId: string,
  ) {
    const actor = supplierActor(user, tenant);
    const data = await this.suppliers.get(actor, supplierId);
    const settlement = canSeeSupplierMoney(actor.role)
      ? await this.supplierPayments.summary(actor, supplierId)
      : undefined;
    return { data: presentSupplier(data, actor.role, settlement), requestId: this.requestId() };
  }

  @Patch(":supplierId")
  @ManageSuppliers()
  @ApiOperation({
    summary: "Update a supplier",
    description: "Set isActive to false to deactivate. Historical purchases keep the supplier.",
  })
  async update(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("supplierId") supplierId: string,
    @Body() body: UpdateSupplierDto,
  ) {
    const actor = supplierActor(user, tenant);
    const data = await this.suppliers.update(actor, supplierId, body);
    return { data: presentSupplier(data, actor.role), requestId: this.requestId() };
  }

  private presentPurchaseList(
    row: {
      id: string;
      billNumber: string;
      businessDate: Date;
      grandTotal: Prisma.Decimal;
      status: string;
      supplierInvoiceNumber: string | null;
      supplier: { id: string; name: string } | null;
    },
    role: string | null,
  ) {
    const body: Record<string, unknown> = {
      id: row.id,
      purchaseNumber: row.billNumber,
      businessDate: businessDateText(row.businessDate),
      status: row.status,
      supplierInvoiceNumber: row.supplierInvoiceNumber,
      supplier: row.supplier ? { id: row.supplier.id, name: row.supplier.name } : null,
    };
    if (canSeeSupplierMoney(role)) {
      body.total = formatMoney(row.grandTotal);
    }
    return body;
  }

  private requestId(): string | null {
    return this.context.current()?.requestId ?? null;
  }
}
