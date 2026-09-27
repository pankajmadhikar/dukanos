import { HttpStatus, Injectable } from "@nestjs/common";
import { AdjustmentReason, MovementType, Prisma } from "@prisma/client";
import { AuditRecorder, ShopAuditAction } from "../audit/audit-recorder";
import { ShopDb } from "../database/prisma.types";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";
import { weightedAverage } from "./stock-calculator";

const INBOUND = new Set<MovementType>([
  MovementType.OPENING_STOCK,
  MovementType.PURCHASE,
  MovementType.SALE_RETURN,
  MovementType.SALE_VOID,
  MovementType.TRANSFER_IN,
]);

const OUTBOUND = new Set<MovementType>([
  MovementType.SALE,
  MovementType.PURCHASE_RETURN,
  MovementType.DAMAGE,
  MovementType.EXPIRY,
  MovementType.TRANSFER_OUT,
]);

const ADJUSTMENT_MOVEMENTS = new Set<MovementType>([
  MovementType.OPENING_STOCK,
  MovementType.ADJUSTMENT,
  MovementType.DAMAGE,
  MovementType.EXPIRY,
]);

export interface LedgerReference {
  type: "STOCK_ADJUSTMENT" | "PURCHASE" | "SALE" | "SALE_RETURN" | "PURCHASE_RETURN" | "STOCK_TRANSFER" | "SALE_VOID";
  id: string;
  lineId: string;
}

/**
 * One stock change. Quantity is always positive. Direction chooses the sign.
 * Adjustment, damage, expiry, and opening create the stock-adjustment document.
 * A future purchase or sale passes its own document line in `reference`.
 */
export interface LedgerCommand {
  tenantId: string;
  userId: string;
  productId: string;
  locationId?: string;
  movementType: MovementType;
  direction: "IN" | "OUT";
  quantity: Prisma.Decimal;
  unitCost?: Prisma.Decimal;
  note?: string;
  reference?: LedgerReference;
  /** Document timestamp. The movement business date is derived from this instant. */
  occurredAt?: Date;
}

export interface PostedStock {
  movementId: string;
  adjustmentId: string;
  adjustmentNumber: string;
  productId: string;
  locationId: string;
  movementType: MovementType;
  quantityDelta: Prisma.Decimal;
  quantityAfter: Prisma.Decimal;
  averageCostAfter: Prisma.Decimal | null;
  /** Cost written on the movement. Null when the balance had no average. */
  unitCostApplied: Prisma.Decimal | null;
  /** Quantity times the applied unit cost, rounded half up. Null when cost is unknown. */
  costAmount: Prisma.Decimal | null;
}

interface LockedBalance {
  id: string;
  quantity: unknown;
  average_cost: unknown;
}

@Injectable()
export class InventoryLedgerService {
  constructor(private readonly audit: AuditRecorder) {}

