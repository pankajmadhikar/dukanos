import { createHash } from "node:crypto";
import { HttpStatus, Injectable } from "@nestjs/common";
import { MovementType, Prisma } from "@prisma/client";
import { AuditRecorder } from "../audit/audit-recorder";
import { formatMoney, formatStock, parseMoney, parseStock } from "../catalog/decimal";
import { normalizeSearch } from "../catalog/text";
import { ShopDb, TenantScope } from "../database/prisma.types";
import { TenantTransactionService } from "../database/tenant-transaction.service";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";
import { InventoryLedgerService } from "../inventory/inventory-ledger.service";
import { CreatePurchaseDto } from "./dto/purchase.dto";
import { PurchaseView } from "./purchase.presenter";

interface PreparedItem {
  productId: string;
  quantity: Prisma.Decimal;
  unitCost: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
}

interface ListQuery {
  supplierId?: string;
  locationId?: string;
  productId?: string;
  from?: string;
  to?: string;
  search?: string;
  page: number;
  limit: number;
}

const purchaseInclude = {
  supplier: { select: { id: true, name: true } },
  location: { select: { id: true, name: true } },
  creator: { select: { id: true, name: true } },
  items: {
    include: { product: { select: { id: true, name: true, sku: true } } },
    orderBy: { createdAt: "asc" as const },
  },
};

@Injectable()
export class PurchaseService {
  constructor(
    private readonly transactions: TenantTransactionService,
    private readonly ledger: InventoryLedgerService,
    private readonly audit: AuditRecorder,
  ) {}

  async create(actor: TenantScope, body: CreatePurchaseDto, idempotencyKey?: string): Promise<PurchaseView> {
    const items = prepareItems(body.items);
    const invoice = body.invoiceNumber?.trim() || null;
    const hash = digest([
      body.supplierId,
      body.locationId ?? "",
      body.purchaseDate ?? "",
      invoice ?? "",
      body.notes?.trim() ?? "",
      ...items.map((item) => `${item.productId}|${item.quantity.toFixed(3)}|${item.unitCost.toFixed(2)}`),
    ]);
    const key = normalizeKey(idempotencyKey);
    return this.transactions.run(actor, async (tx) => {
      if (key) {
        const replay = await this.claim(tx, actor.tenantId, key, hash);
        if (replay) {
          return replay;
        }
      }
      const posted = await this.postPurchase(tx, actor, body, items, invoice);
      if (key) {
        await tx.idempotencyKey.update({
          where: { tenantId_key: { tenantId: actor.tenantId, key } },
          data: { responseStatus: 201, responseBody: storePurchase(posted) },
        });
      }
      return posted;
    });
  }

  /** Posts a purchase inside the caller's shop transaction. The caller owns idempotency. */
  createWithin(tx: ShopDb, actor: TenantScope, body: CreatePurchaseDto): Promise<PurchaseView> {
    const items = prepareItems(body.items);
    const invoice = body.invoiceNumber?.trim() || null;
    return this.postPurchase(tx, actor, body, items, invoice);
  }

