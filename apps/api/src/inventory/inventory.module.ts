import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { DatabaseModule } from "../database/database.module";
import { InventoryController } from "./inventory.controller";
import { InventoryLedgerService } from "./inventory-ledger.service";
import { InventoryService } from "./inventory.service";

@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [InventoryController],
  providers: [InventoryLedgerService, InventoryService],
  exports: [InventoryLedgerService, InventoryService],
})
export class InventoryModule {}
