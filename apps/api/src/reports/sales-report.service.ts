import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { formatMoney, formatStock } from "../catalog/decimal";
import { TenantScope } from "../database/prisma.types";
import { TenantTransactionService } from "../database/tenant-transaction.service";
import { deriveFinance, loadFinanceFigures } from "./finance-figures";
import { ledgerDateText } from "../payments/settlement-support";
import { ReportPeriod, resolveBusinessRange } from "./report-range";

@Injectable()
export class SalesReportService {
  constructor(private readonly transactions: TenantTransactionService) {}

  async summary(
    actor: TenantScope,
    query: { period?: ReportPeriod; from?: string; to?: string },
  ) {
    return this.transactions.run(actor, async (tx) => {
      const range = await resolveBusinessRange(tx, actor.tenantId, query);
      const figures = await loadFinanceFigures(tx, actor.tenantId, range);
      const derived = deriveFinance(figures);
      const average =
        figures.transactionCount === 0
          ? new Prisma.Decimal(0)
          : derived.netSales.div(figures.transactionCount).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      return {
        period: range.period,
        from: range.from,
        to: range.to,
        grossSales: formatMoney(figures.grossSales),
        salesReturns: formatMoney(figures.salesReturns),
        netSales: formatMoney(derived.netSales),
        transactionCount: figures.transactionCount,
        quantitySold: formatStock(figures.quantitySold),
        averageBillValue: formatMoney(average),
        cashSales: formatMoney(figures.cashSalesCollections),
        upiSales: formatMoney(figures.upiSalesCollections),
        customerCreditSales: formatMoney(figures.creditSales),
        customerCollections: formatMoney(figures.customerCollections),
      };
    });
  }

  async daily(
    actor: TenantScope,
    query: { period?: ReportPeriod; from?: string; to?: string },
  ) {
    return this.transactions.run(actor, async (tx) => {
      const range = await resolveBusinessRange(tx, actor.tenantId, query);
      const rows = await tx.$queryRaw<Array<{ business_date: Date | string; gross: string; returns: string }>>`
        SELECT
          days.business_date::date AS business_date,
          COALESCE(sold.gross, 0)::text AS gross,
          COALESCE(returned.amount, 0)::text AS returns
        FROM generate_series(${range.from}::date, ${range.to}::date, interval '1 day') AS days(business_date)
        LEFT JOIN (
          SELECT business_date, SUM(grand_total) AS gross
          FROM sales
          WHERE tenant_id = ${actor.tenantId}::uuid
            AND status = 'COMPLETED'
            AND business_date BETWEEN ${range.from}::date AND ${range.to}::date
          GROUP BY business_date
        ) sold ON sold.business_date = days.business_date
        LEFT JOIN (
          SELECT business_date, SUM(subtotal) AS amount
          FROM sale_returns
          WHERE tenant_id = ${actor.tenantId}::uuid
            AND status = 'CONFIRMED'
            AND business_date BETWEEN ${range.from}::date AND ${range.to}::date
          GROUP BY business_date
        ) returned ON returned.business_date = days.business_date
        ORDER BY days.business_date
      `;
      return {
        period: range.period,
        from: range.from,
        to: range.to,
        days: rows.map((row) => {
          const gross = new Prisma.Decimal(row.gross);
          const returns = new Prisma.Decimal(row.returns);
          return {
            businessDate: ledgerDateText(row.business_date),
            grossSales: formatMoney(gross),
            salesReturns: formatMoney(returns),
            netSales: formatMoney(gross.minus(returns)),
          };
        }),
      };
    });
  }
}
