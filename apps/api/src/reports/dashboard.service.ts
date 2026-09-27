import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { formatMoney, formatStock } from "../catalog/decimal";
import { canViewExpenses } from "../expenses/expense-access";
import { canSeeSaleProfit } from "../sales/sales-access";
import { canSeeSupplierMoney } from "../suppliers/supplier-access";
import { TenantScope } from "../database/prisma.types";
import { TenantTransactionService } from "../database/tenant-transaction.service";
import { deriveFinance, FinanceFigures, loadFinanceFigures } from "./finance-figures";
import { percentChange } from "./report-math";
import { ComparisonPeriod, resolveBusinessRange, resolveComparisonRanges } from "./report-range";

@Injectable()
export class DashboardService {
  constructor(private readonly transactions: TenantTransactionService) {}

  async today(actor: TenantScope & { role: string }) {
    return this.transactions.run(actor, async (tx) => {
      const range = await resolveBusinessRange(tx, actor.tenantId, { period: "today" });
      const figures = await loadFinanceFigures(tx, actor.tenantId, range);
      return presentDashboard(figures, actor.role);
    });
  }

  async comparison(actor: TenantScope & { role: string }, period: ComparisonPeriod) {
    return this.transactions.run(actor, async (tx) => {
      const ranges = await resolveComparisonRanges(tx, actor.tenantId, period);
      const [current, previous] = await Promise.all([
        loadFinanceFigures(tx, actor.tenantId, ranges.current),
        loadFinanceFigures(tx, actor.tenantId, ranges.previous),
      ]);
      return presentComparison(period, current, previous, actor.role);
    });
  }
}

export function presentDashboard(figures: FinanceFigures, role: string) {
  const derived = deriveFinance(figures);
  const body: Record<string, unknown> = {
    businessDate: figures.range.from,
    sales: salesBlock(figures, derived.netSales),
    collections: {
      cash: formatMoney(figures.cashSalesCollections),
      upi: formatMoney(figures.upiSalesCollections),
      customerCollections: formatMoney(figures.customerCollections),
    },
    outstanding: {
      customer: formatMoney(figures.customerOutstanding),
    },
  };
  if (canSeeSaleProfit(role)) {
    body.profit = {
      cogs: formatMoney(derived.cogs),
      grossProfit: formatMoney(derived.grossProfit),
      expenses: formatMoney(figures.expenses),
      netProfit: formatMoney(derived.netProfit),
    };
  }
  if (canSeeSupplierMoney(role) || canViewExpenses(role)) {
    const payments: Record<string, string> = {};
    if (canSeeSupplierMoney(role)) {
      payments.supplierPayments = formatMoney(figures.supplierPayments) ?? "0.00";
      (body.outstanding as Record<string, string>).supplier = formatMoney(figures.supplierOutstanding) ?? "0.00";
    }
    if (canViewExpenses(role)) {
      payments.cashExpenses = formatMoney(figures.cashExpenses) ?? "0.00";
      payments.upiExpenses = formatMoney(figures.upiExpenses) ?? "0.00";
      if (!canSeeSaleProfit(role)) {
        body.expenses = formatMoney(figures.expenses);
      }
    }
    body.payments = payments;
  }
  return body;
}

function presentComparison(
  period: ComparisonPeriod,
  current: FinanceFigures,
  previous: FinanceFigures,
  role: string,
) {
  const currentView = periodSlice(current, role);
  const previousView = periodSlice(previous, role);
  return {
    comparison: period,
    current: { from: current.range.from, to: current.range.to, ...currentView },
    previous: { from: previous.range.from, to: previous.range.to, ...previousView },
    change: diffSlice(current, previous, role, false),
    changePercent: diffSlice(current, previous, role, true),
  };
}

function periodSlice(figures: FinanceFigures, role: string) {
  const derived = deriveFinance(figures);
  const body: Record<string, unknown> = {
    sales: salesBlock(figures, derived.netSales),
    collections: {
      cash: formatMoney(figures.cashSalesCollections),
      upi: formatMoney(figures.upiSalesCollections),
      customerCollections: formatMoney(figures.customerCollections),
    },
  };
  if (canSeeSaleProfit(role)) {
    body.profit = {
      cogs: formatMoney(derived.cogs),
      grossProfit: formatMoney(derived.grossProfit),
      expenses: formatMoney(figures.expenses),
      netProfit: formatMoney(derived.netProfit),
    };
  } else if (canViewExpenses(role)) {
    body.expenses = formatMoney(figures.expenses);
  }
  if (canSeeSupplierMoney(role)) {
    body.supplierPayments = formatMoney(figures.supplierPayments);
  }
  return body;
}

function diffSlice(current: FinanceFigures, previous: FinanceFigures, role: string, asPercent: boolean) {
  const left = deriveFinance(current);
  const right = deriveFinance(previous);
  const money = (now: Prisma.Decimal, before: Prisma.Decimal) =>
    asPercent ? percentChange(now, before) : formatMoney(now.minus(before));
  const count = (now: number, before: number) =>
    asPercent ? percentChange(new Prisma.Decimal(now), new Prisma.Decimal(before)) : now - before;
  const body: Record<string, unknown> = {
    sales: {
      grossSales: money(current.grossSales, previous.grossSales),
      salesReturns: money(current.salesReturns, previous.salesReturns),
      netSales: money(left.netSales, right.netSales),
      transactionCount: count(current.transactionCount, previous.transactionCount),
      quantitySold: asPercent
        ? percentChange(current.quantitySold, previous.quantitySold)
        : formatStock(current.quantitySold.minus(previous.quantitySold)),
    },
    collections: {
      cash: money(current.cashSalesCollections, previous.cashSalesCollections),
      upi: money(current.upiSalesCollections, previous.upiSalesCollections),
      customerCollections: money(current.customerCollections, previous.customerCollections),
    },
  };
  if (canSeeSaleProfit(role)) {
    body.profit = {
      cogs: money(left.cogs, right.cogs),
      grossProfit: money(left.grossProfit, right.grossProfit),
      expenses: money(current.expenses, previous.expenses),
      netProfit: money(left.netProfit, right.netProfit),
    };
  } else if (canViewExpenses(role)) {
    body.expenses = money(current.expenses, previous.expenses);
  }
  if (canSeeSupplierMoney(role)) {
    body.supplierPayments = money(current.supplierPayments, previous.supplierPayments);
  }
  return body;
}

function salesBlock(figures: FinanceFigures, netSales: Prisma.Decimal) {
  return {
    grossSales: formatMoney(figures.grossSales),
    salesReturns: formatMoney(figures.salesReturns),
    netSales: formatMoney(netSales),
    transactionCount: figures.transactionCount,
    quantitySold: formatStock(figures.quantitySold),
  };
}
