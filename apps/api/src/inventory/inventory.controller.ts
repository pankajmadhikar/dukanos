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
import {
  InventorySummaryQuery,
  ListInventoryQuery,
  MovementQuery,
  OpeningStockDto,
  StockAdjustmentDto,
} from "./dto/inventory.dto";
import { inventoryActor, ManageInventory } from "./inventory-access";
import { presentBalance, presentMovement, presentPost, presentSummary } from "./inventory-presenter";
import { InventoryService } from "./inventory.service";

@ApiTags("inventory")
@ApiBearerAuth("session")
@ApiUnauthorizedResponse({ description: "AUTH_REQUIRED when the session is missing." })
@ApiForbiddenResponse({
  description: "TENANT_NOT_SELECTED, TENANT_ACCESS_DENIED, or INVENTORY_ACCESS_DENIED.",
})
@RequiresTenant()
@Controller({ path: "inventory", version: "1" })
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly context: RequestContextService,
  ) {}

  @Post("opening")
  @HttpCode(201)
  @ManageInventory()
  @ApiOperation({
    summary: "Record opening stock",
    description:
      "Posts opening stock once for a product at a location. Requires a selected shop and an owner, admin, or stock keeper. Send Idempotency-Key to make a retry return the original result.",
  })
  @ApiHeader({ name: "Idempotency-Key", required: false })
  @ApiConflictResponse({
    description: "OPENING_STOCK_EXISTS, PRODUCT_INACTIVE, INSUFFICIENT_STOCK, or IDEMPOTENCY_CONFLICT.",
  })
  @ApiNotFoundResponse({ description: "PRODUCT_NOT_FOUND or the location is not in this shop." })
  async opening(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Body() body: OpeningStockDto,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    const actor = inventoryActor(user, tenant);
    const posted = await this.inventory.opening(actor, body, idempotencyKey);
    return { data: presentPost(posted, actor.role), requestId: this.requestId() };
  }

  @Post("adjustments")
  @HttpCode(201)
  @ManageInventory()
  @ApiOperation({
    summary: "Adjust stock",
    description:
      "Posts an inbound or outbound adjustment, damage, or expiry. Quantity is always positive. Outbound stock cannot go below zero. The same Idempotency-Key returns the original result. A reused key with a different body returns IDEMPOTENCY_CONFLICT.",
  })
  @ApiHeader({ name: "Idempotency-Key", required: false })
  @ApiConflictResponse({ description: "INSUFFICIENT_STOCK, PRODUCT_INACTIVE, or IDEMPOTENCY_CONFLICT." })
  async adjust(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Body() body: StockAdjustmentDto,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    const actor = inventoryActor(user, tenant);
    const posted = await this.inventory.adjust(actor, body, idempotencyKey);
    return { data: presentPost(posted, actor.role), requestId: this.requestId() };
  }

  @Get()
  @ApiOperation({
    summary: "List current stock",
    description:
      "Returns on-hand quantity by product and location. Cashiers receive quantity and selling price. Average cost and stock value are omitted for cashiers.",
  })
  async list(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: ListInventoryQuery,
  ) {
    const actor = inventoryActor(user, tenant);
    const page = await this.inventory.list(actor, {
      locationId: query.locationId,
      productId: query.productId,
      search: query.search,
      lowStock: query.lowStock === "true",
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
    return {
      data: page.data.map((row) => presentBalance(row, actor.role)),
      pagination: page.pagination,
      requestId: this.requestId(),
    };
  }

  @Get("summary")
  @ApiOperation({
    summary: "Summarize stock",
    description:
      "Counts products with stock, out of stock, and low stock. Stock value is included only for owner, admin, and stock keeper.",
  })
  async summary(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: InventorySummaryQuery,
  ) {
    const actor = inventoryActor(user, tenant);
    const data = await this.inventory.summary(actor, query.locationId);
    return { data: presentSummary(data, actor.role), requestId: this.requestId() };
  }

  @Get("products/:productId")
  @ApiOperation({
    summary: "Stock for one product",
    description: "Returns quantity at every active location in the selected shop, including zero.",
  })
  @ApiNotFoundResponse({ description: "PRODUCT_NOT_FOUND" })
  async product(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("productId") productId: string,
  ) {
    const actor = inventoryActor(user, tenant);
    const detail = await this.inventory.product(actor, productId);
    return {
      data: {
        product: {
          id: detail.product.id,
          name: detail.product.name,
          sku: detail.product.sku,
          unit: detail.product.unit,
          isActive: detail.product.isActive,
          sellingPrice: detail.locations[0]
            ? presentBalance(detail.locations[0], actor.role).sellingPrice
            : null,
        },
        locations: detail.locations.map((row) => presentBalance(row, actor.role)),
      },
      requestId: this.requestId(),
    };
  }

  @Get("products/:productId/movements")
  @ApiOperation({
    summary: "Stock movement history",
    description:
      "Read-only ledger history. Filters use the shop business date. Cashiers do not receive unit cost.",
  })
  @ApiNotFoundResponse({ description: "PRODUCT_NOT_FOUND" })
  async movements(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("productId") productId: string,
    @Query() query: MovementQuery,
  ) {
    const actor = inventoryActor(user, tenant);
    const page = await this.inventory.movements(actor, productId, {
      locationId: query.locationId,
      movementType: query.movementType,
      from: query.from,
      to: query.to,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
    return {
      data: page.data.map((row) => presentMovement(row, actor.role)),
      pagination: page.pagination,
      requestId: this.requestId(),
    };
  }

  private requestId(): string | null {
    return this.context.current()?.requestId ?? null;
  }
}
