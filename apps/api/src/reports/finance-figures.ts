import { Prisma } from "@prisma/client";
import { ShopDb } from "../database/prisma.types";
import { BusinessRange } from "./report-range";

export interface FinanceFigures {
  range: BusinessRange;
  grossSales: Prisma.Decimal;
  salesReturns: Prisma.Decimal;
  quantitySold: Prisma.Decimal;
  transactionCount: number;
  saleCogs: Prisma.Decimal;
  returnCogs: Prisma.Decimal;
  purchases: Prisma.Decimal;
  purchaseReturns: Prisma.Decimal;
  expenses: Prisma.Decimal;
  cashExpenses: Prisma.Decimal;
  upiExpenses: Prisma.Decimal;
  cashSalesCollections: Prisma.Decimal;
  upiSalesCollections: Prisma.Decimal;
  customerCollections: Prisma.Decimal;
  supplierPayments: Prisma.Decimal;
  customerOutstanding: Prisma.Decimal;
  supplierOutstanding: Prisma.Decimal;
  creditSales: Prisma.Decimal;
}

export interface DerivedFinance {
  netSales: Prisma.Decimal;
  cogs: Prisma.Decimal;
  grossProfit: Prisma.Decimal;
  netProfit: Prisma.Decimal;
}

/**
 * Shared finance math. Dashboard, finance summary, and daily closing all use this.
 *
 * netSales = grossSales - salesReturns
 * cogs = sale line cost - return line cost
 * grossProfit = netSales - cogs
 * netProfit = grossProfit - expenses
 */
export function deriveFinance(figures: Pick<FinanceFigures, "grossSales" | "salesReturns" | "saleCogs" | "returnCogs" | "expenses">): DerivedFinance {
  const netSales = figures.grossSales.minus(figures.salesReturns);
  const cogs = figures.saleCogs.minus(figures.returnCogs);
  return {
    netSales,
    cogs,
    grossProfit: netSales.minus(cogs),
    netProfit: netSales.minus(cogs).minus(figures.expenses),
  };
}

