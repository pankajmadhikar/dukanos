import { createHash } from "node:crypto";
import { HttpStatus, Injectable } from "@nestjs/common";
import { MovementType, Prisma } from "@prisma/client";
import { formatMoney, formatStock, parseMoney, parseStock } from "../catalog/decimal";
import { escapeLike, normalizeBarcode, normalizeSearch, normalizeSku } from "../catalog/text";
import { ShopDb, TenantScope } from "../database/prisma.types";
import { TenantTransactionService } from "../database/tenant-transaction.service";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";
import { OpeningStockDto, StockAdjustmentDto } from "./dto/inventory.dto";
import { InventoryLedgerService, PostedStock } from "./inventory-ledger.service";
import { isLowStock, isOutOfStock, stockValue } from "./stock-calculator";

interface ListQuery {
  locationId?: string;
  productId?: string;
  search?: string;
  lowStock: boolean;
  page: number;
  limit: number;
}

interface HistoryQuery {
  locationId?: string;
  movementType?: MovementType;
  from?: string;
  to?: string;
  page: number;
  limit: number;
}

interface StoredPost {
  movementId: string;
  adjustmentId: string;
  adjustmentNumber: string;
  productId: string;
  locationId: string;
  movementType: MovementType;
  quantity: string;
  quantityAfter: string;
  averageCostAfter: string | null;
}

@Injectable()
export class InventoryService {
  constructor(
    private readonly transactions: TenantTransactionService,
    private readonly ledger: InventoryLedgerService,
  ) {}

  async opening(actor: TenantScope, body: OpeningStockDto, idempotencyKey?: string) {
    const quantity = requirePositive(parseStock(body.quantity));
    const unitCost = parseMoney(body.unitCost);
    const hash = digest([
      "OPENING",
      body.productId,
      body.locationId ?? "",
      quantity.toFixed(3),
      unitCost.toFixed(2),
    ]);
    return this.postOnce(actor, idempotencyKey, hash, (tx) =>
      this.openingWithin(tx, actor, {
        productId: body.productId,
        locationId: body.locationId,
        quantity,
        unitCost,
      }),
    );
  }

  /** Posts opening stock inside the caller's shop transaction. */
  openingWithin(
    tx: ShopDb,
    actor: TenantScope,
    body: { productId: string; locationId?: string; quantity: Prisma.Decimal; unitCost: Prisma.Decimal },
  ) {
    return this.ledger.post(tx, {
      tenantId: actor.tenantId,
      userId: actor.userId,
      productId: body.productId,
      locationId: body.locationId,
      movementType: MovementType.OPENING_STOCK,
      direction: "IN",
      quantity: body.quantity,
      unitCost: body.unitCost,
      note: "Opening stock",
    });
  }

