import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { formatMoney, formatStock } from "../catalog/decimal";
import { escapeLike } from "../catalog/text";
import { TenantScope } from "../database/prisma.types";
import { TenantTransactionService } from "../database/tenant-transaction.service";
import { canSeeStockCost } from "../inventory/inventory-access";
import { ledgerDateText } from "../payments/settlement-support";
import { ReportPeriod, resolveBusinessRange } from "./report-range";

@Injectable()
export class StockReportService {
  constructor(private readonly transactions: TenantTransactionService) {}

  async summary(actor: TenantScope & { role: string }, locationId?: string) {
    return this.transactions.run(actor, async (tx) => {
      const location = locationId ?? null;
      const rows = await tx.$queryRaw<Array<{
        total_products: string;
        with_stock: string;
        out_of_stock: string;
        low_stock: string;
        total_quantity: string;
        total_value: string;
      }>>`
        WITH product_stock AS (
          SELECT
            p.id,
            p.minimum_stock_level,
            COALESCE(SUM(b.quantity), 0) AS quantity,
            COALESCE(SUM(b.quantity * b.average_cost) FILTER (WHERE b.average_cost IS NOT NULL), 0) AS value
          FROM products p
          LEFT JOIN inventory_balances b
            ON b.tenant_id = p.tenant_id
           AND b.product_id = p.id
           AND (${location}::uuid IS NULL OR b.location_id = ${location}::uuid)
          WHERE p.tenant_id = ${actor.tenantId}::uuid
            AND p.is_active = true
          GROUP BY p.id, p.minimum_stock_level
        )
        SELECT
          COUNT(*)::text AS total_products,
          COUNT(*) FILTER (WHERE quantity > 0)::text AS with_stock,
          COUNT(*) FILTER (WHERE quantity = 0)::text AS out_of_stock,
          COUNT(*) FILTER (
            WHERE quantity > 0
              AND minimum_stock_level IS NOT NULL
              AND quantity <= minimum_stock_level
          )::text AS low_stock,
          COALESCE(SUM(quantity), 0)::text AS total_quantity,
          COALESCE(SUM(value), 0)::text AS total_value
        FROM product_stock
      `;
      const row = rows[0];
      const body: Record<string, unknown> = {
        totalProducts: Number(row?.total_products ?? 0),
        productsWithStock: Number(row?.with_stock ?? 0),
        outOfStockProducts: Number(row?.out_of_stock ?? 0),
        lowStockProducts: Number(row?.low_stock ?? 0),
        totalStockQuantity: formatStock(row?.total_quantity ?? "0"),
      };
      if (canSeeStockCost(actor.role)) {
        body.totalStockValue = formatMoney(row?.total_value ?? "0");
      }
      return body;
    });
  }

  async low(
    actor: TenantScope,
    query: { search?: string; categoryId?: string; locationId?: string; page: number; limit: number },
  ) {
    return this.stockList(actor, query, "low");
  }

  async outOfStock(
    actor: TenantScope,
    query: { search?: string; categoryId?: string; locationId?: string; page: number; limit: number },
  ) {
    return this.stockList(actor, query, "out");
  }

  async inactive(
    actor: TenantScope,
    query: { search?: string; categoryId?: string; locationId?: string; daysWithoutSale?: number; page: number; limit: number },
  ) {
    const days = query.daysWithoutSale ?? 30;
    return this.transactions.run(actor, async (tx) => {
      const where = stockWhere(actor.tenantId, query, "inactive");
      const [counted, rows] = await Promise.all([
        tx.$queryRaw<Array<{ total: number }>>(Prisma.sql`
          SELECT count(*)::int AS total
          FROM (${inactiveSql(actor.tenantId, days, where)}) stock
        `),
        tx.$queryRaw<InactiveRow[]>(Prisma.sql`
          SELECT * FROM (${inactiveSql(actor.tenantId, days, where)}) stock
          ORDER BY quantity::numeric DESC, name ASC
          LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}
        `),
      ]);
      return {
        daysWithoutSale: days,
        data: rows.map((row) => ({
          productId: row.id,
          name: row.name,
          sku: row.sku,
          currentStockQuantity: formatStock(row.quantity),
          lastSaleDate: row.last_sale_date ? ledgerDateText(row.last_sale_date) : null,
        })),
        pagination: { page: query.page, limit: query.limit, total: counted[0]?.total ?? 0 },
      };
    });
  }

