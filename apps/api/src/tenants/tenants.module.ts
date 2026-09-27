import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { DatabaseModule } from "../database/database.module";
import { TenantController } from "./tenant.controller";
import { TenantService } from "./tenant.service";

/**
 * Shop creation, listing, and selection.
 * Membership administration beyond the creating owner comes later.
 */
@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [TenantController],
  providers: [TenantService],
  exports: [TenantService],
})
export class TenantsModule {}
