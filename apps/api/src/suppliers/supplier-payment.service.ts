import { HttpStatus, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditRecorder } from "../audit/audit-recorder";
import { formatMoney, parseMoney } from "../catalog/decimal";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";
import { ShopDb, TenantScope } from "../database/prisma.types";
import { TenantTransactionService } from "../database/tenant-transaction.service";
import { RecordSettlementDto } from "../payments/settlement.dto";
import {
  addSupplierPaymentSummary,
  asDecimal,
  assertCivilDate,
  assertSettlementAmount,
  assertSettlementMethod,
  blankToNull,
  businessDateText,
  claimIdempotency,
  dateOnly,
  digest,
  exceedsOutstanding,
  ledgerDateText,
  normalizeKey,
  rememberIdempotency,
  SettlementPaymentView,
  shopInstant,
} from "../payments/settlement-support";

export interface SupplierSettlementSummary {
  paymentCount: number;
  latestPayment: {
    id: string;
    amount: string;
    method: string;
    paymentDate: string;
  } | null;
}

const paymentInclude = {
  creator: { select: { id: true, name: true } },
} satisfies Prisma.PaymentInclude;

type PaymentRow = Prisma.PaymentGetPayload<{ include: typeof paymentInclude }>;

@Injectable()
export class SupplierPaymentService {
  constructor(
    private readonly transactions: TenantTransactionService,
    private readonly audit: AuditRecorder,
  ) {}

  async record(
    actor: TenantScope,
    supplierId: string,
    body: RecordSettlementDto,
    idempotencyKey: string | undefined,
  ): Promise<SettlementPaymentView> {
    const amount = parseMoney(body.amount);
    assertSettlementAmount(amount);
    assertSettlementMethod(body.method);
    if (body.paymentDate) {
      assertCivilDate(body.paymentDate);
    }
    const reference = blankToNull(body.reference);
    const note = blankToNull(body.note);
    const key = normalizeKey(idempotencyKey);
    const hash = digest([
      supplierId,
      amount.toFixed(2),
      body.method,
      body.paymentDate ?? "",
      reference ?? "",
      note ?? "",
    ]);

    return this.transactions.run(actor, async (tx) => {
      if (key) {
        const replayId = await claimIdempotency(tx, actor.tenantId, key, hash);
        if (replayId) {
          return this.loadView(tx, actor.tenantId, supplierId, replayId);
        }
      }

      const supplier = await this.lockSupplier(tx, actor.tenantId, supplierId);
      const outstanding = asDecimal(supplier.payable_balance);
      if (amount.gt(outstanding)) {
        throw exceedsOutstanding();
      }
      const next = outstanding.minus(amount);

      const paidAt = await shopInstant(tx, actor.tenantId, body.paymentDate);
      const payment = await tx.payment.create({
        data: {
          tenantId: actor.tenantId,
          amount,
          paymentMethod: body.method,
          direction: "OUT",
          referenceType: "SUPPLIER_PAYMENT",
          referenceId: null,
          customerId: null,
          supplierId: supplier.id,
          paymentDate: paidAt,
          businessDate: new Date(Date.UTC(2000, 0, 1)),
          externalReference: reference,
          notes: note,
          createdBy: actor.userId,
        },
      });
      const dated = await tx.payment.findFirst({
        where: { id: payment.id, tenantId: actor.tenantId },
        select: { businessDate: true },
      });
      if (!dated) {
        throw new AppException(ErrorCode.INTERNAL_ERROR, "Payment was not stored.", HttpStatus.INTERNAL_SERVER_ERROR);
      }

      await tx.supplierLedger.create({
        data: {
          tenantId: actor.tenantId,
          supplierId: supplier.id,
          entryType: "PAYMENT",
          debitAmount: amount,
          creditAmount: new Prisma.Decimal(0),
          runningBalance: next,
          referenceType: "SUPPLIER_PAYMENT",
          referenceId: payment.id,
          businessDate: dated.businessDate,
        },
      });
      const updated = await tx.supplier.updateMany({
        where: {
          id: supplier.id,
          tenantId: actor.tenantId,
          payableBalance: { gte: amount },
        },
        data: { payableBalance: next, updatedAt: new Date() },
      });
      if (updated.count !== 1) {
        throw exceedsOutstanding();
      }

      await addSupplierPaymentSummary(tx, actor.tenantId, dated.businessDate, amount);
      await this.audit.write(tx, {
        action: "supplier.payment_recorded",
        entityType: "payment",
        entityId: payment.id,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        metadata: {
          amount: amount.toFixed(2),
          method: body.method,
          supplierId: supplier.id,
        },
      });
      if (key) {
        await rememberIdempotency(tx, actor.tenantId, key, payment.id);
      }
      return this.loadView(tx, actor.tenantId, supplier.id, payment.id);
    });
  }

