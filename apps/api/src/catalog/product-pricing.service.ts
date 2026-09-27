import { Injectable } from "@nestjs/common";
import { PriceChangeSource, PriceType, Prisma } from "@prisma/client";
import { AuditRecorder } from "../audit/audit-recorder";
import { ShopDb } from "../database/prisma.types";

export interface ManualPriceChange {
  priceType: PriceType;
  oldPrice: Prisma.Decimal | null;
  newPrice: Prisma.Decimal;
}

export interface ResolvedSellingPrice {
  price: Prisma.Decimal;
  source: "CUSTOMER" | "LIST";
}

/**
 * Catalog price changes and the later customer-price lookup.
 * Customer records are not created here.
 */
@Injectable()
export class ProductPricingService {
  constructor(private readonly audit: AuditRecorder) {}

  async recordManual(
    tx: ShopDb,
    scope: { tenantId: string; userId: string; productId: string },
    changes: ManualPriceChange[],
  ): Promise<void> {
    if (changes.length === 0) {
      return;
    }
    await tx.productPriceHistory.createMany({
      data: changes.map((change) => ({
        tenantId: scope.tenantId,
        productId: scope.productId,
        priceType: change.priceType,
        oldPrice: change.oldPrice,
        newPrice: change.newPrice,
        source: PriceChangeSource.MANUAL,
        changedBy: scope.userId,
      })),
    });
    await this.audit.write(tx, {
      action: "price.changed",
      entityType: "product",
      entityId: scope.productId,
      tenantId: scope.tenantId,
      actorUserId: scope.userId,
    });
  }

  /**
   * Current customer price when one exists. Otherwise the catalog selling price.
   * A stored customer price is used as-is. There is no fallback when that row exists.
   */
  async resolveSellingPrice(
    tx: ShopDb,
    scope: { tenantId: string; productId: string; customerId?: string; at?: Date },
  ): Promise<ResolvedSellingPrice | null> {
    const at = scope.at ?? new Date();
    if (scope.customerId) {
      const special = await tx.customerProductPrice.findFirst({
        where: {
          tenantId: scope.tenantId,
          productId: scope.productId,
          customerId: scope.customerId,
          AND: [
            { OR: [{ validFrom: null }, { validFrom: { lte: at } }] },
            { OR: [{ validUntil: null }, { validUntil: { gt: at } }] },
          ],
        },
        select: { sellingPrice: true },
      });
      if (special) {
        return { price: special.sellingPrice, source: "CUSTOMER" };
      }
    }
    const product = await tx.product.findFirst({
      where: { id: scope.productId, tenantId: scope.tenantId },
      select: { defaultSellingPrice: true },
    });
    if (!product?.defaultSellingPrice) {
      return null;
    }
    return { price: product.defaultSellingPrice, source: "LIST" };
  }

  async setCustomerPrice(
    tx: ShopDb,
    scope: { tenantId: string; customerId: string; productId: string },
    sellingPrice: Prisma.Decimal,
  ): Promise<void> {
    await tx.customerProductPrice.upsert({
      where: {
        tenantId_customerId_productId: {
          tenantId: scope.tenantId,
          customerId: scope.customerId,
          productId: scope.productId,
        },
      },
      create: {
        tenantId: scope.tenantId,
        customerId: scope.customerId,
        productId: scope.productId,
        sellingPrice,
      },
      update: { sellingPrice },
    });
  }
}
