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
  addCustomerCollection,
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

export interface CustomerSettlementSummary {
  paymentCount: number;
  latestPayment: {
    id: string;
    amount: string;
    method: string;
    paymentDate: string;
  } | null;
}

export interface LedgerEntryView {
  date: string;
  type: string;
  reference: { type: string; id: string | null };
  debit: string;
  credit: string;
  runningBalance: string;
}

const paymentInclude = {
  creator: { select: { id: true, name: true } },
} satisfies Prisma.PaymentInclude;

type PaymentRow = Prisma.PaymentGetPayload<{ include: typeof paymentInclude }>;

@Injectable()
export class CustomerPaymentService {
  constructor(
    private readonly transactions: TenantTransactionService,
    private readonly audit: AuditRecorder,
  ) {}

  async record(
    actor: TenantScope,
    customerId: string,
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
      customerId,
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
          return this.loadView(tx, actor.tenantId, customerId, replayId);
        }
      }

      const customer = await this.lockCustomer(tx, actor.tenantId, customerId);
      const outstanding = asDecimal(customer.receivable_balance);
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
          direction: "IN",
          referenceType: "CUSTOMER_RECEIPT",
          referenceId: null,
          customerId: customer.id,
          supplierId: null,
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

      await tx.customerLedger.create({
        data: {
          tenantId: actor.tenantId,
          customerId: customer.id,
          entryType: "PAYMENT",
          debitAmount: new Prisma.Decimal(0),
          creditAmount: amount,
          runningBalance: next,
          referenceType: "CUSTOMER_RECEIPT",
          referenceId: payment.id,
          businessDate: dated.businessDate,
        },
      });
      const updated = await tx.customer.updateMany({
        where: {
          id: customer.id,
          tenantId: actor.tenantId,
          receivableBalance: { gte: amount },
        },
        data: { receivableBalance: next, updatedAt: new Date() },
      });
      if (updated.count !== 1) {
        throw exceedsOutstanding();
      }

      await addCustomerCollection(tx, actor.tenantId, dated.businessDate, amount);
      await this.audit.write(tx, {
        action: "customer.payment_recorded",
        entityType: "payment",
        entityId: payment.id,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        metadata: {
          amount: amount.toFixed(2),
          method: body.method,
          customerId: customer.id,
        },
      });
      if (key) {
        await rememberIdempotency(tx, actor.tenantId, key, payment.id);
      }
      return this.loadView(tx, actor.tenantId, customer.id, payment.id);
    });
  }

  async list(
    actor: TenantScope,
    customerId: string,
    query: { from?: string; to?: string; method?: "CASH" | "UPI"; page: number; limit: number },
  ) {
    return this.transactions.run(actor, async (tx) => {
      await this.requireCustomer(tx, actor.tenantId, customerId);
      const where: Prisma.PaymentWhereInput = {
        tenantId: actor.tenantId,
        customerId,
        direction: "IN",
        referenceType: "CUSTOMER_RECEIPT",
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

  async ledger(actor: TenantScope, customerId: string, query: { page: number; limit: number }) {
    return this.transactions.run(actor, async (tx) => {
      await this.requireCustomer(tx, actor.tenantId, customerId);
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
              SUM(debit_amount - credit_amount) OVER (
                ORDER BY business_date ASC, created_at ASC, id ASC
              )::text AS running_balance
            FROM customer_ledger
            WHERE tenant_id = ${actor.tenantId}::uuid
              AND customer_id = ${customerId}::uuid
          ) lines
          ORDER BY lines.business_date ASC, lines.created_at ASC, lines.id ASC
          LIMIT ${query.limit} OFFSET ${offset}
        `,
        tx.customerLedger.count({ where: { tenantId: actor.tenantId, customerId } }),
      ]);
      return {
        data: rows.map(presentLedger),
        pagination: { page: query.page, limit: query.limit, total: counted },
      };
    });
  }

  async summary(actor: TenantScope, customerId: string): Promise<CustomerSettlementSummary> {
    return this.transactions.run(actor, async (tx) => {
      await this.requireCustomer(tx, actor.tenantId, customerId);
      const where: Prisma.PaymentWhereInput = {
        tenantId: actor.tenantId,
        customerId,
        direction: "IN",
        referenceType: "CUSTOMER_RECEIPT",
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
    customerId: string,
    paymentId: string,
  ): Promise<SettlementPaymentView> {
    const payment = await tx.payment.findFirst({
      where: {
        id: paymentId,
        tenantId,
        customerId,
        direction: "IN",
        referenceType: "CUSTOMER_RECEIPT",
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

  private async requireCustomer(tx: ShopDb, tenantId: string, customerId: string): Promise<void> {
    const customer = await tx.customer.findFirst({
      where: { id: customerId, tenantId },
      select: { id: true },
    });
    if (!customer) {
      throw new AppException(ErrorCode.CUSTOMER_NOT_FOUND, "Customer was not found.", HttpStatus.NOT_FOUND);
    }
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
        "Inactive customers cannot receive a payment.",
        HttpStatus.CONFLICT,
      );
    }
    return customer;
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

function presentLedger(row: LedgerRow): LedgerEntryView {
  return {
    date: ledgerDateText(row.business_date),
    type: row.entry_type,
    reference: { type: row.reference_type, id: row.reference_id },
    debit: new Prisma.Decimal(row.debit_amount).toFixed(2),
    credit: new Prisma.Decimal(row.credit_amount).toFixed(2),
    runningBalance: new Prisma.Decimal(row.running_balance).toFixed(2),
  };
}
