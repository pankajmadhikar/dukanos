import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { CatalogModule } from "../catalog/catalog.module";
import { DatabaseModule } from "../database/database.module";
import { InventoryModule } from "../inventory/inventory.module";
import { ProductSaleController, SalesController } from "./sales.controller";
import { SalesService } from "./sales.service";

@Module({
  imports: [DatabaseModule, AuditModule, CatalogModule, InventoryModule],
  controllers: [SalesController, ProductSaleController],
  providers: [SalesService],
  exports: [SalesService],
})
export class SalesModule {}
