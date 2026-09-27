import { HttpStatus, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { formatMoney, formatStock } from "../catalog/decimal";
import { escapeLike } from "../catalog/text";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";
import { TenantScope } from "../database/prisma.types";
import { TenantTransactionService } from "../database/tenant-transaction.service";
import { canSeeSaleProfit } from "../sales/sales-access";
import { ReportPeriod, resolveBusinessRange } from "./report-range";

type ProductSort = "quantity" | "revenue" | "grossProfit";

interface ProductRow {
  id: string;
  name: string;
  sku: string | null;
  quantity: string;
  revenue: string;
  cogs: string;
  stock_quantity: string;
}

@Injectable()
export class ProductReportService {
  constructor(private readonly transactions: TenantTransactionService) {}

  async list(
    actor: TenantScope & { role: string },
    query: {
      period?: ReportPeriod;
      from?: string;
      to?: string;
      sort?: ProductSort;
      categoryId?: string;
      search?: string;
      page: number;
      limit: number;
    },
  ) {
    const sort = this.sortFor(actor.role, query.sort);
    return this.transactions.run(actor, async (tx) => {
      const range = await resolveBusinessRange(tx, actor.tenantId, query);
      const where = productWhere(actor.tenantId, query.categoryId, query.search);
      const ranked = productSql(actor.tenantId, range.from, range.to, where);
      const [counted, rows] = await Promise.all([
        tx.$queryRaw<Array<{ total: number }>>(Prisma.sql`SELECT count(*)::int AS total FROM (${ranked}) ranked`),
        tx.$queryRaw<ProductRow[]>(Prisma.sql`
          SELECT * FROM (${ranked}) ranked
          ORDER BY ${orderBy(sort)}, name ASC, id ASC
          LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}
        `),
      ]);
      return {
        period: range.period,
        from: range.from,
        to: range.to,
        data: rows.map((row) => presentProduct(row, actor.role)),
        pagination: { page: query.page, limit: query.limit, total: counted[0]?.total ?? 0 },
      };
    });
  }

  async top(
    actor: TenantScope & { role: string },
    query: {
      period?: ReportPeriod;
      from?: string;
      to?: string;
      sort?: ProductSort;
      categoryId?: string;
      limit: number;
    },
  ) {
    const sort = this.sortFor(actor.role, query.sort);
    return this.transactions.run(actor, async (tx) => {
      const range = await resolveBusinessRange(tx, actor.tenantId, query);
      const where = productWhere(actor.tenantId, query.categoryId, undefined);
      const ranked = productSql(actor.tenantId, range.from, range.to, where);
      const rows = await tx.$queryRaw<ProductRow[]>(Prisma.sql`
        SELECT * FROM (${ranked}) ranked
        ORDER BY ${orderBy(sort)}, name ASC, id ASC
        LIMIT ${query.limit}
      `);
      return {
        period: range.period,
        from: range.from,
        to: range.to,
        sort,
        limit: query.limit,
        data: rows.map((row) => presentProduct(row, actor.role)),
      };
    });
  }

  private sortFor(role: string, sort: ProductSort | undefined): ProductSort {
    const chosen = sort ?? "quantity";
    if (chosen === "grossProfit" && !canSeeSaleProfit(role)) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        "Gross profit ranking is not available for this role.",
        HttpStatus.BAD_REQUEST,
      );
    }
    return chosen;
  }
}

function productWhere(tenantId: string, categoryId: string | undefined, search: string | undefined): Prisma.Sql {
  const category = categoryId ?? null;
  const text = search && search.trim() !== "" ? search.trim() : null;
  const like = text ? `%${escapeLike(text)}%` : null;
  return Prisma.sql`
    p.tenant_id = ${tenantId}::uuid
    AND (sold.product_id IS NOT NULL OR returned.product_id IS NOT NULL)
    AND (${category}::uuid IS NULL OR p.category_id = ${category}::uuid)
    AND (
      ${text}::text IS NULL
      OR p.name ILIKE ${like} ESCAPE '\\'
      OR p.sku ILIKE ${like} ESCAPE '\\'
    )
  `;
}

function productSql(tenantId: string, from: string, to: string, where: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT
      p.id::text AS id,
      p.name,
      p.sku,
      (COALESCE(sold.quantity, 0) - COALESCE(returned.quantity, 0))::text AS quantity,
      (COALESCE(sold.revenue, 0) - COALESCE(returned.revenue, 0))::text AS revenue,
      (COALESCE(sold.cogs, 0) - COALESCE(returned.cogs, 0))::text AS cogs,
      COALESCE(stock.quantity, 0)::text AS stock_quantity
    FROM products p
    LEFT JOIN (
      SELECT si.product_id,
        SUM(si.quantity) AS quantity,
        SUM(si.line_total) AS revenue,
        SUM(si.quantity * si.unit_cost) FILTER (WHERE si.unit_cost IS NOT NULL) AS cogs
      FROM sale_items si
      JOIN sales s ON s.tenant_id = si.tenant_id AND s.id = si.sale_id
      WHERE si.tenant_id = ${tenantId}::uuid
        AND s.status = 'COMPLETED'
        AND s.business_date BETWEEN ${from}::date AND ${to}::date
      GROUP BY si.product_id
    ) sold ON sold.product_id = p.id
    LEFT JOIN (
      SELECT sri.product_id,
        SUM(sri.quantity) AS quantity,
        SUM(sri.line_total) AS revenue,
        SUM(sri.quantity * sri.unit_cost) FILTER (WHERE sri.unit_cost IS NOT NULL) AS cogs
      FROM sale_return_items sri
      JOIN sale_returns sr ON sr.tenant_id = sri.tenant_id AND sr.id = sri.sale_return_id
      WHERE sri.tenant_id = ${tenantId}::uuid
        AND sr.status = 'CONFIRMED'
        AND sr.business_date BETWEEN ${from}::date AND ${to}::date
      GROUP BY sri.product_id
    ) returned ON returned.product_id = p.id
    LEFT JOIN (
      SELECT product_id, SUM(quantity) AS quantity
      FROM inventory_balances
      WHERE tenant_id = ${tenantId}::uuid
      GROUP BY product_id
    ) stock ON stock.product_id = p.id
    WHERE ${where}
  `;
}

function orderBy(sort: ProductSort): Prisma.Sql {
  if (sort === "revenue") {
    return Prisma.sql`revenue::numeric DESC`;
  }
  if (sort === "grossProfit") {
    return Prisma.sql`(revenue::numeric - cogs::numeric) DESC`;
  }
  return Prisma.sql`quantity::numeric DESC`;
}

function presentProduct(row: ProductRow, role: string) {
  const revenue = new Prisma.Decimal(row.revenue);
  const cogs = new Prisma.Decimal(row.cogs);
  const body: Record<string, unknown> = {
    productId: row.id,
    name: row.name,
    sku: row.sku,
    quantitySold: formatStock(row.quantity),
    salesRevenue: formatMoney(revenue),
    currentStockQuantity: formatStock(row.stock_quantity),
  };
  if (canSeeSaleProfit(role)) {
    body.cogs = formatMoney(cogs);
    body.grossProfit = formatMoney(revenue.minus(cogs));
  }
  return body;
}
