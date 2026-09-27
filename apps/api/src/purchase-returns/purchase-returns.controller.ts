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
import { CreatePurchaseReturnDto, ListPurchaseReturnsQuery } from "./dto/purchase-return.dto";
import { ManagePurchaseReturns, purchaseReturnActor } from "./purchase-return-access";
import { presentPurchaseReturn } from "./purchase-return.presenter";
import { PurchaseReturnService } from "./purchase-return.service";

@ApiTags("purchase-returns")
@ApiBearerAuth("session")
@ApiUnauthorizedResponse({ description: "AUTH_REQUIRED when the session is missing." })
@ApiForbiddenResponse({ description: "TENANT_NOT_SELECTED or RETURN_NOT_ALLOWED. Cashiers cannot record returns." })
@RequiresTenant()
@ManagePurchaseReturns()
@Controller({ path: "purchases/returns", version: "1" })
export class PurchaseReturnsController {
  constructor(
    private readonly returns: PurchaseReturnService,
    private readonly context: RequestContextService,
  ) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: "Record a purchase return",
    description:
      "Posts a confirmed return against an existing purchase. Quantity and cost come from the original purchase lines. Stock decreases through the inventory ledger. The movement keeps the original purchase cost and the ledger leaves the average cost unchanged. The supplier payable is reduced. DukaanOS does not call a payment provider. The same Idempotency-Key returns the original return. A different body returns IDEMPOTENCY_CONFLICT. Any failure rolls the return, stock, and supplier ledger back together. Cashiers cannot create a return.",
  })
  @ApiHeader({ name: "Idempotency-Key", required: false })
  @ApiConflictResponse({
    description:
      "DUPLICATE_RETURN_LINE, RETURN_QUANTITY_EXCEEDS_REMAINING, RETURN_SOURCE_MISMATCH, RETURN_NOT_ALLOWED, PRODUCT_INACTIVE, INSUFFICIENT_STOCK, or IDEMPOTENCY_CONFLICT.",
  })
  @ApiNotFoundResponse({ description: "RETURN_SOURCE_NOT_FOUND or RETURN_LOCATION_INVALID." })
  async create(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Body() body: CreatePurchaseReturnDto,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    const actor = purchaseReturnActor(user, tenant);
    const row = await this.returns.create(actor, body, idempotencyKey);
    return { data: presentPurchaseReturn(row, actor.role, true), requestId: this.requestId() };
  }

  @Get()
  @ApiOperation({
    summary: "List purchase returns",
    description: "Filter by purchase, supplier, location, return number, or business date.",
  })
  async list(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: ListPurchaseReturnsQuery,
  ) {
    const actor = purchaseReturnActor(user, tenant);
    const page = await this.returns.list(actor, {
      purchaseId: query.purchaseId,
      supplierId: query.supplierId,
      locationId: query.locationId,
      returnNumber: query.returnNumber,
      from: query.from,
      to: query.to,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
    return {
      data: page.data.map((row) => presentPurchaseReturn(row, actor.role, false)),
      pagination: page.pagination,
      requestId: this.requestId(),
    };
  }

  @Get(":returnId")
  @ApiOperation({
    summary: "Purchase return detail",
    description: "Cost is the original purchase cost. Owners, admins, and stock keepers can see it.",
  })
  @ApiNotFoundResponse({ description: "RETURN_NOT_FOUND" })
  async get(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("returnId") returnId: string,
  ) {
    const actor = purchaseReturnActor(user, tenant);
    const row = await this.returns.get(actor, returnId);
    return { data: presentPurchaseReturn(row, actor.role, true), requestId: this.requestId() };
  }

  private requestId(): string | null {
    return this.context.current()?.requestId ?? null;
  }
}
