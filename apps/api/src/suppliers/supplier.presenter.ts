import { Prisma } from "@prisma/client";
import { formatMoney } from "../catalog/decimal";
import { canSeeSupplierMoney } from "./supplier-access";

export interface SupplierRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  isActive: boolean;
  payableBalance: Prisma.Decimal;
  createdAt: Date;
  updatedAt: Date;
}

export interface SupplierSettlementView {
  paymentCount: number;
  latestPayment: {
    id: string;
    amount: string;
    method: string;
    paymentDate: string;
  } | null;
}

export function presentSupplier(row: SupplierRow, role: string | null, settlement?: SupplierSettlementView) {
  const body: Record<string, unknown> = {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    address: row.address,
    notes: row.notes,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (canSeeSupplierMoney(role)) {
    body.payableBalance = formatMoney(row.payableBalance);
    if (settlement) {
      body.paymentCount = settlement.paymentCount;
      body.latestPayment = settlement.latestPayment;
    }
  }
  return body;
}
