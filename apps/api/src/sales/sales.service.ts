import { createHash } from "node:crypto";
import { HttpStatus, Injectable } from "@nestjs/common";
import { MovementType, PaymentMethod, Prisma } from "@prisma/client";
import { AuditRecorder } from "../audit/audit-recorder";
import { formatMoney, formatStock, parseMoney, parseStock } from "../catalog/decimal";
import { ProductPricingService } from "../catalog/product-pricing.service";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";
import { ShopDb, TenantScope } from "../database/prisma.types";
import { TenantTransactionService } from "../database/tenant-transaction.service";
import { InventoryLedgerService } from "../inventory/inventory-ledger.service";
import { CreateSaleDto, QuoteSaleDto, SALE_PAYMENT_METHODS, SalePaymentMethod } from "./dto/sale.dto";
import { lineCostAmount, saleLineTotal, saleOutstanding, salePaymentStatus } from "./sale-calculator";
import { SaleView } from "./sales.presenter";

interface PreparedItem {
  productId: string;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  priceSource: "CUSTOMER" | "LIST";
  offeredPrice: Prisma.Decimal | null;
}

interface PreparedPayment {
  method: SalePaymentMethod;
  amount: Prisma.Decimal;
  reference: string | null;
}

interface ListQuery {
  customerId?: string;
  locationId?: string;
  productId?: string;
  from?: string;
  to?: string;
  saleNumber?: string;
  paymentMethod?: PaymentMethod;
  page: number;
  limit: number;
}

const saleInclude = {
  customer: { select: { id: true, name: true } },
  location: { select: { id: true, name: true } },
  creator: { select: { id: true, name: true } },
  items: {
    include: { product: { select: { id: true, name: true, sku: true } } },
    orderBy: { createdAt: "asc" as const },
  },
};

@Injectable()
export class SalesService {
  constructor(
    private readonly transactions: TenantTransactionService,
    private readonly ledger: InventoryLedgerService,
    private readonly pricing: ProductPricingService,
    private readonly audit: AuditRecorder,
  ) {}

  async create(actor: TenantScope, body: CreateSaleDto, idempotencyKey?: string): Promise<SaleView> {
    const items = prepareItems(body.items);
    const payments = preparePayments(body.payments ?? []);
    const hash = digest([
      body.customerId ?? "",
      body.locationId ?? "",
      body.saleDate ?? "",
      body.notes?.trim() ?? "",
      ...[...items]
        .sort((left, right) => left.productId.localeCompare(right.productId))
        .map((item) => `${item.productId}|${item.quantity.toFixed(3)}|${item.offeredPrice?.toFixed(2) ?? ""}`),
      ...[...payments]
        .sort((left, right) => `${left.method}|${left.amount.toFixed(2)}`.localeCompare(`${right.method}|${right.amount.toFixed(2)}`))
        .map((payment) => `${payment.method}|${payment.amount.toFixed(2)}|${payment.reference ?? ""}`),
    ]);
    const key = normalizeKey(idempotencyKey);
    return this.transactions.run(actor, async (tx) => {
      if (key) {
        const replay = await this.claim(tx, actor.tenantId, key, hash);
        if (replay) {
          return replay;
        }
      }
      const posted = await this.postSale(tx, actor, body, items, payments);
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
      if (query.customerId) {
        const customer = await tx.customer.findFirst({
          where: { id: query.customerId, tenantId: actor.tenantId },
          select: { id: true },
        });
        if (!customer) {
          throw new AppException(ErrorCode.CUSTOMER_NOT_FOUND, "Customer was not found.", HttpStatus.NOT_FOUND);
        }
      }
      const saleIds = query.paymentMethod
        ? await this.salesWithMethod(tx, actor.tenantId, query.paymentMethod)
        : null;
      if (saleIds && saleIds.length === 0) {
        return { data: [], pagination: { page: query.page, limit: query.limit, total: 0 } };
      }
      const where: Prisma.SaleWhereInput = {
        tenantId: actor.tenantId,
        ...(query.customerId ? { customerId: query.customerId } : {}),
        ...(query.locationId ? { locationId: query.locationId } : {}),
        ...(query.productId ? { items: { some: { productId: query.productId } } } : {}),
        ...(saleIds ? { id: { in: saleIds } } : {}),
        ...(query.saleNumber
          ? { billNumber: { contains: query.saleNumber.trim(), mode: "insensitive" } }
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
        tx.sale.findMany({
          where,
          include: {
            customer: { select: { id: true, name: true } },
            location: { select: { id: true, name: true } },
            creator: { select: { id: true, name: true } },
          },
          orderBy: [{ businessDate: "desc" }, { createdAt: "desc" }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        tx.sale.count({ where }),
      ]);
      const paidBySale = await this.paidAmounts(tx, actor.tenantId, rows.map((row) => row.id));
      return {
        data: rows.map((row) => this.toView(row, [], paidBySale.get(row.id) ?? new Prisma.Decimal(0), false)),
        pagination: { page: query.page, limit: query.limit, total },
      };
    });
  }

  async quote(actor: TenantScope, body: QuoteSaleDto) {
    const prepared = prepareItems(
      body.items.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
      })),
    );
    return this.transactions.run(actor, async (tx) => {
      const priced = await this.priceItems(tx, actor.tenantId, body.customerId, prepared);
      const total = priced.reduce((sum, item) => sum.plus(item.lineTotal), new Prisma.Decimal(0));
      return {
        items: priced.map((item) => ({
          productId: item.productId,
          quantity: formatStock(item.quantity),
          unitPrice: formatMoney(item.unitPrice),
          lineTotal: formatMoney(item.lineTotal),
          priceSource: item.priceSource,
        })),
        total: formatMoney(total),
      };
    });
  }

