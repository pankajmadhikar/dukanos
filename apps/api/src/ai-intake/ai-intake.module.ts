import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { AppConfigService } from "../common/config/app-config.service";
import { CatalogModule } from "../catalog/catalog.module";
import { DatabaseModule } from "../database/database.module";
import { InventoryModule } from "../inventory/inventory.module";
import { PurchasesModule } from "../purchases/purchases.module";
import { AiIntakeController } from "./ai-intake.controller";
import { MockStorageController } from "./mock-storage.controller";
import { AiIntakeRateLimiter } from "./ai-intake-rate-limiter";
import { AiIntakeQueue } from "./ai-intake.queue";
import { AiIntakeService } from "./ai-intake.service";
import { AiIntakeWorker } from "./ai-intake.worker";
import { AI_PRODUCT_INTAKE_PROVIDER } from "./ai-product-intake.provider";
import { MockAiProductIntakeProvider } from "./mock-ai-product-intake.provider";
import { OpenAiVisionIntakeProvider } from "./openai-vision-intake.provider";
import { MockObjectStorage, OBJECT_STORAGE } from "./object-storage";
import { S3ObjectStorage } from "./s3-object-storage";

/**
 * Draft intake. The provider only analyzes media. Confirmation calls the
 * catalog and either opening stock or purchases. It does not post the ledger itself.
 * Tests and development use the mock provider and mock storage. Production
 * refuses that fallback in configuration.
 */
@Module({
  imports: [DatabaseModule, AuditModule, CatalogModule, InventoryModule, PurchasesModule],
  controllers: [AiIntakeController, MockStorageController],
  providers: [
    AiIntakeService,
    AiIntakeQueue,
    AiIntakeWorker,
    AiIntakeRateLimiter,
    MockAiProductIntakeProvider,
    MockObjectStorage,
    {
      provide: AI_PRODUCT_INTAKE_PROVIDER,
      useFactory: (config: AppConfigService, mock: MockAiProductIntakeProvider) => {
        if (config.ai.provider === "openai") {
          return new OpenAiVisionIntakeProvider({
            apiKey: config.ai.apiKey,
            model: config.ai.model,
            baseUrl: config.ai.baseUrl,
          });
        }
        return mock;
      },
      inject: [AppConfigService, MockAiProductIntakeProvider],
    },
    {
      provide: OBJECT_STORAGE,
      useFactory: (config: AppConfigService, mock: MockObjectStorage) => {
        if (config.storage.provider === "s3") {
          return new S3ObjectStorage({
            bucket: config.storage.bucket,
            region: config.storage.region,
            endpoint: config.storage.endpoint || undefined,
            accessKeyId: config.storage.accessKeyId,
            secretAccessKey: config.storage.secretAccessKey,
          });
        }
        return mock;
      },
      inject: [AppConfigService, MockObjectStorage],
    },
  ],
})
export class AiIntakeModule {}
