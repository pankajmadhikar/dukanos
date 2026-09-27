import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { CurrentTenant, CurrentTenantPrincipal } from "../common/decorators/current-tenant.decorator";
import { CurrentUser, CurrentUserPrincipal } from "../common/decorators/current-user.decorator";
import { RequiresTenant } from "../common/decorators/requires-tenant.decorator";
import { RequestContextService } from "../context/request-context.service";
import { activeFilter, catalogActor, ManageCatalog } from "./catalog-access";
import { parseMoney } from "./decimal";
import {
  CreateBarcodeDto,
  CreateBrandDto,
  CreateCategoryDto,
  CreateProductDto,
  CreateUnitDto,
  CustomerPriceDto,
  ListMasterQuery,
  ListProductsQuery,
  UpdateBarcodeDto,
  UpdateBrandDto,
  UpdateCategoryDto,
  UpdateProductDto,
  UpdateUnitDto,
} from "./dto/catalog.dto";
import { BrandService, CategoryService, UnitService } from "./master-data.service";
import { ProductService } from "./product.service";

@ApiTags("catalog")
@ApiBearerAuth("session")
@ApiUnauthorizedResponse({ description: "AUTH_REQUIRED" })
@ApiForbiddenResponse({ description: "CATALOG_ACCESS_DENIED or TENANT_ACCESS_DENIED" })
@RequiresTenant()
@Controller({ path: "catalog/products", version: "1" })
export class ProductController {
  constructor(
    private readonly products: ProductService,
    private readonly context: RequestContextService,
  ) {}

  @Get("barcode/:barcode")
  @ApiNotFoundResponse({ description: "PRODUCT_NOT_FOUND" })
  async lookupBarcode(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("barcode") barcode: string,
  ) {
    const data = await this.products.lookupBarcode(catalogActor(user, tenant), barcode);
    return { data, requestId: this.requestId() };
  }

