import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { DatabaseModule } from "../database/database.module";
import { InventoryModule } from "../inventory/inventory.module";
import { PurchaseReturnsController } from "./purchase-returns.controller";
import { PurchaseReturnService } from "./purchase-return.service";

@Module({
  imports: [DatabaseModule, AuditModule, InventoryModule],
  controllers: [PurchaseReturnsController],
  providers: [PurchaseReturnService],
})
export class PurchaseReturnsModule {}