  async adjust(actor: TenantScope, body: StockAdjustmentDto, idempotencyKey?: string) {
    const quantity = requirePositive(parseStock(body.quantity));
    const inbound = body.type === "IN";
    const unitCost = inbound ? parseMoney(body.unitCost) : undefined;
    const movementType =
      body.type === "DAMAGE"
        ? MovementType.DAMAGE
        : body.type === "EXPIRY"
          ? MovementType.EXPIRY
          : MovementType.ADJUSTMENT;
    const hash = digest([
      body.type,
      body.productId,
      body.locationId ?? "",
      quantity.toFixed(3),
      unitCost?.toFixed(2) ?? "",
      body.reason?.trim() ?? "",
    ]);
    return this.postOnce(actor, idempotencyKey, hash, (tx) =>
      this.ledger.post(tx, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        productId: body.productId,
        locationId: body.locationId,
        movementType,
        direction: inbound ? "IN" : "OUT",
        quantity,
        unitCost,
        note: body.reason,
      }),
    );
  }

  async list(actor: TenantScope, query: ListQuery) {
    return this.transactions.run(actor, async (tx) => {
      let productIds = query.search
        ? await this.searchProductIds(tx, actor.tenantId, query.search)
        : null;
      if (productIds && productIds.length === 0) {
        return { data: [], pagination: { page: query.page, limit: query.limit, total: 0 } };
      }
      if (query.productId) {
        if (productIds && !productIds.includes(query.productId)) {
          return { data: [], pagination: { page: query.page, limit: query.limit, total: 0 } };
        }
        productIds = [query.productId];
      }
      const where: Prisma.InventoryBalanceWhereInput = {
        tenantId: actor.tenantId,
        ...(query.locationId ? { locationId: query.locationId } : {}),
        ...(productIds ? { productId: { in: productIds } } : {}),
      };
      if (query.lowStock) {
        const ids = await this.lowStockIds(tx, actor.tenantId, query.locationId, productIds);
        if (ids.length === 0) {
          return { data: [], pagination: { page: query.page, limit: query.limit, total: 0 } };
        }
        where.id = { in: ids };
      }
      const [rows, total] = await Promise.all([
        tx.inventoryBalance.findMany({
          where,
          include: {
            product: { include: { unit: true } },
            location: true,
          },
          orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        tx.inventoryBalance.count({ where }),
      ]);
      return {
        data: rows.map((row) => ({
          product: {
            id: row.product.id,
            name: row.product.name,
            sku: row.product.sku,
            sellingPrice: row.product.defaultSellingPrice,
            minimumStockLevel: row.product.minimumStockLevel,
            unit: row.product.unit.shortCode,
          },
          location: { id: row.location.id, name: row.location.name },
          quantity: row.quantity,
          averageCost: row.averageCost,
        })),
        pagination: { page: query.page, limit: query.limit, total },
      };
    });
  }

  async summary(actor: TenantScope, locationId?: string) {
    return this.transactions.run(actor, async (tx) => {
      const rows = await tx.inventoryBalance.findMany({
        where: {
          tenantId: actor.tenantId,
          ...(locationId ? { locationId } : {}),
        },
        include: { product: { select: { minimumStockLevel: true } } },
      });
      let productsWithStock = 0;
      let outOfStock = 0;
      let lowStock = 0;
      let totalQuantity = new Prisma.Decimal(0);
      let totalStockValue = new Prisma.Decimal(0);
      let valued = false;
      for (const row of rows) {
        totalQuantity = totalQuantity.plus(row.quantity);
        if (isOutOfStock(row.quantity)) {
          outOfStock += 1;
        } else {
          productsWithStock += 1;
        }
        if (isLowStock(row.quantity, row.product.minimumStockLevel)) {
          lowStock += 1;
        }
        const value = stockValue(row.quantity, row.averageCost);
        if (value) {
          valued = true;
          totalStockValue = totalStockValue.plus(value);
        }
      }
      return {
        productsWithStock,
        outOfStock,
        lowStock,
        totalQuantity,
        totalStockValue: valued ? totalStockValue : null,
      };
    });
  }

  async product(actor: TenantScope, productId: string) {
    return this.transactions.run(actor, async (tx) => {
      const product = await tx.product.findFirst({
        where: { id: productId, tenantId: actor.tenantId },
        include: { unit: true },
      });
      if (!product) {
        throw new AppException(ErrorCode.PRODUCT_NOT_FOUND, "Product was not found.", HttpStatus.NOT_FOUND);
      }
      const [locations, balances] = await Promise.all([
        tx.location.findMany({
          where: { tenantId: actor.tenantId, isActive: true },
          orderBy: { name: "asc" },
        }),
        tx.inventoryBalance.findMany({
          where: { tenantId: actor.tenantId, productId },
        }),
      ]);
      const byLocation = new Map(balances.map((row) => [row.locationId, row]));
      return {
        product: {
          id: product.id,
          name: product.name,
          sku: product.sku,
          isActive: product.isActive,
          sellingPrice: product.defaultSellingPrice,
          unit: product.unit.shortCode,
          minimumStockLevel: product.minimumStockLevel,
        },
        locations: locations.map((location) => {
          const balance = byLocation.get(location.id);
          return {
            product: {
              id: product.id,
              name: product.name,
              sku: product.sku,
              sellingPrice: product.defaultSellingPrice,
              minimumStockLevel: product.minimumStockLevel,
              unit: product.unit.shortCode,
            },
            location: { id: location.id, name: location.name },
            quantity: balance?.quantity ?? new Prisma.Decimal(0),
            averageCost: balance?.averageCost ?? null,
          };
        }),
      };
    });
  }

  async movements(actor: TenantScope, productId: string, query: HistoryQuery) {
    return this.transactions.run(actor, async (tx) => {
      const product = await tx.product.findFirst({
        where: { id: productId, tenantId: actor.tenantId },
        select: { id: true },
      });
      if (!product) {
        throw new AppException(ErrorCode.PRODUCT_NOT_FOUND, "Product was not found.", HttpStatus.NOT_FOUND);
      }
      const where: Prisma.InventoryMovementWhereInput = {
        tenantId: actor.tenantId,
        productId,
        ...(query.locationId ? { locationId: query.locationId } : {}),
        ...(query.movementType ? { movementType: query.movementType } : {}),
        ...(query.from || query.to
          ? {
              businessDate: {
                ...(query.from ? { gte: dateOnly(query.from) } : {}),
                ...(query.to ? { lte: dateOnly(query.to) } : {}),
              },
            }
          : {}),
      };
      const [rows, total] = await Promise.all([
        tx.inventoryMovement.findMany({
          where,
          orderBy: [{ occurredAt: "desc" }, { id: "asc" }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        tx.inventoryMovement.count({ where }),
      ]);
      const lineIds = rows.map((row) => row.sourceLineId);
      const lines =
        lineIds.length === 0
          ? []
          : await tx.stockAdjustmentItem.findMany({
              where: { tenantId: actor.tenantId, id: { in: lineIds } },
              select: { id: true, reason: true },
            });
      const reasons = new Map(lines.map((line) => [line.id, line.reason]));
      return {
        data: rows.map((row) => ({
          id: row.id,
          occurredAt: row.occurredAt,
          businessDate: row.businessDate,
          movementType: row.movementType,
          quantityDelta: row.quantityDelta,
          unitCost: row.unitCost,
          referenceType: row.referenceType,
          referenceId: row.referenceId,
          createdBy: row.createdBy,
          reason: reasons.get(row.sourceLineId) ?? null,
        })),
        pagination: { page: query.page, limit: query.limit, total },
      };
    });
  }

  private async postOnce(
    actor: TenantScope,
    idempotencyKey: string | undefined,
    requestHash: string,
    work: (tx: ShopDb) => Promise<PostedStock>,
  ): Promise<PostedStock> {
    const key = normalizeKey(idempotencyKey);
    return this.transactions.run(actor, async (tx) => {
      if (key) {
        const replay = await this.claim(tx, actor.tenantId, key, requestHash);
        if (replay) {
          return replay;
        }
      }
      const posted = await work(tx);
      if (key) {
        await tx.idempotencyKey.update({
          where: { tenantId_key: { tenantId: actor.tenantId, key } },
          data: {
            responseStatus: 201,
            responseBody: storePost(posted),
          },
        });
      }
      return posted;
    });
  }

  private async claim(
    tx: ShopDb,
    tenantId: string,
    key: string,
    requestHash: string,
  ): Promise<PostedStock | null> {
    const existing = await tx.idempotencyKey.findUnique({
      where: { tenantId_key: { tenantId, key } },
    });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new AppException(
          ErrorCode.IDEMPOTENCY_CONFLICT,
          "This idempotency key was already used for a different request.",
          HttpStatus.CONFLICT,
        );
      }
      if (!existing.responseBody) {
        throw new AppException(
          ErrorCode.IDEMPOTENCY_CONFLICT,
          "This request was already processed.",
          HttpStatus.CONFLICT,
        );
      }
      return restorePost(existing.responseBody);
    }
    await tx.idempotencyKey.create({
      data: { tenantId, key, requestHash },
    });
    return null;
  }

  private async searchProductIds(tx: ShopDb, tenantId: string, search: string): Promise<string[]> {
    const text = normalizeSearch(search);
    if (!text) {
      return [];
    }
    const barcode = await tx.productBarcode.findFirst({
      where: { tenantId, barcode: normalizeBarcode(text) },
      select: { productId: true },
    });
    if (barcode) {
      return [barcode.productId];
    }
    const sku = await tx.product.findFirst({
      where: { tenantId, sku: normalizeSku(text) },
      select: { id: true },
    });
    if (sku) {
      return [sku.id];
    }
    const like = `%${escapeLike(text)}%`;
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM products
      WHERE tenant_id = ${tenantId}::uuid
        AND (
          name ILIKE ${like} ESCAPE '\\'
          OR name_en ILIKE ${like} ESCAPE '\\'
          OR name_hi ILIKE ${like} ESCAPE '\\'
          OR name_mr ILIKE ${like} ESCAPE '\\'
        )
      ORDER BY CASE WHEN lower(name) = lower(${text}) THEN 0 ELSE 1 END, name
      LIMIT 100
    `;
    return rows.map((row) => row.id);
  }

  private async lowStockIds(
    tx: ShopDb,
    tenantId: string,
    locationId: string | undefined,
    productIds: string[] | null,
  ): Promise<string[]> {
    const onlyProduct = productIds && productIds.length === 1 ? productIds[0] : null;
    const rows = await tx.$queryRaw<Array<{ id: string; product_id: string }>>`
      SELECT b.id, b.product_id
      FROM inventory_balances b
      JOIN products p ON p.id = b.product_id AND p.tenant_id = b.tenant_id
      WHERE b.tenant_id = ${tenantId}::uuid
        AND b.quantity > 0
        AND p.minimum_stock_level IS NOT NULL
        AND b.quantity <= p.minimum_stock_level
        AND (${locationId ?? null}::uuid IS NULL OR b.location_id = ${locationId ?? null}::uuid)
        AND (${onlyProduct}::uuid IS NULL OR b.product_id = ${onlyProduct}::uuid)
    `;
    if (!productIds || productIds.length <= 1) {
      return rows.map((row) => row.id);
    }
    const allowed = new Set(productIds);
    return rows.filter((row) => allowed.has(row.product_id)).map((row) => row.id);
  }
}

function requirePositive(quantity: Prisma.Decimal): Prisma.Decimal {
  if (quantity.lte(0)) {
    throw new AppException(
      ErrorCode.VALIDATION_ERROR,
      "Quantity must be greater than zero.",
      HttpStatus.BAD_REQUEST,
    );
  }
  return quantity;
}

function normalizeKey(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") {
    return null;
  }
  const key = value.trim();
  if (key.length > 128 || /\s/.test(key)) {
    throw new AppException(
      ErrorCode.VALIDATION_ERROR,
      "Idempotency-Key must be 1 to 128 characters without spaces.",
      HttpStatus.BAD_REQUEST,
    );
  }
  return key;
}

function digest(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

function storePost(posted: PostedStock): Prisma.InputJsonObject {
  const body: StoredPost = {
    movementId: posted.movementId,
    adjustmentId: posted.adjustmentId,
    adjustmentNumber: posted.adjustmentNumber,
    productId: posted.productId,
    locationId: posted.locationId,
    movementType: posted.movementType,
    quantity: formatStock(posted.quantityDelta) ?? "0.000",
    quantityAfter: formatStock(posted.quantityAfter) ?? "0.000",
    averageCostAfter: formatMoney(posted.averageCostAfter),
  };
  return { ...body };
}

function restorePost(body: Prisma.JsonValue): PostedStock {
  const row = body as unknown as StoredPost;
  return {
    movementId: row.movementId,
    adjustmentId: row.adjustmentId,
    adjustmentNumber: row.adjustmentNumber,
    productId: row.productId,
    locationId: row.locationId,
    movementType: row.movementType,
    quantityDelta: new Prisma.Decimal(row.quantity),
    quantityAfter: new Prisma.Decimal(row.quantityAfter),
    averageCostAfter: row.averageCostAfter === null ? null : new Prisma.Decimal(row.averageCostAfter),
    unitCostApplied: null,
    costAmount: null,
  };
}

function dateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}
