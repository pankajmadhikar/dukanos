import { Prisma } from "@prisma/client";
import { formatMoney, formatStock } from "../catalog/decimal";
import { canSeePurchaseCost } from "./purchase-access";

export interface PurchaseItemView {
  id: string;
  quantity: Prisma.Decimal;
  unitCost: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  returnedQuantity?: Prisma.Decimal;
  product: { id: string; name: string; sku: string | null };
}

export interface PurchaseView {
  id: string;
  billNumber: string;
  purchaseDate: Date;
  businessDate: Date;
  status: string;
  supplierInvoiceNumber: string | null;
  notes: string | null;
  subtotal: Prisma.Decimal;
  discountTotal: Prisma.Decimal;
  taxTotal: Prisma.Decimal;
  grandTotal: Prisma.Decimal;
  createdAt: Date;
  supplier: { id: string; name: string } | null;
  location: { id: string; name: string };
  creator: { id: string; name: string };
  items?: PurchaseItemView[];
}

export function presentPurchase(row: PurchaseView, role: string | null, detail: boolean) {
  const seeCost = canSeePurchaseCost(role);
  const body: Record<string, unknown> = {
    id: row.id,
    purchaseNumber: row.billNumber,
    purchaseDate: row.purchaseDate.toISOString(),
    businessDate: businessDateText(row.businessDate),
    status: row.status,
    supplierInvoiceNumber: row.supplierInvoiceNumber,
    supplier: row.supplier,
    location: row.location,
    createdBy: row.creator,
    createdAt: row.createdAt.toISOString(),
  };
  if (seeCost) {
    body.subtotal = formatMoney(row.subtotal);
    body.discountTotal = formatMoney(row.discountTotal);
    body.taxTotal = formatMoney(row.taxTotal);
    body.total = formatMoney(row.grandTotal);
  }
  if (detail) {
    body.notes = row.notes;
    body.items = (row.items ?? []).map((item) => {
      const line: Record<string, unknown> = {
        id: item.id,
        product: item.product,
        quantity: formatStock(item.quantity),
        returnedQuantity: formatStock(item.returnedQuantity ?? new Prisma.Decimal(0)),
        remainingQuantity: formatStock(item.quantity.minus(item.returnedQuantity ?? new Prisma.Decimal(0))),
      };
      if (seeCost) {
        line.unitCost = formatMoney(item.unitCost);
        line.lineTotal = formatMoney(item.lineTotal);
      }
      return line;
    });
  }
  return body;
}

export function presentProductPurchase(
  row: {
    purchaseDate: Date;
    businessDate: Date;
    billNumber: string;
    purchaseId: string;
    supplierName: string | null;
    quantity: Prisma.Decimal;
    unitCost: Prisma.Decimal;
  },
  role: string | null,
) {
  const body: Record<string, unknown> = {
    purchaseId: row.purchaseId,
    purchaseNumber: row.billNumber,
    purchaseDate: row.purchaseDate.toISOString(),
    businessDate: businessDateText(row.businessDate),
    supplierName: row.supplierName,
    quantity: formatStock(row.quantity),
  };
  if (canSeePurchaseCost(role)) {
    body.unitCost = formatMoney(row.unitCost);
  }
  return body;
}

function businessDateText(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
