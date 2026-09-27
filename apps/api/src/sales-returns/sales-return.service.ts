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
import { saleLineTotal, lineCostAmount } from "../sales/sale-calculator";
import { CreateSaleReturnDto } from "./dto/sales-return.dto";
import { SaleReturnView } from "./sales-return.presenter";

interface PreparedLine {
  saleItemId: string;
  quantity: Prisma.Decimal;
}

interface LockedLine {
  id: string;
  productId: string;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  unitCost: Prisma.Decimal | null;
  returned: Prisma.Decimal;
}

interface ListQuery {
  saleId?: string;
  customerId?: string;
  locationId?: string;
  returnNumber?: string;
  from?: string;
  to?: string;
  page: number;
  limit: number;
}

const returnInclude = {
  originalSale: { select: { id: true, billNumber: true } },
  customer: { select: { id: true, name: true } },
  location: { select: { id: true, name: true } },
  creator: { select: { id: true, name: true } },
  items: {
    include: { product: { select: { id: true, name: true, sku: true } } },
    orderBy: { createdAt: "asc" as const },
  },
};

@Injectable()
export class SalesReturnService {
  constructor(
    private readonly transactions: TenantTransactionService,
    private readonly ledger: InventoryLedgerService,
    private readonly audit: AuditRecorder,
  ) {}

