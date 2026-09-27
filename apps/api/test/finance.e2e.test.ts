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
  throw new Error("DATABASE_ADMIN_URL is required for finance tests.");
}

let serial = 8000001000;
const phones: string[] = [];

describe("finance", () => {
  let app: INestApplication;
  let admin: Client;
  let sender: CapturingOtpSender;
  let ownerToken = "";
  let ownerShop = "";
  let ownerUserId = "";
  let shopId = "";
  let cashierToken = "";
  let cashierShop = "";
  let stockToken = "";
  let stockShop = "";
  let adminToken = "";
  let adminShop = "";
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
    ownerUserId = owner.userId;
    const created = await createShop(ownerToken, "[FIN] Shop A");
    shopId = created.id;
    ownerShop = created.shopContext;

    const cashier = await login(nextNational());
    const stock = await login(nextNational());
    const manager = await login(nextNational());
    const other = await login(nextNational());
    await admin.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role)
       VALUES ($1, $2, $3, 'CASHIER'), ($4, $2, $5, 'STOCK_KEEPER'), ($6, $2, $7, 'ADMIN')
       ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [randomUUID(), shopId, cashier.userId, randomUUID(), stock.userId, randomUUID(), manager.userId],
    );
    cashierToken = cashier.token;
    cashierShop = await selectShop(cashier.token, shopId);
    stockToken = stock.token;
    stockShop = await selectShop(stock.token, shopId);
    adminToken = manager.token;
    adminShop = await selectShop(manager.token, shopId);
    otherToken = other.token;
    const otherCreated = await createShop(other.token, "[FIN] Shop B");
    otherShop = otherCreated.shopContext;

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

  it("keeps net profit at sales minus returns, cost, and expenses", async () => {
    const empty = await finance("custom", "1999-01-01", "1999-01-02");
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.equal(empty.body.data.sales.grossSales, "0.00");
    assert.equal(empty.body.data.sales.netSales, "0.00");
    assert.equal(empty.body.data.sales.transactionCount, 0);
    assert.equal(empty.body.data.profit.netProfit, "0.00");
    assert.equal(empty.body.data.outstanding.customerOutstanding, "0.00");
    assert.equal(empty.body.data.outstanding.supplierOutstanding, "0.00");

    const categories = await authed(ownerToken, ownerShop).get("/api/v1/expenses/categories");
    assert.equal(categories.status, 200, JSON.stringify(categories.body));
    const names = categories.body.data.map((row: { name: string }) => row.name);
    for (const name of ["Rent", "Electricity", "Salary", "Transport", "Internet", "Maintenance", "Packaging", "Other"]) {
      assert.equal(names.includes(name), true, name);
    }
    const electricity = categories.body.data.find((row: { name: string }) => row.name === "Electricity").id as string;

    const priced = await createProduct("Margin rice", "9000.00");
    const returnedGoods = await createProduct("Zero margin bag", "1000.00");
    const bought = await createProduct("Supplier atta", "10.00");
    await openStock(priced, "1", "5000.00");
    await openStock(returnedGoods, "1", "1000.00");
    const customerId = await createCustomer("Finance Rahul");
    const sold = await authed(ownerToken, ownerShop)
      .post("/api/v1/sales")
      .send({
        customerId,
        items: [
          { productId: priced, quantity: "1" },
          { productId: returnedGoods, quantity: "1" },
        ],
      });
    assert.equal(sold.status, 201, JSON.stringify(sold.body));
    assert.equal(sold.body.data.total, "10000.00");
    assert.equal(sold.body.data.outstanding, "10000.00");
    const returnLine = sold.body.data.items.find(
      (item: { product: { id: string } }) => item.product.id === returnedGoods,
    );
    const returned = await authed(ownerToken, ownerShop)
      .post("/api/v1/sales/returns")
      .send({ saleId: sold.body.data.id, items: [{ saleItemId: returnLine.id, quantity: "1" }] });
    assert.equal(returned.status, 201, JSON.stringify(returned.body));
    assert.equal(returned.body.data.total, "1000.00");

    const movementsBefore = await countRows("inventory_movements");
    const expense = await payExpense(ownerToken, ownerShop, {
      categoryId: electricity,
      amount: "1500.00",
      paymentMethod: "CASH",
      note: "Shop electricity",
    });
    assert.equal(expense.status, 201, JSON.stringify(expense.body));
    assert.equal(expense.body.data.amount, "1500.00");
    assert.equal(expense.body.data.paymentMethod, "CASH");
    assert.equal(expense.body.data.note, "Shop electricity");
    assert.equal(expense.body.data.category.name, "Electricity");
    assert.equal(expense.body.data.createdBy.id, ownerUserId);
    assert.equal(await countRows("inventory_movements"), movementsBefore);

    const supplierId = await createSupplier("Finance Mill");
    const purchased = await authed(ownerToken, ownerShop)
      .post("/api/v1/purchases")
      .send({ supplierId, items: [{ productId: bought, quantity: "10", unitCost: "500.00" }] });
    assert.equal(purchased.status, 201, JSON.stringify(purchased.body));
    assert.equal(purchased.body.data.total, "5000.00");
    const purchaseReturn = await authed(ownerToken, ownerShop)
      .post("/api/v1/purchases/returns")
      .send({
        purchaseId: purchased.body.data.id,
        items: [{ purchaseItemId: purchased.body.data.items[0].id, quantity: "2" }],
      });
    assert.equal(purchaseReturn.status, 201, JSON.stringify(purchaseReturn.body));
    assert.equal(purchaseReturn.body.data.total, "1000.00");
    const supplierPay = await authed(ownerToken, ownerShop)
      .post(`/api/v1/suppliers/${supplierId}/payments`)
      .send({ amount: "3000.00", method: "CASH" });
    assert.equal(supplierPay.status, 201, JSON.stringify(supplierPay.body));
    const customerPay = await authed(ownerToken, ownerShop)
      .post(`/api/v1/customers/${customerId}/payments`)
      .send({ amount: "2000.00", method: "UPI", reference: "UTR-OLD" });
    assert.equal(customerPay.status, 201, JSON.stringify(customerPay.body));

    const report = await finance("today");
    assert.equal(report.status, 200, JSON.stringify(report.body));
    assert.equal(report.body.data.sales.grossSales, "10000.00");
    assert.equal(report.body.data.sales.salesReturns, "1000.00");
    assert.equal(report.body.data.sales.netSales, "9000.00");
    assert.equal(report.body.data.sales.transactionCount, 1);
    assert.equal(report.body.data.sales.quantitySold, "1.000");
    assert.equal(report.body.data.cost.cogs, "5000.00");
    assert.equal(report.body.data.cost.purchases, "5000.00");
    assert.equal(report.body.data.cost.purchaseReturns, "1000.00");
    assert.equal(report.body.data.profit.grossProfit, "4000.00");
    assert.equal(report.body.data.profit.expenses, "1500.00");
    assert.equal(report.body.data.profit.netProfit, "2500.00");
    assert.equal(report.body.data.collections.cashSalesCollections, "0.00");
    assert.equal(report.body.data.collections.upiSalesCollections, "0.00");
    assert.equal(report.body.data.collections.customerCollections, "2000.00");
    assert.equal(report.body.data.supplierPayments, "3000.00");
    assert.equal(report.body.data.outstanding.customerOutstanding, "7000.00");
    assert.equal(report.body.data.outstanding.supplierOutstanding, "1000.00");

    const month = await finance("month");
    assert.equal(month.body.data.profit.netProfit, "2500.00");
    const year = await finance("year");
    assert.equal(year.body.data.profit.netProfit, "2500.00");
    const week = await finance("week");
    assert.equal(week.body.data.sales.netSales, "9000.00");

    const cashierReport = await authed(cashierToken, cashierShop).get("/api/v1/reports/finance-summary?period=today");
    assert.equal(cashierReport.status, 200, JSON.stringify(cashierReport.body));
    assert.equal(cashierReport.body.data.sales.netSales, "9000.00");
    assert.equal(cashierReport.body.data.collections.customerCollections, "2000.00");
    assert.equal(cashierReport.body.data.outstanding.customerOutstanding, "7000.00");
    assert.equal("profit" in cashierReport.body.data, false);
    assert.equal("cost" in cashierReport.body.data, false);
    assert.equal("supplierPayments" in cashierReport.body.data, false);
    assert.equal("supplierOutstanding" in cashierReport.body.data.outstanding, false);
    const cashierExpenses = await authed(cashierToken, cashierShop).get("/api/v1/expenses");
    assert.equal(cashierExpenses.status, 403);
    assert.equal(cashierExpenses.body.error.code, "EXPENSE_ACCESS_DENIED");

    const stockReport = await authed(stockToken, stockShop).get("/api/v1/reports/finance-summary?period=today");
    assert.equal(stockReport.status, 200, JSON.stringify(stockReport.body));
    assert.equal(stockReport.body.data.expenses, "1500.00");
    assert.equal(stockReport.body.data.cost.purchases, "5000.00");
    assert.equal("cogs" in stockReport.body.data.cost, false);
    assert.equal("profit" in stockReport.body.data, false);
    assert.equal(stockReport.body.data.outstanding.supplierOutstanding, "1000.00");

    const cache = await admin.query<{ expenses: string; net_profit: string; gross_profit: string }>(
      `SELECT COALESCE(SUM(total_expenses), 0)::text AS expenses,
              COALESCE(SUM(net_profit), 0)::text AS net_profit,
              COALESCE(SUM(gross_profit), 0)::text AS gross_profit
       FROM daily_summaries WHERE tenant_id = $1::uuid`,
      [shopId],
    );
    assert.equal(Number(cache.rows[0]?.expenses).toFixed(2), "1500.00");
    assert.equal(Number(cache.rows[0]?.gross_profit).toFixed(2), "4000.00");
    assert.equal(Number(cache.rows[0]?.net_profit).toFixed(2), "2500.00");

    const cashGoods = await createProduct("Cash soap", "100.00");
    await openStock(cashGoods, "2", "40.00");
    const cashSale = await authed(ownerToken, ownerShop)
      .post("/api/v1/sales")
      .send({ items: [{ productId: cashGoods, quantity: "1" }], payments: [{ method: "CASH", amount: "100.00" }] });
    assert.equal(cashSale.status, 201, JSON.stringify(cashSale.body));
    const upiSale = await authed(ownerToken, ownerShop)
      .post("/api/v1/sales")
      .send({ items: [{ productId: cashGoods, quantity: "1" }], payments: [{ method: "UPI", amount: "100.00" }] });
    assert.equal(upiSale.status, 201, JSON.stringify(upiSale.body));
    const afterTender = await finance("today");
    assert.equal(afterTender.body.data.collections.cashSalesCollections, "100.00");
    assert.equal(afterTender.body.data.collections.upiSalesCollections, "100.00");
    assert.equal(afterTender.body.data.collections.customerCollections, "2000.00");
    assert.equal(afterTender.body.data.profit.netProfit, "2620.00");
    assert.equal(afterTender.body.data.profit.expenses, "1500.00");
  });

  it("records shop expenses without a second copy on retry", async () => {
    const categories = await authed(adminToken, adminShop).get("/api/v1/expenses/categories");
    const transport = categories.body.data.find((row: { name: string }) => row.name === "Transport").id as string;
    const internet = categories.body.data.find((row: { name: string }) => row.name === "Internet").id as string;
    const duplicate = await authed(ownerToken, ownerShop).post("/api/v1/expenses/categories").send({ name: " rent " });
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.equal(duplicate.body.error.code, "CONFLICT");
    const created = await authed(ownerToken, ownerShop)
      .post("/api/v1/expenses/categories")
      .send({ name: "  Packaging supplies  " });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.name, "Packaging supplies");
    assert.equal(created.body.data.isSystem, false);
    const renamed = await authed(ownerToken, ownerShop)
      .patch(`/api/v1/expenses/categories/${created.body.data.id}`)
      .send({ name: "Packing" });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    const deactivated = await authed(ownerToken, ownerShop)
      .post(`/api/v1/expenses/categories/${internet}/deactivate`)
      .send({});
    assert.equal(deactivated.status, 200, JSON.stringify(deactivated.body));
    assert.equal(deactivated.body.data.isActive, false);

    const blocked = await payExpense(
      ownerToken,
      ownerShop,
      { categoryId: internet, amount: "80.00", paymentMethod: "CASH" },
      "exp-rollback",
    );
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(blocked.body.error.code, "EXPENSE_CATEGORY_INACTIVE");
    const before = await expenseCount();
    const recorded = await payExpense(
      ownerToken,
      ownerShop,
      {
        categoryId: transport,
        amount: "250.00",
        expenseDate: "2026-01-15",
        paymentMethod: "UPI",
        reference: "UTR-BUS",
        note: "Bus to market",
      },
      "exp-rollback",
    );
    assert.equal(recorded.status, 201, JSON.stringify(recorded.body));
    assert.equal(recorded.body.data.businessDate, "2026-01-15");
    assert.equal(recorded.body.data.reference, "UTR-BUS");
    assert.equal(recorded.body.data.paymentMethod, "UPI");
    const replay = await payExpense(
      adminToken,
      adminShop,
      {
        categoryId: transport,
        amount: "250.00",
        expenseDate: "2026-01-15",
        paymentMethod: "UPI",
        reference: "UTR-BUS",
        note: "Bus to market",
      },
      "exp-rollback",
    );
    assert.equal(replay.status, 201, JSON.stringify(replay.body));
    assert.equal(replay.body.data.id, recorded.body.data.id);
    assert.equal(await expenseCount(), String(Number(before) + 1));
    const conflict = await payExpense(
      ownerToken,
      ownerShop,
      { categoryId: transport, amount: "10.00", paymentMethod: "CASH", expenseDate: "2026-01-15" },
      "exp-rollback",
    );
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, "IDEMPOTENCY_CONFLICT");

    const packing = await payExpense(ownerToken, ownerShop, {
      categoryId: renamed.body.data.id,
      amount: "40.00",
      expenseDate: "2026-01-15",
      paymentMethod: "CASH",
      note: "Bags",
    });
    assert.equal(packing.status, 201, JSON.stringify(packing.body));
    const detail = await authed(stockToken, stockShop).get(`/api/v1/expenses/${recorded.body.data.id}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.data.amount, "250.00");
    assert.equal(detail.body.data.category.name, "Transport");
    const history = await authed(stockToken, stockShop).get(
      "/api/v1/expenses?from=2026-01-15&to=2026-01-15&paymentMethod=UPI&search=UTR-BUS",
    );
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.equal(history.body.data.length, 1);
    assert.equal(history.body.data[0].id, recorded.body.data.id);
    const nextDay = await authed(ownerToken, ownerShop).get("/api/v1/expenses/summary?period=custom&from=2026-01-16&to=2026-01-16");
    assert.equal(nextDay.body.data.totalExpenses, "0.00");
    assert.equal(nextDay.body.data.expenseCount, 0);
    const thatDay = await authed(ownerToken, ownerShop).get("/api/v1/expenses/summary?period=custom&from=2026-01-15&to=2026-01-15");
    assert.equal(thatDay.body.data.totalExpenses, "290.00");
    assert.equal(thatDay.body.data.cashExpenses, "40.00");
    assert.equal(thatDay.body.data.upiExpenses, "250.00");
    assert.equal(thatDay.body.data.expenseCount, 2);
    assert.deepEqual(
      thatDay.body.data.byCategory.map((row: { categoryName: string; amount: string }) => ({
        categoryName: row.categoryName,
        amount: row.amount,
      })),
      [
        { categoryName: "Packing", amount: "40.00" },
        { categoryName: "Transport", amount: "250.00" },
      ],
    );
    const backwards = await authed(ownerToken, ownerShop).get("/api/v1/expenses/summary?period=custom&from=2026-02-02&to=2026-02-01");
    assert.equal(backwards.status, 400);
    assert.equal(backwards.body.error.code, "VALIDATION_ERROR");

    const stored = await admin.query<{ business_date: string; reference_type: string }>(
      `SELECT e.business_date::text, p.reference_type::text
       FROM expenses e
       JOIN payments p ON p.id = e.payment_id
       WHERE e.id = $1::uuid`,
      [recorded.body.data.id],
    );
    assert.equal(stored.rows[0]?.business_date, "2026-01-15");
    assert.equal(stored.rows[0]?.reference_type, "EXPENSE");

    const cashierCreate = await payExpense(cashierToken, cashierShop, {
      categoryId: transport,
      amount: "10.00",
      paymentMethod: "CASH",
    });
    assert.equal(cashierCreate.status, 403);
    const stockCreate = await payExpense(stockToken, stockShop, {
      categoryId: transport,
      amount: "10.00",
      paymentMethod: "CASH",
    });
    assert.equal(stockCreate.status, 403);
    const otherGet = await authed(otherToken, otherShop).get(`/api/v1/expenses/${recorded.body.data.id}`);
    assert.equal(otherGet.status, 404);
    assert.equal(otherGet.body.error.code, "EXPENSE_NOT_FOUND");
    const otherCategory = await payExpense(otherToken, otherShop, {
      categoryId: transport,
      amount: "10.00",
      paymentMethod: "CASH",
    });
    assert.equal(otherCategory.status, 404);
    assert.equal(otherCategory.body.error.code, "EXPENSE_CATEGORY_NOT_FOUND");
    const card = await payExpense(ownerToken, ownerShop, { categoryId: transport, amount: "10.00", paymentMethod: "CARD" });
    assert.equal(card.status, 400);
    const zero = await payExpense(ownerToken, ownerShop, { categoryId: transport, amount: "0.00", paymentMethod: "CASH" });
    assert.equal(zero.status, 400);
    const badDate = await payExpense(ownerToken, ownerShop, {
      categoryId: transport,
      amount: "10.00",
      paymentMethod: "CASH",
      expenseDate: "2026-02-31",
    });
    assert.equal(badDate.status, 400);
    const immutable = await authed(ownerToken, ownerShop)
      .patch(`/api/v1/expenses/${recorded.body.data.id}`)
      .send({ amount: "1.00" });
    assert.equal(immutable.status, 404);
  });

  function authed(token: string, shopContext: string) {
    const http = request(app.getHttpServer());
    const headers = (method: "get" | "post" | "patch" | "delete") => (path: string) =>
      http[method](path).set("Authorization", `Bearer ${token}`).set("x-dukaan-shop", shopContext);
    return { get: headers("get"), post: headers("post"), patch: headers("patch"), delete: headers("delete") };
  }

  function finance(period: string, from?: string, to?: string) {
    const params = new URLSearchParams({ period });
    if (from) {
      params.set("from", from);
    }
    if (to) {
      params.set("to", to);
    }
    return authed(ownerToken, ownerShop).get(`/api/v1/reports/finance-summary?${params.toString()}`);
  }

  function payExpense(token: string, shopContext: string, body: Record<string, unknown>, key?: string) {
    const call = authed(token, shopContext).post("/api/v1/expenses");
    if (key) {
      call.set("Idempotency-Key", key);
    }
    return call.send(body);
  }

  async function login(national: string): Promise<{ token: string; userId: string }> {
    const requested = await request(app.getHttpServer()).post("/api/v1/auth/request-otp").send({ phone: national });
    assert.equal(requested.status, 200, JSON.stringify(requested.body));
    const code = sender.latest(normalizeIndianPhone(national));
    assert.ok(code);
    const verified = await request(app.getHttpServer())
      .post("/api/v1/auth/verify-otp")
      .send({ phone: national, code });
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
    const response = await authed(ownerToken, ownerShop).post("/api/v1/customers").send({ name });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.data.id as string;
  }

  async function createSupplier(name: string): Promise<string> {
    const response = await authed(ownerToken, ownerShop).post("/api/v1/suppliers").send({ name });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.data.id as string;
  }

  async function createProduct(name: string, sellingPrice: string): Promise<string> {
    const response = await authed(ownerToken, ownerShop)
      .post("/api/v1/catalog/products")
      .send({ name, unitId, defaultSellingPrice: sellingPrice });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.data.id as string;
  }

  async function openStock(productId: string, quantity: string, unitCost: string): Promise<void> {
    const response = await authed(ownerToken, ownerShop)
      .post("/api/v1/inventory/opening")
      .send({ productId, quantity, unitCost });
    assert.equal(response.status, 201, JSON.stringify(response.body));
  }

  async function countRows(table: "inventory_movements"): Promise<string> {
    const rows = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE tenant_id = $1::uuid`,
      [shopId],
    );
    return rows.rows[0]?.count ?? "0";
  }

  async function expenseCount(): Promise<string> {
    const rows = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM expenses WHERE tenant_id = $1::uuid`,
      [shopId],
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
  const tenants = `(SELECT id FROM tenants WHERE name LIKE '[FIN]%')`;
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
  await admin.query(`DELETE FROM units WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM customers WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM suppliers WHERE tenant_id IN ${tenants}`);
  await admin.query(
    `DELETE FROM memberships
     WHERE tenant_id IN ${tenants}
        OR user_id IN (SELECT id FROM users WHERE phone = ANY($1::text[]))`,
    [numbers],
  );
  await admin.query(`UPDATE tenants SET default_location_id = NULL WHERE name LIKE '[FIN]%'`);
  await admin.query(`DELETE FROM locations WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM document_counters WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM tenants WHERE name LIKE '[FIN]%'`);
  await admin.query(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE phone = ANY($1::text[]))`, [numbers]);
  await admin.query(`DELETE FROM otp_challenges WHERE phone = ANY($1::text[])`, [numbers]);
  await admin.query(`DELETE FROM users WHERE phone = ANY($1::text[])`, [numbers]);
}