  async list(
    actor: TenantScope,
    supplierId: string,
    query: { from?: string; to?: string; method?: "CASH" | "UPI"; page: number; limit: number },
  ) {
    return this.transactions.run(actor, async (tx) => {
      await this.requireSupplier(tx, actor.tenantId, supplierId);
      const where: Prisma.PaymentWhereInput = {
        tenantId: actor.tenantId,
        supplierId,
        direction: "OUT",
        referenceType: "SUPPLIER_PAYMENT",
        ...(query.method ? { paymentMethod: query.method } : {}),
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
        tx.payment.findMany({
          where,
          include: paymentInclude,
          orderBy: [{ paymentDate: "desc" }, { id: "desc" }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        tx.payment.count({ where }),
      ]);
      return {
        data: rows.map(presentPayment),
        pagination: { page: query.page, limit: query.limit, total },
      };
    });
  }

  async ledger(actor: TenantScope, supplierId: string, query: { page: number; limit: number }) {
    return this.transactions.run(actor, async (tx) => {
      await this.requireSupplier(tx, actor.tenantId, supplierId);
      const offset = (query.page - 1) * query.limit;
      const [rows, counted] = await Promise.all([
        tx.$queryRaw<LedgerRow[]>`
          SELECT business_date, entry_type, reference_type, reference_id, debit_amount, credit_amount, running_balance
          FROM (
            SELECT
              business_date,
              entry_type::text AS entry_type,
              reference_type::text AS reference_type,
              reference_id::text AS reference_id,
              debit_amount::text AS debit_amount,
              credit_amount::text AS credit_amount,
              created_at,
              id,
              SUM(credit_amount - debit_amount) OVER (
                ORDER BY business_date ASC, created_at ASC, id ASC
              )::text AS running_balance
            FROM supplier_ledger
            WHERE tenant_id = ${actor.tenantId}::uuid
              AND supplier_id = ${supplierId}::uuid
          ) lines
          ORDER BY lines.business_date ASC, lines.created_at ASC, lines.id ASC
          LIMIT ${query.limit} OFFSET ${offset}
        `,
        tx.supplierLedger.count({ where: { tenantId: actor.tenantId, supplierId } }),
      ]);
      return {
        data: rows.map(presentLedger),
        pagination: { page: query.page, limit: query.limit, total: counted },
      };
    });
  }

  async summary(actor: TenantScope, supplierId: string): Promise<SupplierSettlementSummary> {
    return this.transactions.run(actor, async (tx) => {
      await this.requireSupplier(tx, actor.tenantId, supplierId);
      const where: Prisma.PaymentWhereInput = {
        tenantId: actor.tenantId,
        supplierId,
        direction: "OUT",
        referenceType: "SUPPLIER_PAYMENT",
      };
      const [paymentCount, latest] = await Promise.all([
        tx.payment.count({ where }),
        tx.payment.findFirst({
          where,
          orderBy: [{ paymentDate: "desc" }, { id: "desc" }],
          select: { id: true, amount: true, paymentMethod: true, paymentDate: true },
        }),
      ]);
      return {
        paymentCount,
        latestPayment: latest
          ? {
              id: latest.id,
              amount: formatMoney(latest.amount) ?? "0.00",
              method: latest.paymentMethod,
              paymentDate: latest.paymentDate.toISOString(),
            }
          : null,
      };
    });
  }

  private async loadView(
    tx: ShopDb,
    tenantId: string,
    supplierId: string,
    paymentId: string,
  ): Promise<SettlementPaymentView> {
    const payment = await tx.payment.findFirst({
      where: {
        id: paymentId,
        tenantId,
        supplierId,
        direction: "OUT",
        referenceType: "SUPPLIER_PAYMENT",
      },
      include: paymentInclude,
    });
    if (!payment) {
      throw new AppException(
        ErrorCode.IDEMPOTENCY_CONFLICT,
        "This request was already processed.",
        HttpStatus.CONFLICT,
      );
    }
    return presentPayment(payment);
  }

  private async requireSupplier(tx: ShopDb, tenantId: string, supplierId: string): Promise<void> {
    const supplier = await tx.supplier.findFirst({
      where: { id: supplierId, tenantId },
      select: { id: true },
    });
    if (!supplier) {
      throw new AppException(ErrorCode.SUPPLIER_NOT_FOUND, "Supplier was not found.", HttpStatus.NOT_FOUND);
    }
  }

  private async lockSupplier(
    tx: ShopDb,
    tenantId: string,
    supplierId: string,
  ): Promise<{ id: string; payable_balance: unknown }> {
    const rows = await tx.$queryRaw<Array<{ id: string; is_active: boolean; payable_balance: unknown }>>`
      SELECT id, is_active, payable_balance
      FROM suppliers
      WHERE id = ${supplierId}::uuid AND tenant_id = ${tenantId}::uuid
      FOR UPDATE
    `;
    const supplier = rows[0];
    if (!supplier) {
      throw new AppException(ErrorCode.SUPPLIER_NOT_FOUND, "Supplier was not found.", HttpStatus.NOT_FOUND);
    }
    if (!supplier.is_active) {
      throw new AppException(
        ErrorCode.SUPPLIER_INACTIVE,
        "Inactive suppliers cannot receive a payment.",
        HttpStatus.CONFLICT,
      );
    }
    return supplier;
  }
}

function presentPayment(row: PaymentRow): SettlementPaymentView {
  return {
    id: row.id,
    amount: formatMoney(row.amount) ?? "0.00",
    method: row.paymentMethod,
    paymentDate: row.paymentDate.toISOString(),
    businessDate: businessDateText(row.businessDate),
    reference: row.externalReference,
    note: row.notes,
    createdAt: row.createdAt.toISOString(),
    createdBy: { id: row.creator.id, name: row.creator.name },
  };
}

interface LedgerRow {
  business_date: Date | string;
  entry_type: string;
  reference_type: string;
  reference_id: string | null;
  debit_amount: string;
  credit_amount: string;
  running_balance: string;
}

function presentLedger(row: LedgerRow) {
  return {
    date: ledgerDateText(row.business_date),
    type: row.entry_type,
    reference: { type: row.reference_type, id: row.reference_id },
    debit: new Prisma.Decimal(row.debit_amount).toFixed(2),
    credit: new Prisma.Decimal(row.credit_amount).toFixed(2),
    runningBalance: new Prisma.Decimal(row.running_balance).toFixed(2),
  };
}