  async movements(
    actor: TenantScope & { role: string },
    query: {
      period?: ReportPeriod;
      from?: string;
      to?: string;
      productId?: string;
      locationId?: string;
      movementType?: string;
      page: number;
      limit: number;
    },
  ) {
    return this.transactions.run(actor, async (tx) => {
      const range = await resolveBusinessRange(tx, actor.tenantId, query);
      const productId = query.productId ?? null;
      const locationId = query.locationId ?? null;
      const movementType = query.movementType ?? null;
      const where = Prisma.sql`
        m.tenant_id = ${actor.tenantId}::uuid
        AND m.business_date BETWEEN ${range.from}::date AND ${range.to}::date
        AND (${productId}::uuid IS NULL OR m.product_id = ${productId}::uuid)
        AND (${locationId}::uuid IS NULL OR m.location_id = ${locationId}::uuid)
        AND (${movementType}::text IS NULL OR m.movement_type::text = ${movementType})
      `;
      const [counted, rows] = await Promise.all([
        tx.$queryRaw<Array<{ total: number }>>(Prisma.sql`
          SELECT count(*)::int AS total FROM inventory_movements m WHERE ${where}
        `),
        tx.$queryRaw<MovementRow[]>(Prisma.sql`
          SELECT
            m.id::text AS id,
            m.occurred_at,
            m.business_date,
            m.movement_type,
            CASE WHEN m.quantity_delta >= 0 THEN 'IN' ELSE 'OUT' END AS direction,
            m.quantity_delta::text AS quantity,
            m.unit_cost::text AS unit_cost,
            m.reference_type,
            m.reference_id::text AS reference_id,
            p.id::text AS product_id,
            p.name AS product_name,
            p.sku AS product_sku,
            l.id::text AS location_id,
            l.name AS location_name
          FROM inventory_movements m
          JOIN products p ON p.tenant_id = m.tenant_id AND p.id = m.product_id
          JOIN locations l ON l.tenant_id = m.tenant_id AND l.id = m.location_id
          WHERE ${where}
          ORDER BY m.occurred_at DESC, m.id DESC
          LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}
        `),
      ]);
      const seeCost = canSeeStockCost(actor.role);
      return {
        period: range.period,
        from: range.from,
        to: range.to,
        data: rows.map((row) => {
          const body: Record<string, unknown> = {
            id: row.id,
            occurredAt: row.occurred_at.toISOString(),
            businessDate: ledgerDateText(row.business_date),
            product: { id: row.product_id, name: row.product_name, sku: row.product_sku },
            location: { id: row.location_id, name: row.location_name },
            movementType: row.movement_type,
            direction: row.direction,
            quantity: formatStock(row.quantity),
            referenceType: row.reference_type,
            referenceId: row.reference_id,
          };
          if (seeCost) {
            body.unitCost = row.unit_cost === null ? null : formatMoney(row.unit_cost);
          }
          return body;
        }),
        pagination: { page: query.page, limit: query.limit, total: counted[0]?.total ?? 0 },
      };
    });
  }

  private stockList(
    actor: TenantScope,
    query: { search?: string; categoryId?: string; locationId?: string; page: number; limit: number },
    kind: "low" | "out",
  ) {
    return this.transactions.run(actor, async (tx) => {
      const where = stockWhere(actor.tenantId, query, kind);
      const source = stockSql(actor.tenantId, query.locationId, where);
      const [counted, rows] = await Promise.all([
        tx.$queryRaw<Array<{ total: number }>>(Prisma.sql`SELECT count(*)::int AS total FROM (${source}) stock`),
        tx.$queryRaw<StockRow[]>(Prisma.sql`
          SELECT * FROM (${source}) stock
          ORDER BY name ASC, id ASC
          LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}
        `),
      ]);
      return {
        data: rows.map((row) => ({
          productId: row.id,
          name: row.name,
          sku: row.sku,
          quantity: formatStock(row.quantity),
          minimumStockLevel: row.minimum_stock_level === null ? null : formatStock(row.minimum_stock_level),
        })),
        pagination: { page: query.page, limit: query.limit, total: counted[0]?.total ?? 0 },
      };
    });
  }
}

