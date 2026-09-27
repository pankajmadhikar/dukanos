import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { CatalogModule } from "../catalog/catalog.module";
import { DatabaseModule } from "../database/database.module";
import { InventoryModule } from "../inventory/inventory.module";
import { PurchasesModule } from "../purchases/purchases.module";
import { AiIntakeController } from "./ai-intake.controller";
import { AiIntakeService } from "./ai-intake.service";
import { AI_PRODUCT_INTAKE_PROVIDER } from "./ai-product-intake.provider";
import { MockAiProductIntakeProvider } from "./mock-ai-product-intake.provider";
import { MockObjectStorage, OBJECT_STORAGE } from "./object-storage";

/**
 * Draft intake. The provider only analyzes media. Confirmation calls the
 * catalog and either opening stock or purchases. It does not post the ledger itself.
 */
@Module({
  imports: [DatabaseModule, AuditModule, CatalogModule, InventoryModule, PurchasesModule],
  controllers: [AiIntakeController],
  providers: [
    AiIntakeService,
    MockAiProductIntakeProvider,
    MockObjectStorage,
    { provide: AI_PRODUCT_INTAKE_PROVIDER, useExisting: MockAiProductIntakeProvider },
    { provide: OBJECT_STORAGE, useExisting: MockObjectStorage },
  ],
})
export class AiIntakeModule {}
