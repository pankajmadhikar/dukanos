import { createHash } from "node:crypto";
import { HttpStatus, Injectable } from "@nestjs/common";
import { MovementType, Prisma } from "@prisma/client";
import { AuditRecorder } from "../audit/audit-recorder";
import { parseStock } from "../catalog/decimal";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";
import { ShopDb, TenantScope } from "../database/prisma.types";
import { TenantTransactionService } from "../database/tenant-transaction.service";
import { InventoryLedgerService } from "../inventory/inventory-ledger.service";
import { saleLineTotal } from "../sales/sale-calculator";
import { CreatePurchaseReturnDto } from "./dto/purchase-return.dto";
import { PurchaseReturnView } from "./purchase-return.presenter";

interface PreparedLine {
  purchaseItemId: string;
  quantity: Prisma.Decimal;
}

interface LockedLine {
  id: string;
  productId: string;
  quantity: Prisma.Decimal;
  unitCost: Prisma.Decimal;
}

interface ListQuery {
  purchaseId?: string;
  supplierId?: string;
  locationId?: string;
  returnNumber?: string;
  from?: string;
  to?: string;
  page: number;
  limit: number;
}

const returnInclude = {
  originalPurchase: { select: { id: true, billNumber: true } },
  supplier: { select: { id: true, name: true } },
  location: { select: { id: true, name: true } },
  creator: { select: { id: true, name: true } },
  items: {
    include: { product: { select: { id: true, name: true, sku: true } } },
    orderBy: { createdAt: "asc" as const },
  },
};

@Injectable()
export class PurchaseReturnService {
  constructor(
    private readonly transactions: TenantTransactionService,
    private readonly ledger: InventoryLedgerService,
    private readonly audit: AuditRecorder,
  ) {}

  async create(
    actor: TenantScope,
    body: CreatePurchaseReturnDto,
    idempotencyKey?: string,
  ): Promise<PurchaseReturnView> {
    const lines = prepareLines(body.items);
    const hash = digest([
      body.purchaseId,
      body.locationId ?? "",
      body.reason?.trim() ?? "",
      ...[...lines]
        .sort((left, right) => left.purchaseItemId.localeCompare(right.purchaseItemId))
        .map((line) => `${line.purchaseItemId}|${line.quantity.toFixed(3)}`),
    ]);
    const key = normalizeKey(idempotencyKey);
    return this.transactions.run(actor, async (tx) => {
      if (key) {
        const replay = await this.claim(tx, actor.tenantId, key, hash);
        if (replay) {
          return replay;
        }
      }
      const posted = await this.postReturn(tx, actor, body, lines);
      if (key) {
        await tx.idempotencyKey.update({
          where: { tenantId_key: { tenantId: actor.tenantId, key } },
          data: { responseStatus: 201, responseBody: { id: posted.id } satisfies Prisma.InputJsonObject },
        });
      }
      return posted;
    });
  }

