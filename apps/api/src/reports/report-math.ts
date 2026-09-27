import { Prisma } from "@prisma/client";

const PLACES = 2;

/** Percent change. Both zero is 0.00. A zero base with a non-zero current has no percentage. */
export function percentChange(current: Prisma.Decimal, previous: Prisma.Decimal): string | null {
  if (previous.isZero()) {
    return current.isZero() ? "0.00" : null;
  }
  return current.minus(previous).div(previous).mul(100).toDecimalPlaces(PLACES, Prisma.Decimal.ROUND_HALF_UP).toFixed(PLACES);
}
