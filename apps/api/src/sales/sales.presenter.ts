import { Prisma } from "@prisma/client";
import { formatMoney, formatStock } from "../catalog/decimal";
import { lineCostAmount } from "./sale-calculator";
import { canSeeSaleProfit } from "./sales-access";

export interface SaleItemView {
  id: string;
  quantity: Prisma.Decimal;
  unitSellingPrice: Prisma.Decimal;
  unitCost: Prisma.Decimal | null;
  lineTotal: Prisma.Decimal;
  priceSource: string;
  returnedQuantity?: Prisma.Decimal;
  product: { id: string; name: string; sku: string | null };
}

export interface SalePaymentView {
  id: string;
  method: string;
  amount: Prisma.Decimal;
  externalReference: string | null;
}

export interface SaleView {
  id: string;
  billNumber: string;
  saleDate: Date;
  businessDate: Date;
  status: string;
  paymentStatus: string;
  notes: string | null;
  subtotal: Prisma.Decimal;
  grandTotal: Prisma.Decimal;
  createdAt: Date;
  customer: { id: string; name: string } | null;
  location: { id: string; name: string };
  creator: { id: string; name: string };
  paid: Prisma.Decimal;
  outstanding: Prisma.Decimal;
  items?: SaleItemView[];
  payments?: SalePaymentView[];
}

export function presentSale(row: SaleView, role: string | null, detail: boolean) {
  const seeProfit = canSeeSaleProfit(role);
  const body: Record<string, unknown> = {
    id: row.id,
    saleNumber: row.billNumber,
    saleDate: row.saleDate.toISOString(),
    businessDate: businessDateText(row.businessDate),
    status: row.status,
    paymentStatus: row.paymentStatus,
    customer: row.customer,
    location: row.location,
    total: formatMoney(row.grandTotal),
    paid: formatMoney(row.paid),
    outstanding: formatMoney(row.outstanding),
    createdBy: row.creator,
    createdAt: row.createdAt.toISOString(),
  };
  if (detail) {
    body.notes = row.notes;
    body.subtotal = formatMoney(row.subtotal);
    body.items = (row.items ?? []).map((item) => presentItem(item, seeProfit));
    body.payments = (row.payments ?? []).map((payment) => ({
      id: payment.id,
      method: payment.method,
      amount: formatMoney(payment.amount),
      reference: payment.externalReference,
    }));
    if (seeProfit) {
      const profit = profitOf(row.items ?? [], row.grandTotal);
      body.cogs = profit.cogs;
      body.grossProfit = profit.grossProfit;
    }
  }
  return body;
}

export function presentProductSale(
  row: {
    purchaseId?: string;
    saleId: string;
    saleNumber: string;
    saleDate: Date;
    businessDate: Date;
    customerName: string | null;
    quantity: Prisma.Decimal;
    unitSellingPrice: Prisma.Decimal;
    unitCost: Prisma.Decimal | null;
  },
  role: string | null,
) {
  const body: Record<string, unknown> = {
    saleId: row.saleId,
    saleNumber: row.saleNumber,
    saleDate: row.saleDate.toISOString(),
    businessDate: businessDateText(row.businessDate),
    customerName: row.customerName,
    quantity: formatStock(row.quantity),
    unitPrice: formatMoney(row.unitSellingPrice),
  };
  if (canSeeSaleProfit(role)) {
    body.unitCost = formatMoney(row.unitCost);
  }
  return body;
}

function presentItem(item: SaleItemView, seeProfit: boolean) {
  const line: Record<string, unknown> = {
    id: item.id,
    product: item.product,
    quantity: formatStock(item.quantity),
    unitPrice: formatMoney(item.unitSellingPrice),
    lineTotal: formatMoney(item.lineTotal),
    priceSource: item.priceSource,
    returnedQuantity: formatStock(item.returnedQuantity ?? new Prisma.Decimal(0)),
    remainingQuantity: formatStock(item.quantity.minus(item.returnedQuantity ?? new Prisma.Decimal(0))),
  };
  if (seeProfit) {
    line.unitCost = formatMoney(item.unitCost);
    line.costAmount = formatMoney(lineCostAmount(item.quantity, item.unitCost));
  }
  return line;
}

function profitOf(items: SaleItemView[], total: Prisma.Decimal): { cogs: string | null; grossProfit: string | null } {
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

export function businessDateText(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
