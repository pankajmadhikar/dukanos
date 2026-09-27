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
import { CreateSaleReturnDto, ListSaleReturnsQuery } from "./dto/sales-return.dto";
import { ManageSaleReturns, saleReturnActor } from "./sales-return-access";
import { presentSaleReturn } from "./sales-return.presenter";
import { SalesReturnService } from "./sales-return.service";

@ApiTags("sales-returns")
@ApiBearerAuth("session")
@ApiUnauthorizedResponse({ description: "AUTH_REQUIRED when the session is missing." })
@ApiForbiddenResponse({ description: "TENANT_NOT_SELECTED or RETURN_NOT_ALLOWED. Cashiers cannot record returns." })
@RequiresTenant()
@ManageSaleReturns()
@Controller({ path: "sales/returns", version: "1" })
export class SalesReturnsController {
  constructor(
    private readonly returns: SalesReturnService,
    private readonly context: RequestContextService,
  ) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: "Record a sales return",
    description:
      "Posts a confirmed return against an existing sale. Quantities and prices come from the original sale lines. Stock increases through the inventory ledger at the original sale cost. The customer's receivable is reduced first. Any remainder is recorded as cash returned to the customer. DukaanOS does not call a payment provider. The same Idempotency-Key returns the original return. A different body returns IDEMPOTENCY_CONFLICT. Any failure rolls the return, stock, ledger, and refund record back together. Cashiers cannot create a return. Cost and profit are omitted for stock keepers.",
  })
  @ApiHeader({ name: "Idempotency-Key", required: false })
  @ApiConflictResponse({
    description:
      "DUPLICATE_RETURN_LINE, RETURN_QUANTITY_EXCEEDS_REMAINING, RETURN_SOURCE_MISMATCH, RETURN_NOT_ALLOWED, PRODUCT_INACTIVE, or IDEMPOTENCY_CONFLICT.",
  })
  @ApiNotFoundResponse({ description: "RETURN_SOURCE_NOT_FOUND or RETURN_LOCATION_INVALID." })
  async create(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Body() body: CreateSaleReturnDto,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    const actor = saleReturnActor(user, tenant);
    const row = await this.returns.create(actor, body, idempotencyKey);
    return { data: presentSaleReturn(row, actor.role, true), requestId: this.requestId() };
  }

  @Get()
  @ApiOperation({
    summary: "List sales returns",
    description: "Filter by sale, customer, location, return number, or business date.",
  })
  async list(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: ListSaleReturnsQuery,
  ) {
    const actor = saleReturnActor(user, tenant);
    const page = await this.returns.list(actor, {
      saleId: query.saleId,
      customerId: query.customerId,
      locationId: query.locationId,
      returnNumber: query.returnNumber,
      from: query.from,
      to: query.to,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
    return {
      data: page.data.map((row) => presentSaleReturn(row, actor.role, false)),
      pagination: page.pagination,
      requestId: this.requestId(),
    };
  }

  @Get(":returnId")
  @ApiOperation({
    summary: "Sales return detail",
    description: "Prices are the original sale prices. Cost is returned to owners and admins.",
  })
  @ApiNotFoundResponse({ description: "RETURN_NOT_FOUND" })
  async get(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("returnId") returnId: string,
  ) {
    const actor = saleReturnActor(user, tenant);
    const row = await this.returns.get(actor, returnId);
    return { data: presentSaleReturn(row, actor.role, true), requestId: this.requestId() };
  }

  private requestId(): string | null {
    return this.context.current()?.requestId ?? null;
  }
}
