import { HttpStatus, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditRecorder } from "../audit/audit-recorder";
import { activeFilter } from "../catalog/catalog-access";
import { normalizeSearch } from "../catalog/text";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";
import { TenantScope } from "../database/prisma.types";
import { TenantTransactionService } from "../database/tenant-transaction.service";
import { CreateCustomerDto, UpdateCustomerDto } from "./dto/customer.dto";

@Injectable()
export class CustomerService {
  constructor(
    private readonly transactions: TenantTransactionService,
    private readonly audit: AuditRecorder,
  ) {}

  async create(actor: TenantScope, body: CreateCustomerDto) {
    const name = body.name.trim().replace(/\s+/g, " ");
    return this.transactions.run(actor, async (tx) => {
      const customer = await tx.customer.create({
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
        action: "customer.created",
        entityType: "customer",
        entityId: customer.id,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
      });
      return customer;
    });
  }

  async update(actor: TenantScope, customerId: string, body: UpdateCustomerDto) {
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
        "Provide a customer field to update.",
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.transactions.run(actor, async (tx) => {
      const existing = await tx.customer.findFirst({
        where: { id: customerId, tenantId: actor.tenantId },
      });
      if (!existing) {
        throw new AppException(ErrorCode.CUSTOMER_NOT_FOUND, "Customer was not found.", HttpStatus.NOT_FOUND);
      }
      const customer = await tx.customer.update({
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
          body.isActive === false && existing.isActive ? "customer.deactivated" : "customer.updated",
        entityType: "customer",
        entityId: customer.id,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
      });
      return customer;
    });
  }

  async get(actor: TenantScope, customerId: string) {
    return this.transactions.run(actor, async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id: customerId, tenantId: actor.tenantId },
      });
      if (!customer) {
        throw new AppException(ErrorCode.CUSTOMER_NOT_FOUND, "Customer was not found.", HttpStatus.NOT_FOUND);
      }
      return customer;
    });
  }

  async list(
    actor: TenantScope,
    query: { search?: string; isActive: boolean | null; page: number; limit: number },
  ) {
    return this.transactions.run(actor, async (tx) => {
      const text = query.search ? normalizeSearch(query.search) : "";
      const where: Prisma.CustomerWhereInput = {
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
        tx.customer.findMany({
          where,
          orderBy: [{ name: "asc" }, { id: "asc" }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        tx.customer.count({ where }),
      ]);
      return { data: rows, pagination: { page: query.page, limit: query.limit, total } };
    });
  }

  async summary(actor: TenantScope, customerId: string) {
    return this.transactions.run(actor, async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id: customerId, tenantId: actor.tenantId },
        select: { id: true, receivableBalance: true },
      });
      if (!customer) {
        throw new AppException(ErrorCode.CUSTOMER_NOT_FOUND, "Customer was not found.", HttpStatus.NOT_FOUND);
      }
      const summary = await tx.sale.aggregate({
        where: { tenantId: actor.tenantId, customerId, status: "COMPLETED" },
        _count: { _all: true },
        _sum: { grandTotal: true },
        _max: { businessDate: true },
      });
      return {
        saleCount: summary._count._all,
        totalSales: summary._sum.grandTotal ?? new Prisma.Decimal(0),
        outstanding: customer.receivableBalance,
        lastSaleDate: summary._max.businessDate,
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

export function customerActiveFilter(value: string | undefined): boolean | null {
  return activeFilter(value);
}
