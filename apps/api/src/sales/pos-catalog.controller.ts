import { Controller, Get, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, Max, Min } from "class-validator";
import { CurrentTenant, CurrentTenantPrincipal } from "../common/decorators/current-tenant.decorator";
import { CurrentUser, CurrentUserPrincipal } from "../common/decorators/current-user.decorator";
import { RequiresTenant } from "../common/decorators/requires-tenant.decorator";
import { RequestContextService } from "../context/request-context.service";
import { saleActor } from "./sales-access";
import { PosCatalogService, posPage } from "./pos-catalog.service";

class PosPageQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

@ApiTags("pos")
@ApiBearerAuth("session")
@RequiresTenant()
@Controller({ path: "pos", version: "1" })
export class PosCatalogController {
  constructor(
    private readonly posCatalog: PosCatalogService,
    private readonly context: RequestContextService,
  ) {}

  @Get("catalog")
  @ApiOperation({
    summary: "Sellable products for this device",
    description:
      "Active products, barcodes, selling prices, and on-hand quantity at the shop's default location. Cost, profit, and stock value are not included. Pages are limited to 100.",
  })
  async catalog(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: PosPageQuery,
  ) {
    const data = await this.posCatalog.products(saleActor(user, tenant), posPage(query.page, query.limit));
    return { ...data, requestId: this.requestId() };
  }

  @Get("customers")
  @ApiOperation({
    summary: "Customers for selling",
    description: "Name, phone, and a snapshot of outstanding. This snapshot is not the ledger.",
  })
  async customers(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: PosPageQuery,
  ) {
    const data = await this.posCatalog.customers(saleActor(user, tenant), posPage(query.page, query.limit));
    return { ...data, requestId: this.requestId() };
  }

  @Get("customer-prices")
  @ApiOperation({
    summary: "Customer selling prices",
    description: "Prices already stored for a customer and product. The device must not invent prices.",
  })
  async customerPrices(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: PosPageQuery,
  ) {
    const data = await this.posCatalog.customerPrices(saleActor(user, tenant), posPage(query.page, query.limit));
    return { ...data, requestId: this.requestId() };
  }

  private requestId(): string | null {
    return this.context.current()?.requestId ?? null;
  }
}
