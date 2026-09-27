import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { DatabaseModule } from "../database/database.module";
import { InventoryModule } from "../inventory/inventory.module";
import { ProductPurchaseController, PurchaseController } from "./purchase.controller";
import { PurchaseService } from "./purchase.service";

@Module({
  imports: [DatabaseModule, AuditModule, InventoryModule],
  controllers: [PurchaseController, ProductPurchaseController],
  providers: [PurchaseService],
  exports: [PurchaseService],
})
export class PurchasesModule {}
