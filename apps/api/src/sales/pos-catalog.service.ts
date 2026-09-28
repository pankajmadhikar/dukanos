import { Injectable } from "@nestjs/common";
import { formatMoney, formatStock } from "../catalog/decimal";
import { TenantScope } from "../database/prisma.types";
import { TenantTransactionService } from "../database/tenant-transaction.service";

const PAGE_LIMIT = 100;

export interface PosPage {
  page: number;
  limit: number;
}

@Injectable()
export class PosCatalogService {
  constructor(private readonly transactions: TenantTransactionService) {}

  async products(actor: TenantScope, page: PosPage) {
    return this.transactions.run(actor, async (tx) => {
      const shop = await tx.tenant.findFirst({
        where: { id: actor.tenantId },
        select: { defaultLocationId: true },
      });
      const where = { tenantId: actor.tenantId, isActive: true };
      const [rows, total] = await Promise.all([
        tx.product.findMany({
          where,
          select: {
            id: true,
            name: true,
            nameEn: true,
            nameHi: true,
            nameMr: true,
            sku: true,
            defaultSellingPrice: true,
            isActive: true,
            unit: { select: { name: true, shortCode: true } },
            barcodes: { select: { barcode: true } },
          },
          orderBy: { name: "asc" },
          skip: (page.page - 1) * page.limit,
          take: page.limit,
        }),
        tx.product.count({ where }),
      ]);
      const balances = shop?.defaultLocationId
        ? await tx.inventoryBalance.findMany({
            where: {
              tenantId: actor.tenantId,
              locationId: shop.defaultLocationId,
              productId: { in: rows.map((row) => row.id) },
            },
            select: { productId: true, quantity: true },
          })
        : [];
      const quantityByProduct = new Map(balances.map((row) => [row.productId, row.quantity]));
      return {
        data: rows.map((row) => ({
          productId: row.id,
          name: row.name,
          nameEn: row.nameEn,
          nameHi: row.nameHi,
          nameMr: row.nameMr,
          sku: row.sku,
          barcodes: row.barcodes.map((item) => item.barcode),
          sellingPrice: formatMoney(row.defaultSellingPrice),
          unit: row.unit.shortCode || row.unit.name,
          active: row.isActive,
          quantity: formatStock(quantityByProduct.get(row.id) ?? 0),
        })),
        pagination: { page: page.page, limit: page.limit, total },
      };
    });
  }

  async customers(actor: TenantScope, page: PosPage) {
    return this.transactions.run(actor, async (tx) => {
      const where = { tenantId: actor.tenantId, isActive: true };
      const [rows, total] = await Promise.all([
        tx.customer.findMany({
          where,
          select: { id: true, name: true, phone: true, isActive: true, receivableBalance: true },
          orderBy: { name: "asc" },
          skip: (page.page - 1) * page.limit,
          take: page.limit,
        }),
        tx.customer.count({ where }),
      ]);
      return {
        data: rows.map((row) => ({
          customerId: row.id,
          name: row.name,
          phone: row.phone,
          active: row.isActive,
          outstanding: formatMoney(row.receivableBalance),
        })),
        pagination: { page: page.page, limit: page.limit, total },
      };
    });
  }

  async customerPrices(actor: TenantScope, page: PosPage) {
    return this.transactions.run(actor, async (tx) => {
      const where = {
        tenantId: actor.tenantId,
        customer: { isActive: true },
        product: { isActive: true },
      };
      const [rows, total] = await Promise.all([
        tx.customerProductPrice.findMany({
          where,
          select: { customerId: true, productId: true, sellingPrice: true },
          orderBy: { updatedAt: "desc" },
          skip: (page.page - 1) * page.limit,
          take: page.limit,
        }),
        tx.customerProductPrice.count({ where }),
      ]);
      return {
        data: rows.map((row) => ({
          customerId: row.customerId,
          productId: row.productId,
          sellingPrice: formatMoney(row.sellingPrice),
        })),
        pagination: { page: page.page, limit: page.limit, total },
      };
    });
  }
}

export function posPage(page?: number, limit?: number): PosPage {
  return {
    page: page && page > 0 ? page : 1,
    limit: Math.min(limit && limit > 0 ? limit : 50, PAGE_LIMIT),
  };
}
