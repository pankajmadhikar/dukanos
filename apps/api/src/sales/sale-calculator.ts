import { PaymentStatus, Prisma } from "@prisma/client";

const ROUNDING = Prisma.Decimal.ROUND_HALF_UP;

export function saleLineTotal(quantity: Prisma.Decimal, unitPrice: Prisma.Decimal): Prisma.Decimal {
  return quantity.mul(unitPrice).toDecimalPlaces(2, ROUNDING);
}

export function saleOutstanding(total: Prisma.Decimal, paid: Prisma.Decimal): Prisma.Decimal {
  return total.minus(paid);
}

export function salePaymentStatus(total: Prisma.Decimal, paid: Prisma.Decimal): PaymentStatus {
  if (paid.gte(total)) {
    return PaymentStatus.PAID;
  }
  if (paid.gt(0)) {
    return PaymentStatus.PARTIAL;
  }
  return PaymentStatus.UNPAID;
}

export function lineCostAmount(quantity: Prisma.Decimal, unitCost: Prisma.Decimal | null): Prisma.Decimal | null {
  if (unitCost === null) {
    return null;
  }
  return quantity.mul(unitCost).toDecimalPlaces(2, ROUNDING);
}
