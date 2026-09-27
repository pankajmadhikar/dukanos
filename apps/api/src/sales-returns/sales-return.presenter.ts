import { Prisma } from "@prisma/client";
import { formatMoney, formatStock } from "../catalog/decimal";
import { lineCostAmount } from "../sales/sale-calculator";
import { canSeeSaleProfit } from "../sales/sales-access";

export interface SaleReturnItemView {
  id: string;
  originalSaleItemId: string;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  unitCost: Prisma.Decimal | null;
  lineTotal: Prisma.Decimal;
  product: { id: string; name: string; sku: string | null };
}

export interface SaleReturnView {
  id: string;
  returnNumber: string;
  returnDate: Date;
  businessDate: Date;
  status: string;
  reason: string | null;
  subtotal: Prisma.Decimal;
  refundAmount: Prisma.Decimal;
  createdAt: Date;
  originalSale: { id: string; billNumber: string };
  customer: { id: string; name: string } | null;
  location: { id: string; name: string };
  creator: { id: string; name: string };
  items?: SaleReturnItemView[];
  payments?: Array<{ method: string; amount: Prisma.Decimal }>;
}

export function presentSaleReturn(row: SaleReturnView, role: string | null, detail: boolean) {
  const seeProfit = canSeeSaleProfit(role);
  const credit = row.subtotal.minus(row.refundAmount);
  const body: Record<string, unknown> = {
    id: row.id,
    returnNumber: row.returnNumber,
    returnDate: row.returnDate.toISOString(),
    businessDate: businessDateText(row.businessDate),
    status: row.status,
    sale: { id: row.originalSale.id, saleNumber: row.originalSale.billNumber },
    customer: row.customer,
    location: row.location,
    total: formatMoney(row.subtotal),
    refundAmount: formatMoney(row.refundAmount),
    receivableCredit: formatMoney(credit),
    createdBy: row.creator,
    createdAt: row.createdAt.toISOString(),
  };
  if (detail) {
    body.reason = row.reason;
    body.items = (row.items ?? []).map((item) => presentItem(item, seeProfit));
    body.payments = (row.payments ?? []).map((payment) => ({
      method: payment.method,
      amount: formatMoney(payment.amount),
    }));
    if (seeProfit) {
      const profit = profitOf(row.items ?? [], row.subtotal);
      body.cogs = profit.cogs;
      body.grossProfit = profit.grossProfit;
    }
  }
  return body;
}

function presentItem(item: SaleReturnItemView, seeProfit: boolean) {
  const line: Record<string, unknown> = {
    id: item.id,
    saleItemId: item.originalSaleItemId,
    product: item.product,
    quantity: formatStock(item.quantity),
    unitPrice: formatMoney(item.unitPrice),
    lineTotal: formatMoney(item.lineTotal),
  };
  if (seeProfit) {
    line.unitCost = formatMoney(item.unitCost);
    line.costAmount = formatMoney(lineCostAmount(item.quantity, item.unitCost));
  }
  return line;
}

function profitOf(
  items: SaleReturnItemView[],
  total: Prisma.Decimal,
): { cogs: string | null; grossProfit: string | null } {
  if (items.some((item) => item.unitCost === null)) {
    return { cogs: null, grossProfit: null };
  }
  const cogs = items.reduce(
    (sum, item) => sum.plus(lineCostAmount(item.quantity, item.unitCost) ?? new Prisma.Decimal(0)),
    new Prisma.Decimal(0),
  );
  return {
    cogs: formatMoney(cogs),
    grossProfit: formatMoney(total.minus(cogs)),
  };
}

function businessDateText(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