export async function loadFinanceFigures(tx: ShopDb, tenantId: string, range: BusinessRange): Promise<FinanceFigures> {
  const [sales, saleLines, returns, returnLines, purchases, purchaseReturns, expenses, payments, customers, suppliers, credit] =
    await Promise.all([
      tx.$queryRaw<Array<{ amount: string; count: string }>>`
        SELECT COALESCE(SUM(grand_total), 0)::text AS amount, COUNT(*)::text AS count
        FROM sales
        WHERE tenant_id = ${tenantId}::uuid
          AND status = 'COMPLETED'
          AND business_date BETWEEN ${range.from}::date AND ${range.to}::date
      `,
      tx.$queryRaw<Array<{ quantity: string; cogs: string }>>`
        SELECT
          COALESCE(SUM(si.quantity), 0)::text AS quantity,
          COALESCE(SUM(si.quantity * si.unit_cost) FILTER (WHERE si.unit_cost IS NOT NULL), 0)::text AS cogs
        FROM sale_items si
        JOIN sales s ON s.tenant_id = si.tenant_id AND s.id = si.sale_id
        WHERE si.tenant_id = ${tenantId}::uuid
          AND s.status = 'COMPLETED'
          AND s.business_date BETWEEN ${range.from}::date AND ${range.to}::date
      `,
      tx.$queryRaw<Array<{ amount: string }>>`
        SELECT COALESCE(SUM(subtotal), 0)::text AS amount
        FROM sale_returns
        WHERE tenant_id = ${tenantId}::uuid
          AND status = 'CONFIRMED'
          AND business_date BETWEEN ${range.from}::date AND ${range.to}::date
      `,
      tx.$queryRaw<Array<{ quantity: string; cogs: string }>>`
        SELECT
          COALESCE(SUM(sri.quantity), 0)::text AS quantity,
          COALESCE(SUM(sri.quantity * sri.unit_cost) FILTER (WHERE sri.unit_cost IS NOT NULL), 0)::text AS cogs
        FROM sale_return_items sri
        JOIN sale_returns sr ON sr.tenant_id = sri.tenant_id AND sr.id = sri.sale_return_id
        WHERE sri.tenant_id = ${tenantId}::uuid
          AND sr.status = 'CONFIRMED'
          AND sr.business_date BETWEEN ${range.from}::date AND ${range.to}::date
      `,
      tx.$queryRaw<Array<{ amount: string }>>`
        SELECT COALESCE(SUM(grand_total), 0)::text AS amount
        FROM purchases
        WHERE tenant_id = ${tenantId}::uuid
          AND status = 'CONFIRMED'
          AND business_date BETWEEN ${range.from}::date AND ${range.to}::date
      `,
      tx.$queryRaw<Array<{ amount: string }>>`
        SELECT COALESCE(SUM(subtotal), 0)::text AS amount
        FROM purchase_returns
        WHERE tenant_id = ${tenantId}::uuid
          AND status = 'CONFIRMED'
          AND business_date BETWEEN ${range.from}::date AND ${range.to}::date
      `,
      tx.$queryRaw<Array<{ amount: string; cash: string; upi: string }>>`
        SELECT
          COALESCE(SUM(e.amount), 0)::text AS amount,
          COALESCE(SUM(e.amount) FILTER (WHERE p.payment_method = 'CASH'), 0)::text AS cash,
          COALESCE(SUM(e.amount) FILTER (WHERE p.payment_method = 'UPI'), 0)::text AS upi
        FROM expenses e
        LEFT JOIN payments p ON p.tenant_id = e.tenant_id AND p.id = e.payment_id
        WHERE e.tenant_id = ${tenantId}::uuid
          AND e.business_date BETWEEN ${range.from}::date AND ${range.to}::date
      `,
      tx.$queryRaw<Array<{ cash_sales: string; upi_sales: string; customer_collections: string; supplier_payments: string }>>`
        SELECT
          COALESCE(SUM(amount) FILTER (
            WHERE reference_type = 'SALE' AND direction = 'IN' AND payment_method = 'CASH'
          ), 0)::text AS cash_sales,
          COALESCE(SUM(amount) FILTER (
            WHERE reference_type = 'SALE' AND direction = 'IN' AND payment_method = 'UPI'
          ), 0)::text AS upi_sales,
          COALESCE(SUM(amount) FILTER (
            WHERE reference_type = 'CUSTOMER_RECEIPT' AND direction = 'IN'
          ), 0)::text AS customer_collections,
          COALESCE(SUM(amount) FILTER (
            WHERE reference_type = 'SUPPLIER_PAYMENT' AND direction = 'OUT'
          ), 0)::text AS supplier_payments
        FROM payments
        WHERE tenant_id = ${tenantId}::uuid
          AND business_date BETWEEN ${range.from}::date AND ${range.to}::date
      `,
      tx.$queryRaw<Array<{ amount: string }>>`
        SELECT COALESCE(SUM(receivable_balance), 0)::text AS amount
        FROM customers
        WHERE tenant_id = ${tenantId}::uuid
      `,
      tx.$queryRaw<Array<{ amount: string }>>`
        SELECT COALESCE(SUM(payable_balance), 0)::text AS amount
        FROM suppliers
        WHERE tenant_id = ${tenantId}::uuid
      `,
      tx.$queryRaw<Array<{ amount: string }>>`
        SELECT COALESCE(SUM(debit_amount), 0)::text AS amount
        FROM customer_ledger
        WHERE tenant_id = ${tenantId}::uuid
          AND entry_type = 'CREDIT_SALE'
          AND business_date BETWEEN ${range.from}::date AND ${range.to}::date
      `,
    ]);
  return {
    range,
    grossSales: decimal(sales[0]?.amount),
    salesReturns: decimal(returns[0]?.amount),
    quantitySold: decimal(saleLines[0]?.quantity).minus(decimal(returnLines[0]?.quantity)),
    transactionCount: Number(sales[0]?.count ?? 0),
    saleCogs: decimal(saleLines[0]?.cogs),
    returnCogs: decimal(returnLines[0]?.cogs),
    purchases: decimal(purchases[0]?.amount),
    purchaseReturns: decimal(purchaseReturns[0]?.amount),
    expenses: decimal(expenses[0]?.amount),
    cashExpenses: decimal(expenses[0]?.cash),
    upiExpenses: decimal(expenses[0]?.upi),
    cashSalesCollections: decimal(payments[0]?.cash_sales),
    upiSalesCollections: decimal(payments[0]?.upi_sales),
    customerCollections: decimal(payments[0]?.customer_collections),
    supplierPayments: decimal(payments[0]?.supplier_payments),
    customerOutstanding: decimal(customers[0]?.amount),
    supplierOutstanding: decimal(suppliers[0]?.amount),
    creditSales: decimal(credit[0]?.amount),
  };
}

export async function loadAsOfBalances(
  tx: ShopDb,
  tenantId: string,
  businessDate: string,
): Promise<{ customer: Prisma.Decimal; supplier: Prisma.Decimal }> {
  const [customers, suppliers] = await Promise.all([
    tx.$queryRaw<Array<{ amount: string }>>`
      SELECT COALESCE(SUM(debit_amount - credit_amount), 0)::text AS amount
      FROM customer_ledger
      WHERE tenant_id = ${tenantId}::uuid
        AND business_date <= ${businessDate}::date
    `,
    tx.$queryRaw<Array<{ amount: string }>>`
      SELECT COALESCE(SUM(credit_amount - debit_amount), 0)::text AS amount
      FROM supplier_ledger
      WHERE tenant_id = ${tenantId}::uuid
        AND business_date <= ${businessDate}::date
    `,
  ]);
  return {
    customer: decimal(customers[0]?.amount),
    supplier: decimal(suppliers[0]?.amount),
  };
}

export function decimal(value: string | undefined): Prisma.Decimal {
  return new Prisma.Decimal(value ?? "0");
}
