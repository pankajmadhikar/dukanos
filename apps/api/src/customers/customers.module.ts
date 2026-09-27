import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { DatabaseModule } from "../database/database.module";
import { SalesModule } from "../sales/sales.module";
import { CustomerController } from "./customer.controller";
import { CustomerPaymentService } from "./customer-payment.service";
import { CustomerService } from "./customer.service";

@Module({
  imports: [DatabaseModule, AuditModule, SalesModule],
  controllers: [CustomerController],
  providers: [CustomerService, CustomerPaymentService],
})
export class CustomersModule {}
