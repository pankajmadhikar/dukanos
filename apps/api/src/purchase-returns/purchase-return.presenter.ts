import { Prisma } from "@prisma/client";
import { formatMoney, formatStock } from "../catalog/decimal";
import { canSeePurchaseCost } from "../purchases/purchase-access";

export interface PurchaseReturnItemView {
  id: string;
  originalPurchaseItemId: string;
  quantity: Prisma.Decimal;
  unitCost: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  product: { id: string; name: string; sku: string | null };
}

export interface PurchaseReturnView {
  id: string;
  returnNumber: string;
  returnDate: Date;
  businessDate: Date;
  status: string;
  reason: string | null;
  subtotal: Prisma.Decimal;
  grandTotal: Prisma.Decimal;
  refundAmount: Prisma.Decimal;
  createdAt: Date;
  originalPurchase: { id: string; billNumber: string };
  supplier: { id: string; name: string } | null;
  location: { id: string; name: string };
  creator: { id: string; name: string };
  items?: PurchaseReturnItemView[];
  payments?: Array<{ method: string; amount: Prisma.Decimal }>;
}

export function presentPurchaseReturn(row: PurchaseReturnView, role: string | null, detail: boolean) {
  const seeCost = canSeePurchaseCost(role);
  const debit = row.grandTotal.minus(row.refundAmount);
  const body: Record<string, unknown> = {
    id: row.id,
    returnNumber: row.returnNumber,
    returnDate: row.returnDate.toISOString(),
    businessDate: businessDateText(row.businessDate),
    status: row.status,
    purchase: { id: row.originalPurchase.id, purchaseNumber: row.originalPurchase.billNumber },
    supplier: row.supplier,
    location: row.location,
    createdBy: row.creator,
    createdAt: row.createdAt.toISOString(),
  };
  if (seeCost) {
    body.total = formatMoney(row.grandTotal);
    body.refundAmount = formatMoney(row.refundAmount);
    body.payableDebit = formatMoney(debit);
  }
  if (detail) {
    body.reason = row.reason;
    body.items = (row.items ?? []).map((item) => {
      const line: Record<string, unknown> = {
        id: item.id,
        purchaseItemId: item.originalPurchaseItemId,
        product: item.product,
        quantity: formatStock(item.quantity),
      };
      if (seeCost) {
        line.unitCost = formatMoney(item.unitCost);
        line.lineTotal = formatMoney(item.lineTotal);
      }
      return line;
    });
    if (seeCost) {
      body.payments = (row.payments ?? []).map((payment) => ({
        method: payment.method,
        amount: formatMoney(payment.amount),
      }));
    }
  }
  return body;
}

function businessDateText(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