  async create(
    actor: TenantScope,
    body: CreateSaleReturnDto,
    idempotencyKey?: string,
  ): Promise<SaleReturnView> {
    const lines = prepareLines(body.items);
    const hash = digest([
      body.saleId,
      body.locationId ?? "",
      body.reason?.trim() ?? "",
      ...[...lines]
        .sort((left, right) => left.saleItemId.localeCompare(right.saleItemId))
        .map((line) => `${line.saleItemId}|${line.quantity.toFixed(3)}`),
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
      if (query.saleId) {
        const sale = await tx.sale.findFirst({
          where: { id: query.saleId, tenantId: actor.tenantId },
          select: { id: true },
        });
        if (!sale) {
          throw new AppException(ErrorCode.SALE_NOT_FOUND, "Sale was not found.", HttpStatus.NOT_FOUND);
        }
      }
      if (query.customerId) {
        const customer = await tx.customer.findFirst({
          where: { id: query.customerId, tenantId: actor.tenantId },
          select: { id: true },
        });
        if (!customer) {
          throw new AppException(ErrorCode.CUSTOMER_NOT_FOUND, "Customer was not found.", HttpStatus.NOT_FOUND);
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
      const where: Prisma.SaleReturnWhereInput = {
        tenantId: actor.tenantId,
        ...(query.saleId ? { originalSaleId: query.saleId } : {}),
        ...(query.customerId ? { customerId: query.customerId } : {}),
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
        tx.saleReturn.findMany({
          where,
          include: {
            originalSale: { select: { id: true, billNumber: true } },
            customer: { select: { id: true, name: true } },
            location: { select: { id: true, name: true } },
            creator: { select: { id: true, name: true } },
          },
          orderBy: [{ businessDate: "desc" }, { createdAt: "desc" }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        tx.saleReturn.count({ where }),
      ]);
      return {
        data: rows.map((row) => toView(row, false)),
        pagination: { page: query.page, limit: query.limit, total },
      };
    });
  }

  async get(actor: TenantScope, returnId: string): Promise<SaleReturnView> {
    return this.transactions.run(actor, async (tx) => {
      const row = await this.load(tx, actor.tenantId, returnId);
      if (!row) {
        throw new AppException(ErrorCode.RETURN_NOT_FOUND, "Sales return was not found.", HttpStatus.NOT_FOUND);
      }
      return row;
    });
  }

  private async postReturn(
    tx: ShopDb,
    actor: TenantScope,
    body: CreateSaleReturnDto,
    lines: PreparedLine[],
  ): Promise<SaleReturnView> {
    const sale = await lockSale(tx, actor.tenantId, body.saleId);
    const locationId = await resolveReturnLocation(tx, actor.tenantId, sale.locationId, body.locationId);
    const customer = sale.customerId ? await lockCustomer(tx, actor.tenantId, sale.customerId) : null;
    const source = await lockSaleLines(tx, actor.tenantId, sale.id, lines);
    const subtotal = source.reduce(
      (sum, line) => sum.plus(saleLineTotal(line.quantity, line.unitPrice)),
      new Prisma.Decimal(0),
    );
    const balance = customer ? asDecimal(customer.receivable_balance) : new Prisma.Decimal(0);
    const credit = customer
      ? Prisma.Decimal.max(new Prisma.Decimal(0), Prisma.Decimal.min(subtotal, balance))
      : new Prisma.Decimal(0);
    const refund = subtotal.minus(credit);
    const grossProfit = source.reduce((sum, line) => {
      const cost = lineCostAmount(line.quantity, line.unitCost);
      if (cost === null) {
        return sum;
      }
      return sum.plus(saleLineTotal(line.quantity, line.unitPrice).minus(cost));
    }, new Prisma.Decimal(0));
    const quantity = source.reduce((sum, line) => sum.plus(line.quantity), new Prisma.Decimal(0));

    const returnAt = new Date();
    const numbers = await tx.$queryRaw<Array<{ next_document_number: string }>>`
      SELECT next_document_number(${actor.tenantId}::uuid, 'SALE_RETURN'::document_type) AS next_document_number
    `;
    const returnNumber = numbers[0]?.next_document_number;
    if (!returnNumber) {
      throw new AppException(
        ErrorCode.INVALID_BUSINESS_OPERATION,
        "This shop has no sales return number.",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const created = await tx.saleReturn.create({
      data: {
        tenantId: actor.tenantId,
        originalSaleId: sale.id,
        customerId: customer?.id ?? null,
        locationId,
        returnNumber,
        returnDate: returnAt,
        businessDate: new Date(Date.UTC(2000, 0, 1)),
        subtotal,
        refundAmount: refund,
        reason: body.reason?.trim() || null,
        status: "CONFIRMED",
        createdBy: actor.userId,
      },
      select: { id: true },
    });

    const postedLines: Array<LockedLine & { id: string }> = [];
    for (const line of source) {
      const item = await tx.saleReturnItem.create({
        data: {
          tenantId: actor.tenantId,
          saleReturnId: created.id,
          originalSaleItemId: line.id,
          productId: line.productId,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          unitCost: line.unitCost,
          lineTotal: saleLineTotal(line.quantity, line.unitPrice),
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
        movementType: MovementType.SALE_RETURN,
        direction: "IN",
        quantity: line.quantity,
        unitCost: line.unitCost ?? undefined,
        occurredAt: returnAt,
        reference: { type: "SALE_RETURN", id: created.id, lineId: line.id },
      });
    }

    const dated = await tx.saleReturn.findFirst({
      where: { id: created.id },
      select: { businessDate: true },
    });
    const businessDate = dated?.businessDate ?? new Date(Date.UTC(2000, 0, 1));
    if (credit.gt(0) && customer) {
      const next = balance.minus(credit);
      await tx.customer.update({
        where: { id: customer.id },
        data: { receivableBalance: next },
      });
      await tx.customerLedger.create({
        data: {
          tenantId: actor.tenantId,
          customerId: customer.id,
          entryType: "SALE_RETURN",
          debitAmount: new Prisma.Decimal(0),
          creditAmount: credit,
          runningBalance: next,
          referenceType: "SALE_RETURN",
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
          direction: "OUT",
          referenceType: "SALE_RETURN",
          referenceId: created.id,
          customerId: customer?.id ?? null,
          paymentDate: returnAt,
          businessDate: new Date(Date.UTC(2000, 0, 1)),
          createdBy: actor.userId,
        },
      });
    }

    await recordReturnSummary(tx, actor.tenantId, businessDate, {
      total: subtotal,
      grossProfit,
      quantity,
    });
    await this.audit.write(tx, {
      action: "sale_return.created",
      entityType: "sale_return",
      entityId: created.id,
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
    });
    await this.audit.write(tx, {
      action: "sale_return.posted",
      entityType: "sale_return",
      entityId: created.id,
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
    });

    const saved = await this.load(tx, actor.tenantId, created.id);
    if (!saved) {
      throw new AppException(ErrorCode.RETURN_NOT_FOUND, "Sales return was not found.", HttpStatus.NOT_FOUND);
    }
    return saved;
  }

  private async load(tx: ShopDb, tenantId: string, returnId: string): Promise<SaleReturnView | null> {
    const row = await tx.saleReturn.findFirst({
      where: { id: returnId, tenantId },
      include: returnInclude,
    });
    if (!row) {
      return null;
    }
    const payments = await tx.payment.findMany({
      where: { tenantId, referenceType: "SALE_RETURN", referenceId: row.id, direction: "OUT" },
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
  ): Promise<SaleReturnView | null> {
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

function prepareLines(items: CreateSaleReturnDto["items"]): PreparedLine[] {
  const seen = new Set<string>();
  return items.map((item) => {
    if (seen.has(item.saleItemId)) {
      throw new AppException(
        ErrorCode.DUPLICATE_RETURN_LINE,
        "A sale line can appear only once on a return.",
        HttpStatus.CONFLICT,
      );
    }
    seen.add(item.saleItemId);
    const quantity = parseStock(item.quantity);
    if (quantity.lte(0)) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        "Quantity must be greater than zero.",
        HttpStatus.BAD_REQUEST,
      );
    }
    return { saleItemId: item.saleItemId, quantity };
  });
}

async function lockSale(
  tx: ShopDb,
  tenantId: string,
  saleId: string,
): Promise<{ id: string; status: string; customerId: string | null; locationId: string }> {
  const rows = await tx.$queryRaw<
    Array<{ id: string; status: string; customer_id: string | null; location_id: string }>
  >`
    SELECT id, status::text, customer_id, location_id
    FROM sales
    WHERE id = ${saleId}::uuid AND tenant_id = ${tenantId}::uuid
    FOR UPDATE
  `;
  const sale = rows[0];
  if (!sale) {
    throw new AppException(ErrorCode.RETURN_SOURCE_NOT_FOUND, "Sale was not found.", HttpStatus.NOT_FOUND);
  }
  if (sale.status === "VOIDED") {
    throw new AppException(
      ErrorCode.RETURN_NOT_ALLOWED,
      "A voided sale cannot be returned.",
      HttpStatus.CONFLICT,
    );
  }
  return {
    id: sale.id,
    status: sale.status,
    customerId: sale.customer_id,
    locationId: sale.location_id,
  };
}

async function lockCustomer(
  tx: ShopDb,
  tenantId: string,
  customerId: string,
): Promise<{ id: string; receivable_balance: unknown }> {
  const rows = await tx.$queryRaw<Array<{ id: string; receivable_balance: unknown }>>`
    SELECT id, receivable_balance
    FROM customers
    WHERE id = ${customerId}::uuid AND tenant_id = ${tenantId}::uuid
    FOR UPDATE
  `;
  const customer = rows[0];
  if (!customer) {
    throw new AppException(ErrorCode.CUSTOMER_NOT_FOUND, "Customer was not found.", HttpStatus.NOT_FOUND);
  }
  return customer;
}

async function lockSaleLines(
  tx: ShopDb,
  tenantId: string,
  saleId: string,
  requested: PreparedLine[],
): Promise<LockedLine[]> {
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      product_id: string;
      quantity: unknown;
      unit_selling_price: unknown;
      unit_cost: unknown;
      is_active: boolean;
    }>
  >`
    SELECT si.id, si.product_id, si.quantity, si.unit_selling_price, si.unit_cost, p.is_active
    FROM sale_items si
    JOIN products p ON p.id = si.product_id AND p.tenant_id = si.tenant_id
    WHERE si.tenant_id = ${tenantId}::uuid AND si.sale_id = ${saleId}::uuid
    ORDER BY si.id
    FOR UPDATE OF si
  `;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const returnedRows = await tx.$queryRaw<Array<{ original_sale_item_id: string; quantity: unknown }>>`
    SELECT sri.original_sale_item_id, COALESCE(SUM(sri.quantity), 0) AS quantity
    FROM sale_return_items sri
    JOIN sale_returns sr ON sr.id = sri.sale_return_id AND sr.tenant_id = sri.tenant_id
    WHERE sri.tenant_id = ${tenantId}::uuid
      AND sr.original_sale_id = ${saleId}::uuid
      AND sr.status = 'CONFIRMED'
    GROUP BY sri.original_sale_item_id
  `;
  const returned = new Map(returnedRows.map((row) => [row.original_sale_item_id, asDecimal(row.quantity)]));
  return requested.map((line) => {
    const source = byId.get(line.saleItemId);
    if (!source) {
      throw new AppException(
        ErrorCode.RETURN_SOURCE_MISMATCH,
        "That line is not on this sale.",
        HttpStatus.CONFLICT,
      );
    }
    if (!source.is_active) {
      throw new AppException(
        ErrorCode.PRODUCT_INACTIVE,
        "Inactive products cannot be returned into stock.",
        HttpStatus.CONFLICT,
      );
    }
    if (source.unit_cost === null) {
      throw new AppException(
        ErrorCode.RETURN_NOT_ALLOWED,
        "This sale line has no cost snapshot and cannot be returned.",
        HttpStatus.CONFLICT,
      );
    }
    const sold = asDecimal(source.quantity);
    const already = returned.get(source.id) ?? new Prisma.Decimal(0);
    const remaining = sold.minus(already);
    if (line.quantity.gt(remaining)) {
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
      unitPrice: asDecimal(source.unit_selling_price),
      unitCost: source.unit_cost === null ? null : asDecimal(source.unit_cost),
      returned: already,
    };
  });
}

async function resolveReturnLocation(
  tx: ShopDb,
  tenantId: string,
  saleLocationId: string,
  requested?: string,
): Promise<string> {
  if (!requested || requested === saleLocationId) {
    return saleLocationId;
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
    refundAmount: Prisma.Decimal;
    createdAt: Date;
    originalSale: { id: string; billNumber: string };
    customer: { id: string; name: string } | null;
    location: { id: string; name: string };
    creator: { id: string; name: string };
    items?: Array<{
      id: string;
      originalSaleItemId: string;
      quantity: Prisma.Decimal;
      unitPrice: Prisma.Decimal;
      unitCost: Prisma.Decimal | null;
      lineTotal: Prisma.Decimal;
      product: { id: string; name: string; sku: string | null };
    }>;
  },
  detail: boolean,
  payments: Array<{ paymentMethod: string; amount: Prisma.Decimal }> = [],
): SaleReturnView {
  return {
    id: row.id,
    returnNumber: row.returnNumber,
    returnDate: row.returnDate,
    businessDate: row.businessDate,
    status: row.status,
    reason: row.reason,
    subtotal: row.subtotal,
    refundAmount: row.refundAmount,
    createdAt: row.createdAt,
    originalSale: row.originalSale,
    customer: row.customer,
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

async function recordReturnSummary(
  tx: ShopDb,
  tenantId: string,
  businessDate: Date,
  totals: { total: Prisma.Decimal; grossProfit: Prisma.Decimal; quantity: Prisma.Decimal },
): Promise<void> {
  const day = businessDateText(businessDate);
  await tx.$executeRaw`
    INSERT INTO daily_summaries (
      id, tenant_id, business_date,
      total_sales_returns, net_sales, gross_profit, net_profit, products_sold
    ) VALUES (
      uuidv7(),
      ${tenantId}::uuid,
      ${day}::date,
      ${totals.total.toFixed(2)}::numeric,
      ${totals.total.negated().toFixed(2)}::numeric,
      ${totals.grossProfit.negated().toFixed(2)}::numeric,
      ${totals.grossProfit.negated().toFixed(2)}::numeric,
      ${totals.quantity.negated().toFixed(3)}::numeric
    )
    ON CONFLICT (tenant_id, business_date) DO UPDATE SET
      total_sales_returns = daily_summaries.total_sales_returns + EXCLUDED.total_sales_returns,
      net_sales = daily_summaries.net_sales + EXCLUDED.net_sales,
      gross_profit = daily_summaries.gross_profit + EXCLUDED.gross_profit,
      net_profit = daily_summaries.net_profit + EXCLUDED.net_profit,
      products_sold = daily_summaries.products_sold + EXCLUDED.products_sold,
      updated_at = CURRENT_TIMESTAMP
    WHERE daily_summaries.closed_at IS NULL
  `;
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

function businessDateText(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function asDecimal(value: unknown): Prisma.Decimal {
  if (value instanceof Prisma.Decimal) {
    return value;
  }
  return new Prisma.Decimal(value === null || value === undefined ? 0 : String(value));
}
