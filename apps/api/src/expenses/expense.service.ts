import { HttpStatus, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditRecorder } from "../audit/audit-recorder";
import { formatMoney, parseMoney } from "../catalog/decimal";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";
import { ShopDb, TenantScope } from "../database/prisma.types";
import { TenantTransactionService } from "../database/tenant-transaction.service";
import { CreateExpenseDto } from "./dto/expense.dto";
import { ReportPeriod, resolveBusinessRange } from "../reports/report-range";
import {
  assertCivilDate,
  assertSettlementAmount,
  assertSettlementMethod,
  blankToNull,
  businessDateText,
  claimIdempotency,
  dateOnly,
  digest,
  ledgerDateText,
  normalizeKey,
  rememberIdempotency,
  shopInstant,
} from "../payments/settlement-support";

export interface ExpenseView {
  id: string;
  category: { id: string; name: string; isActive: boolean };
  amount: string;
  expenseDate: string;
  businessDate: string;
  paymentMethod: string | null;
  note: string | null;
  reference: string | null;
  createdBy: { id: string; name: string };
  createdAt: string;
}

const expenseInclude = {
  category: { select: { id: true, name: true, isActive: true } },
  payment: { select: { paymentMethod: true, externalReference: true } },
  creator: { select: { id: true, name: true } },
} satisfies Prisma.ExpenseInclude;

type ExpenseRow = Prisma.ExpenseGetPayload<{ include: typeof expenseInclude }>;

@Injectable()
export class ExpenseService {
  constructor(
    private readonly transactions: TenantTransactionService,
    private readonly audit: AuditRecorder,
  ) {}

  async create(
    actor: TenantScope,
    body: CreateExpenseDto,
    idempotencyKey: string | undefined,
  ): Promise<ExpenseView> {
    const amount = parseMoney(body.amount);
    assertSettlementAmount(amount);
    assertSettlementMethod(body.paymentMethod);
    if (body.expenseDate) {
      assertCivilDate(body.expenseDate);
    }
    const note = blankToNull(body.note);
    const reference = blankToNull(body.reference);
    const key = normalizeKey(idempotencyKey);
    const hash = digest([
      body.categoryId,
      amount.toFixed(2),
      body.expenseDate ?? "",
      body.paymentMethod,
      note ?? "",
      reference ?? "",
    ]);

    return this.transactions.run(actor, async (tx) => {
      if (key) {
        const replayId = await claimIdempotency(tx, actor.tenantId, key, hash);
        if (replayId) {
          return this.loadView(tx, actor.tenantId, replayId);
        }
      }

      const category = await this.lockCategory(tx, actor.tenantId, body.categoryId);
      const spentAt = await shopInstant(tx, actor.tenantId, body.expenseDate);
      const expense = await tx.expense.create({
        data: {
          tenantId: actor.tenantId,
          categoryId: category.id,
          amount,
          expenseDate: spentAt,
          businessDate: new Date(Date.UTC(2000, 0, 1)),
          description: note,
          createdBy: actor.userId,
        },
      });
      const payment = await tx.payment.create({
        data: {
          tenantId: actor.tenantId,
          amount,
          paymentMethod: body.paymentMethod,
          direction: "OUT",
          referenceType: "EXPENSE",
          referenceId: expense.id,
          customerId: null,
          supplierId: null,
          paymentDate: spentAt,
          businessDate: new Date(Date.UTC(2000, 0, 1)),
          externalReference: reference,
          createdBy: actor.userId,
        },
      });
      await tx.expense.update({
        where: { id: expense.id },
        data: { paymentId: payment.id },
      });
      const dated = await tx.expense.findFirst({
        where: { id: expense.id, tenantId: actor.tenantId },
        select: { businessDate: true },
      });
      if (!dated) {
        throw new AppException(ErrorCode.INTERNAL_ERROR, "Expense was not stored.", HttpStatus.INTERNAL_SERVER_ERROR);
      }
      await addExpenseSummary(tx, actor.tenantId, dated.businessDate, amount);
      await this.audit.write(tx, {
        action: "expense.created",
        entityType: "expense",
        entityId: expense.id,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        metadata: {
          amount: amount.toFixed(2),
          method: body.paymentMethod,
          categoryId: category.id,
        },
      });
      if (key) {
        await rememberIdempotency(tx, actor.tenantId, key, expense.id);
      }
      return this.loadView(tx, actor.tenantId, expense.id);
    });
  }

