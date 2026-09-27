import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { DatabaseModule } from "../database/database.module";
import { ExpenseCategoryService } from "./expense-category.service";
import { ExpenseController } from "./expense.controller";
import { ExpenseService } from "./expense.service";

@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [ExpenseController],
  providers: [ExpenseCategoryService, ExpenseService],
  exports: [ExpenseService],
})
export class ExpensesModule {}
