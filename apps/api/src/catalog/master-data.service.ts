import { HttpStatus, Injectable } from "@nestjs/common";
import { AuditRecorder } from "../audit/audit-recorder";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";
import { mapDatabaseError } from "../common/errors/map-database-error";
import { ShopDb } from "../database/prisma.types";
import { TenantTransactionService } from "../database/tenant-transaction.service";
import { assertUuid } from "./catalog-access";
import { normalizeName } from "./text";

export interface CatalogActor {
  tenantId: string;
  userId: string;
}

@Injectable()
export class UnitService {
  constructor(
    private readonly transactions: TenantTransactionService,
    private readonly audit: AuditRecorder,
  ) {}

  async list(actor: CatalogActor, isActive: boolean | undefined) {
    return this.transactions.run(actor, (tx) =>
      tx.unit.findMany({
        where: { tenantId: actor.tenantId, ...(isActive === undefined ? {} : { isActive }) },
        select: { id: true, name: true, shortCode: true, decimalPlaces: true, isActive: true },
        orderBy: { name: "asc" },
      }),
    );
  }

  async create(actor: CatalogActor, input: { name: string; shortCode: string; decimalPlaces: number }) {
    const name = requiredName(input.name, "unit");
    const shortCode = input.shortCode.trim();
    return this.transactions.run(actor, async (tx) => {
      try {
        const unit = await tx.unit.create({
          data: { tenantId: actor.tenantId, name, shortCode, decimalPlaces: input.decimalPlaces },
          select: { id: true, name: true, shortCode: true, decimalPlaces: true, isActive: true },
        });
        await this.audit.write(tx, {
          action: "unit.created",
          entityType: "unit",
          entityId: unit.id,
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
        });
        return unit;
      } catch (error) {
        throw conflict(error, "A unit with this name or short code already exists.");
      }
    });
  }

  async update(
    actor: CatalogActor,
    id: string,
    input: { name?: string; shortCode?: string; decimalPlaces?: number; isActive?: boolean },
  ) {
    assertUuid(id, "Unit id");
    return this.transactions.run(actor, async (tx) => {
      const existing = await tx.unit.findFirst({ where: { id, tenantId: actor.tenantId } });
      if (!existing) {
        throw notFound(ErrorCode.UNIT_NOT_FOUND, "Unit was not found.");
      }
      try {
        const unit = await tx.unit.update({
          where: { id },
          data: {
            name: input.name === undefined ? undefined : requiredName(input.name, "unit"),
            shortCode: input.shortCode?.trim(),
            decimalPlaces: input.decimalPlaces,
            isActive: input.isActive,
          },
          select: { id: true, name: true, shortCode: true, decimalPlaces: true, isActive: true },
        });
        await this.audit.write(tx, {
          action: "unit.updated",
          entityType: "unit",
          entityId: unit.id,
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
        });
        return unit;
      } catch (error) {
        throw conflict(error, "A unit with this name or short code already exists.");
      }
    });
  }
}

@Injectable()
export class CategoryService {
  constructor(
    private readonly transactions: TenantTransactionService,
    private readonly audit: AuditRecorder,
  ) {}

  async list(actor: CatalogActor, isActive: boolean | undefined) {
    return this.transactions.run(actor, (tx) =>
      tx.category.findMany({
        where: { tenantId: actor.tenantId, ...(isActive === undefined ? {} : { isActive }) },
        select: { id: true, name: true, parentId: true, isActive: true },
        orderBy: { name: "asc" },
      }),
    );
  }

  async create(actor: CatalogActor, input: { name: string; parentId?: string }) {
    const name = requiredName(input.name, "category");
    if (input.parentId) {
      assertUuid(input.parentId, "Parent category id");
    }
    return this.transactions.run(actor, async (tx) => {
      if (input.parentId) {
        await this.requireParent(tx, actor.tenantId, input.parentId);
      }
      try {
        const category = await tx.category.create({
          data: { tenantId: actor.tenantId, name, parentId: input.parentId ?? null },
          select: { id: true, name: true, parentId: true, isActive: true },
        });
        await this.audit.write(tx, {
          action: "category.created",
          entityType: "category",
          entityId: category.id,
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
        });
        return category;
      } catch (error) {
        throw conflict(error, "A category with this name already exists here.");
      }
    });
  }

