import { Prisma } from "@prisma/client";
import { formatMoney, formatStock } from "../catalog/decimal";
import { canSeeStockCost } from "./inventory-access";
import { isLowStock, isOutOfStock, sellingValue, stockValue } from "./stock-calculator";

interface ProductView {
  id: string;
  name: string;
  sku: string | null;
  sellingPrice: Prisma.Decimal | null;
  minimumStockLevel: Prisma.Decimal | null;
  unit: string | null;
}

interface LocationView {
  id: string;
  name: string;
}

export interface BalanceView {
  product: ProductView;
  location: LocationView;
  quantity: Prisma.Decimal;
  averageCost: Prisma.Decimal | null;
}

export function presentBalance(row: BalanceView, role: string | null) {
  const seeCost = canSeeStockCost(role);
  const quantity = formatStock(row.quantity) ?? "0.000";
  const body: Record<string, unknown> = {
    product: {
      id: row.product.id,
      name: row.product.name,
      sku: row.product.sku,
      unit: row.product.unit,
    },
    location: {
      id: row.location.id,
      name: row.location.name,
    },
    quantity,
    sellingPrice: formatMoney(row.product.sellingPrice),
    sellingValue: formatMoney(sellingValue(row.quantity, row.product.sellingPrice)),
    outOfStock: isOutOfStock(row.quantity),
    lowStock: isLowStock(row.quantity, row.product.minimumStockLevel),
  };
  if (seeCost) {
    body.averageCost = formatMoney(row.averageCost);
    body.stockValue = formatMoney(stockValue(row.quantity, row.averageCost));
  }
  return body;
}

export function presentMovement(
  row: {
    id: string;
    occurredAt: Date;
    businessDate: Date;
    movementType: string;
    quantityDelta: Prisma.Decimal;
    unitCost: Prisma.Decimal | null;
    referenceType: string;
    referenceId: string;
    createdBy: string | null;
    reason: string | null;
  },
  role: string | null,
) {
  const seeCost = canSeeStockCost(role);
  const body: Record<string, unknown> = {
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    businessDate: businessDateText(row.businessDate),
    movementType: row.movementType,
    quantity: formatStock(row.quantityDelta),
    referenceType: row.referenceType,
    referenceId: row.referenceId,
    reason: row.reason,
    createdBy: row.createdBy,
  };
  if (seeCost) {
    body.unitCost = formatMoney(row.unitCost);
  }
  return body;
}

export function presentSummary(
  row: {
    productsWithStock: number;
    outOfStock: number;
    lowStock: number;
    totalQuantity: Prisma.Decimal;
    totalStockValue: Prisma.Decimal | null;
  },
  role: string | null,
) {
  const body: Record<string, unknown> = {
    productsWithStock: row.productsWithStock,
    outOfStock: row.outOfStock,
    lowStock: row.lowStock,
    totalQuantity: formatStock(row.totalQuantity),
  };
  if (canSeeStockCost(role)) {
    body.totalStockValue = formatMoney(row.totalStockValue);
  }
  return body;
}

export function presentPost(
  row: {
    movementId: string;
    adjustmentId: string;
    adjustmentNumber: string;
    productId: string;
    locationId: string;
    movementType: string;
    quantityDelta: Prisma.Decimal;
    quantityAfter: Prisma.Decimal;
    averageCostAfter: Prisma.Decimal | null;
  },
  role: string | null,
) {
  const seeCost = canSeeStockCost(role);
  const body: Record<string, unknown> = {
    movementId: row.movementId,
    adjustmentId: row.adjustmentId,
    adjustmentNumber: row.adjustmentNumber,
    productId: row.productId,
    locationId: row.locationId,
    movementType: row.movementType,
    quantity: formatStock(row.quantityDelta),
    quantityAfter: formatStock(row.quantityAfter),
  };
  if (seeCost) {
    body.averageCostAfter = formatMoney(row.averageCostAfter);
  }
  return body;
}

function businessDateText(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
