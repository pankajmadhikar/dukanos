import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { DatabaseModule } from "../database/database.module";
import { PurchasesModule } from "../purchases/purchases.module";
import { SupplierController } from "./supplier.controller";
import { SupplierPaymentService } from "./supplier-payment.service";
import { SupplierService } from "./supplier.service";

@Module({
  imports: [DatabaseModule, AuditModule, PurchasesModule],
  controllers: [SupplierController],
  providers: [SupplierService, SupplierPaymentService],
})
export class SuppliersModule {}