  async list(
    actor: TenantScope,
    query: {
      from?: string;
      to?: string;
      categoryId?: string;
      paymentMethod?: "CASH" | "UPI";
      search?: string;
      page: number;
      limit: number;
    },
  ) {
    return this.transactions.run(actor, async (tx) => {
      if (query.categoryId) {
        const category = await tx.expenseCategory.findFirst({
          where: { id: query.categoryId, tenantId: actor.tenantId },
          select: { id: true },
        });
        if (!category) {
          throw new AppException(
            ErrorCode.EXPENSE_CATEGORY_NOT_FOUND,
            "Expense category was not found.",
            HttpStatus.NOT_FOUND,
          );
        }
      }
      const text = query.search?.trim();
      const where: Prisma.ExpenseWhereInput = {
        tenantId: actor.tenantId,
        ...(query.categoryId ? { categoryId: query.categoryId } : {}),
        ...(query.paymentMethod ? { payment: { paymentMethod: query.paymentMethod } } : {}),
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
                { description: { contains: text, mode: "insensitive" } },
                { payment: { externalReference: { contains: text, mode: "insensitive" } } },
              ],
            }
          : {}),
      };
      const [rows, total] = await Promise.all([
        tx.expense.findMany({
          where,
          include: expenseInclude,
          orderBy: [{ expenseDate: "desc" }, { id: "desc" }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        tx.expense.count({ where }),
      ]);
      return {
        data: rows.map(presentExpense),
        pagination: { page: query.page, limit: query.limit, total },
      };
    });
  }

  async get(actor: TenantScope, expenseId: string): Promise<ExpenseView> {
    return this.transactions.run(actor, async (tx) => this.loadView(tx, actor.tenantId, expenseId, true));
  }

  async summary(
    actor: TenantScope,
    query: { period?: ReportPeriod; from?: string; to?: string },
  ) {
    return this.transactions.run(actor, async (tx) => {
      const range = await resolveBusinessRange(tx, actor.tenantId, query);
      const [totals, categories, daily] = await Promise.all([
        tx.$queryRaw<Array<{ total: string; count: string; cash: string; upi: string }>>`
          SELECT
            COALESCE(SUM(e.amount), 0)::text AS total,
            COUNT(e.id)::text AS count,
            COALESCE(SUM(e.amount) FILTER (WHERE p.payment_method = 'CASH'), 0)::text AS cash,
            COALESCE(SUM(e.amount) FILTER (WHERE p.payment_method = 'UPI'), 0)::text AS upi
          FROM expenses e
          LEFT JOIN payments p ON p.tenant_id = e.tenant_id AND p.id = e.payment_id
          WHERE e.tenant_id = ${actor.tenantId}::uuid
            AND e.business_date BETWEEN ${range.from}::date AND ${range.to}::date
        `,
        tx.$queryRaw<Array<{ category_id: string; category_name: string; amount: string }>>`
          SELECT
            c.id::text AS category_id,
            c.name AS category_name,
            COALESCE(SUM(e.amount), 0)::text AS amount
          FROM expenses e
          JOIN expense_categories c ON c.tenant_id = e.tenant_id AND c.id = e.category_id
          WHERE e.tenant_id = ${actor.tenantId}::uuid
            AND e.business_date BETWEEN ${range.from}::date AND ${range.to}::date
          GROUP BY c.id, c.name
          ORDER BY c.name ASC, c.id ASC
        `,
        tx.$queryRaw<Array<{ business_date: Date | string; amount: string }>>`
          SELECT days.business_date::date AS business_date, COALESCE(SUM(e.amount), 0)::text AS amount
          FROM generate_series(${range.from}::date, ${range.to}::date, interval '1 day') AS days(business_date)
          LEFT JOIN expenses e
            ON e.tenant_id = ${actor.tenantId}::uuid
           AND e.business_date = days.business_date
          GROUP BY days.business_date
          ORDER BY days.business_date
        `,
      ]);
      const row = totals[0];
      return {
        period: range.period,
        from: range.from,
        to: range.to,
        totalExpenses: money(row?.total),
        expenseCount: Number(row?.count ?? 0),
        cashExpenses: money(row?.cash),
        upiExpenses: money(row?.upi),
        byCategory: categories.map((category) => ({
          categoryId: category.category_id,
          categoryName: category.category_name,
          amount: money(category.amount),
        })),
        daily: daily.map((day) => ({
          businessDate: ledgerDateText(day.business_date),
          amount: money(day.amount),
        })),
      };
    });
  }

