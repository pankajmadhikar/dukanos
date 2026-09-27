import { Injectable } from "@nestjs/common";
import { formatMoney, formatStock } from "../catalog/decimal";
import { canViewExpenses } from "../expenses/expense-access";
import { canSeeSaleProfit } from "../sales/sales-access";
import { canSeeSupplierMoney } from "../suppliers/supplier-access";
import { TenantScope } from "../database/prisma.types";
import { TenantTransactionService } from "../database/tenant-transaction.service";
import { deriveFinance, FinanceFigures, loadFinanceFigures } from "./finance-figures";
import { ReportPeriod, resolveBusinessRange } from "./report-range";

@Injectable()
export class FinanceReportService {
  constructor(private readonly transactions: TenantTransactionService) {}

  async summary(
    actor: TenantScope & { role: string },
    query: { period?: ReportPeriod; from?: string; to?: string },
  ) {
    const figures = await this.transactions.run(actor, async (tx) => {
      const range = await resolveBusinessRange(tx, actor.tenantId, query);
      return loadFinanceFigures(tx, actor.tenantId, range);
    });
    return presentFinance(figures, actor.role);
  }
}

export function presentFinance(figures: FinanceFigures, role: string) {
  const derived = deriveFinance(figures);
  const body: Record<string, unknown> = {
    period: figures.range.period,
    from: figures.range.from,
    to: figures.range.to,
    sales: {
      grossSales: formatMoney(figures.grossSales),
      salesReturns: formatMoney(figures.salesReturns),
      netSales: formatMoney(derived.netSales),
      transactionCount: figures.transactionCount,
      quantitySold: formatStock(figures.quantitySold),
    },
    collections: {
      cashSalesCollections: formatMoney(figures.cashSalesCollections),
      upiSalesCollections: formatMoney(figures.upiSalesCollections),
      customerCollections: formatMoney(figures.customerCollections),
    },
    outstanding: {
      customerOutstanding: formatMoney(figures.customerOutstanding),
    },
  };
  if (canSeeSupplierMoney(role)) {
    body.cost = {
      ...(canSeeSaleProfit(role) ? { cogs: formatMoney(derived.cogs) } : {}),
      purchases: formatMoney(figures.purchases),
      purchaseReturns: formatMoney(figures.purchaseReturns),
    };
    body.supplierPayments = formatMoney(figures.supplierPayments);
    (body.outstanding as Record<string, unknown>).supplierOutstanding = formatMoney(figures.supplierOutstanding);
  }
  if (canSeeSaleProfit(role)) {
    body.profit = {
      grossProfit: formatMoney(derived.grossProfit),
      expenses: formatMoney(figures.expenses),
      netProfit: formatMoney(derived.netProfit),
    };
  } else if (canViewExpenses(role)) {
    body.expenses = formatMoney(figures.expenses);
  }
  return body;
}
