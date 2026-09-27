import { Prisma } from "@prisma/client";

const MONEY_PLACES = 2;
const ROUNDING = Prisma.Decimal.ROUND_HALF_UP;

/**
 * Weighted average for an inbound quantity.
 * A zero on-hand quantity takes the incoming unit cost as the new average.
 * The result is stored at NUMERIC(18,2), rounded half up.
 */
export function weightedAverage(
  oldQuantity: Prisma.Decimal,
  oldAverageCost: Prisma.Decimal | null,
  incomingQuantity: Prisma.Decimal,
  incomingUnitCost: Prisma.Decimal,
): Prisma.Decimal {
  if (oldQuantity.isZero() || oldAverageCost === null) {
    return incomingUnitCost.toDecimalPlaces(MONEY_PLACES, ROUNDING);
  }
  const value = oldQuantity.mul(oldAverageCost).plus(incomingQuantity.mul(incomingUnitCost));
  const quantity = oldQuantity.plus(incomingQuantity);
  return value.div(quantity).toDecimalPlaces(MONEY_PLACES, ROUNDING);
}

export function stockValue(
  quantity: Prisma.Decimal,
  averageCost: Prisma.Decimal | null,
): Prisma.Decimal | null {
  if (averageCost === null) {
    return null;
  }
  return quantity.mul(averageCost).toDecimalPlaces(MONEY_PLACES, ROUNDING);
}

export function sellingValue(
  quantity: Prisma.Decimal,
  sellingPrice: Prisma.Decimal | null,
): Prisma.Decimal | null {
  if (sellingPrice === null) {
    return null;
  }
  return quantity.mul(sellingPrice).toDecimalPlaces(MONEY_PLACES, ROUNDING);
}

export function isOutOfStock(quantity: Prisma.Decimal): boolean {
  return quantity.isZero();
}

/**
 * Low stock is a positive quantity at or under a configured minimum.
 * A missing minimum is not low stock. Zero quantity is out of stock.
 */
export function isLowStock(
  quantity: Prisma.Decimal,
  minimumStockLevel: Prisma.Decimal | null,
): boolean {
  if (minimumStockLevel === null || quantity.lte(0)) {
    return false;
  }
  return quantity.lte(minimumStockLevel);
}
