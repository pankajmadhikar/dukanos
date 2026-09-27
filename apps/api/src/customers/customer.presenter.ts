import { Prisma } from "@prisma/client";
import { formatMoney } from "../catalog/decimal";

export interface CustomerRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  isActive: boolean;
  receivableBalance: Prisma.Decimal;
  createdAt: Date;
  updatedAt: Date;
}

export interface CustomerSettlementView {
  paymentCount: number;
  latestPayment: {
    id: string;
    amount: string;
    method: string;
    paymentDate: string;
  } | null;
}

export function presentCustomer(row: CustomerRow, settlement?: CustomerSettlementView) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    address: row.address,
    notes: row.notes,
    isActive: row.isActive,
    receivableBalance: formatMoney(row.receivableBalance),
    ...(settlement
      ? { paymentCount: settlement.paymentCount, latestPayment: settlement.latestPayment }
      : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