  async get(actor: TenantScope, saleId: string): Promise<SaleView> {
    return this.transactions.run(actor, async (tx) => {
      const sale = await this.load(tx, actor.tenantId, saleId);
      if (!sale) {
        throw new AppException(ErrorCode.SALE_NOT_FOUND, "Sale was not found.", HttpStatus.NOT_FOUND);
      }
      return sale;
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
        tx.saleItem.findMany({
          where,
          include: {
            sale: {
              select: {
                id: true,
                billNumber: true,
                saleDate: true,
                businessDate: true,
                customer: { select: { name: true } },
              },
            },
          },
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        tx.saleItem.count({ where }),
      ]);
      return {
        data: rows.map((row) => ({
          saleId: row.sale.id,
          saleNumber: row.sale.billNumber,
          saleDate: row.sale.saleDate,
          businessDate: row.sale.businessDate,
          customerName: row.sale.customer?.name ?? null,
          quantity: row.quantity,
          unitSellingPrice: row.unitSellingPrice,
          unitCost: row.unitCost,
        })),
        pagination: { page, limit, total },
      };
    });
  }

  private async postSale(
    tx: ShopDb,
    actor: TenantScope,
    body: CreateSaleDto,
    items: PreparedItem[],
    payments: PreparedPayment[],
  ): Promise<SaleView> {
    const customer = body.customerId ? await this.lockCustomer(tx, actor.tenantId, body.customerId) : null;
    const locationId = await this.resolveLocation(tx, actor.tenantId, body.locationId);
    const priced = await this.priceItems(tx, actor.tenantId, body.customerId, items);
    const subtotal = priced.reduce((sum, item) => sum.plus(item.lineTotal), new Prisma.Decimal(0));
    const paid = payments.reduce((sum, payment) => sum.plus(payment.amount), new Prisma.Decimal(0));
    if (paid.gt(subtotal)) {
      throw new AppException(
        ErrorCode.PAYMENT_EXCEEDS_SALE,
        "Payments cannot be more than the sale total.",
        HttpStatus.CONFLICT,
      );
    }
    const outstanding = saleOutstanding(subtotal, paid);
    if (outstanding.gt(0) && !customer) {
      throw new AppException(
        ErrorCode.CUSTOMER_REQUIRED_FOR_CREDIT,
        "A walk-in sale must be paid in full.",
        HttpStatus.CONFLICT,
      );
    }

    const saleAt = await shopInstant(tx, actor.tenantId, body.saleDate);
    const numbers = await tx.$queryRaw<Array<{ next_document_number: string }>>`
      SELECT next_document_number(${actor.tenantId}::uuid, 'SALE'::document_type) AS next_document_number
    `;
    const billNumber = numbers[0]?.next_document_number;
    if (!billNumber) {
      throw new AppException(
        ErrorCode.INVALID_BUSINESS_OPERATION,
        "This shop has no sale number.",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const sale = await tx.sale.create({
      data: {
        tenantId: actor.tenantId,
        customerId: customer?.id ?? null,
        locationId,
        billNumber,
        saleDate: saleAt,
        businessDate: new Date(Date.UTC(2000, 0, 1)),
        subtotal,
        discountTotal: new Prisma.Decimal(0),
        taxTotal: new Prisma.Decimal(0),
        roundOff: new Prisma.Decimal(0),
        grandTotal: subtotal,
        paymentStatus: salePaymentStatus(subtotal, paid),
        status: "COMPLETED",
        notes: body.notes?.trim() || null,
        createdBy: actor.userId,
      },
      select: { id: true },
    });

    const costs = new Map<string, Prisma.Decimal | null>();
    const lockOrder = [...priced].sort((left, right) => left.productId.localeCompare(right.productId));
    for (const item of lockOrder) {
      costs.set(
        item.productId,
        await this.ledger.lockUnitCost(tx, {
          tenantId: actor.tenantId,
          productId: item.productId,
          locationId,
        }),
      );
    }

    const lines: Array<PreparedItem & { id: string; unitCost: Prisma.Decimal | null }> = [];
    for (const item of priced) {
      const unitCost = costs.get(item.productId) ?? null;
      const line = await tx.saleItem.create({
        data: {
          tenantId: actor.tenantId,
          saleId: sale.id,
          productId: item.productId,
          quantity: item.quantity,
          unitSellingPrice: item.unitPrice,
          unitCost,
          discountAmount: new Prisma.Decimal(0),
          taxAmount: new Prisma.Decimal(0),
          lineTotal: item.lineTotal,
          priceSource: item.priceSource,
        },
        select: { id: true },
      });
      lines.push({ ...item, id: line.id, unitCost });
    }

    let grossProfit = new Prisma.Decimal(0);
    let quantitySold = new Prisma.Decimal(0);
    for (const line of [...lines].sort((left, right) => left.productId.localeCompare(right.productId))) {
      const posted = await this.ledger.post(tx, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        productId: line.productId,
        locationId,
        movementType: MovementType.SALE,
        direction: "OUT",
        quantity: line.quantity,
        occurredAt: saleAt,
        reference: { type: "SALE", id: sale.id, lineId: line.id },
      });
      if (!sameCost(line.unitCost, posted.unitCostApplied)) {
        throw new AppException(
          ErrorCode.INTERNAL_ERROR,
          "Sale cost did not match the inventory ledger.",
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      const cost = lineCostAmount(line.quantity, posted.unitCostApplied);
      if (cost !== null) {
        grossProfit = grossProfit.plus(line.lineTotal.minus(cost));
      }
      quantitySold = quantitySold.plus(line.quantity);
    }

    for (const payment of payments) {
      await tx.payment.create({
        data: {
          tenantId: actor.tenantId,
          amount: payment.amount,
          paymentMethod: payment.method,
          direction: "IN",
          referenceType: "SALE",
          referenceId: sale.id,
          customerId: customer?.id ?? null,
          paymentDate: saleAt,
          businessDate: new Date(Date.UTC(2000, 0, 1)),
          externalReference: payment.reference,
          createdBy: actor.userId,
        },
      });
    }

    const dated = await tx.sale.findFirst({
      where: { id: sale.id },
      select: { businessDate: true },
    });
    const businessDate = dated?.businessDate ?? new Date(Date.UTC(2000, 0, 1));
    if (outstanding.gt(0) && customer) {
      const receivable = asDecimal(customer.receivable_balance).plus(outstanding);
      await tx.customer.update({
        where: { id: customer.id },
        data: { receivableBalance: receivable },
      });
      await tx.customerLedger.create({
        data: {
          tenantId: actor.tenantId,
          customerId: customer.id,
          entryType: "CREDIT_SALE",
          debitAmount: outstanding,
          creditAmount: new Prisma.Decimal(0),
          runningBalance: receivable,
          referenceType: "SALE",
          referenceId: sale.id,
          businessDate,
        },
      });
    }

    await recordDailySummary(tx, actor.tenantId, businessDate, {
      total: subtotal,
      paid,
      outstanding,
      grossProfit,
      quantitySold,
    });
    await this.audit.write(tx, {
      action: "sale.created",
      entityType: "sale",
      entityId: sale.id,
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
    });
    await this.audit.write(tx, {
      action: "sale.posted",
      entityType: "sale",
      entityId: sale.id,
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
    });

    const saved = await this.load(tx, actor.tenantId, sale.id);
    if (!saved) {
      throw new AppException(ErrorCode.SALE_NOT_FOUND, "Sale was not found.", HttpStatus.NOT_FOUND);
    }
    return saved;
  }

  private async priceItems(
    tx: ShopDb,
    tenantId: string,
    customerId: string | undefined,
    items: PreparedItem[],
  ): Promise<PreparedItem[]> {
    const products = await tx.product.findMany({
      where: { tenantId, id: { in: items.map((item) => item.productId) } },
      select: { id: true, isActive: true },
    });
    const active = new Map(products.map((product) => [product.id, product.isActive]));
    const priced: PreparedItem[] = [];
    for (const item of items) {
      const state = active.get(item.productId);
      if (state === undefined) {
        throw new AppException(ErrorCode.PRODUCT_NOT_FOUND, "Product was not found.", HttpStatus.NOT_FOUND);
      }
      if (!state) {
        throw new AppException(
          ErrorCode.PRODUCT_INACTIVE,
          "Inactive products cannot be sold.",
          HttpStatus.CONFLICT,
        );
      }
      const resolved = await this.pricing.resolveSellingPrice(tx, {
        tenantId,
        productId: item.productId,
        customerId,
      });
      if (!resolved) {
        throw new AppException(
          ErrorCode.INVALID_PRODUCT_PRICE,
          "This product has no selling price.",
          HttpStatus.CONFLICT,
        );
      }
      if (item.offeredPrice && !item.offeredPrice.equals(resolved.price)) {
        throw new AppException(
          ErrorCode.SALE_PRICE_MISMATCH,
          "The selling price does not match the price for this customer.",
          HttpStatus.CONFLICT,
        );
      }
      priced.push({
        ...item,
        unitPrice: resolved.price,
        lineTotal: saleLineTotal(item.quantity, resolved.price),
        priceSource: resolved.source,
      });
    }
    return priced;
  }

  private async lockCustomer(
    tx: ShopDb,
    tenantId: string,
    customerId: string,
  ): Promise<{ id: string; receivable_balance: unknown }> {
    const rows = await tx.$queryRaw<Array<{ id: string; is_active: boolean; receivable_balance: unknown }>>`
      SELECT id, is_active, receivable_balance
      FROM customers
      WHERE id = ${customerId}::uuid AND tenant_id = ${tenantId}::uuid
      FOR UPDATE
    `;
    const customer = rows[0];
    if (!customer) {
      throw new AppException(ErrorCode.CUSTOMER_NOT_FOUND, "Customer was not found.", HttpStatus.NOT_FOUND);
    }
    if (!customer.is_active) {
      throw new AppException(
        ErrorCode.CUSTOMER_INACTIVE,
        "Inactive customers cannot be used for a new sale.",
        HttpStatus.CONFLICT,
      );
    }
    return customer;
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

  private async salesWithMethod(tx: ShopDb, tenantId: string, method: PaymentMethod): Promise<string[]> {
    const rows = await tx.payment.findMany({
      where: { tenantId, referenceType: "SALE", direction: "IN", paymentMethod: method },
      select: { referenceId: true },
      distinct: ["referenceId"],
    });
    return rows.flatMap((row) => (row.referenceId ? [row.referenceId] : []));
  }

  private async paidAmounts(tx: ShopDb, tenantId: string, saleIds: string[]): Promise<Map<string, Prisma.Decimal>> {
    const totals = new Map<string, Prisma.Decimal>();
    if (saleIds.length === 0) {
      return totals;
    }
    const rows = await tx.payment.groupBy({
      by: ["referenceId"],
      where: { tenantId, referenceType: "SALE", direction: "IN", referenceId: { in: saleIds } },
      _sum: { amount: true },
    });
    for (const row of rows) {
      if (row.referenceId) {
        totals.set(row.referenceId, row._sum.amount ?? new Prisma.Decimal(0));
      }
    }
    return totals;
  }

  private async load(tx: ShopDb, tenantId: string, saleId: string): Promise<SaleView | null> {
    const sale = await tx.sale.findFirst({
      where: { id: saleId, tenantId },
      include: saleInclude,
    });
    if (!sale) {
      return null;
    }
    const payments = await tx.payment.findMany({
      where: { tenantId, referenceType: "SALE", referenceId: sale.id, direction: "IN" },
      orderBy: { createdAt: "asc" },
    });
    const paid = payments.reduce((sum, payment) => sum.plus(payment.amount), new Prisma.Decimal(0));
    const returned = await returnedBySaleItem(tx, tenantId, sale.items.map((item) => item.id));
    return this.toView(
      {
        ...sale,
        items: sale.items.map((item) => ({
          ...item,
          returnedQuantity: returned.get(item.id) ?? new Prisma.Decimal(0),
        })),
      },
      payments,
      paid,
      true,
    );
  }

  private toView(
    sale: {
      id: string;
      billNumber: string;
      saleDate: Date;
      businessDate: Date;
      status: string;
      paymentStatus: string;
      notes: string | null;
      subtotal: Prisma.Decimal;
      grandTotal: Prisma.Decimal;
      createdAt: Date;
      customer: { id: string; name: string } | null;
      location: { id: string; name: string };
      creator: { id: string; name: string };
      items?: Array<{
        id: string;
        quantity: Prisma.Decimal;
        unitSellingPrice: Prisma.Decimal;
        unitCost: Prisma.Decimal | null;
        lineTotal: Prisma.Decimal;
        priceSource: string;
        returnedQuantity?: Prisma.Decimal;
        product: { id: string; name: string; sku: string | null };
      }>;
    },
    payments: Array<{ id: string; paymentMethod: string; amount: Prisma.Decimal; externalReference: string | null }>,
    paid: Prisma.Decimal,
    detail: boolean,
  ): SaleView {
    return {
      id: sale.id,
      billNumber: sale.billNumber,
      saleDate: sale.saleDate,
      businessDate: sale.businessDate,
      status: sale.status,
      paymentStatus: sale.paymentStatus,
      notes: sale.notes,
      subtotal: sale.subtotal,
      grandTotal: sale.grandTotal,
      createdAt: sale.createdAt,
      customer: sale.customer,
      location: sale.location,
      creator: sale.creator,
      paid,
      outstanding: saleOutstanding(sale.grandTotal, paid),
      ...(detail
        ? {
            items: sale.items,
            payments: payments.map((payment) => ({
              id: payment.id,
              method: payment.paymentMethod,
              amount: payment.amount,
              externalReference: payment.externalReference,
            })),
          }
        : {}),
    };
  }

  private async claim(tx: ShopDb, tenantId: string, key: string, requestHash: string): Promise<SaleView | null> {
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
    const sale = await this.load(tx, tenantId, stored.id);
    if (!sale) {
      throw new AppException(
        ErrorCode.IDEMPOTENCY_CONFLICT,
        "This request was already processed.",
        HttpStatus.CONFLICT,
      );
    }
    return sale;
  }
}

function prepareItems(items: CreateSaleDto["items"]): PreparedItem[] {
  const seen = new Set<string>();
  return items.map((item) => {
    if (seen.has(item.productId)) {
      throw new AppException(
        ErrorCode.DUPLICATE_SALE_LINE,
        "A product can appear only once on a sale.",
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
    return {
      productId: item.productId,
      quantity,
      unitPrice: new Prisma.Decimal(0),
      lineTotal: new Prisma.Decimal(0),
      priceSource: "LIST" as const,
      offeredPrice: item.unitPrice === undefined ? null : parseMoney(item.unitPrice),
    };
  });
}

function preparePayments(payments: NonNullable<CreateSaleDto["payments"]>): PreparedPayment[] {
  return payments.map((payment) => {
    if (!(SALE_PAYMENT_METHODS as readonly string[]).includes(payment.method)) {
      throw new AppException(
        ErrorCode.UNSUPPORTED_PAYMENT_METHOD,
        "Record cash or UPI. DukaanOS does not take card, bank, or other tenders on a new sale.",
        HttpStatus.BAD_REQUEST,
      );
    }
    const amount = parseMoney(payment.amount);
    if (amount.lte(0)) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        "Payment amount must be greater than zero.",
        HttpStatus.BAD_REQUEST,
      );
    }
    return {
      method: payment.method,
      amount,
      reference: payment.reference?.trim() || null,
    };
  });
}

async function recordDailySummary(
  tx: ShopDb,
  tenantId: string,
  businessDate: Date,
  totals: {
    total: Prisma.Decimal;
    paid: Prisma.Decimal;
    outstanding: Prisma.Decimal;
    grossProfit: Prisma.Decimal;
    quantitySold: Prisma.Decimal;
  },
): Promise<void> {
  const day = businessDateText(businessDate);
  await tx.$executeRaw`
    INSERT INTO daily_summaries (
      id, tenant_id, business_date,
      total_sales, net_sales, gross_profit, net_profit,
      cash_received, credit_sales, products_sold, transaction_count
    ) VALUES (
      uuidv7(),
      ${tenantId}::uuid,
      ${day}::date,
      ${totals.total.toFixed(2)}::numeric,
      ${totals.total.toFixed(2)}::numeric,
      ${totals.grossProfit.toFixed(2)}::numeric,
      ${totals.grossProfit.toFixed(2)}::numeric,
      ${totals.paid.toFixed(2)}::numeric,
      ${totals.outstanding.toFixed(2)}::numeric,
      ${totals.quantitySold.toFixed(3)}::numeric,
      1
    )
    ON CONFLICT (tenant_id, business_date) DO UPDATE SET
      total_sales = daily_summaries.total_sales + EXCLUDED.total_sales,
      net_sales = daily_summaries.net_sales + EXCLUDED.net_sales,
      gross_profit = daily_summaries.gross_profit + EXCLUDED.gross_profit,
      net_profit = daily_summaries.net_profit + EXCLUDED.net_profit,
      cash_received = daily_summaries.cash_received + EXCLUDED.cash_received,
      credit_sales = daily_summaries.credit_sales + EXCLUDED.credit_sales,
      products_sold = daily_summaries.products_sold + EXCLUDED.products_sold,
      transaction_count = daily_summaries.transaction_count + EXCLUDED.transaction_count,
      updated_at = CURRENT_TIMESTAMP
    WHERE daily_summaries.closed_at IS NULL
  `;
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

function dateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function businessDateText(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function returnedBySaleItem(
  tx: ShopDb,
  tenantId: string,
  itemIds: string[],
): Promise<Map<string, Prisma.Decimal>> {
  if (itemIds.length === 0) {
    return new Map();
  }
  const rows = await tx.saleReturnItem.groupBy({
    by: ["originalSaleItemId"],
    where: { tenantId, originalSaleItemId: { in: itemIds } },
    _sum: { quantity: true },
  });
  return new Map(rows.map((row) => [row.originalSaleItemId, row._sum.quantity ?? new Prisma.Decimal(0)]));
}

function asDecimal(value: unknown): Prisma.Decimal {
  if (value instanceof Prisma.Decimal) {
    return value;
  }
  return new Prisma.Decimal(String(value));
}

function sameCost(left: Prisma.Decimal | null, right: Prisma.Decimal | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.equals(right);
}