interface StockRow {
  id: string;
  name: string;
  sku: string | null;
  quantity: string;
  minimum_stock_level: string | null;
}

interface InactiveRow extends StockRow {
  last_sale_date: Date | string | null;
}

interface MovementRow {
  id: string;
  occurred_at: Date;
  business_date: Date | string;
  movement_type: string;
  direction: string;
  quantity: string;
  unit_cost: string | null;
  reference_type: string;
  reference_id: string;
  product_id: string;
  product_name: string;
  product_sku: string | null;
  location_id: string;
  location_name: string;
}

function stockWhere(
  tenantId: string,
  query: { search?: string; categoryId?: string },
  kind: "low" | "out" | "inactive",
): Prisma.Sql {
  const categoryId = query.categoryId ?? null;
  const text = query.search && query.search.trim() !== "" ? query.search.trim() : null;
  const like = text ? `%${escapeLike(text)}%` : null;
  const level =
    kind === "low"
      ? Prisma.sql`AND stock.quantity > 0 AND stock.minimum_stock_level IS NOT NULL AND stock.quantity <= stock.minimum_stock_level`
      : kind === "out"
        ? Prisma.sql`AND stock.quantity = 0`
        : Prisma.sql`AND stock.quantity > 0`;
  return Prisma.sql`
    stock.tenant_id = ${tenantId}::uuid
    AND stock.is_active = true
    ${level}
    AND (${categoryId}::uuid IS NULL OR stock.category_id = ${categoryId}::uuid)
    AND (
      ${text}::text IS NULL
      OR stock.name ILIKE ${like} ESCAPE '\\'
      OR stock.sku ILIKE ${like} ESCAPE '\\'
    )
  `;
}

function stockSql(tenantId: string, locationId: string | undefined, where: Prisma.Sql): Prisma.Sql {
  const location = locationId ?? null;
  return Prisma.sql`
    SELECT stock.id, stock.name, stock.sku, stock.quantity::text AS quantity, stock.minimum_stock_level::text AS minimum_stock_level
    FROM (
      SELECT
        p.tenant_id,
        p.id::text AS id,
        p.name,
        p.sku,
        p.category_id,
        p.is_active,
        p.minimum_stock_level,
        COALESCE(SUM(b.quantity), 0) AS quantity
      FROM products p
      LEFT JOIN inventory_balances b
        ON b.tenant_id = p.tenant_id
       AND b.product_id = p.id
       AND (${location}::uuid IS NULL OR b.location_id = ${location}::uuid)
      WHERE p.tenant_id = ${tenantId}::uuid
      GROUP BY p.tenant_id, p.id, p.name, p.sku, p.category_id, p.is_active, p.minimum_stock_level
    ) stock
    WHERE ${where}
  `;
}

function inactiveSql(tenantId: string, days: number, where: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT
      stock.id::text AS id,
      stock.name,
      stock.sku,
      stock.quantity::text AS quantity,
      stock.minimum_stock_level::text AS minimum_stock_level,
      last_sale.last_sale_date
    FROM (
      SELECT
        p.tenant_id,
        p.id,
        p.name,
        p.sku,
        p.category_id,
        p.is_active,
        p.minimum_stock_level,
        COALESCE(SUM(b.quantity), 0) AS quantity
      FROM products p
      LEFT JOIN inventory_balances b ON b.tenant_id = p.tenant_id AND b.product_id = p.id
      WHERE p.tenant_id = ${tenantId}::uuid
      GROUP BY p.tenant_id, p.id, p.name, p.sku, p.category_id, p.is_active, p.minimum_stock_level
    ) stock
    LEFT JOIN (
      SELECT si.product_id, MAX(s.business_date) AS last_sale_date
      FROM sale_items si
      JOIN sales s ON s.tenant_id = si.tenant_id AND s.id = si.sale_id
      WHERE si.tenant_id = ${tenantId}::uuid
        AND s.status = 'COMPLETED'
      GROUP BY si.product_id
    ) last_sale ON last_sale.product_id = stock.id
    WHERE ${where}
      AND (
        last_sale.last_sale_date IS NULL
        OR last_sale.last_sale_date < (
          SELECT (CURRENT_TIMESTAMP AT TIME ZONE timezone)::date
          FROM tenants
          WHERE id = ${tenantId}::uuid
        ) - ${days}::int
      )
  `;
}
