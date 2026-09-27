import { HttpStatus, Injectable } from "@nestjs/common";
import { AuditRecorder } from "../audit/audit-recorder";
import { activeFilter } from "../catalog/catalog-access";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";
import { ShopDb, TenantScope } from "../database/prisma.types";
import { TenantTransactionService } from "../database/tenant-transaction.service";
import { CreateExpenseCategoryDto, UpdateExpenseCategoryDto } from "./dto/expense.dto";

export interface ExpenseCategoryView {
  id: string;
  name: string;
  isSystem: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class ExpenseCategoryService {
  constructor(
    private readonly transactions: TenantTransactionService,
    private readonly audit: AuditRecorder,
  ) {}

  async create(actor: TenantScope, body: CreateExpenseCategoryDto): Promise<ExpenseCategoryView> {
    const name = cleanName(body.name);
    return this.transactions.run(actor, async (tx) => {
      await this.assertNameAvailable(tx, actor.tenantId, name);
      const category = await tx.expenseCategory.create({
        data: { tenantId: actor.tenantId, name, isSystem: false, isActive: true },
      });
      await this.audit.write(tx, {
        action: "expense.category_created",
        entityType: "expense_category",
        entityId: category.id,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        metadata: { name },
      });
      return presentCategory(category);
    });
  }

  async list(actor: TenantScope, isActive: string | undefined) {
    const active = activeFilter(isActive);
    return this.transactions.run(actor, async (tx) => {
      const rows = await tx.expenseCategory.findMany({
        where: {
          tenantId: actor.tenantId,
          ...(active === null ? {} : { isActive: active }),
        },
        orderBy: [{ name: "asc" }, { id: "asc" }],
      });
      return rows.map(presentCategory);
    });
  }

  async update(
    actor: TenantScope,
    categoryId: string,
    body: UpdateExpenseCategoryDto,
  ): Promise<ExpenseCategoryView> {
    const name = cleanName(body.name);
    return this.transactions.run(actor, async (tx) => {
      const current = await this.lock(tx, actor.tenantId, categoryId);
      if (current.name !== name) {
        await this.assertNameAvailable(tx, actor.tenantId, name, current.id);
      }
      const category = await tx.expenseCategory.update({
        where: { id: current.id },
        data: { name },
      });
      await this.audit.write(tx, {
        action: "expense.category_updated",
        entityType: "expense_category",
        entityId: category.id,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        metadata: { name },
      });
      return presentCategory(category);
    });
  }

  async deactivate(actor: TenantScope, categoryId: string): Promise<ExpenseCategoryView> {
    return this.transactions.run(actor, async (tx) => {
      const current = await this.lock(tx, actor.tenantId, categoryId);
      if (!current.isActive) {
        return presentCategory(current);
      }
      const category = await tx.expenseCategory.update({
        where: { id: current.id },
        data: { isActive: false },
      });
      await this.audit.write(tx, {
        action: "expense.category_deactivated",
        entityType: "expense_category",
        entityId: category.id,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        metadata: { name: category.name },
      });
      return presentCategory(category);
    });
  }

  private async lock(tx: ShopDb, tenantId: string, categoryId: string) {
    const rows = await tx.$queryRaw<Array<{ id: string; name: string; is_system: boolean; is_active: boolean; created_at: Date; updated_at: Date }>>`
      SELECT id, name, is_system, is_active, created_at, updated_at
      FROM expense_categories
      WHERE id = ${categoryId}::uuid AND tenant_id = ${tenantId}::uuid
      FOR UPDATE
    `;
    const row = rows[0];
    if (!row) {
      throw new AppException(
        ErrorCode.EXPENSE_CATEGORY_NOT_FOUND,
        "Expense category was not found.",
        HttpStatus.NOT_FOUND,
      );
    }
    return {
      id: row.id,
      name: row.name,
      isSystem: row.is_system,
      isActive: row.is_active,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private async assertNameAvailable(tx: ShopDb, tenantId: string, name: string, exceptId?: string) {
    const existing = await tx.expenseCategory.findFirst({
      where: {
        tenantId,
        name: { equals: name, mode: "insensitive" },
        ...(exceptId ? { NOT: { id: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (existing) {
      throw new AppException(
        ErrorCode.CONFLICT,
        "An expense category with this name already exists.",
        HttpStatus.CONFLICT,
      );
    }
  }
}

function cleanName(value: string): string {
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length === 0 || name.length > 80) {
    throw new AppException(
      ErrorCode.VALIDATION_ERROR,
      "Category name must be 1 to 80 characters.",
      HttpStatus.BAD_REQUEST,
    );
  }
  return name;
}

function presentCategory(row: {
  id: string;
  name: string;
  isSystem: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}): ExpenseCategoryView {
  return {
    id: row.id,
    name: row.name,
    isSystem: row.isSystem,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