  private async loadView(tx: ShopDb, tenantId: string, expenseId: string, missingIsNotFound = false): Promise<ExpenseView> {
    const expense = await tx.expense.findFirst({
      where: { id: expenseId, tenantId },
      include: expenseInclude,
    });
    if (!expense) {
      throw new AppException(
        missingIsNotFound ? ErrorCode.EXPENSE_NOT_FOUND : ErrorCode.IDEMPOTENCY_CONFLICT,
        missingIsNotFound ? "Expense was not found." : "This request was already processed.",
        missingIsNotFound ? HttpStatus.NOT_FOUND : HttpStatus.CONFLICT,
      );
    }
    return presentExpense(expense);
  }

  private async lockCategory(tx: ShopDb, tenantId: string, categoryId: string): Promise<{ id: string }> {
    const rows = await tx.$queryRaw<Array<{ id: string; is_active: boolean }>>`
      SELECT id, is_active
      FROM expense_categories
      WHERE id = ${categoryId}::uuid AND tenant_id = ${tenantId}::uuid
      FOR UPDATE
    `;
    const category = rows[0];
    if (!category) {
      throw new AppException(
        ErrorCode.EXPENSE_CATEGORY_NOT_FOUND,
        "Expense category was not found.",
        HttpStatus.NOT_FOUND,
      );
    }
    if (!category.is_active) {
      throw new AppException(
        ErrorCode.EXPENSE_CATEGORY_INACTIVE,
        "Inactive expense categories cannot be used for a new expense.",
        HttpStatus.CONFLICT,
      );
    }
    return { id: category.id };
  }
}

function presentExpense(row: ExpenseRow): ExpenseView {
  return {
    id: row.id,
    category: {
      id: row.category.id,
      name: row.category.name,
      isActive: row.category.isActive,
    },
    amount: formatMoney(row.amount) ?? "0.00",
    expenseDate: row.expenseDate.toISOString(),
    businessDate: businessDateText(row.businessDate),
    paymentMethod: row.payment?.paymentMethod ?? null,
    note: row.description,
    reference: row.payment?.externalReference ?? null,
    createdBy: { id: row.creator.id, name: row.creator.name },
    createdAt: row.createdAt.toISOString(),
  };
}

function money(value: string | undefined): string {
  return new Prisma.Decimal(value ?? "0").toFixed(2);
}

async function addExpenseSummary(tx: ShopDb, tenantId: string, businessDate: Date, amount: Prisma.Decimal): Promise<void> {
  const day = businessDateText(businessDate);
  const reduction = amount.negated().toFixed(2);
  await tx.$executeRaw`
    INSERT INTO daily_summaries (
      id, tenant_id, business_date, total_expenses, net_profit
    ) VALUES (
      uuidv7(),
      ${tenantId}::uuid,
      ${day}::date,
      ${amount.toFixed(2)}::numeric,
      ${reduction}::numeric
    )
    ON CONFLICT (tenant_id, business_date) DO UPDATE SET
      total_expenses = daily_summaries.total_expenses + EXCLUDED.total_expenses,
      net_profit = daily_summaries.net_profit + EXCLUDED.net_profit,
      updated_at = CURRENT_TIMESTAMP
    WHERE daily_summaries.closed_at IS NULL
  `;
}