  @Get()
  async list(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: ListProductsQuery,
  ) {
    const page = await this.products.list(catalogActor(user, tenant), {
      search: query.search,
      categoryId: query.categoryId,
      brandId: query.brandId,
      isActive: activeFilter(query.isActive),
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
    return { ...page, requestId: this.requestId() };
  }

  @Post()
  @ManageCatalog()
  @HttpCode(201)
  async create(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Body() body: CreateProductDto,
  ) {
    const data = await this.products.create(catalogActor(user, tenant), body);
    return { data, requestId: this.requestId() };
  }

  @Get(":id/barcodes")
  async listBarcodes(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("id") id: string,
  ) {
    const data = await this.products.listBarcodes(catalogActor(user, tenant), id);
    return { data, requestId: this.requestId() };
  }

  @Post(":id/barcodes")
  @ManageCatalog()
  @HttpCode(201)
  async addBarcode(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("id") id: string,
    @Body() body: CreateBarcodeDto,
  ) {
    const data = await this.products.addBarcode(catalogActor(user, tenant), id, body);
    return { data, requestId: this.requestId() };
  }

  @Patch(":id/barcodes/:barcodeId")
  @ManageCatalog()
  async updateBarcode(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("id") id: string,
    @Param("barcodeId") barcodeId: string,
    @Body() body: UpdateBarcodeDto,
  ) {
    const data = await this.products.updateBarcode(
      catalogActor(user, tenant),
      id,
      barcodeId,
      body.isPrimary,
    );
    return { data, requestId: this.requestId() };
  }

  @Delete(":id/barcodes/:barcodeId")
  @ManageCatalog()
  @HttpCode(200)
  async removeBarcode(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("id") id: string,
    @Param("barcodeId") barcodeId: string,
  ) {
    await this.products.removeBarcode(catalogActor(user, tenant), id, barcodeId);
    return { data: { status: "removed" }, requestId: this.requestId() };
  }

  @Post(":id/customer-prices")
  @ManageCatalog()
  @HttpCode(200)
  @ApiOperation({
    summary: "Set a customer selling price",
    description:
      "Stores the price this customer pays for the product. Cashiers cannot change it. A sale reads this price and does not trust a client total.",
  })
  async customerPrice(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("id") id: string,
    @Body() body: CustomerPriceDto,
  ) {
    await this.products.setCustomerPrice(catalogActor(user, tenant), id, body.customerId, parseMoney(body.sellingPrice));
    return { data: { productId: id, customerId: body.customerId, sellingPrice: body.sellingPrice }, requestId: this.requestId() };
  }

  @Get(":id/price-history")
  async priceHistory(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("id") id: string,
  ) {
    const data = await this.products.priceHistory(catalogActor(user, tenant), id);
    return { data, requestId: this.requestId() };
  }

  @Post(":id/deactivate")
  @ManageCatalog()
  @HttpCode(200)
  async deactivate(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("id") id: string,
  ) {
    const data = await this.products.setActive(catalogActor(user, tenant), id, false);
    return { data, requestId: this.requestId() };
  }

  @Post(":id/reactivate")
  @ManageCatalog()
  @HttpCode(200)
  async reactivate(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("id") id: string,
  ) {
    const data = await this.products.setActive(catalogActor(user, tenant), id, true);
    return { data, requestId: this.requestId() };
  }

  @Get(":id")
  @ApiNotFoundResponse({ description: "PRODUCT_NOT_FOUND" })
  async get(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("id") id: string,
  ) {
    const data = await this.products.get(catalogActor(user, tenant), id);
    return { data, requestId: this.requestId() };
  }

  @Patch(":id")
  @ManageCatalog()
  async update(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("id") id: string,
    @Body() body: UpdateProductDto,
  ) {
    const data = await this.products.update(catalogActor(user, tenant), id, body);
    return { data, requestId: this.requestId() };
  }

  private requestId(): string | null {
    return this.context.current()?.requestId ?? null;
  }
}

@ApiTags("catalog")
@ApiBearerAuth("session")
@RequiresTenant()
@Controller({ path: "catalog/units", version: "1" })
export class UnitController {
  constructor(
    private readonly units: UnitService,
    private readonly context: RequestContextService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: ListMasterQuery,
  ) {
    const active = activeFilter(query.isActive);
    const data = await this.units.list(catalogActor(user, tenant), active === null ? undefined : active);
    return { data, requestId: this.requestId() };
  }

  @Post()
  @ManageCatalog()
  @HttpCode(201)
  async create(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Body() body: CreateUnitDto,
  ) {
    const data = await this.units.create(catalogActor(user, tenant), body);
    return { data, requestId: this.requestId() };
  }

  @Patch(":id")
  @ManageCatalog()
  async update(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("id") id: string,
    @Body() body: UpdateUnitDto,
  ) {
    const data = await this.units.update(catalogActor(user, tenant), id, body);
    return { data, requestId: this.requestId() };
  }

  private requestId(): string | null {
    return this.context.current()?.requestId ?? null;
  }
}

@ApiTags("catalog")
@ApiBearerAuth("session")
@RequiresTenant()
@Controller({ path: "catalog/categories", version: "1" })
export class CategoryController {
  constructor(
    private readonly categories: CategoryService,
    private readonly context: RequestContextService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: ListMasterQuery,
  ) {
    const active = activeFilter(query.isActive);
    const data = await this.categories.list(
      catalogActor(user, tenant),
      active === null ? undefined : active,
    );
    return { data, requestId: this.requestId() };
  }

  @Post()
  @ManageCatalog()
  @HttpCode(201)
  async create(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Body() body: CreateCategoryDto,
  ) {
    const data = await this.categories.create(catalogActor(user, tenant), body);
    return { data, requestId: this.requestId() };
  }

  @Patch(":id")
  @ManageCatalog()
  async update(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("id") id: string,
    @Body() body: UpdateCategoryDto,
  ) {
    const data = await this.categories.update(catalogActor(user, tenant), id, body);
    return { data, requestId: this.requestId() };
  }

  private requestId(): string | null {
    return this.context.current()?.requestId ?? null;
  }
}

@ApiTags("catalog")
@ApiBearerAuth("session")
@RequiresTenant()
@Controller({ path: "catalog/brands", version: "1" })
export class BrandController {
  constructor(
    private readonly brands: BrandService,
    private readonly context: RequestContextService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Query() query: ListMasterQuery,
  ) {
    const active = activeFilter(query.isActive);
    const data = await this.brands.list(catalogActor(user, tenant), active === null ? undefined : active);
    return { data, requestId: this.requestId() };
  }

  @Post()
  @ManageCatalog()
  @HttpCode(201)
  async create(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Body() body: CreateBrandDto,
  ) {
    const data = await this.brands.create(catalogActor(user, tenant), body);
    return { data, requestId: this.requestId() };
  }

  @Patch(":id")
  @ManageCatalog()
  async update(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("id") id: string,
    @Body() body: UpdateBrandDto,
  ) {
    const data = await this.brands.update(catalogActor(user, tenant), id, body);
    return { data, requestId: this.requestId() };
  }

  private requestId(): string | null {
    return this.context.current()?.requestId ?? null;
  }
}