  async list(actor: TenantScope, query: ListQuery) {
    return this.transactions.run(actor, async (tx) => {
      if (query.supplierId) {
        const supplier = await tx.supplier.findFirst({
          where: { id: query.supplierId, tenantId: actor.tenantId },
          select: { id: true },
        });
        if (!supplier) {
          throw new AppException(ErrorCode.SUPPLIER_NOT_FOUND, "Supplier was not found.", HttpStatus.NOT_FOUND);
        }
      }
      const text = query.search ? normalizeSearch(query.search) : "";
      const where: Prisma.PurchaseWhereInput = {
        tenantId: actor.tenantId,
        ...(query.supplierId ? { supplierId: query.supplierId } : {}),
        ...(query.locationId ? { locationId: query.locationId } : {}),
        ...(query.productId ? { items: { some: { productId: query.productId } } } : {}),
        ...(query.from || query.to
          ? {
              businessDate: {
                ...(query.from ? { gte: dateOnly(query.from) } : {}),
                ...(query.to ? { lte: dateOnly(query.to) } : {}),
              },
            }
          : {}),
        ...(text
          ? {
              OR: [
                { billNumber: { contains: text, mode: "insensitive" } },
                { supplierInvoiceNumber: { contains: text, mode: "insensitive" } },
                { supplier: { name: { contains: text, mode: "insensitive" } } },
              ],
            }
          : {}),
      };
      const [rows, total] = await Promise.all([
        tx.purchase.findMany({
          where,
          include: {
            supplier: { select: { id: true, name: true } },
            location: { select: { id: true, name: true } },
            creator: { select: { id: true, name: true } },
          },
          orderBy: [{ businessDate: "desc" }, { createdAt: "desc" }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        tx.purchase.count({ where }),
      ]);
      return { data: rows, pagination: { page: query.page, limit: query.limit, total } };
    });
  }

  async get(actor: TenantScope, purchaseId: string): Promise<PurchaseView> {
    return this.transactions.run(actor, async (tx) => {
      const purchase = await tx.purchase.findFirst({
        where: { id: purchaseId, tenantId: actor.tenantId },
        include: purchaseInclude,
      });
      if (!purchase) {
        throw new AppException(ErrorCode.PURCHASE_NOT_FOUND, "Purchase was not found.", HttpStatus.NOT_FOUND);
      }
      const itemIds = purchase.items.map((item) => item.id);
      const returned = itemIds.length === 0
        ? []
        : await tx.purchaseReturnItem.groupBy({
            by: ["originalPurchaseItemId"],
            where: { tenantId: actor.tenantId, originalPurchaseItemId: { in: itemIds } },
            _sum: { quantity: true },
          });
      const returnedByItem = new Map(
        returned.map((row) => [row.originalPurchaseItemId, row._sum.quantity ?? new Prisma.Decimal(0)]),
      );
      return {
        ...purchase,
        items: purchase.items.map((item) => ({
          ...item,
          returnedQuantity: returnedByItem.get(item.id) ?? new Prisma.Decimal(0),
        })),
      };
    });
  }

  async productHistory(actor: TenantScope, productId: string, page: number, limit: number) {
    return this.transactions.run(actor, async (tx) => {
      const product = await tx.product.findFirst({
        where: { id: productId, tenantId: actor.tenantId },
        select: { id: true },
      });
      if (!product) {
        throw new AppException(ErrorCode.PRODUCT_NOT_FOUND, "Product was not found.", HttpStatus.NOT_FOUND);
      }
      const where = { tenantId: actor.tenantId, productId };
      const [rows, total] = await Promise.all([
        tx.purchaseItem.findMany({
          where,
          include: {
            purchase: {
              select: {
                id: true,
                billNumber: true,
                purchaseDate: true,
                businessDate: true,
                supplier: { select: { name: true } },
              },
            },
          },
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        tx.purchaseItem.count({ where }),
      ]);
      return {
        data: rows.map((row) => ({
          purchaseId: row.purchase.id,
          billNumber: row.purchase.billNumber,
          purchaseDate: row.purchase.purchaseDate,
          businessDate: row.purchase.businessDate,
          supplierName: row.purchase.supplier?.name ?? null,
          quantity: row.quantity,
          unitCost: row.unitCost,
        })),
        pagination: { page, limit, total },
      };
    });
  }

  private async postPurchase(
    tx: ShopDb,
    actor: TenantScope,
    body: CreatePurchaseDto,
    items: PreparedItem[],
    invoice: string | null,
  ): Promise<PurchaseView> {
    const supplier = await tx.$queryRaw<Array<{ id: string; is_active: boolean; payable_balance: unknown }>>`
      SELECT id, is_active, payable_balance
      FROM suppliers
      WHERE id = ${body.supplierId}::uuid AND tenant_id = ${actor.tenantId}::uuid
      FOR UPDATE
    `;
    const lockedSupplier = supplier[0];
    if (!lockedSupplier) {
      throw new AppException(ErrorCode.SUPPLIER_NOT_FOUND, "Supplier was not found.", HttpStatus.NOT_FOUND);
    }
    if (!lockedSupplier.is_active) {
      throw new AppException(
        ErrorCode.SUPPLIER_INACTIVE,
        "Inactive suppliers cannot be used for a new purchase.",
        HttpStatus.CONFLICT,
      );
    }
    if (invoice) {
      const clash = await tx.purchase.findFirst({
        where: { tenantId: actor.tenantId, supplierId: body.supplierId, supplierInvoiceNumber: invoice },
        select: { id: true },
      });
      if (clash) {
        throw new AppException(
          ErrorCode.CONFLICT,
          "This supplier invoice is already recorded.",
          HttpStatus.CONFLICT,
        );
      }
    }
    const locationId = await this.resolveLocation(tx, actor.tenantId, body.locationId);
    const location = await tx.location.findFirst({
      where: { id: locationId, tenantId: actor.tenantId },
      select: { id: true, name: true },
    });
    if (!location) {
      throw new AppException(ErrorCode.NOT_FOUND, "Location was not found.", HttpStatus.NOT_FOUND);
    }
    await this.requireActiveProducts(tx, actor.tenantId, items.map((item) => item.productId));

    const subtotal = items.reduce(
      (sum, item) => sum.plus(item.lineTotal),
      new Prisma.Decimal(0),
    );
    const purchaseAt = await shopInstant(tx, actor.tenantId, body.purchaseDate);
    const numbers = await tx.$queryRaw<Array<{ next_document_number: string }>>`
      SELECT next_document_number(${actor.tenantId}::uuid, 'PURCHASE'::document_type) AS next_document_number
    `;
    const billNumber = numbers[0]?.next_document_number;
    if (!billNumber) {
      throw new AppException(
        ErrorCode.INVALID_BUSINESS_OPERATION,
        "This shop has no purchase number.",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const purchase = await tx.purchase.create({
      data: {
        tenantId: actor.tenantId,
        supplierId: body.supplierId,
        locationId,
        billNumber,
        supplierInvoiceNumber: invoice,
        purchaseDate: purchaseAt,
        businessDate: new Date(Date.UTC(2000, 0, 1)),
        subtotal,
        discountTotal: new Prisma.Decimal(0),
        taxTotal: new Prisma.Decimal(0),
        grandTotal: subtotal,
        notes: body.notes?.trim() || null,
        status: "DRAFT",
        createdBy: actor.userId,
      },
      select: { id: true, businessDate: true },
    });

    const lines: Array<PreparedItem & { id: string }> = [];
    for (const item of items) {
      const line = await tx.purchaseItem.create({
        data: {
          tenantId: actor.tenantId,
          purchaseId: purchase.id,
          productId: item.productId,
          quantity: item.quantity,
          unitCost: item.unitCost,
          discountAmount: new Prisma.Decimal(0),
          taxAmount: new Prisma.Decimal(0),
          lineTotal: item.lineTotal,
        },
        select: { id: true },
      });
      lines.push({ ...item, id: line.id });
    }
    lines.sort((left, right) => left.productId.localeCompare(right.productId));
    for (const line of lines) {
      await this.ledger.post(tx, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        productId: line.productId,
        locationId,
        movementType: MovementType.PURCHASE,
        direction: "IN",
        quantity: line.quantity,
        unitCost: line.unitCost,
        occurredAt: purchaseAt,
        reference: { type: "PURCHASE", id: purchase.id, lineId: line.id },
      });
    }

    if (subtotal.gt(0)) {
      const dated = await tx.purchase.findFirst({
        where: { id: purchase.id },
        select: { businessDate: true },
      });
      const payable = asDecimal(lockedSupplier.payable_balance).plus(subtotal);
      await tx.supplier.update({
        where: { id: body.supplierId },
        data: { payableBalance: payable },
      });
      await tx.supplierLedger.create({
        data: {
          tenantId: actor.tenantId,
          supplierId: body.supplierId,
          entryType: "PURCHASE",
          creditAmount: subtotal,
          debitAmount: new Prisma.Decimal(0),
          runningBalance: payable,
          referenceType: "PURCHASE",
          referenceId: purchase.id,
          businessDate: dated?.businessDate ?? purchase.businessDate,
        },
      });
    }

    await tx.purchase.update({
      where: { id: purchase.id },
      data: { status: "CONFIRMED" },
    });
    await this.audit.write(tx, {
      action: "purchase.created",
      entityType: "purchase",
      entityId: purchase.id,
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
    });
    await this.audit.write(tx, {
      action: "purchase.posted",
      entityType: "purchase",
      entityId: purchase.id,
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
    });

    const saved = await tx.purchase.findFirst({
      where: { id: purchase.id, tenantId: actor.tenantId },
      include: purchaseInclude,
    });
    if (!saved) {
      throw new AppException(ErrorCode.PURCHASE_NOT_FOUND, "Purchase was not found.", HttpStatus.NOT_FOUND);
    }
    return saved;
  }

  private async resolveLocation(tx: ShopDb, tenantId: string, locationId?: string): Promise<string> {
    if (locationId) {
      const location = await tx.location.findFirst({
        where: { id: locationId, tenantId, isActive: true },
        select: { id: true },
      });
      if (!location) {
        throw new AppException(ErrorCode.NOT_FOUND, "Location was not found.", HttpStatus.NOT_FOUND);
      }
      return location.id;
    }
    const shop = await tx.tenant.findFirst({
      where: { id: tenantId },
      select: { defaultLocationId: true },
    });
    if (!shop?.defaultLocationId) {
      throw new AppException(ErrorCode.NOT_FOUND, "This shop has no default location.", HttpStatus.NOT_FOUND);
    }
    return shop.defaultLocationId;
  }

  private async requireActiveProducts(tx: ShopDb, tenantId: string, productIds: string[]): Promise<void> {
    const products = await tx.product.findMany({
      where: { tenantId, id: { in: productIds } },
      select: { id: true, isActive: true },
    });
    const byId = new Map(products.map((product) => [product.id, product.isActive]));
    for (const productId of productIds) {
      const active = byId.get(productId);
      if (active === undefined) {
        throw new AppException(ErrorCode.PRODUCT_NOT_FOUND, "Product was not found.", HttpStatus.NOT_FOUND);
      }
      if (!active) {
        throw new AppException(
          ErrorCode.PRODUCT_INACTIVE,
          "Inactive products cannot receive purchased stock.",
          HttpStatus.CONFLICT,
        );
      }
    }
  }

  private async claim(
    tx: ShopDb,
    tenantId: string,
    key: string,
    requestHash: string,
  ): Promise<PurchaseView | null> {
    const existing = await tx.idempotencyKey.findUnique({
      where: { tenantId_key: { tenantId, key } },
    });
    if (!existing) {
      await tx.idempotencyKey.create({ data: { tenantId, key, requestHash } });
      return null;
    }
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
    const stored = existing.responseBody as { id?: string };
    if (!stored.id) {
      throw new AppException(
        ErrorCode.IDEMPOTENCY_CONFLICT,
        "This request was already processed.",
        HttpStatus.CONFLICT,
      );
    }
    const purchase = await tx.purchase.findFirst({
      where: { id: stored.id, tenantId },
      include: purchaseInclude,
    });
    if (!purchase) {
      throw new AppException(
        ErrorCode.IDEMPOTENCY_CONFLICT,
        "This request was already processed.",
        HttpStatus.CONFLICT,
      );
    }
    return purchase;
  }
}

function prepareItems(items: CreatePurchaseDto["items"]): PreparedItem[] {
  const seen = new Set<string>();
  return items.map((item) => {
    if (seen.has(item.productId)) {
      throw new AppException(
        ErrorCode.DUPLICATE_PURCHASE_LINE,
        "A product can appear only once on a purchase.",
        HttpStatus.CONFLICT,
      );
    }
    seen.add(item.productId);
    const quantity = parseStock(item.quantity);
    if (quantity.lte(0)) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        "Quantity must be greater than zero.",
        HttpStatus.BAD_REQUEST,
      );
    }
    const unitCost = parseMoney(item.unitCost);
    return {
      productId: item.productId,
      quantity,
      unitCost,
      lineTotal: quantity.mul(unitCost).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
    };
  });
}

async function shopInstant(tx: ShopDb, tenantId: string, businessDate: string | undefined): Promise<Date> {
  if (!businessDate) {
    return new Date();
  }
  const rows = await tx.$queryRaw<Array<{ ts: Date }>>`
    SELECT ((${businessDate}::text || ' 12:00:00')::timestamp AT TIME ZONE timezone) AS ts
    FROM tenants
    WHERE id = ${tenantId}::uuid
  `;
  const instant = rows[0]?.ts;
  if (!instant) {
    throw new AppException(ErrorCode.NOT_FOUND, "Shop was not found.", HttpStatus.NOT_FOUND);
  }
  return instant;
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

function storePurchase(purchase: PurchaseView): Prisma.InputJsonObject {
  return {
    id: purchase.id,
    purchaseNumber: purchase.billNumber,
    total: formatMoney(purchase.grandTotal) ?? "0.00",
    items: (purchase.items ?? []).map((item) => ({
      productId: item.product.id,
      quantity: formatStock(item.quantity) ?? "0.000",
    })),
  };
}

function dateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function asDecimal(value: unknown): Prisma.Decimal {
  if (value instanceof Prisma.Decimal) {
    return value;
  }
  return new Prisma.Decimal(String(value));
}
