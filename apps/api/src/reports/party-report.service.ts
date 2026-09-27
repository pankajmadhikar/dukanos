import { HttpStatus, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { formatMoney } from "../catalog/decimal";
import { escapeLike } from "../catalog/text";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";
import { TenantScope } from "../database/prisma.types";
import { TenantTransactionService } from "../database/tenant-transaction.service";
import { ledgerDateText } from "../payments/settlement-support";
import { canSeeSupplierMoney } from "../suppliers/supplier-access";
import { ReportPeriod, resolveBusinessRange } from "./report-range";

@Injectable()
export class PartyReportService {
  constructor(private readonly transactions: TenantTransactionService) {}

  async customers(
    actor: TenantScope,
    query: { period?: ReportPeriod; from?: string; to?: string; search?: string; page: number; limit: number },
  ) {
    return this.transactions.run(actor, async (tx) => {
      const range = await resolveBusinessRange(tx, actor.tenantId, query);
      const text = blank(query.search);
      const like = text ? `%${escapeLike(text)}%` : null;
      const [walkIn, counted, rows] = await Promise.all([
        tx.$queryRaw<Array<{ transactions: string; sales: string; returns: string; paid: string }>>`
          SELECT
            COALESCE(sold.transactions, 0)::text AS transactions,
            COALESCE(sold.sales, 0)::text AS sales,
            COALESCE(returned.amount, 0)::text AS returns,
            COALESCE(paid.amount, 0)::text AS paid
          FROM (SELECT 1) anchor
          LEFT JOIN (
            SELECT COUNT(*) AS transactions, SUM(grand_total) AS sales
            FROM sales
            WHERE tenant_id = ${actor.tenantId}::uuid
              AND status = 'COMPLETED'
              AND customer_id IS NULL
              AND business_date BETWEEN ${range.from}::date AND ${range.to}::date
          ) sold ON true
          LEFT JOIN (
            SELECT SUM(sr.subtotal) AS amount
            FROM sale_returns sr
            JOIN sales s ON s.tenant_id = sr.tenant_id AND s.id = sr.original_sale_id
            WHERE sr.tenant_id = ${actor.tenantId}::uuid
              AND sr.status = 'CONFIRMED'
              AND s.customer_id IS NULL
              AND sr.business_date BETWEEN ${range.from}::date AND ${range.to}::date
          ) returned ON true
          LEFT JOIN (
            SELECT SUM(p.amount) AS amount
            FROM payments p
            JOIN sales s ON s.tenant_id = p.tenant_id AND s.id = p.reference_id
            WHERE p.tenant_id = ${actor.tenantId}::uuid
              AND p.reference_type = 'SALE'
              AND p.direction = 'IN'
              AND s.customer_id IS NULL
              AND p.business_date BETWEEN ${range.from}::date AND ${range.to}::date
          ) paid ON true
        `,
        tx.$queryRaw<Array<{ total: number }>>`
          SELECT count(*)::int AS total
          FROM (${customerActivity(actor.tenantId, range.from, range.to, text, like)}) activity
        `,
        tx.$queryRaw<CustomerActivityRow[]>`
          SELECT * FROM (${customerActivity(actor.tenantId, range.from, range.to, text, like)}) activity
          ORDER BY net_sales::numeric DESC, name ASC
          LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}
        `,
      ]);
      const walk = walkIn[0];
      const sales = decimal(walk?.sales);
      const returns = decimal(walk?.returns);
      return {
        period: range.period,
        from: range.from,
        to: range.to,
        walkIn: {
          transactionCount: Number(walk?.transactions ?? 0),
          totalSales: formatMoney(sales),
          returnedAmount: formatMoney(returns),
          netSales: formatMoney(sales.minus(returns)),
          amountPaidAtSale: formatMoney(decimal(walk?.paid)),
        },
        data: rows.map(presentCustomerActivity),
        pagination: { page: query.page, limit: query.limit, total: counted[0]?.total ?? 0 },
      };
    });
  }

  async customerOutstanding(
    actor: TenantScope,
    query: { search?: string; page: number; limit: number },
  ) {
    return this.transactions.run(actor, async (tx) => {
      const text = blank(query.search);
      const like = text ? `%${escapeLike(text)}%` : null;
      const where = Prisma.sql`
        c.tenant_id = ${actor.tenantId}::uuid
        AND c.is_active = true
        AND c.receivable_balance > 0
        AND (
          ${text}::text IS NULL
          OR c.name ILIKE ${like} ESCAPE '\\'
          OR c.phone ILIKE ${like} ESCAPE '\\'
        )
      `;
      const [counted, rows] = await Promise.all([
        tx.$queryRaw<Array<{ total: number }>>(Prisma.sql`
          SELECT count(*)::int AS total FROM customers c WHERE ${where}
        `),
        tx.$queryRaw<OutstandingRow[]>(Prisma.sql`
          SELECT
            c.id::text AS id,
            c.name,
            c.phone,
            c.receivable_balance::text AS balance,
            COALESCE(counts.payment_count, 0)::text AS payment_count,
            latest.id::text AS latest_id,
            latest.amount::text AS latest_amount,
            latest.payment_method AS latest_method,
            latest.business_date AS latest_date
          FROM customers c
          LEFT JOIN LATERAL (
            SELECT count(*) AS payment_count
            FROM payments p
            WHERE p.tenant_id = c.tenant_id
              AND p.customer_id = c.id
              AND p.reference_type = 'CUSTOMER_RECEIPT'
              AND p.direction = 'IN'
          ) counts ON true
          LEFT JOIN LATERAL (
            SELECT p.id, p.amount, p.payment_method, p.business_date
            FROM payments p
            WHERE p.tenant_id = c.tenant_id
              AND p.customer_id = c.id
              AND p.reference_type = 'CUSTOMER_RECEIPT'
              AND p.direction = 'IN'
            ORDER BY p.payment_date DESC, p.id DESC
            LIMIT 1
          ) latest ON true
          WHERE ${where}
          ORDER BY c.receivable_balance DESC, c.name ASC
          LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}
        `),
      ]);
      return {
        data: rows.map(presentOutstanding),
        pagination: { page: query.page, limit: query.limit, total: counted[0]?.total ?? 0 },
      };
    });
  }

  async suppliers(
    actor: TenantScope & { role: string },
    query: { period?: ReportPeriod; from?: string; to?: string; search?: string; page: number; limit: number },
  ) {
    this.assertSupplier(actor.role);
    return this.transactions.run(actor, async (tx) => {
      const range = await resolveBusinessRange(tx, actor.tenantId, query);
      const text = blank(query.search);
      const like = text ? `%${escapeLike(text)}%` : null;
      const activity = supplierActivity(actor.tenantId, range.from, range.to, text, like);
      const [counted, rows] = await Promise.all([
        tx.$queryRaw<Array<{ total: number }>>(Prisma.sql`SELECT count(*)::int AS total FROM (${activity}) activity`),
        tx.$queryRaw<SupplierActivityRow[]>(Prisma.sql`
          SELECT * FROM (${activity}) activity
          ORDER BY purchase_total::numeric DESC, name ASC
          LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}
        `),
      ]);
      return {
        period: range.period,
        from: range.from,
        to: range.to,
        data: rows.map(presentSupplierActivity),
        pagination: { page: query.page, limit: query.limit, total: counted[0]?.total ?? 0 },
      };
    });
  }

  async supplierOutstanding(
    actor: TenantScope & { role: string },
    query: { search?: string; page: number; limit: number },
  ) {
    this.assertSupplier(actor.role);
    return this.transactions.run(actor, async (tx) => {
      const text = blank(query.search);
      const like = text ? `%${escapeLike(text)}%` : null;
      const where = Prisma.sql`
        s.tenant_id = ${actor.tenantId}::uuid
        AND s.is_active = true
        AND s.payable_balance > 0
        AND (
          ${text}::text IS NULL
          OR s.name ILIKE ${like} ESCAPE '\\'
          OR s.phone ILIKE ${like} ESCAPE '\\'
        )
      `;
      const [counted, rows] = await Promise.all([
        tx.$queryRaw<Array<{ total: number }>>(Prisma.sql`SELECT count(*)::int AS total FROM suppliers s WHERE ${where}`),
        tx.$queryRaw<OutstandingRow[]>(Prisma.sql`
          SELECT
            s.id::text AS id,
            s.name,
            s.phone,
            s.payable_balance::text AS balance,
            COALESCE(counts.payment_count, 0)::text AS payment_count,
            latest.id::text AS latest_id,
            latest.amount::text AS latest_amount,
            latest.payment_method AS latest_method,
            latest.business_date AS latest_date
          FROM suppliers s
          LEFT JOIN LATERAL (
            SELECT count(*) AS payment_count
            FROM payments p
            WHERE p.tenant_id = s.tenant_id
              AND p.supplier_id = s.id
              AND p.reference_type = 'SUPPLIER_PAYMENT'
              AND p.direction = 'OUT'
          ) counts ON true
          LEFT JOIN LATERAL (
            SELECT p.id, p.amount, p.payment_method, p.business_date
            FROM payments p
            WHERE p.tenant_id = s.tenant_id
              AND p.supplier_id = s.id
              AND p.reference_type = 'SUPPLIER_PAYMENT'
              AND p.direction = 'OUT'
            ORDER BY p.payment_date DESC, p.id DESC
            LIMIT 1
          ) latest ON true
          WHERE ${where}
          ORDER BY s.payable_balance DESC, s.name ASC
          LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}
        `),
      ]);
      return {
        data: rows.map(presentOutstanding),
        pagination: { page: query.page, limit: query.limit, total: counted[0]?.total ?? 0 },
      };
    });
  }

  private assertSupplier(role: string): void {
    if (!canSeeSupplierMoney(role)) {
      throw new AppException(
        ErrorCode.SUPPLIER_ACCESS_DENIED,
        "You cannot view supplier reports.",
        HttpStatus.FORBIDDEN,
      );
    }
  }
}

interface CustomerActivityRow {
  id: string;
  name: string;
  phone: string | null;
  transactions: string;
  total_sales: string;
  returned_amount: string;
  net_sales: string;
  paid_at_sale: string;
  collections: string;
  outstanding: string;
}

interface SupplierActivityRow {
  id: string;
  name: string;
  phone: string | null;
  purchase_total: string;
  purchase_returns: string;
  payable_balance: string;
  supplier_payments: string;
}

interface OutstandingRow {
  id: string;
  name: string;
  phone: string | null;
  balance: string;
  payment_count: string;
  latest_id: string | null;
  latest_amount: string | null;
  latest_method: string | null;
  latest_date: Date | string | null;
}

function customerActivity(tenantId: string, from: string, to: string, text: string | null, like: string | null): Prisma.Sql {
  return Prisma.sql`
    SELECT
      c.id::text AS id,
      c.name,
      c.phone,
      COALESCE(sold.transactions, 0)::text AS transactions,
      COALESCE(sold.sales, 0)::text AS total_sales,
      COALESCE(returned.amount, 0)::text AS returned_amount,
      (COALESCE(sold.sales, 0) - COALESCE(returned.amount, 0))::text AS net_sales,
      COALESCE(paid.amount, 0)::text AS paid_at_sale,
      COALESCE(collected.amount, 0)::text AS collections,
      c.receivable_balance::text AS outstanding
    FROM customers c
    LEFT JOIN (
      SELECT customer_id, COUNT(*) AS transactions, SUM(grand_total) AS sales
      FROM sales
      WHERE tenant_id = ${tenantId}::uuid
        AND status = 'COMPLETED'
        AND customer_id IS NOT NULL
        AND business_date BETWEEN ${from}::date AND ${to}::date
      GROUP BY customer_id
    ) sold ON sold.customer_id = c.id
    LEFT JOIN (
      SELECT s.customer_id, SUM(sr.subtotal) AS amount
      FROM sale_returns sr
      JOIN sales s ON s.tenant_id = sr.tenant_id AND s.id = sr.original_sale_id
      WHERE sr.tenant_id = ${tenantId}::uuid
        AND sr.status = 'CONFIRMED'
        AND s.customer_id IS NOT NULL
        AND sr.business_date BETWEEN ${from}::date AND ${to}::date
      GROUP BY s.customer_id
    ) returned ON returned.customer_id = c.id
    LEFT JOIN (
      SELECT s.customer_id, SUM(p.amount) AS amount
      FROM payments p
      JOIN sales s ON s.tenant_id = p.tenant_id AND s.id = p.reference_id
      WHERE p.tenant_id = ${tenantId}::uuid
        AND p.reference_type = 'SALE'
        AND p.direction = 'IN'
        AND s.customer_id IS NOT NULL
        AND p.business_date BETWEEN ${from}::date AND ${to}::date
      GROUP BY s.customer_id
    ) paid ON paid.customer_id = c.id
    LEFT JOIN (
      SELECT customer_id, SUM(amount) AS amount
      FROM payments
      WHERE tenant_id = ${tenantId}::uuid
        AND reference_type = 'CUSTOMER_RECEIPT'
        AND direction = 'IN'
        AND customer_id IS NOT NULL
        AND business_date BETWEEN ${from}::date AND ${to}::date
      GROUP BY customer_id
    ) collected ON collected.customer_id = c.id
    WHERE c.tenant_id = ${tenantId}::uuid
      AND (sold.customer_id IS NOT NULL OR returned.customer_id IS NOT NULL OR collected.customer_id IS NOT NULL)
      AND (
        ${text}::text IS NULL
        OR c.name ILIKE ${like} ESCAPE '\\'
        OR c.phone ILIKE ${like} ESCAPE '\\'
      )
  `;
}

function supplierActivity(tenantId: string, from: string, to: string, text: string | null, like: string | null): Prisma.Sql {
  return Prisma.sql`
    SELECT
      s.id::text AS id,
      s.name,
      s.phone,
      COALESCE(bought.total, 0)::text AS purchase_total,
      COALESCE(returned.total, 0)::text AS purchase_returns,
      s.payable_balance::text AS payable_balance,
      COALESCE(paid.total, 0)::text AS supplier_payments
    FROM suppliers s
    LEFT JOIN (
      SELECT supplier_id, SUM(grand_total) AS total
      FROM purchases
      WHERE tenant_id = ${tenantId}::uuid
        AND status = 'CONFIRMED'
        AND business_date BETWEEN ${from}::date AND ${to}::date
      GROUP BY supplier_id
    ) bought ON bought.supplier_id = s.id
    LEFT JOIN (
      SELECT supplier_id, SUM(subtotal) AS total
      FROM purchase_returns
      WHERE tenant_id = ${tenantId}::uuid
        AND status = 'CONFIRMED'
        AND supplier_id IS NOT NULL
        AND business_date BETWEEN ${from}::date AND ${to}::date
      GROUP BY supplier_id
    ) returned ON returned.supplier_id = s.id
    LEFT JOIN (
      SELECT supplier_id, SUM(amount) AS total
      FROM payments
      WHERE tenant_id = ${tenantId}::uuid
        AND reference_type = 'SUPPLIER_PAYMENT'
        AND direction = 'OUT'
        AND business_date BETWEEN ${from}::date AND ${to}::date
      GROUP BY supplier_id
    ) paid ON paid.supplier_id = s.id
    WHERE s.tenant_id = ${tenantId}::uuid
      AND (bought.supplier_id IS NOT NULL OR returned.supplier_id IS NOT NULL OR paid.supplier_id IS NOT NULL)
      AND (
        ${text}::text IS NULL
        OR s.name ILIKE ${like} ESCAPE '\\'
        OR s.phone ILIKE ${like} ESCAPE '\\'
      )
  `;
}

function presentCustomerActivity(row: CustomerActivityRow) {
  return {
    customer: { id: row.id, name: row.name, phone: row.phone },
    transactionCount: Number(row.transactions),
    totalSales: formatMoney(row.total_sales),
    returnedAmount: formatMoney(row.returned_amount),
    netSales: formatMoney(row.net_sales),
    amountPaidAtSale: formatMoney(row.paid_at_sale),
    customerCollections: formatMoney(row.collections),
    outstandingBalance: formatMoney(row.outstanding),
  };
}

function presentSupplierActivity(row: SupplierActivityRow) {
  return {
    supplier: { id: row.id, name: row.name, phone: row.phone },
    purchaseTotal: formatMoney(row.purchase_total),
    purchaseReturns: formatMoney(row.purchase_returns),
    payableBalance: formatMoney(row.payable_balance),
    supplierPayments: formatMoney(row.supplier_payments),
  };
}

function presentOutstanding(row: OutstandingRow) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    outstandingBalance: formatMoney(row.balance),
    paymentCount: Number(row.payment_count),
    latestPayment: row.latest_id
      ? {
          id: row.latest_id,
          amount: formatMoney(row.latest_amount),
          method: row.latest_method,
          businessDate: row.latest_date ? ledgerDateText(row.latest_date) : null,
        }
      : null,
  };
}

function blank(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") {
    return null;
  }
  return value.trim();
}

function decimal(value: string | undefined): Prisma.Decimal {
  return new Prisma.Decimal(value ?? "0");
}
