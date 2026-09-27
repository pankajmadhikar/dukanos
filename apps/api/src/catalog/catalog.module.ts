import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { DatabaseModule } from "../database/database.module";
import {
  BrandController,
  CategoryController,
  ProductController,
  UnitController,
} from "./catalog.controller";
import { BrandService, CategoryService, UnitService } from "./master-data.service";
import { ProductPricingService } from "./product-pricing.service";
import { ProductService } from "./product.service";

/** Products, categories, brands, units, barcodes, and prices. No stock posting. */
@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [ProductController, UnitController, CategoryController, BrandController],
  providers: [
    ProductService,
    ProductPricingService,
    UnitService,
    CategoryService,
    BrandService,
  ],
  exports: [ProductService, ProductPricingService],
})
export class CatalogModule {}
