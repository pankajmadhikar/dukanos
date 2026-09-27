import { Module } from "@nestjs/common";
import { DatabaseHealthIndicator } from "./database-health.indicator";
import { PrismaService } from "./prisma.service";
import { TenantTransactionService } from "./tenant-transaction.service";

@Module({
  providers: [PrismaService, TenantTransactionService, DatabaseHealthIndicator],
  exports: [TenantTransactionService, DatabaseHealthIndicator],
})
export class DatabaseModule {}