  async update(
    actor: CatalogActor,
    id: string,
    input: { name?: string; parentId?: string | null; isActive?: boolean },
  ) {
    assertUuid(id, "Category id");
    if (input.parentId) {
      assertUuid(input.parentId, "Parent category id");
    }
    if (input.parentId === id) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        "A category cannot be its own parent.",
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.transactions.run(actor, async (tx) => {
      const existing = await tx.category.findFirst({ where: { id, tenantId: actor.tenantId } });
      if (!existing) {
        throw notFound(ErrorCode.CATEGORY_NOT_FOUND, "Category was not found.");
      }
      if (input.parentId) {
        await this.requireParent(tx, actor.tenantId, input.parentId);
      }
      try {
        const category = await tx.category.update({
          where: { id },
          data: {
            name: input.name === undefined ? undefined : requiredName(input.name, "category"),
            parentId: input.parentId,
            isActive: input.isActive,
          },
          select: { id: true, name: true, parentId: true, isActive: true },
        });
        await this.audit.write(tx, {
          action: "category.updated",
          entityType: "category",
          entityId: category.id,
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
        });
        return category;
      } catch (error) {
        throw conflict(error, "A category with this name already exists here.");
      }
    });
  }

  private async requireParent(tx: ShopDb, tenantId: string, parentId: string) {
    const parent = await tx.category.findFirst({
      where: { id: parentId, tenantId },
      select: { isActive: true },
    });
    if (!parent) {
      throw notFound(ErrorCode.CATEGORY_NOT_FOUND, "Category was not found.");
    }
    if (!parent.isActive) {
      throw new AppException(
        ErrorCode.CATEGORY_INACTIVE,
        "That category is inactive.",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
  }
}

@Injectable()
export class BrandService {
  constructor(
    private readonly transactions: TenantTransactionService,
    private readonly audit: AuditRecorder,
  ) {}

  async list(actor: CatalogActor, isActive: boolean | undefined) {
    return this.transactions.run(actor, (tx) =>
      tx.brand.findMany({
        where: { tenantId: actor.tenantId, ...(isActive === undefined ? {} : { isActive }) },
        select: { id: true, name: true, isActive: true },
        orderBy: { name: "asc" },
      }),
    );
  }

  async create(actor: CatalogActor, input: { name: string }) {
    const name = requiredName(input.name, "brand");
    return this.transactions.run(actor, async (tx) => {
      try {
        const brand = await tx.brand.create({
          data: { tenantId: actor.tenantId, name },
          select: { id: true, name: true, isActive: true },
        });
        await this.audit.write(tx, {
          action: "brand.created",
          entityType: "brand",
          entityId: brand.id,
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
        });
        return brand;
      } catch (error) {
        throw conflict(error, "A brand with this name already exists.");
      }
    });
  }

  async update(actor: CatalogActor, id: string, input: { name?: string; isActive?: boolean }) {
    assertUuid(id, "Brand id");
    return this.transactions.run(actor, async (tx) => {
      const existing = await tx.brand.findFirst({ where: { id, tenantId: actor.tenantId } });
      if (!existing) {
        throw notFound(ErrorCode.BRAND_NOT_FOUND, "Brand was not found.");
      }
      try {
        const brand = await tx.brand.update({
          where: { id },
          data: {
            name: input.name === undefined ? undefined : requiredName(input.name, "brand"),
            isActive: input.isActive,
          },
          select: { id: true, name: true, isActive: true },
        });
        await this.audit.write(tx, {
          action: "brand.updated",
          entityType: "brand",
          entityId: brand.id,
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
        });
        return brand;
      } catch (error) {
        throw conflict(error, "A brand with this name already exists.");
      }
    });
  }
}

function requiredName(value: string, label: string): string {
  const name = normalizeName(value);
  if (name.length === 0) {
    throw new AppException(
      ErrorCode.VALIDATION_ERROR,
      `Enter a ${label} name.`,
      HttpStatus.BAD_REQUEST,
    );
  }
  return name;
}

function notFound(code: ErrorCode, message: string): AppException {
  return new AppException(code, message, HttpStatus.NOT_FOUND);
}

function conflict(error: unknown, message: string): unknown {
  const mapped = mapDatabaseError(error);
  if (mapped?.code === ErrorCode.CONFLICT) {
    return new AppException(ErrorCode.CONFLICT, message, HttpStatus.CONFLICT);
  }
  return mapped ?? error;
}
