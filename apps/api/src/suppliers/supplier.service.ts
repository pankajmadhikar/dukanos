import { HttpStatus, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditRecorder } from "../audit/audit-recorder";
import { activeFilter } from "../catalog/catalog-access";
import { normalizeSearch } from "../catalog/text";
import { TenantScope } from "../database/prisma.types";
import { TenantTransactionService } from "../database/tenant-transaction.service";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";
import { CreateSupplierDto, UpdateSupplierDto } from "./dto/supplier.dto";

@Injectable()
export class SupplierService {
  constructor(
    private readonly transactions: TenantTransactionService,
    private readonly audit: AuditRecorder,
  ) {}

  async create(actor: TenantScope, body: CreateSupplierDto) {
    const name = body.name.trim().replace(/\s+/g, " ");
    return this.transactions.run(actor, async (tx) => {
      const supplier = await tx.supplier.create({
        data: {
          tenantId: actor.tenantId,
          name,
          phone: blankToNull(body.phone),
          email: blankToNull(body.email),
          address: blankToNull(body.address),
          notes: blankToNull(body.notes),
        },
      });
      await this.audit.write(tx, {
        action: "supplier.created",
        entityType: "supplier",
        entityId: supplier.id,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
      });
      return supplier;
    });
  }

  async update(actor: TenantScope, supplierId: string, body: UpdateSupplierDto) {
    if (
      body.name === undefined &&
      body.phone === undefined &&
      body.email === undefined &&
      body.address === undefined &&
      body.notes === undefined &&
      body.isActive === undefined
    ) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        "Provide a supplier field to update.",
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.transactions.run(actor, async (tx) => {
      const existing = await tx.supplier.findFirst({
        where: { id: supplierId, tenantId: actor.tenantId },
      });
      if (!existing) {
        throw new AppException(ErrorCode.SUPPLIER_NOT_FOUND, "Supplier was not found.", HttpStatus.NOT_FOUND);
      }
      const supplier = await tx.supplier.update({
        where: { id: existing.id },
        data: {
          ...(body.name !== undefined ? { name: body.name.trim().replace(/\s+/g, " ") } : {}),
          ...(body.phone !== undefined ? { phone: blankToNull(body.phone) } : {}),
          ...(body.email !== undefined ? { email: blankToNull(body.email) } : {}),
          ...(body.address !== undefined ? { address: blankToNull(body.address) } : {}),
          ...(body.notes !== undefined ? { notes: blankToNull(body.notes) } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        },
      });
      await this.audit.write(tx, {
        action:
          body.isActive === false && existing.isActive ? "supplier.deactivated" : "supplier.updated",
        entityType: "supplier",
        entityId: supplier.id,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
      });
      return supplier;
    });
  }

  async get(actor: TenantScope, supplierId: string) {
    return this.transactions.run(actor, async (tx) => {
      const supplier = await tx.supplier.findFirst({
        where: { id: supplierId, tenantId: actor.tenantId },
      });
      if (!supplier) {
        throw new AppException(ErrorCode.SUPPLIER_NOT_FOUND, "Supplier was not found.", HttpStatus.NOT_FOUND);
      }
      return supplier;
    });
  }

  async list(
    actor: TenantScope,
    query: { search?: string; isActive: boolean | null; page: number; limit: number },
  ) {
    return this.transactions.run(actor, async (tx) => {
      const text = query.search ? normalizeSearch(query.search) : "";
      const where: Prisma.SupplierWhereInput = {
        tenantId: actor.tenantId,
        ...(query.isActive === null ? {} : { isActive: query.isActive }),
        ...(text
          ? {
              OR: [
                { name: { contains: text, mode: "insensitive" } },
                { phone: { contains: text, mode: "insensitive" } },
              ],
            }
          : {}),
      };
      const [rows, total] = await Promise.all([
        tx.supplier.findMany({
          where,
          orderBy: [{ name: "asc" }, { id: "asc" }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        tx.supplier.count({ where }),
      ]);
      return { data: rows, pagination: { page: query.page, limit: query.limit, total } };
    });
  }

  async summary(actor: TenantScope, supplierId: string) {
    return this.transactions.run(actor, async (tx) => {
      const supplier = await tx.supplier.findFirst({
        where: { id: supplierId, tenantId: actor.tenantId },
        select: { id: true },
      });
      if (!supplier) {
        throw new AppException(ErrorCode.SUPPLIER_NOT_FOUND, "Supplier was not found.", HttpStatus.NOT_FOUND);
      }
      const summary = await tx.purchase.aggregate({
        where: { tenantId: actor.tenantId, supplierId, status: "CONFIRMED" },
        _count: { _all: true },
        _sum: { grandTotal: true },
        _max: { businessDate: true },
      });
      return {
        purchaseCount: summary._count._all,
        totalPurchaseValue: summary._sum.grandTotal ?? new Prisma.Decimal(0),
        lastPurchaseDate: summary._max.businessDate,
      };
    });
  }
}

function blankToNull(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const text = value.trim();
  return text.length === 0 ? null : text;
}

export function supplierActiveFilter(value: string | undefined): boolean | null {
  return activeFilter(value);
}
