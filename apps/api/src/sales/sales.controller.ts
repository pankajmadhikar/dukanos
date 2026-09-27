import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from "@nestjs/common";
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
import { CreateSaleDto, ListSalesQuery } from "./dto/sale.dto";
import { presentProductSale, presentSale } from "./sales.presenter";
import { saleActor } from "./sales-access";
import { SalesService } from "./sales.service";

@ApiTags("sales")
@ApiBearerAuth("session")
@ApiUnauthorizedResponse({ description: "AUTH_REQUIRED when the session is missing." })
@ApiForbiddenResponse({ description: "TENANT_NOT_SELECTED when no shop is selected." })
@RequiresTenant()
@Controller({ path: "sales", version: "1" })
export class SalesController {
  constructor(
    private readonly sales: SalesService,
    private readonly context: RequestContextService,
  ) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: "Record a sale",
    description:
      "Creates a completed bill. Selling prices come from the customer price or the catalog price. Each line posts one SALE movement through the inventory ledger. A new sale records only CASH or UPI after the shopkeeper confirms the money was received. DukaanOS does not verify UPI and does not call a payment provider. The unpaid remainder is a customer receivable. A walk-in sale must be paid in full. The same Idempotency-Key returns the original sale. A different body returns IDEMPOTENCY_CONFLICT. Any failure rolls the sale, stock, payment, and receivable back together. Cashiers do not receive cost or profit.",
  })
  @ApiHeader({ name: "Idempotency-Key", required: false })
  @ApiConflictResponse({
    description:
      "CUSTOMER_INACTIVE, CUSTOMER_REQUIRED_FOR_CREDIT, PRODUCT_INACTIVE, DUPLICATE_SALE_LINE, SALE_PRICE_MISMATCH, PAYMENT_EXCEEDS_SALE, INSUFFICIENT_STOCK, or IDEMPOTENCY_CONFLICT.",
  })
  @ApiNotFoundResponse({ description: "CUSTOMER_NOT_FOUND, PRODUCT_NOT_FOUND, or the location is not in this shop." })
  async create(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Body() body: CreateSaleDto,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    const actor = saleActor(user, tenant);
    const sale = await this.sales.create(actor, body, idempotencyKey);
    return { data: presentSale(sale, actor.role, true), requestId: this.requestId() };
  }

  @Get()
  @ApiOperation({
    summary: "List sales",
    description: "Filter by customer, location, business date, sale number, or payment method.",
  })
  async list(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: ListSalesQuery,
  ) {
    const actor = saleActor(user, tenant);
    const page = await this.sales.list(actor, {
      customerId: query.customerId,
      locationId: query.locationId,
      from: query.from,
      to: query.to,
      saleNumber: query.saleNumber,
      paymentMethod: query.paymentMethod,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
    return {
      data: page.data.map((row) => presentSale(row, actor.role, false)),
      pagination: page.pagination,
      requestId: this.requestId(),
    };
  }

  @Get(":saleId")
  @ApiOperation({
    summary: "Sale detail",
    description: "Line prices are the prices charged on this sale. Cost and gross profit are returned to owners and admins.",
  })
  @ApiNotFoundResponse({ description: "SALE_NOT_FOUND" })
  async get(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("saleId") saleId: string,
  ) {
    const actor = saleActor(user, tenant);
    const sale = await this.sales.get(actor, saleId);
    return { data: presentSale(sale, actor.role, true), requestId: this.requestId() };
  }

  private requestId(): string | null {
    return this.context.current()?.requestId ?? null;
  }
}

@ApiTags("sales")
@ApiBearerAuth("session")
@ApiUnauthorizedResponse({ description: "AUTH_REQUIRED when the session is missing." })
@ApiForbiddenResponse({ description: "TENANT_NOT_SELECTED when no shop is selected." })
@RequiresTenant()
@Controller({ path: "catalog/products", version: "1" })
export class ProductSaleController {
  constructor(
    private readonly sales: SalesService,
    private readonly context: RequestContextService,
  ) {}

  @Get(":productId/sales")
  @ApiOperation({
    summary: "Sale history for a product",
    description: "Historical selling price from each sale line. Cost is omitted for cashiers and stock keepers.",
  })
  @ApiNotFoundResponse({ description: "PRODUCT_NOT_FOUND" })
  async history(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("productId") productId: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    const actor = saleActor(user, tenant);
    const pageNumber = page ? Number(page) : 1;
    const limitNumber = limit ? Number(limit) : 20;
    const history = await this.sales.productHistory(
      actor,
      productId,
      Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : 1,
      Number.isInteger(limitNumber) && limitNumber > 0 ? Math.min(limitNumber, 100) : 20,
    );
    return {
      data: history.data.map((row) => presentProductSale(row, actor.role)),
      pagination: history.pagination,
      requestId: this.context.current()?.requestId ?? null,
    };
  }
}
