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
import { CreatePurchaseDto, ListPurchasesQuery } from "./dto/purchase.dto";
import { ManagePurchases, purchaseActor } from "./purchase-access";
import { presentProductPurchase, presentPurchase } from "./purchase.presenter";
import { PurchaseService } from "./purchase.service";

@ApiTags("purchases")
@ApiBearerAuth("session")
@ApiUnauthorizedResponse({ description: "AUTH_REQUIRED when the session is missing." })
@ApiForbiddenResponse({ description: "TENANT_NOT_SELECTED or PURCHASE_ACCESS_DENIED." })
@RequiresTenant()
@ManagePurchases()
@Controller({ path: "purchases", version: "1" })
export class PurchaseController {
  constructor(
    private readonly purchases: PurchaseService,
    private readonly context: RequestContextService,
  ) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: "Record a purchase",
    description:
      "Creates a confirmed purchase, posts one PURCHASE movement per item through the inventory ledger, and records the unpaid amount as supplier payable. Same Idempotency-Key returns the original purchase. A different body returns IDEMPOTENCY_CONFLICT. The whole purchase rolls back if any item fails.",
  })
  @ApiHeader({ name: "Idempotency-Key", required: false })
  @ApiConflictResponse({
    description: "SUPPLIER_INACTIVE, PRODUCT_INACTIVE, DUPLICATE_PURCHASE_LINE, or IDEMPOTENCY_CONFLICT.",
  })
  @ApiNotFoundResponse({ description: "SUPPLIER_NOT_FOUND, PRODUCT_NOT_FOUND, or the location is not in this shop." })
  async create(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Body() body: CreatePurchaseDto,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    const actor = purchaseActor(user, tenant);
    const purchase = await this.purchases.create(actor, body, idempotencyKey);
    return { data: presentPurchase(purchase, actor.role, true), requestId: this.requestId() };
  }

  @Get()
  @ApiOperation({
    summary: "List purchases",
    description: "Filter by supplier, location, business date, purchase number, invoice, or supplier name.",
  })
  async list(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: ListPurchasesQuery,
  ) {
    const actor = purchaseActor(user, tenant);
    const page = await this.purchases.list(actor, {
      supplierId: query.supplierId,
      locationId: query.locationId,
      from: query.from,
      to: query.to,
      search: query.search,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
    return {
      data: page.data.map((row) => presentPurchase(row, actor.role, false)),
      pagination: page.pagination,
      requestId: this.requestId(),
    };
  }

  @Get(":purchaseId")
  @ApiOperation({
    summary: "Purchase detail",
    description: "Line costs come from the purchase item, not the current catalog price.",
  })
  @ApiNotFoundResponse({ description: "PURCHASE_NOT_FOUND" })
  async get(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("purchaseId") purchaseId: string,
  ) {
    const actor = purchaseActor(user, tenant);
    const purchase = await this.purchases.get(actor, purchaseId);
    return { data: presentPurchase(purchase, actor.role, true), requestId: this.requestId() };
  }

  private requestId(): string | null {
    return this.context.current()?.requestId ?? null;
  }
}

@ApiTags("purchases")
@ApiBearerAuth("session")
@ApiUnauthorizedResponse({ description: "AUTH_REQUIRED when the session is missing." })
@ApiForbiddenResponse({ description: "PURCHASE_ACCESS_DENIED" })
@RequiresTenant()
@ManagePurchases()
@Controller({ path: "catalog/products", version: "1" })
export class ProductPurchaseController {
  constructor(
    private readonly purchases: PurchaseService,
    private readonly context: RequestContextService,
  ) {}

  @Get(":productId/purchases")
  @ApiOperation({
    summary: "Purchase history for a product",
    description: "Historical unit cost from each purchase line. Cashiers cannot read purchase cost.",
  })
  @ApiNotFoundResponse({ description: "PRODUCT_NOT_FOUND" })
  async history(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("productId") productId: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    const actor = purchaseActor(user, tenant);
    const pageNumber = page ? Number(page) : 1;
    const limitNumber = limit ? Number(limit) : 20;
    const history = await this.purchases.productHistory(
      actor,
      productId,
      Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : 1,
      Number.isInteger(limitNumber) && limitNumber > 0 ? Math.min(limitNumber, 100) : 20,
    );
    return {
      data: history.data.map((row) => presentProductPurchase(row, actor.role)),
      pagination: history.pagination,
      requestId: this.context.current()?.requestId ?? null,
    };
  }
}
