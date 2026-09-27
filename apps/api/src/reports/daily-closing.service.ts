import { HttpStatus, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditRecorder } from "../audit/audit-recorder";
import { formatMoney, formatStock } from "../catalog/decimal";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";
import { ShopDb, TenantScope } from "../database/prisma.types";
import { TenantTransactionService } from "../database/tenant-transaction.service";
import { canViewExpenses } from "../expenses/expense-access";
import { assertCivilDate, ledgerDateText } from "../payments/settlement-support";
import { canSeeSaleProfit } from "../sales/sales-access";
import { canSeeSupplierMoney } from "../suppliers/supplier-access";
import { deriveFinance, loadAsOfBalances, loadFinanceFigures } from "./finance-figures";
import { shopBusinessDate } from "./report-range";

interface SnapshotRow {
  id: string;
  business_date: Date | string;
  closed_at: Date;
  total_sales: string;
  total_sales_returns: string;
  net_sales: string;
  total_purchase: string;
  gross_profit: string;
  total_expenses: string;
  net_profit: string;
  cash_received: string;
  credit_sales: string;
  customer_collections: string;
  supplier_payments: string;
  closing_receivables: string;
  closing_payables: string;
  products_sold: string;
  transaction_count: number;
}

const SNAPSHOT_COLUMNS = Prisma.sql`
  id::text AS id,
  business_date,
  closed_at,
  total_sales::text AS total_sales,
  total_sales_returns::text AS total_sales_returns,
  net_sales::text AS net_sales,
  total_purchase::text AS total_purchase,
  gross_profit::text AS gross_profit,
  total_expenses::text AS total_expenses,
  net_profit::text AS net_profit,
  cash_received::text AS cash_received,
  credit_sales::text AS credit_sales,
  customer_collections::text AS customer_collections,
  supplier_payments::text AS supplier_payments,
  closing_receivables::text AS closing_receivables,
  closing_payables::text AS closing_payables,
  products_sold::text AS products_sold,
  transaction_count
`;

@Injectable()
export class DailyClosingService {
  constructor(
    private readonly transactions: TenantTransactionService,
    private readonly audit: AuditRecorder,
  ) {}

  async close(actor: TenantScope & { role: string }, businessDate?: string) {
    return this.transactions.run(actor, async (tx) => {
      const day = await this.resolveDay(tx, actor.tenantId, businessDate);
      const existing = await this.findClosed(tx, actor.tenantId, day);
      if (existing) {
        return presentClosing(existing, actor.role);
      }
      const written = await this.writeSnapshot(tx, actor, day, false);
      if (written.created) {
        await this.audit.write(tx, {
          action: "daily_closing.created",
          entityType: "daily_summary",
          entityId: written.row.id,
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          metadata: { businessDate: day, netSales: written.row.net_sales, netProfit: written.row.net_profit },
        });
      }
      return presentClosing(written.row, actor.role);
    });
  }

  async rebuild(actor: TenantScope & { role: string }, businessDate: string) {
    return this.transactions.run(actor, async (tx) => {
      const day = await this.resolveDay(tx, actor.tenantId, businessDate);
      const written = await this.writeSnapshot(tx, actor, day, true);
      const row = written.row;
      await this.audit.write(tx, {
        action: "daily_closing.rebuilt",
        entityType: "daily_summary",
        entityId: row.id,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        metadata: { businessDate: day, netSales: row.net_sales, netProfit: row.net_profit },
      });
      return presentClosing(row, actor.role);
    });
  }

