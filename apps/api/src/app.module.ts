import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";
import { AiIntakeModule } from "./ai-intake/ai-intake.module";
import { AuditModule } from "./audit/audit.module";
import { AuthModule } from "./auth/auth.module";
import { AuthenticationGuard } from "./auth/guards/authentication.guard";
import { CatalogModule } from "./catalog/catalog.module";
import { AppConfigModule } from "./common/config/app-config.module";
import { AllExceptionsFilter } from "./common/errors/all-exceptions.filter";
import { RequestLoggingInterceptor } from "./common/interceptors/request-logging.interceptor";
import { LoggingModule } from "./common/logging/logging.module";
import { SecurityMiddleware } from "./common/middleware/security.middleware";
import { createValidationPipe } from "./common/pipes/create-validation-pipe";
import { RequestContextMiddleware } from "./context/request-context.middleware";
import { RequestContextModule } from "./context/request-context.module";
import { CustomersModule } from "./customers/customers.module";
import { DatabaseModule } from "./database/database.module";
import { ExpensesModule } from "./expenses/expenses.module";
import { HealthModule } from "./health/health.module";
import { InventoryModule } from "./inventory/inventory.module";
import { PaymentsModule } from "./payments/payments.module";
import { PurchaseReturnsModule } from "./purchase-returns/purchase-returns.module";
import { PurchasesModule } from "./purchases/purchases.module";
import { ReportsModule } from "./reports/reports.module";
import { SalesReturnsModule } from "./sales-returns/sales-returns.module";
import { SalesModule } from "./sales/sales.module";
import { SuppliersModule } from "./suppliers/suppliers.module";
import { TenantsModule } from "./tenants/tenants.module";

@Module({
  imports: [
    AppConfigModule,
    LoggingModule,
    RequestContextModule,
    DatabaseModule,
    AuthModule,
    TenantsModule,
    CatalogModule,
    SalesReturnsModule,
    PurchaseReturnsModule,
    CustomersModule,
    SuppliersModule,
    InventoryModule,
    PurchasesModule,
    SalesModule,
    PaymentsModule,
    ExpensesModule,
    ReportsModule,
    AiIntakeModule,
    AuditModule,
    HealthModule,
  ],
  providers: [
    SecurityMiddleware,
    { provide: APP_PIPE, useFactory: () => createValidationPipe() },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: RequestLoggingInterceptor },
    { provide: APP_GUARD, useExisting: AuthenticationGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(SecurityMiddleware, RequestContextMiddleware)
      .forRoutes({ path: "{*path}", method: RequestMethod.ALL });
  }
}
