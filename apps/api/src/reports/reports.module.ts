import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { DatabaseModule } from "../database/database.module";
import { ExpensesModule } from "../expenses/expenses.module";
import { DailyClosingController } from "./daily-closing.controller";
import { DailyClosingService } from "./daily-closing.service";
import { DashboardController } from "./dashboard.controller";
import { DashboardService } from "./dashboard.service";
import { FinanceReportController } from "./finance-report.controller";
import { FinanceReportService } from "./finance-report.service";
import { PartyReportService } from "./party-report.service";
import { ProductReportService } from "./product-report.service";
import { SalesReportService } from "./sales-report.service";
import { ShopReportController } from "./shop-report.controller";
import { StockReportService } from "./stock-report.service";

@Module({
  imports: [DatabaseModule, AuditModule, ExpensesModule],
  controllers: [FinanceReportController, DashboardController, ShopReportController, DailyClosingController],
  providers: [
    FinanceReportService,
    DashboardService,
    SalesReportService,
    ProductReportService,
    PartyReportService,
    StockReportService,
    DailyClosingService,
  ],
})
export class ReportsModule {}
