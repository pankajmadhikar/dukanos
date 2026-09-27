import "dotenv/config";
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, it } from "@jest/globals";
import { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Client } from "pg";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { CapturingOtpSender } from "../src/auth/capturing-otp-sender";
import { OTP_SENDER } from "../src/auth/otp-sender";
import { normalizeIndianPhone } from "../src/auth/phone";
import { configureApp } from "../src/configure-app";

jest.setTimeout(60_000);
process.env.PRISMA_CONNECTION_LIMIT = "2";
process.env.OTP_IP_LIMIT = "500";

const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) {
  throw new Error("DATABASE_ADMIN_URL is required for report tests.");
}

let serial = 8100001000;
const phones: string[] = [];

describe("reports and daily closing", () => {
  let app: INestApplication;
  let admin: Client;
  let sender: CapturingOtpSender;
  let ownerToken = "";
  let ownerShop = "";
  let shopId = "";
  let cashierToken = "";
  let cashierShop = "";
  let stockToken = "";
  let stockShop = "";
  let otherToken = "";
  let otherShop = "";
  let unitId = "";

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.init();
    sender = app.get<CapturingOtpSender>(OTP_SENDER);

    const owner = await login(nextNational());
    ownerToken = owner.token;
    const created = await createShop(ownerToken, "[RPT] Shop A");
    shopId = created.id;
    ownerShop = created.shopContext;

    const cashier = await login(nextNational());
    const stock = await login(nextNational());
    const other = await login(nextNational());
    await admin.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role)
       VALUES ($1, $2, $3, 'CASHIER'), ($4, $2, $5, 'STOCK_KEEPER')
       ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [randomUUID(), shopId, cashier.userId, randomUUID(), stock.userId],
    );
    cashierToken = cashier.token;
    cashierShop = await selectShop(cashier.token, shopId);
    stockToken = stock.token;
    stockShop = await selectShop(stock.token, shopId);
    otherToken = other.token;
    otherShop = (await createShop(other.token, "[RPT] Shop B")).shopContext;

    const unit = await authed(ownerToken, ownerShop)
      .post("/api/v1/catalog/units")
      .send({ name: "Piece", shortCode: "pcs", decimalPlaces: 0 });
    assert.equal(unit.status, 201, JSON.stringify(unit.body));
    unitId = unit.body.data.id as string;
  });

  afterAll(async () => {
    delete process.env.PRISMA_CONNECTION_LIMIT;
    try {
      if (admin) {
        await cleanup(admin, phones);
        await admin.end();
      }
    } finally {
      if (app) {
        await app.close();
      }
    }
  });

  it("returns zeros before the shop has transactions", async () => {
    const dashboard = await authed(ownerToken, ownerShop).get("/api/v1/dashboard/today");
    assert.equal(dashboard.status, 200, JSON.stringify(dashboard.body));
    assert.equal(dashboard.body.data.sales.grossSales, "0.00");
    assert.equal(dashboard.body.data.sales.netSales, "0.00");
    assert.equal(dashboard.body.data.sales.transactionCount, 0);
    assert.equal(dashboard.body.data.sales.quantitySold, "0.000");
    assert.equal(dashboard.body.data.profit.netProfit, "0.00");
    assert.equal(dashboard.body.data.profit.cogs, "0.00");
    assert.equal(dashboard.body.data.collections.cash, "0.00");
    assert.equal(dashboard.body.data.collections.upi, "0.00");
    assert.equal(dashboard.body.data.collections.customerCollections, "0.00");
    assert.equal(dashboard.body.data.payments.supplierPayments, "0.00");
    assert.equal(dashboard.body.data.outstanding.customer, "0.00");
    assert.equal(dashboard.body.data.outstanding.supplier, "0.00");

    const finance = await authed(ownerToken, ownerShop).get("/api/v1/reports/finance-summary?period=today");
    assert.equal(finance.body.data.sales.netSales, dashboard.body.data.sales.netSales);
    assert.equal(finance.body.data.profit.netProfit, dashboard.body.data.profit.netProfit);

    const compared = await authed(ownerToken, ownerShop).get("/api/v1/dashboard/comparison?period=today");
    assert.equal(compared.status, 200, JSON.stringify(compared.body));
    assert.equal(compared.body.data.current.sales.netSales, "0.00");
    assert.equal(compared.body.data.previous.sales.netSales, "0.00");
    assert.equal(compared.body.data.change.sales.netSales, "0.00");
    assert.equal(compared.body.data.changePercent.sales.netSales, "0.00");

    const sales = await authed(ownerToken, ownerShop).get("/api/v1/reports/sales?period=custom&from=1999-01-01&to=1999-01-02");
    assert.equal(sales.status, 200, JSON.stringify(sales.body));
    assert.equal(sales.body.data.netSales, "0.00");
    assert.equal(sales.body.data.averageBillValue, "0.00");
    assert.equal(sales.body.data.transactionCount, 0);

    const trend = await authed(ownerToken, ownerShop).get("/api/v1/reports/sales/daily?period=custom&from=1999-01-01&to=1999-01-02");
    assert.equal(trend.body.data.days.length, 2);
    assert.equal(trend.body.data.days[0].netSales, "0.00");

    const missing = await authed(ownerToken, ownerShop).get("/api/v1/daily-closing/1999-01-01");
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, "DAILY_CLOSING_NOT_FOUND");
  });

  it("reports sales, stock, and a frozen daily closing from the same totals", async () => {
    const category = await authed(ownerToken, ownerShop).post("/api/v1/catalog/categories").send({ name: "Empty shelf" });
    assert.equal(category.status, 201, JSON.stringify(category.body));
    const rice = await createProduct("Margin rice", "1000.00");
    const soap = await createProduct("Cash soap", "200.00");
    const oil = await createProduct("Upi oil", "100.00");
    const bulbs = await createProduct("Low bulbs", "30.00", { minimumStockLevel: "5" });
    const jars = await createProduct("Idle jars", "15.00");
    const atta = await createProduct("Supplier atta", "10.00");
    const missing = await createProduct("Missing tea", "12.00", { categoryId: category.body.data.id as string });

    const riceStock = await openStock(rice, "1", "400.00");
    await openStock(soap, "2", "50.00");
    await openStock(oil, "1", "20.00");
    await openStock(bulbs, "4", "25.00");
    await openStock(jars, "8", "10.00");

    const customerId = await createCustomer("Report Rahul");
    const creditSale = await authed(ownerToken, ownerShop)
      .post("/api/v1/sales")
      .send({ customerId, items: [{ productId: rice, quantity: "1" }] });
    assert.equal(creditSale.status, 201, JSON.stringify(creditSale.body));
    const cashSale = await authed(ownerToken, ownerShop)
      .post("/api/v1/sales")
      .send({ items: [{ productId: soap, quantity: "2" }], payments: [{ method: "CASH", amount: "400.00" }] });
    assert.equal(cashSale.status, 201, JSON.stringify(cashSale.body));
    const upiSale = await authed(ownerToken, ownerShop)
      .post("/api/v1/sales")
      .send({ items: [{ productId: oil, quantity: "1" }], payments: [{ method: "UPI", amount: "100.00" }] });
    assert.equal(upiSale.status, 201, JSON.stringify(upiSale.body));

    const categories = await authed(ownerToken, ownerShop).get("/api/v1/expenses/categories");
    const electricity = categories.body.data.find((row: { name: string }) => row.name === "Electricity").id as string;
    const expense = await authed(ownerToken, ownerShop)
      .post("/api/v1/expenses")
      .send({ categoryId: electricity, amount: "100.00", paymentMethod: "CASH", note: "Tube light" });
    assert.equal(expense.status, 201, JSON.stringify(expense.body));

    const receipt = await authed(ownerToken, ownerShop)
      .post(`/api/v1/customers/${customerId}/payments`)
      .send({ amount: "100.00", method: "UPI" });
    assert.equal(receipt.status, 201, JSON.stringify(receipt.body));

    const supplierId = await createSupplier("Report Mill");
    const purchased = await authed(ownerToken, ownerShop)
      .post("/api/v1/purchases")
      .send({ supplierId, items: [{ productId: atta, quantity: "10", unitCost: "50.00" }] });
    assert.equal(purchased.status, 201, JSON.stringify(purchased.body));
    const purchaseReturn = await authed(ownerToken, ownerShop).post("/api/v1/purchases/returns").send({
      purchaseId: purchased.body.data.id,
      items: [{ purchaseItemId: purchased.body.data.items[0].id, quantity: "2" }],
    });
    assert.equal(purchaseReturn.status, 201, JSON.stringify(purchaseReturn.body));
    const supplierPay = await authed(ownerToken, ownerShop)
      .post(`/api/v1/suppliers/${supplierId}/payments`)
      .send({ amount: "200.00", method: "CASH" });
    assert.equal(supplierPay.status, 201, JSON.stringify(supplierPay.body));

    const dashboard = await authed(ownerToken, ownerShop).get("/api/v1/dashboard/today");
    assert.equal(dashboard.status, 200, JSON.stringify(dashboard.body));
    const today = dashboard.body.data;
    assert.equal(today.sales.grossSales, "1500.00");
    assert.equal(today.sales.salesReturns, "0.00");
    assert.equal(today.sales.netSales, "1500.00");
    assert.equal(today.sales.transactionCount, 3);
    assert.equal(today.sales.quantitySold, "4.000");
    assert.equal(today.profit.cogs, "520.00");
    assert.equal(today.profit.grossProfit, "980.00");
    assert.equal(today.profit.expenses, "100.00");
    assert.equal(today.profit.netProfit, "880.00");
    assert.equal(today.collections.cash, "400.00");
    assert.equal(today.collections.upi, "100.00");
    assert.equal(today.collections.customerCollections, "100.00");
    assert.equal(today.payments.supplierPayments, "200.00");
    assert.equal(today.payments.cashExpenses, "100.00");
    assert.equal(today.payments.upiExpenses, "0.00");
    assert.equal(today.outstanding.customer, "900.00");
    assert.equal(today.outstanding.supplier, "200.00");

    const finance = await authed(ownerToken, ownerShop).get("/api/v1/reports/finance-summary?period=today");
    assert.equal(finance.body.data.sales.netSales, today.sales.netSales);
    assert.equal(finance.body.data.cost.cogs, today.profit.cogs);
    assert.equal(finance.body.data.profit.grossProfit, today.profit.grossProfit);
    assert.equal(finance.body.data.profit.netProfit, today.profit.netProfit);
    assert.equal(finance.body.data.collections.cashSalesCollections, today.collections.cash);
    assert.equal(finance.body.data.collections.upiSalesCollections, today.collections.upi);
    assert.equal(finance.body.data.collections.customerCollections, today.collections.customerCollections);
    assert.equal(finance.body.data.supplierPayments, today.payments.supplierPayments);

    const compared = await authed(ownerToken, ownerShop).get("/api/v1/dashboard/comparison?period=today");
    assert.equal(compared.body.data.previous.sales.netSales, "0.00");
    assert.equal(compared.body.data.change.sales.netSales, "1500.00");
    assert.equal(compared.body.data.changePercent.sales.netSales, null);
    const week = await authed(ownerToken, ownerShop).get("/api/v1/dashboard/comparison?period=week");
    assert.equal(week.status, 200, JSON.stringify(week.body));
    assert.equal(week.body.data.current.sales.netSales, "1500.00");
    assert.equal(week.body.data.previous.sales.netSales, "0.00");
    const month = await authed(ownerToken, ownerShop).get("/api/v1/dashboard/comparison?period=month");
    assert.equal(month.body.data.current.sales.netSales, "1500.00");
    assert.equal(month.body.data.previous.profit.netProfit, "0.00");

    const sales = await authed(ownerToken, ownerShop).get("/api/v1/reports/sales?period=today");
    assert.equal(sales.body.data.netSales, "1500.00");
    assert.equal(sales.body.data.averageBillValue, "500.00");
    assert.equal(sales.body.data.cashSales, "400.00");
    assert.equal(sales.body.data.upiSales, "100.00");
    assert.equal(sales.body.data.customerCreditSales, "1000.00");
    assert.equal(sales.body.data.customerCollections, "100.00");
    const trend = await authed(ownerToken, ownerShop).get("/api/v1/reports/sales/daily?period=today");
    assert.equal(trend.body.data.days.length, 1);
    assert.equal(trend.body.data.days[0].businessDate, today.businessDate);
    assert.equal(trend.body.data.days[0].netSales, "1500.00");

    const byQuantity = await authed(ownerToken, ownerShop).get("/api/v1/reports/products/top?period=today&sort=quantity&limit=10");
    assert.equal(byQuantity.status, 200, JSON.stringify(byQuantity.body));
    assert.equal(byQuantity.body.data[0].name, "Cash soap");
    assert.equal(byQuantity.body.data[0].quantitySold, "2.000");
    assert.equal(byQuantity.body.data[0].grossProfit, "300.00");
    const byRevenue = await authed(ownerToken, ownerShop).get("/api/v1/reports/products/top?period=today&sort=revenue");
    assert.equal(byRevenue.body.data[0].name, "Margin rice");
    assert.equal(byRevenue.body.data[0].salesRevenue, "1000.00");
    const byProfit = await authed(ownerToken, ownerShop).get("/api/v1/reports/products/top?period=today&sort=grossProfit");
    assert.equal(byProfit.body.data[0].name, "Margin rice");
    assert.equal(byProfit.body.data[0].cogs, "400.00");
    assert.equal(byProfit.body.data[0].grossProfit, "600.00");
    const hiddenProfit = await authed(cashierToken, cashierShop).get("/api/v1/reports/products/top?period=today&sort=quantity");
    assert.equal(hiddenProfit.status, 200, JSON.stringify(hiddenProfit.body));
    assert.equal("cogs" in hiddenProfit.body.data[0], false);
    assert.equal("grossProfit" in hiddenProfit.body.data[0], false);
    const deniedRank = await authed(cashierToken, cashierShop).get("/api/v1/reports/products/top?period=today&sort=grossProfit");
    assert.equal(deniedRank.status, 400);

    const customers = await authed(ownerToken, ownerShop).get("/api/v1/reports/customers?period=today");
    assert.equal(customers.status, 200, JSON.stringify(customers.body));
    assert.equal(customers.body.data.walkIn.transactionCount, 2);
    assert.equal(customers.body.data.walkIn.totalSales, "500.00");
    assert.equal(customers.body.data.walkIn.amountPaidAtSale, "500.00");
    assert.equal(customers.body.data.customers.length, 1);
    assert.equal(customers.body.data.customers[0].customer.name, "Report Rahul");
    assert.equal(customers.body.data.customers[0].netSales, "1000.00");
    assert.equal(customers.body.data.customers[0].amountPaidAtSale, "0.00");
    assert.equal(customers.body.data.customers[0].customerCollections, "100.00");
    assert.equal(customers.body.data.customers[0].outstandingBalance, "900.00");
    const owing = await authed(ownerToken, ownerShop).get("/api/v1/reports/customers/outstanding");
    assert.equal(owing.body.data[0].name, "Report Rahul");
    assert.equal(owing.body.data[0].outstandingBalance, "900.00");
    assert.equal(owing.body.data[0].paymentCount, 1);
    assert.equal(owing.body.data[0].latestPayment.amount, "100.00");

    const suppliers = await authed(ownerToken, ownerShop).get("/api/v1/reports/suppliers?period=today");
    assert.equal(suppliers.status, 200, JSON.stringify(suppliers.body));
    assert.equal(suppliers.body.data[0].purchaseTotal, "500.00");
    assert.equal(suppliers.body.data[0].purchaseReturns, "100.00");
    assert.equal(suppliers.body.data[0].supplierPayments, "200.00");
    assert.equal(suppliers.body.data[0].payableBalance, "200.00");
    const supplierOwing = await authed(ownerToken, ownerShop).get("/api/v1/reports/suppliers/outstanding");
    assert.equal(supplierOwing.body.data[0].outstandingBalance, "200.00");
    assert.equal(supplierOwing.body.data[0].paymentCount, 1);
    const cashierSuppliers = await authed(cashierToken, cashierShop).get("/api/v1/reports/suppliers?period=today");
    assert.equal(cashierSuppliers.status, 403);
    assert.equal(cashierSuppliers.body.error.code, "SUPPLIER_ACCESS_DENIED");

    const expenseReport = await authed(ownerToken, ownerShop).get("/api/v1/reports/expenses?period=today");
    assert.equal(expenseReport.status, 200, JSON.stringify(expenseReport.body));
    assert.equal(expenseReport.body.data.totalExpenses, "100.00");
    assert.equal(expenseReport.body.data.cashExpenses, "100.00");
    assert.equal(expenseReport.body.data.upiExpenses, "0.00");
    assert.equal(expenseReport.body.data.expenseCount, 1);
    assert.equal(expenseReport.body.data.byCategory[0].categoryName, "Electricity");
    assert.equal(expenseReport.body.data.byCategory[0].amount, "100.00");
    assert.equal(expenseReport.body.data.daily[0].amount, "100.00");
    const cashierExpenses = await authed(cashierToken, cashierShop).get("/api/v1/reports/expenses?period=today");
    assert.equal(cashierExpenses.status, 403);

    const stockSummary = await authed(ownerToken, ownerShop).get("/api/v1/reports/stock");
    assert.equal(stockSummary.status, 200, JSON.stringify(stockSummary.body));
    assert.equal(stockSummary.body.data.totalProducts, 7);
    assert.equal(stockSummary.body.data.productsWithStock, 3);
    assert.equal(stockSummary.body.data.outOfStockProducts, 4);
    assert.equal(stockSummary.body.data.lowStockProducts, 1);
    assert.equal(stockSummary.body.data.totalStockQuantity, "20.000");
    assert.equal(stockSummary.body.data.totalStockValue, "580.00");
    const cashierStock = await authed(cashierToken, cashierShop).get("/api/v1/reports/stock");
    assert.equal("totalStockValue" in cashierStock.body.data, false);
    const low = await authed(ownerToken, ownerShop).get("/api/v1/reports/stock/low");
    assert.equal(low.body.data.length, 1);
    assert.equal(low.body.data[0].name, "Low bulbs");
    assert.equal(low.body.data[0].quantity, "4.000");
    const outs = await authed(ownerToken, ownerShop).get(
      `/api/v1/reports/stock/out-of-stock?search=Missing&categoryId=${category.body.data.id}`,
    );
    assert.equal(outs.body.data.length, 1);
    assert.equal(outs.body.data[0].name, "Missing tea");
    assert.equal(outs.body.data[0].productId, missing);
    const inactive = await authed(ownerToken, ownerShop).get("/api/v1/reports/stock/inactive?daysWithoutSale=30");
    const inactiveNames = inactive.body.data.map((row: { name: string }) => row.name);
    assert.equal(inactiveNames.includes("Idle jars"), true);
    assert.equal(inactiveNames.includes("Margin rice"), false);
    assert.equal(inactive.body.daysWithoutSale, 30);

    const movements = await authed(ownerToken, ownerShop).get(
      `/api/v1/reports/inventory-movements?period=today&productId=${jars}&movementType=OPENING_STOCK`,
    );
    assert.equal(movements.status, 200, JSON.stringify(movements.body));
    assert.equal(movements.body.data.length, 1);
    assert.equal(movements.body.data[0].direction, "IN");
    assert.equal(movements.body.data[0].quantity, "8.000");
    assert.equal(movements.body.data[0].unitCost, "10.00");
    assert.equal(movements.body.data[0].referenceType, "STOCK_ADJUSTMENT");
    const cashierMoves = await authed(cashierToken, cashierShop).get(
      `/api/v1/reports/inventory-movements?period=today&productId=${jars}`,
    );
    assert.equal("unitCost" in cashierMoves.body.data[0], false);

    const cashierDash = await authed(cashierToken, cashierShop).get("/api/v1/dashboard/today");
    assert.equal(cashierDash.body.data.sales.netSales, "1500.00");
    assert.equal(cashierDash.body.data.collections.customerCollections, "100.00");
    assert.equal(cashierDash.body.data.outstanding.customer, "900.00");
    assert.equal("profit" in cashierDash.body.data, false);
    assert.equal("payments" in cashierDash.body.data, false);
    assert.equal("supplier" in cashierDash.body.data.outstanding, false);
    const stockDash = await authed(stockToken, stockShop).get("/api/v1/dashboard/today");
    assert.equal("profit" in stockDash.body.data, false);
    assert.equal("cogs" in stockDash.body.data, false);
    assert.equal(stockDash.body.data.expenses, "100.00");
    assert.equal(stockDash.body.data.payments.supplierPayments, "200.00");
    assert.equal(stockDash.body.data.outstanding.supplier, "200.00");

    const otherDash = await authed(otherToken, otherShop).get("/api/v1/dashboard/today");
    assert.equal(otherDash.body.data.sales.grossSales, "0.00");
    assert.equal(otherDash.body.data.outstanding.customer, "0.00");
    const leaked = await authed(otherToken, otherShop).get("/api/v1/reports/products?period=today&search=Idle");
    assert.equal(leaked.body.data.length, 0);

    const salesBefore = await countRows("sales");
    const paymentsBefore = await countRows("payments");
    const expensesBefore = await countRows("expenses");
    const movementsBefore = await countRows("inventory_movements");
    const closed = await authed(ownerToken, ownerShop).post("/api/v1/daily-closing").send({});
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(closed.body.data.businessDate, today.businessDate);
    assert.equal(closed.body.data.sales.netSales, "1500.00");
    assert.equal(closed.body.data.profit.netProfit, "880.00");
    assert.equal(closed.body.data.profit.cogs, "520.00");
    assert.equal(closed.body.data.collections.cashReceived, "500.00");
    assert.equal(closed.body.data.collections.customerCollections, "100.00");
    assert.equal(closed.body.data.supplierPayments, "200.00");
    assert.equal(closed.body.data.outstanding.customer, "900.00");
    assert.equal(closed.body.data.outstanding.supplier, "200.00");
    assert.equal(closed.body.data.sales.customerCreditSales, "1000.00");
    assert.equal(await countRows("sales"), salesBefore);
    assert.equal(await countRows("payments"), paymentsBefore);
    assert.equal(await countRows("expenses"), expensesBefore);
    assert.equal(await countRows("inventory_movements"), movementsBefore);
    assert.equal(await countAudit("daily_closing.created"), "1");

    const again = await authed(ownerToken, ownerShop).post("/api/v1/daily-closing").send({ businessDate: today.businessDate });
    assert.equal(again.body.data.id, closed.body.data.id);
    assert.equal(again.body.data.closedAt, closed.body.data.closedAt);
    assert.equal(await countAudit("daily_closing.created"), "1");

    const laterExpense = await authed(ownerToken, ownerShop)
      .post("/api/v1/expenses")
      .send({ categoryId: electricity, amount: "50.00", paymentMethod: "UPI" });
    assert.equal(laterExpense.status, 201, JSON.stringify(laterExpense.body));
    const afterExpense = await authed(ownerToken, ownerShop).get("/api/v1/dashboard/today");
    assert.equal(afterExpense.body.data.profit.expenses, "150.00");
    assert.equal(afterExpense.body.data.profit.netProfit, "830.00");
    const stillClosed = await authed(ownerToken, ownerShop).get(`/api/v1/daily-closing/${today.businessDate}`);
    assert.equal(stillClosed.body.data.profit.netProfit, "880.00");
    assert.equal(stillClosed.body.data.closedAt, closed.body.data.closedAt);

    const rebuilt = await authed(ownerToken, ownerShop).post(`/api/v1/daily-closing/${today.businessDate}/rebuild`).send({});
    assert.equal(rebuilt.status, 200, JSON.stringify(rebuilt.body));
    assert.equal(rebuilt.body.data.profit.netProfit, "830.00");
    assert.equal(rebuilt.body.data.profit.expenses, "150.00");
    assert.notEqual(rebuilt.body.data.closedAt, closed.body.data.closedAt);
    assert.equal(await countAudit("daily_closing.rebuilt"), "1");
    const history = await authed(ownerToken, ownerShop).get(`/api/v1/daily-closing?from=${today.businessDate}&to=${today.businessDate}`);
    assert.equal(history.body.data.length, 1);
    assert.equal(history.body.data[0].id, closed.body.data.id);

    const cashierClose = await authed(cashierToken, cashierShop).post("/api/v1/daily-closing").send({});
    assert.equal(cashierClose.status, 403);
    assert.equal(cashierClose.body.error.code, "DAILY_CLOSING_ACCESS_DENIED");
    const stockClose = await authed(stockToken, stockShop).post("/api/v1/daily-closing").send({});
    assert.equal(stockClose.status, 403);
    const cashierView = await authed(cashierToken, cashierShop).get(`/api/v1/daily-closing/${today.businessDate}`);
    assert.equal(cashierView.status, 200, JSON.stringify(cashierView.body));
    assert.equal("profit" in cashierView.body.data, false);
    assert.equal("supplierPayments" in cashierView.body.data, false);
    const stockView = await authed(stockToken, stockShop).get(`/api/v1/daily-closing/${today.businessDate}`);
    assert.equal("profit" in stockView.body.data, false);
    assert.equal(stockView.body.data.expenses, "150.00");
    assert.equal(stockView.body.data.supplierPayments, "200.00");

    const otherClose = await authed(otherToken, otherShop).get(`/api/v1/daily-closing/${today.businessDate}`);
    assert.equal(otherClose.status, 404);
    const future = await authed(ownerToken, ownerShop).post("/api/v1/daily-closing").send({ businessDate: "2099-01-01" });
    assert.equal(future.status, 400);

    const boundary = await authed(ownerToken, ownerShop)
      .post("/api/v1/sales")
      .send({ items: [{ productId: bulbs, quantity: "1" }], payments: [{ method: "CASH", amount: "30.00" }] });
    assert.equal(boundary.status, 201, JSON.stringify(boundary.body));
    await admin.query("ALTER TABLE sales DISABLE TRIGGER sales_protect_header");
    await admin.query("ALTER TABLE sales DISABLE TRIGGER sales_consistent");
    try {
      await admin.query(`UPDATE sales SET sale_date = '2026-09-23 23:59:00+05:30' WHERE id = $1::uuid`, [boundary.body.data.id]);
      const previousDay = await authed(ownerToken, ownerShop).get("/api/v1/reports/sales?period=custom&from=2026-09-23&to=2026-09-23");
      assert.equal(previousDay.body.data.grossSales, "30.00");
      const sameEvening = await authed(ownerToken, ownerShop).get(`/api/v1/reports/sales?period=custom&from=${today.businessDate}&to=${today.businessDate}`);
      assert.equal(sameEvening.body.data.grossSales, "1500.00");
      await admin.query(`UPDATE sales SET sale_date = '2026-09-24 00:01:00+05:30' WHERE id = $1::uuid`, [boundary.body.data.id]);
      const nextMorning = await authed(ownerToken, ownerShop).get("/api/v1/reports/sales?period=custom&from=2026-09-24&to=2026-09-24");
      assert.equal(nextMorning.body.data.grossSales, today.businessDate === "2026-09-24" ? "1530.00" : "30.00");
      const leftBehind = await authed(ownerToken, ownerShop).get("/api/v1/reports/sales?period=custom&from=2026-09-23&to=2026-09-23");
      assert.equal(leftBehind.body.data.grossSales, "0.00");
    } finally {
      await admin.query("ALTER TABLE sales ENABLE TRIGGER sales_consistent");
      await admin.query("ALTER TABLE sales ENABLE TRIGGER sales_protect_header");
    }

    assert.equal(riceStock.locationId.length > 0, true);
  });

  function authed(token: string, shopContext: string) {
    const http = request(app.getHttpServer());
    const headers = (method: "get" | "post" | "patch" | "delete") => (path: string) =>
      http[method](path).set("Authorization", `Bearer ${token}`).set("x-dukaan-shop", shopContext);
    return { get: headers("get"), post: headers("post"), patch: headers("patch"), delete: headers("delete") };
  }

  async function login(national: string): Promise<{ token: string; userId: string }> {
    const requested = await request(app.getHttpServer()).post("/api/v1/auth/request-otp").send({ phone: national });
    assert.equal(requested.status, 200, JSON.stringify(requested.body));
    const code = sender.latest(normalizeIndianPhone(national));
    assert.ok(code);
    const verified = await request(app.getHttpServer()).post("/api/v1/auth/verify-otp").send({ phone: national, code });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    return { token: verified.body.data.token as string, userId: verified.body.data.user.id as string };
  }

  async function createShop(token: string, name: string): Promise<{ id: string; shopContext: string }> {
    const response = await request(app.getHttpServer())
      .post("/api/v1/tenants")
      .set("Authorization", `Bearer ${token}`)
      .send({ name, businessType: "GROCERY" });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return { id: response.body.data.id as string, shopContext: response.body.data.shopContext as string };
  }

  async function selectShop(token: string, tenantId: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/tenants/${tenantId}/select`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.data.shopContext as string;
  }

  async function createCustomer(name: string): Promise<string> {
    const response = await authed(ownerToken, ownerShop).post("/api/v1/customers").send({ name, phone: "9876543210" });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.data.id as string;
  }

  async function createSupplier(name: string): Promise<string> {
    const response = await authed(ownerToken, ownerShop).post("/api/v1/suppliers").send({ name });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.data.id as string;
  }

  async function createProduct(
    name: string,
    sellingPrice: string,
    extra: { minimumStockLevel?: string; categoryId?: string } = {},
  ): Promise<string> {
    const response = await authed(ownerToken, ownerShop)
      .post("/api/v1/catalog/products")
      .send({ name, unitId, defaultSellingPrice: sellingPrice, ...extra });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.data.id as string;
  }

  async function openStock(productId: string, quantity: string, unitCost: string): Promise<{ locationId: string }> {
    const response = await authed(ownerToken, ownerShop)
      .post("/api/v1/inventory/opening")
      .send({ productId, quantity, unitCost });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return { locationId: response.body.data.locationId as string };
  }

  async function countRows(table: "sales" | "payments" | "expenses" | "inventory_movements"): Promise<string> {
    const rows = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE tenant_id = $1::uuid`,
      [shopId],
    );
    return rows.rows[0]?.count ?? "0";
  }

  async function countAudit(action: string): Promise<string> {
    const rows = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_logs WHERE tenant_id = $1::uuid AND action = $2`,
      [shopId, action],
    );
    return rows.rows[0]?.count ?? "0";
  }
});

function nextNational(): string {
  serial += 1;
  const national = String(serial);
  phones.push(normalizeIndianPhone(national));
  return national;
}

async function cleanup(admin: Client, numbers: string[]): Promise<void> {
  const tenants = `(SELECT id FROM tenants WHERE name LIKE '[RPT]%')`;
  await admin.query("ALTER TABLE inventory_movements DISABLE TRIGGER inventory_movements_append_only");
  await admin.query("ALTER TABLE stock_adjustment_items DISABLE TRIGGER stock_adjustment_items_draft_only");
  await admin.query("ALTER TABLE stock_adjustments DISABLE TRIGGER stock_adjustments_no_delete");
  await admin.query("ALTER TABLE customer_ledger DISABLE TRIGGER customer_ledger_append_only");
  await admin.query("ALTER TABLE supplier_ledger DISABLE TRIGGER supplier_ledger_append_only");
  await admin.query("ALTER TABLE payments DISABLE TRIGGER payments_append_only");
  await admin.query("ALTER TABLE sale_return_items DISABLE TRIGGER sale_return_items_append_only");
  await admin.query("ALTER TABLE sale_returns DISABLE TRIGGER sale_returns_no_delete");
  await admin.query("ALTER TABLE sale_items DISABLE TRIGGER sale_items_append_only");
  await admin.query("ALTER TABLE sales DISABLE TRIGGER sales_no_delete");
  await admin.query("ALTER TABLE purchase_return_items DISABLE TRIGGER purchase_return_items_append_only");
  await admin.query("ALTER TABLE purchase_returns DISABLE TRIGGER purchase_returns_no_delete");
  await admin.query("ALTER TABLE purchase_items DISABLE TRIGGER purchase_items_draft_only");
  await admin.query("ALTER TABLE purchases DISABLE TRIGGER purchases_no_delete");
  await admin.query("ALTER TABLE product_price_history DISABLE TRIGGER product_price_history_append_only");
  await admin.query("ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only");
  try {
    await admin.query(`DELETE FROM inventory_movements WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM inventory_balances WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM stock_adjustment_items WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM stock_adjustments WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM customer_ledger WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM supplier_ledger WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM expenses WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM payments WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM sale_return_items WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM sale_returns WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM sale_items WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM sales WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM purchase_return_items WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM purchase_returns WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM purchase_items WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM purchases WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM daily_summaries WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM idempotency_keys WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM customer_product_prices WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM product_price_history WHERE tenant_id IN ${tenants}`);
    await admin.query(
      `DELETE FROM audit_logs
       WHERE tenant_id IN ${tenants}
          OR actor_user_id IN (SELECT id FROM users WHERE phone = ANY($1::text[]))`,
      [numbers],
    );
  } finally {
    await admin.query("ALTER TABLE inventory_movements ENABLE TRIGGER inventory_movements_append_only");
    await admin.query("ALTER TABLE stock_adjustment_items ENABLE TRIGGER stock_adjustment_items_draft_only");
    await admin.query("ALTER TABLE stock_adjustments ENABLE TRIGGER stock_adjustments_no_delete");
    await admin.query("ALTER TABLE customer_ledger ENABLE TRIGGER customer_ledger_append_only");
    await admin.query("ALTER TABLE supplier_ledger ENABLE TRIGGER supplier_ledger_append_only");
    await admin.query("ALTER TABLE payments ENABLE TRIGGER payments_append_only");
    await admin.query("ALTER TABLE sale_return_items ENABLE TRIGGER sale_return_items_append_only");
    await admin.query("ALTER TABLE sale_returns ENABLE TRIGGER sale_returns_no_delete");
    await admin.query("ALTER TABLE sale_items ENABLE TRIGGER sale_items_append_only");
    await admin.query("ALTER TABLE sales ENABLE TRIGGER sales_no_delete");
    await admin.query("ALTER TABLE purchase_return_items ENABLE TRIGGER purchase_return_items_append_only");
    await admin.query("ALTER TABLE purchase_returns ENABLE TRIGGER purchase_returns_no_delete");
    await admin.query("ALTER TABLE purchase_items ENABLE TRIGGER purchase_items_draft_only");
    await admin.query("ALTER TABLE purchases ENABLE TRIGGER purchases_no_delete");
    await admin.query("ALTER TABLE product_price_history ENABLE TRIGGER product_price_history_append_only");
    await admin.query("ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only");
  }
  await admin.query(`DELETE FROM expense_categories WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM product_barcodes WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM products WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM categories WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM units WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM customers WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM suppliers WHERE tenant_id IN ${tenants}`);
  await admin.query(
    `DELETE FROM memberships
     WHERE tenant_id IN ${tenants}
        OR user_id IN (SELECT id FROM users WHERE phone = ANY($1::text[]))`,
    [numbers],
  );
  await admin.query(`UPDATE tenants SET default_location_id = NULL WHERE name LIKE '[RPT]%'`);
  await admin.query(`DELETE FROM locations WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM document_counters WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM tenants WHERE name LIKE '[RPT]%'`);
  await admin.query(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE phone = ANY($1::text[]))`, [numbers]);
  await admin.query(`DELETE FROM otp_challenges WHERE phone = ANY($1::text[])`, [numbers]);
  await admin.query(`DELETE FROM users WHERE phone = ANY($1::text[])`, [numbers]);
}
