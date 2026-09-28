import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { CatalogModule } from "../catalog/catalog.module";
import { DatabaseModule } from "../database/database.module";
import { InventoryModule } from "../inventory/inventory.module";
import { PosCatalogController } from "./pos-catalog.controller";
import { PosCatalogService } from "./pos-catalog.service";
import { ProductSaleController, SalesController } from "./sales.controller";
import { SalesService } from "./sales.service";

@Module({
  imports: [DatabaseModule, AuditModule, CatalogModule, InventoryModule],
  controllers: [SalesController, ProductSaleController, PosCatalogController],
  providers: [SalesService, PosCatalogService],
  exports: [SalesService],
})
export class SalesModule {}