  async post(tx: ShopDb, command: LedgerCommand): Promise<PostedStock> {
    if (command.quantity.lte(0)) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        "Quantity must be greater than zero.",
        HttpStatus.BAD_REQUEST,
      );
    }
    const delta =
      command.direction === "IN" ? command.quantity : command.quantity.negated();
    assertSign(command.movementType, delta);

    const locationId = await this.resolveLocation(tx, command.tenantId, command.locationId);
    await this.requireActiveProduct(tx, command.tenantId, command.productId);

    if (command.movementType === MovementType.OPENING_STOCK) {
      await this.requireFirstOpening(tx, command.tenantId, command.productId, locationId);
    }

    const locked = await this.lockBalance(tx, command.tenantId, command.productId, locationId);
    const oldQuantity = locked ? asDecimal(locked.quantity) : new Prisma.Decimal(0);
    const oldAverage = locked && locked.average_cost !== null ? asDecimal(locked.average_cost) : null;
    const quantityAfter = oldQuantity.plus(delta);
    if (quantityAfter.isNeg()) {
      throw new AppException(
        ErrorCode.INSUFFICIENT_STOCK,
        "Not enough stock for this product.",
        HttpStatus.CONFLICT,
      );
    }

    const incoming = command.direction === "IN";
    const purchaseReturn = command.movementType === MovementType.PURCHASE_RETURN;
    if (incoming && command.unitCost == null) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        "Enter a unit cost for incoming stock.",
        HttpStatus.BAD_REQUEST,
      );
    }
    if (purchaseReturn && command.unitCost == null) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        "A purchase return needs the original purchase cost.",
        HttpStatus.BAD_REQUEST,
      );
    }
    const incomingCost = command.unitCost ?? new Prisma.Decimal(0);
    // A purchase return leaves the average alone and records the original purchase cost.
    const unitCost = incoming ? incomingCost : purchaseReturn ? command.unitCost! : oldAverage;
    const averageCostAfter = incoming
      ? weightedAverage(oldQuantity, oldAverage, command.quantity, incomingCost)
      : oldAverage;

    const occurredAt = command.occurredAt ?? new Date();
    const source = command.reference
      ? this.useReference(command)
      : await this.createAdjustment(tx, command, locationId, delta, unitCost ?? null, occurredAt);

    const movement = await tx.inventoryMovement.create({
      data: {
        tenantId: command.tenantId,
        productId: command.productId,
        locationId,
        movementType: command.movementType,
        quantityDelta: delta,
        unitCost,
        referenceType: source.referenceType,
        referenceId: source.referenceId,
        sourceLineId: source.lineId,
        occurredAt,
        businessDate: new Date(Date.UTC(2000, 0, 1)),
        createdBy: command.userId,
      },
      select: { id: true },
    });

    if (locked) {
      await tx.inventoryBalance.update({
        where: { id: locked.id },
        data: { quantity: quantityAfter, averageCost: averageCostAfter },
      });
    } else {
      await tx.inventoryBalance.create({
        data: {
          tenantId: command.tenantId,
          productId: command.productId,
          locationId,
          quantity: quantityAfter,
          averageCost: averageCostAfter,
        },
      });
    }

    if (!command.reference) {
      await tx.stockAdjustment.update({
        where: { id: source.referenceId },
        data: { status: "CONFIRMED" },
      });
    }

    if (!command.reference) {
      await this.audit.write(tx, {
        action: auditAction(command.movementType),
        entityType: "stock_adjustment",
        entityId: source.referenceId,
        tenantId: command.tenantId,
        actorUserId: command.userId,
      });
    }

    return {
      movementId: movement.id,
      adjustmentId: source.referenceId,
      adjustmentNumber: source.number,
      productId: command.productId,
      locationId,
      movementType: command.movementType,
      quantityDelta: delta,
      quantityAfter,
      averageCostAfter,
      unitCostApplied: unitCost,
      costAmount:
        unitCost === null
          ? null
          : command.quantity.mul(unitCost).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
    };
  }

  /**
   * Locks the balance and returns the average a later outbound post will record.
   * The row stays locked until the caller's transaction ends.
   */
  async lockUnitCost(
    tx: ShopDb,
    scope: { tenantId: string; productId: string; locationId: string },
  ): Promise<Prisma.Decimal | null> {
    const locked = await this.lockBalance(tx, scope.tenantId, scope.productId, scope.locationId);
    if (!locked || locked.average_cost === null) {
      return null;
    }
    return asDecimal(locked.average_cost);
  }

  private async resolveLocation(
    tx: ShopDb,
    tenantId: string,
    locationId: string | undefined,
  ): Promise<string> {
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
      throw new AppException(
        ErrorCode.NOT_FOUND,
        "This shop has no default location.",
        HttpStatus.NOT_FOUND,
      );
    }
    const location = await tx.location.findFirst({
      where: { id: shop.defaultLocationId, tenantId, isActive: true },
      select: { id: true },
    });
    if (!location) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        "This shop has no default location.",
        HttpStatus.NOT_FOUND,
      );
    }
    return location.id;
  }

  private async requireActiveProduct(tx: ShopDb, tenantId: string, productId: string): Promise<void> {
    const product = await tx.product.findFirst({
      where: { id: productId, tenantId },
      select: { isActive: true },
    });
    if (!product) {
      throw new AppException(ErrorCode.PRODUCT_NOT_FOUND, "Product was not found.", HttpStatus.NOT_FOUND);
    }
    if (!product.isActive) {
      throw new AppException(
        ErrorCode.PRODUCT_INACTIVE,
        "Inactive products cannot receive stock movements.",
        HttpStatus.CONFLICT,
      );
    }
  }

  private async requireFirstOpening(
    tx: ShopDb,
    tenantId: string,
    productId: string,
    locationId: string,
  ): Promise<void> {
    const existing = await tx.inventoryMovement.findFirst({
      where: {
        tenantId,
        productId,
        locationId,
        movementType: MovementType.OPENING_STOCK,
      },
      select: { id: true },
    });
    if (existing) {
      throw new AppException(
        ErrorCode.OPENING_STOCK_EXISTS,
        "Opening stock is already recorded for this product at this location.",
        HttpStatus.CONFLICT,
      );
    }
  }

  private async lockBalance(
    tx: ShopDb,
    tenantId: string,
    productId: string,
    locationId: string,
  ): Promise<LockedBalance | null> {
    const rows = await tx.$queryRaw<LockedBalance[]>`
      SELECT id, quantity, average_cost
      FROM inventory_balances
      WHERE tenant_id = ${tenantId}::uuid
        AND product_id = ${productId}::uuid
        AND location_id = ${locationId}::uuid
      FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  private async createAdjustment(
    tx: ShopDb,
    command: LedgerCommand,
    locationId: string,
    delta: Prisma.Decimal,
    unitCost: Prisma.Decimal | null,
    occurredAt: Date,
  ): Promise<{ referenceType: "STOCK_ADJUSTMENT"; referenceId: string; lineId: string; number: string }> {
    if (!ADJUSTMENT_MOVEMENTS.has(command.movementType)) {
      throw new AppException(
        ErrorCode.INVALID_BUSINESS_OPERATION,
        "This stock movement needs a source document.",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const numbers = await tx.$queryRaw<Array<{ next_document_number: string }>>`
      SELECT next_document_number(${command.tenantId}::uuid, 'STOCK_ADJUSTMENT'::document_type)
        AS next_document_number
    `;
    const adjustmentNumber = numbers[0]?.next_document_number;
    if (!adjustmentNumber) {
      throw new AppException(
        ErrorCode.INVALID_BUSINESS_OPERATION,
        "This shop has no stock adjustment number.",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const adjustment = await tx.stockAdjustment.create({
      data: {
        tenantId: command.tenantId,
        locationId,
        adjustmentNumber,
        adjustmentDate: occurredAt,
        businessDate: new Date(Date.UTC(2000, 0, 1)),
        reason: documentReason(command.movementType),
        status: "DRAFT",
        createdBy: command.userId,
      },
      select: { id: true },
    });
    const item = await tx.stockAdjustmentItem.create({
      data: {
        tenantId: command.tenantId,
        stockAdjustmentId: adjustment.id,
        productId: command.productId,
        quantityDelta: delta,
        unitCost,
        reason: command.note?.trim() || defaultNote(command.movementType, command.direction),
      },
      select: { id: true },
    });
    return {
      referenceType: "STOCK_ADJUSTMENT",
      referenceId: adjustment.id,
      lineId: item.id,
      number: adjustmentNumber,
    };
  }

  private useReference(
    command: LedgerCommand,
  ): { referenceType: LedgerReference["type"]; referenceId: string; lineId: string; number: string } {
    if (!command.reference) {
      throw new AppException(
        ErrorCode.INVALID_BUSINESS_OPERATION,
        "This stock movement needs a source document.",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return {
      referenceType: command.reference.type,
      referenceId: command.reference.id,
      lineId: command.reference.lineId,
      number: "",
    };
  }
}

function assertSign(movementType: MovementType, delta: Prisma.Decimal): void {
  if (INBOUND.has(movementType) && delta.lte(0)) {
    throw new AppException(
      ErrorCode.INVALID_BUSINESS_OPERATION,
      "This stock movement must increase quantity.",
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
  if (OUTBOUND.has(movementType) && delta.gte(0)) {
    throw new AppException(
      ErrorCode.INVALID_BUSINESS_OPERATION,
      "This stock movement must decrease quantity.",
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
  if (delta.isZero()) {
    throw new AppException(
      ErrorCode.VALIDATION_ERROR,
      "Quantity must be greater than zero.",
      HttpStatus.BAD_REQUEST,
    );
  }
}

function documentReason(movementType: MovementType): AdjustmentReason {
  if (movementType === MovementType.OPENING_STOCK) {
    return AdjustmentReason.OPENING;
  }
  if (movementType === MovementType.DAMAGE) {
    return AdjustmentReason.DAMAGE;
  }
  if (movementType === MovementType.EXPIRY) {
    return AdjustmentReason.EXPIRY;
  }
  return AdjustmentReason.CORRECTION;
}

function defaultNote(movementType: MovementType, direction: "IN" | "OUT"): string {
  if (movementType === MovementType.OPENING_STOCK) {
    return "Opening stock";
  }
  if (movementType === MovementType.DAMAGE) {
    return "Damaged";
  }
  if (movementType === MovementType.EXPIRY) {
    return "Expired";
  }
  return direction === "IN" ? "Stock increase" : "Stock decrease";
}

function auditAction(movementType: MovementType): ShopAuditAction {
  if (movementType === MovementType.OPENING_STOCK) {
    return "inventory.opening_created";
  }
  if (movementType === MovementType.DAMAGE) {
    return "inventory.damage_recorded";
  }
  if (movementType === MovementType.EXPIRY) {
    return "inventory.expiry_recorded";
  }
  return "inventory.adjustment_created";
}

function asDecimal(value: unknown): Prisma.Decimal {
  if (value instanceof Prisma.Decimal) {
    return value;
  }
  return new Prisma.Decimal(String(value));
}
