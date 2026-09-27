import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { DatabaseModule } from "../database/database.module";
import { InventoryModule } from "../inventory/inventory.module";
import { SalesReturnsController } from "./sales-returns.controller";
import { SalesReturnService } from "./sales-return.service";

@Module({
  imports: [DatabaseModule, AuditModule, InventoryModule],
  controllers: [SalesReturnsController],
  providers: [SalesReturnService],
})
export class SalesReturnsModule {}