  async list(actor: TenantScope, query: ListQuery) {
    return this.transactions.run(actor, async (tx) => {
      if (query.purchaseId) {
        const purchase = await tx.purchase.findFirst({
          where: { id: query.purchaseId, tenantId: actor.tenantId },
          select: { id: true },
        });
        if (!purchase) {
          throw new AppException(ErrorCode.PURCHASE_NOT_FOUND, "Purchase was not found.", HttpStatus.NOT_FOUND);
        }
      }
      if (query.supplierId) {
        const supplier = await tx.supplier.findFirst({
          where: { id: query.supplierId, tenantId: actor.tenantId },
          select: { id: true },
        });
        if (!supplier) {
          throw new AppException(ErrorCode.SUPPLIER_NOT_FOUND, "Supplier was not found.", HttpStatus.NOT_FOUND);
        }
      }
      if (query.locationId) {
        const location = await tx.location.findFirst({
          where: { id: query.locationId, tenantId: actor.tenantId },
          select: { id: true },
        });
        if (!location) {
          throw new AppException(
            ErrorCode.RETURN_LOCATION_INVALID,
            "Location was not found in this shop.",
            HttpStatus.NOT_FOUND,
          );
        }
      }
      const where: Prisma.PurchaseReturnWhereInput = {
        tenantId: actor.tenantId,
        ...(query.purchaseId ? { originalPurchaseId: query.purchaseId } : {}),
        ...(query.supplierId ? { supplierId: query.supplierId } : {}),
        ...(query.locationId ? { locationId: query.locationId } : {}),
        ...(query.returnNumber
          ? { returnNumber: { contains: query.returnNumber.trim(), mode: "insensitive" } }
          : {}),
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
        tx.purchaseReturn.findMany({
          where,
          include: {
            originalPurchase: { select: { id: true, billNumber: true } },
            supplier: { select: { id: true, name: true } },
            location: { select: { id: true, name: true } },
            creator: { select: { id: true, name: true } },
          },
          orderBy: [{ businessDate: "desc" }, { createdAt: "desc" }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        tx.purchaseReturn.count({ where }),
      ]);
      return {
        data: rows.map((row) => toView(row, false)),
        pagination: { page: query.page, limit: query.limit, total },
      };
    });
  }

  async get(actor: TenantScope, returnId: string): Promise<PurchaseReturnView> {
    return this.transactions.run(actor, async (tx) => {
      const row = await this.load(tx, actor.tenantId, returnId);
      if (!row) {
        throw new AppException(ErrorCode.RETURN_NOT_FOUND, "Purchase return was not found.", HttpStatus.NOT_FOUND);
      }
      return row;
    });
  }

  private async postReturn(
    tx: ShopDb,
    actor: TenantScope,
    body: CreatePurchaseReturnDto,
    lines: PreparedLine[],
  ): Promise<PurchaseReturnView> {
    const purchase = await lockPurchase(tx, actor.tenantId, body.purchaseId);
    const locationId = await resolveReturnLocation(tx, actor.tenantId, purchase.locationId, body.locationId);
    const supplier = await lockSupplier(tx, actor.tenantId, purchase.supplierId);
    const source = await lockPurchaseLines(tx, actor.tenantId, purchase.id, lines);
    const subtotal = source.reduce(
      (sum, line) => sum.plus(saleLineTotal(line.quantity, line.unitCost)),
      new Prisma.Decimal(0),
    );
    const payable = asDecimal(supplier.payable_balance);
    const debit = Prisma.Decimal.max(new Prisma.Decimal(0), Prisma.Decimal.min(subtotal, payable));
    const refund = subtotal.minus(debit);

    const returnAt = new Date();
    const numbers = await tx.$queryRaw<Array<{ next_document_number: string }>>`
      SELECT next_document_number(${actor.tenantId}::uuid, 'PURCHASE_RETURN'::document_type) AS next_document_number
    `;
    const returnNumber = numbers[0]?.next_document_number;
    if (!returnNumber) {
      throw new AppException(
        ErrorCode.INVALID_BUSINESS_OPERATION,
        "This shop has no purchase return number.",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const created = await tx.purchaseReturn.create({
      data: {
        tenantId: actor.tenantId,
        originalPurchaseId: purchase.id,
        supplierId: supplier.id,
        locationId,
        returnNumber,
        returnDate: returnAt,
        businessDate: new Date(Date.UTC(2000, 0, 1)),
        subtotal,
        taxTotal: new Prisma.Decimal(0),
        grandTotal: subtotal,
        refundAmount: refund,
        reason: body.reason?.trim() || null,
        status: "CONFIRMED",
        createdBy: actor.userId,
      },
      select: { id: true },
    });

    const postedLines: Array<LockedLine & { id: string }> = [];
    for (const line of source) {
      const item = await tx.purchaseReturnItem.create({
        data: {
          tenantId: actor.tenantId,
          purchaseReturnId: created.id,
          originalPurchaseItemId: line.id,
          productId: line.productId,
          quantity: line.quantity,
          unitCost: line.unitCost,
          lineTotal: saleLineTotal(line.quantity, line.unitCost),
        },
        select: { id: true },
      });
      postedLines.push({ ...line, id: item.id });
    }

    for (const line of [...postedLines].sort((left, right) => left.productId.localeCompare(right.productId))) {
      await this.ledger.post(tx, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        productId: line.productId,
        locationId,
        movementType: MovementType.PURCHASE_RETURN,
        direction: "OUT",
        quantity: line.quantity,
        unitCost: line.unitCost,
        occurredAt: returnAt,
        reference: { type: "PURCHASE_RETURN", id: created.id, lineId: line.id },
      });
    }

    const dated = await tx.purchaseReturn.findFirst({
      where: { id: created.id },
      select: { businessDate: true },
    });
    const businessDate = dated?.businessDate ?? new Date(Date.UTC(2000, 0, 1));
    if (debit.gt(0)) {
      const next = payable.minus(debit);
      await tx.supplier.update({
        where: { id: supplier.id },
        data: { payableBalance: next },
      });
      await tx.supplierLedger.create({
        data: {
          tenantId: actor.tenantId,
          supplierId: supplier.id,
          entryType: "PURCHASE_RETURN",
          debitAmount: debit,
          creditAmount: new Prisma.Decimal(0),
          runningBalance: next,
          referenceType: "PURCHASE_RETURN",
          referenceId: created.id,
          businessDate,
        },
      });
    }
    if (refund.gt(0)) {
      await tx.payment.create({
        data: {
          tenantId: actor.tenantId,
          amount: refund,
          paymentMethod: "CASH",
          direction: "IN",
          referenceType: "PURCHASE_RETURN",
          referenceId: created.id,
          supplierId: supplier.id,
          paymentDate: returnAt,
          businessDate: new Date(Date.UTC(2000, 0, 1)),
          createdBy: actor.userId,
        },
      });
    }

    await this.audit.write(tx, {
      action: "purchase_return.created",
      entityType: "purchase_return",
      entityId: created.id,
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
    });
    await this.audit.write(tx, {
      action: "purchase_return.posted",
      entityType: "purchase_return",
      entityId: created.id,
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
    });

    const saved = await this.load(tx, actor.tenantId, created.id);
    if (!saved) {
      throw new AppException(ErrorCode.RETURN_NOT_FOUND, "Purchase return was not found.", HttpStatus.NOT_FOUND);
    }
    return saved;
  }

  private async load(tx: ShopDb, tenantId: string, returnId: string): Promise<PurchaseReturnView | null> {
    const row = await tx.purchaseReturn.findFirst({
      where: { id: returnId, tenantId },
      include: returnInclude,
    });
    if (!row) {
      return null;
    }
    const payments = await tx.payment.findMany({
      where: { tenantId, referenceType: "PURCHASE_RETURN", referenceId: row.id, direction: "IN" },
      orderBy: { createdAt: "asc" },
      select: { paymentMethod: true, amount: true },
    });
    return toView(row, true, payments);
  }

  private async claim(
    tx: ShopDb,
    tenantId: string,
    key: string,
    requestHash: string,
  ): Promise<PurchaseReturnView | null> {
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
    const stored = existing.responseBody as { id?: string } | null;
    if (!stored?.id) {
      throw new AppException(
        ErrorCode.IDEMPOTENCY_CONFLICT,
        "This request was already processed.",
        HttpStatus.CONFLICT,
      );
    }
    const row = await this.load(tx, tenantId, stored.id);
    if (!row) {
      throw new AppException(
        ErrorCode.IDEMPOTENCY_CONFLICT,
        "This request was already processed.",
        HttpStatus.CONFLICT,
      );
    }
    return row;
  }
}

function prepareLines(items: CreatePurchaseReturnDto["items"]): PreparedLine[] {
  const seen = new Set<string>();
  return items.map((item) => {
    if (seen.has(item.purchaseItemId)) {
      throw new AppException(
        ErrorCode.DUPLICATE_RETURN_LINE,
        "A purchase line can appear only once on a return.",
        HttpStatus.CONFLICT,
      );
    }
    seen.add(item.purchaseItemId);
    const quantity = parseStock(item.quantity);
    if (quantity.lte(0)) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        "Quantity must be greater than zero.",
        HttpStatus.BAD_REQUEST,
      );
    }
    return { purchaseItemId: item.purchaseItemId, quantity };
  });
}

async function lockPurchase(
  tx: ShopDb,
  tenantId: string,
  purchaseId: string,
): Promise<{ id: string; supplierId: string; locationId: string }> {
  const rows = await tx.$queryRaw<
    Array<{ id: string; status: string; supplier_id: string | null; location_id: string }>
  >`
    SELECT id, status::text, supplier_id, location_id
    FROM purchases
    WHERE id = ${purchaseId}::uuid AND tenant_id = ${tenantId}::uuid
    FOR UPDATE
  `;
  const purchase = rows[0];
  if (!purchase) {
    throw new AppException(ErrorCode.RETURN_SOURCE_NOT_FOUND, "Purchase was not found.", HttpStatus.NOT_FOUND);
  }
  if (purchase.status !== "CONFIRMED") {
    throw new AppException(
      ErrorCode.RETURN_NOT_ALLOWED,
      "Only a confirmed purchase can be returned.",
      HttpStatus.CONFLICT,
    );
  }
  if (!purchase.supplier_id) {
    throw new AppException(
      ErrorCode.RETURN_NOT_ALLOWED,
      "This purchase has no supplier.",
      HttpStatus.CONFLICT,
    );
  }
  return { id: purchase.id, supplierId: purchase.supplier_id, locationId: purchase.location_id };
}

async function lockSupplier(
  tx: ShopDb,
  tenantId: string,
  supplierId: string,
): Promise<{ id: string; payable_balance: unknown }> {
  const rows = await tx.$queryRaw<Array<{ id: string; payable_balance: unknown }>>`
    SELECT id, payable_balance
    FROM suppliers
    WHERE id = ${supplierId}::uuid AND tenant_id = ${tenantId}::uuid
    FOR UPDATE
  `;
  const supplier = rows[0];
  if (!supplier) {
    throw new AppException(ErrorCode.SUPPLIER_NOT_FOUND, "Supplier was not found.", HttpStatus.NOT_FOUND);
  }
  return supplier;
}

async function lockPurchaseLines(
  tx: ShopDb,
  tenantId: string,
  purchaseId: string,
  requested: PreparedLine[],
): Promise<LockedLine[]> {
  const rows = await tx.$queryRaw<
    Array<{ id: string; product_id: string; quantity: unknown; unit_cost: unknown; is_active: boolean }>
  >`
    SELECT pi.id, pi.product_id, pi.quantity, pi.unit_cost, p.is_active
    FROM purchase_items pi
    JOIN products p ON p.id = pi.product_id AND p.tenant_id = pi.tenant_id
    WHERE pi.tenant_id = ${tenantId}::uuid AND pi.purchase_id = ${purchaseId}::uuid
    ORDER BY pi.id
    FOR UPDATE OF pi
  `;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const returnedRows = await tx.$queryRaw<Array<{ original_purchase_item_id: string; quantity: unknown }>>`
    SELECT original_purchase_item_id, COALESCE(SUM(quantity), 0) AS quantity
    FROM purchase_return_items
    WHERE tenant_id = ${tenantId}::uuid
      AND original_purchase_item_id IN (
        SELECT id FROM purchase_items
        WHERE tenant_id = ${tenantId}::uuid AND purchase_id = ${purchaseId}::uuid
      )
    GROUP BY original_purchase_item_id
  `;
  const returned = new Map(
    returnedRows.map((row) => [row.original_purchase_item_id, asDecimal(row.quantity)]),
  );
  return requested.map((line) => {
    const source = byId.get(line.purchaseItemId);
    if (!source) {
      throw new AppException(
        ErrorCode.RETURN_SOURCE_MISMATCH,
        "That line is not on this purchase.",
        HttpStatus.CONFLICT,
      );
    }
    if (!source.is_active) {
      throw new AppException(
        ErrorCode.PRODUCT_INACTIVE,
        "Inactive products cannot be returned to a supplier.",
        HttpStatus.CONFLICT,
      );
    }
    const bought = asDecimal(source.quantity);
    const already = returned.get(source.id) ?? new Prisma.Decimal(0);
    if (line.quantity.gt(bought.minus(already))) {
      throw new AppException(
        ErrorCode.RETURN_QUANTITY_EXCEEDS_REMAINING,
        "Return quantity is more than the quantity still returnable.",
        HttpStatus.CONFLICT,
      );
    }
    return {
      id: source.id,
      productId: source.product_id,
      quantity: line.quantity,
      unitCost: asDecimal(source.unit_cost),
    };
  });
}

async function resolveReturnLocation(
  tx: ShopDb,
  tenantId: string,
  purchaseLocationId: string,
  requested?: string,
): Promise<string> {
  if (!requested || requested === purchaseLocationId) {
    return purchaseLocationId;
  }
  const location = await tx.location.findFirst({
    where: { id: requested, tenantId, isActive: true },
    select: { id: true },
  });
  if (!location) {
    throw new AppException(
      ErrorCode.RETURN_LOCATION_INVALID,
      "Location was not found in this shop.",
      HttpStatus.NOT_FOUND,
    );
  }
  return location.id;
}

function toView(
  row: {
    id: string;
    returnNumber: string;
    returnDate: Date;
    businessDate: Date;
    status: string;
    reason: string | null;
    subtotal: Prisma.Decimal;
    grandTotal: Prisma.Decimal;
    refundAmount: Prisma.Decimal;
    createdAt: Date;
    originalPurchase: { id: string; billNumber: string };
    supplier: { id: string; name: string } | null;
    location: { id: string; name: string };
    creator: { id: string; name: string };
    items?: Array<{
      id: string;
      originalPurchaseItemId: string;
      quantity: Prisma.Decimal;
      unitCost: Prisma.Decimal;
      lineTotal: Prisma.Decimal;
      product: { id: string; name: string; sku: string | null };
    }>;
  },
  detail: boolean,
  payments: Array<{ paymentMethod: string; amount: Prisma.Decimal }> = [],
): PurchaseReturnView {
  return {
    id: row.id,
    returnNumber: row.returnNumber,
    returnDate: row.returnDate,
    businessDate: row.businessDate,
    status: row.status,
    reason: row.reason,
    subtotal: row.subtotal,
    grandTotal: row.grandTotal,
    refundAmount: row.refundAmount,
    createdAt: row.createdAt,
    originalPurchase: row.originalPurchase,
    supplier: row.supplier,
    location: row.location,
    creator: row.creator,
    ...(detail
      ? {
          items: row.items,
          payments: payments.map((payment) => ({ method: payment.paymentMethod, amount: payment.amount })),
        }
      : {}),
  };
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

function dateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function asDecimal(value: unknown): Prisma.Decimal {
  if (value instanceof Prisma.Decimal) {
    return value;
  }
  return new Prisma.Decimal(value === null || value === undefined ? 0 : String(value));
}