  async list(
    actor: TenantScope & { role: string },
    query: { from?: string; to?: string; page: number; limit: number },
  ) {
    if (query.from) {
      assertCivilDate(query.from);
    }
    if (query.to) {
      assertCivilDate(query.to);
    }
    if (query.from && query.to && query.from > query.to) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, "The start date is after the end date.", HttpStatus.BAD_REQUEST);
    }
    return this.transactions.run(actor, async (tx) => {
      const from = query.from ?? null;
      const to = query.to ?? null;
      const where = Prisma.sql`
        tenant_id = ${actor.tenantId}::uuid
        AND closed_at IS NOT NULL
        AND (${from}::date IS NULL OR business_date >= ${from}::date)
        AND (${to}::date IS NULL OR business_date <= ${to}::date)
      `;
      const [counted, rows] = await Promise.all([
        tx.$queryRaw<Array<{ total: number }>>(Prisma.sql`SELECT count(*)::int AS total FROM daily_summaries WHERE ${where}`),
        tx.$queryRaw<SnapshotRow[]>(Prisma.sql`
          SELECT ${SNAPSHOT_COLUMNS}
          FROM daily_summaries
          WHERE ${where}
          ORDER BY business_date DESC
          LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}
        `),
      ]);
      return {
        data: rows.map((row) => presentClosing(row, actor.role)),
        pagination: { page: query.page, limit: query.limit, total: counted[0]?.total ?? 0 },
      };
    });
  }

  async get(actor: TenantScope & { role: string }, businessDate: string) {
    assertCivilDate(businessDate);
    return this.transactions.run(actor, async (tx) => {
      const row = await this.findClosed(tx, actor.tenantId, businessDate);
      if (!row) {
        throw new AppException(ErrorCode.DAILY_CLOSING_NOT_FOUND, "Daily closing was not found.", HttpStatus.NOT_FOUND);
      }
      return presentClosing(row, actor.role);
    });
  }

  private async resolveDay(tx: ShopDb, tenantId: string, businessDate: string | undefined): Promise<string> {
    const day = businessDate ?? (await shopBusinessDate(tx, tenantId));
    assertCivilDate(day);
    const today = await shopBusinessDate(tx, tenantId);
    if (day > today) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        "A future business date cannot be closed.",
        HttpStatus.BAD_REQUEST,
      );
    }
    return day;
  }

  private async findClosed(tx: ShopDb, tenantId: string, day: string): Promise<SnapshotRow | null> {
    const rows = await tx.$queryRaw<SnapshotRow[]>`
      SELECT ${SNAPSHOT_COLUMNS}
      FROM daily_summaries
      WHERE tenant_id = ${tenantId}::uuid
        AND business_date = ${day}::date
        AND closed_at IS NOT NULL
    `;
    return rows[0] ?? null;
  }

  private async writeSnapshot(
    tx: ShopDb,
    actor: TenantScope,
    day: string,
    replace: boolean,
  ): Promise<{ row: SnapshotRow; created: boolean }> {
    const range = { period: "custom" as const, from: day, to: day };
    const [figures, balances] = await Promise.all([
      loadFinanceFigures(tx, actor.tenantId, range),
      loadAsOfBalances(tx, actor.tenantId, day),
    ]);
    const derived = deriveFinance(figures);
    const cashReceived = figures.cashSalesCollections.plus(figures.upiSalesCollections);
    const guard = replace ? Prisma.sql`` : Prisma.sql`WHERE daily_summaries.closed_at IS NULL`;
    const rows = await tx.$queryRaw<SnapshotRow[]>`
      INSERT INTO daily_summaries (
        id, tenant_id, business_date,
        total_sales, total_sales_returns, net_sales, total_purchase,
        gross_profit, total_expenses, net_profit,
        cash_received, credit_sales, customer_collections, supplier_payments,
        closing_receivables, closing_payables, products_sold, transaction_count,
        closed_at
      ) VALUES (
        uuidv7(),
        ${actor.tenantId}::uuid,
        ${day}::date,
        ${figures.grossSales.toFixed(2)}::numeric,
        ${figures.salesReturns.toFixed(2)}::numeric,
        ${derived.netSales.toFixed(2)}::numeric,
        ${figures.purchases.toFixed(2)}::numeric,
        ${derived.grossProfit.toFixed(2)}::numeric,
        ${figures.expenses.toFixed(2)}::numeric,
        ${derived.netProfit.toFixed(2)}::numeric,
        ${cashReceived.toFixed(2)}::numeric,
        ${figures.creditSales.toFixed(2)}::numeric,
        ${figures.customerCollections.toFixed(2)}::numeric,
        ${figures.supplierPayments.toFixed(2)}::numeric,
        ${balances.customer.toFixed(2)}::numeric,
        ${balances.supplier.toFixed(2)}::numeric,
        ${figures.quantitySold.toFixed(3)}::numeric,
        ${figures.transactionCount},
        CURRENT_TIMESTAMP
      )
      ON CONFLICT (tenant_id, business_date) DO UPDATE SET
        total_sales = EXCLUDED.total_sales,
        total_sales_returns = EXCLUDED.total_sales_returns,
        net_sales = EXCLUDED.net_sales,
        total_purchase = EXCLUDED.total_purchase,
        gross_profit = EXCLUDED.gross_profit,
        total_expenses = EXCLUDED.total_expenses,
        net_profit = EXCLUDED.net_profit,
        cash_received = EXCLUDED.cash_received,
        credit_sales = EXCLUDED.credit_sales,
        customer_collections = EXCLUDED.customer_collections,
        supplier_payments = EXCLUDED.supplier_payments,
        closing_receivables = EXCLUDED.closing_receivables,
        closing_payables = EXCLUDED.closing_payables,
        products_sold = EXCLUDED.products_sold,
        transaction_count = EXCLUDED.transaction_count,
        closed_at = EXCLUDED.closed_at,
        updated_at = CURRENT_TIMESTAMP
      ${guard}
      RETURNING ${SNAPSHOT_COLUMNS}
    `;
    if (rows[0]) {
      return { row: rows[0], created: true };
    }
    const existing = await this.findClosed(tx, actor.tenantId, day);
    if (!existing) {
      throw new AppException(ErrorCode.DAILY_CLOSING_NOT_FOUND, "Daily closing was not found.", HttpStatus.NOT_FOUND);
    }
    return { row: existing, created: false };
  }
}

export function presentClosing(row: SnapshotRow, role: string) {
  const netSales = new Prisma.Decimal(row.net_sales);
  const grossProfit = new Prisma.Decimal(row.gross_profit);
  const cogs = netSales.minus(grossProfit);
  const body: Record<string, unknown> = {
    id: row.id,
    businessDate: ledgerDateText(row.business_date),
    closedAt: row.closed_at.toISOString(),
    sales: {
      grossSales: formatMoney(row.total_sales),
      salesReturns: formatMoney(row.total_sales_returns),
      netSales: formatMoney(netSales),
      transactionCount: Number(row.transaction_count),
      quantitySold: formatStock(row.products_sold),
      customerCreditSales: formatMoney(row.credit_sales),
    },
    collections: {
      cashReceived: formatMoney(row.cash_received),
      customerCollections: formatMoney(row.customer_collections),
    },
    outstanding: {
      customer: formatMoney(row.closing_receivables),
    },
  };
  if (canSeeSaleProfit(role)) {
    body.profit = {
      cogs: formatMoney(cogs),
      grossProfit: formatMoney(grossProfit),
      expenses: formatMoney(row.total_expenses),
      netProfit: formatMoney(row.net_profit),
    };
  } else if (canViewExpenses(role)) {
    body.expenses = formatMoney(row.total_expenses);
  }
  if (canSeeSupplierMoney(role)) {
    body.purchases = formatMoney(row.total_purchase);
    body.supplierPayments = formatMoney(row.supplier_payments);
    (body.outstanding as Record<string, string>).supplier = formatMoney(row.closing_payables) ?? "0.00";
  }
  return body;
}
