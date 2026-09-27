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
  throw new Error("DATABASE_ADMIN_URL is required for sales return tests.");
}

let serial = 7700001000;
const phones: string[] = [];

describe("sales returns", () => {
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
  let otherLocationId = "";
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
    const created = await createShop(ownerToken, "[SRET] Shop A");
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
    const otherCreated = await createShop(other.token, "[SRET] Shop B");
    otherShop = otherCreated.shopContext;
    otherLocationId = await defaultLocation(otherCreated.id);

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

  it("returns sold goods at the original cost and adjusts the customer", async () => {
    const customerId = await createCustomer("Rahul");
    const productId = await createProduct("Soap", "100.00");
    await openStock(productId, "10", "80.00");
    const sold = await sell(customerId, productId, "5", [{ method: "CASH", amount: "500.00" }]);
    assert.equal(sold.status, 201, JSON.stringify(sold.body));
    assert.equal(sold.body.data.total, "500.00");
    await assertStock(productId, "5.000", "80.00");
    const before = await summaryFor(sold.body.data.businessDate as string);

    const returned = await authed(ownerToken, ownerShop)
      .post("/api/v1/sales/returns")
      .send({
        saleId: sold.body.data.id,
        reason: "Customer changed their mind",
        items: [{ saleItemId: sold.body.data.items[0].id, quantity: "2" }],
      });
    assert.equal(returned.status, 201, JSON.stringify(returned.body));
    assert.match(returned.body.data.returnNumber, /^SR-\d{5}$/);
    assert.equal(returned.body.data.total, "200.00");
    assert.equal(returned.body.data.refundAmount, "200.00");
    assert.equal(returned.body.data.receivableCredit, "0.00");
    assert.equal(returned.body.data.cogs, "160.00");
    assert.equal(returned.body.data.grossProfit, "40.00");
    assert.equal(returned.body.data.items[0].unitPrice, "100.00");
    assert.equal(returned.body.data.items[0].unitCost, "80.00");
    assert.equal(returned.body.data.items[0].costAmount, "160.00");
    assert.equal(returned.body.data.payments[0].method, "CASH");
    assert.equal(returned.body.data.payments[0].amount, "200.00");
    await assertStock(productId, "7.000", "80.00");

    const movement = await admin.query<{
      movement_type: string;
      quantity_delta: string;
      unit_cost: string;
      reference_type: string;
      reference_id: string;
      source_line_id: string;
    }>(
      `SELECT movement_type::text, quantity_delta::text, unit_cost::text,
              reference_type::text, reference_id::text, source_line_id::text
       FROM inventory_movements
       WHERE reference_id = $1::uuid`,
      [returned.body.data.id],
    );
    assert.equal(movement.rows.length, 1);
    assert.equal(movement.rows[0]?.movement_type, "SALE_RETURN");
    assert.equal(movement.rows[0]?.quantity_delta, "2.000");
    assert.equal(movement.rows[0]?.unit_cost, "80.00");
    assert.equal(movement.rows[0]?.reference_type, "SALE_RETURN");
    assert.equal(movement.rows[0]?.reference_id, returned.body.data.id);
    assert.equal(movement.rows[0]?.source_line_id, returned.body.data.items[0].id);

    const original = await authed(ownerToken, ownerShop).get(`/api/v1/sales/${sold.body.data.id}`);
    assert.equal(original.body.data.total, "500.00");
    assert.equal(original.body.data.items[0].quantity, "5.000");
    assert.equal(original.body.data.items[0].unitPrice, "100.00");
    assert.equal(original.body.data.items[0].returnedQuantity, "2.000");
    assert.equal(original.body.data.items[0].remainingQuantity, "3.000");

    const day = await summaryFor(returned.body.data.businessDate as string);
    assert.equal(Number(day.returns) - Number(before.returns), 200);
    assert.equal(Number(day.netSales) - Number(before.netSales), -200);
    assert.equal(Number(day.quantity) - Number(before.quantity), -2);
    assert.equal(Number(day.profit) - Number(before.profit), -40);
    assert.equal(day.transactions, before.transactions);

    const stockView = await authed(stockToken, stockShop).get(`/api/v1/sales/returns/${returned.body.data.id}`);
    assert.equal(stockView.status, 200, JSON.stringify(stockView.body));
    assert.equal("cogs" in stockView.body.data, false);
    assert.equal("unitCost" in stockView.body.data.items[0], false);

    const listed = await authed(ownerToken, ownerShop).get(
      `/api/v1/sales/returns?saleId=${sold.body.data.id}&customerId=${customerId}&returnNumber=${returned.body.data.returnNumber}`,
    );
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.data[0].id, returned.body.data.id);

    const creditProduct = await createProduct("Rice", "100.00");
    await openStock(creditProduct, "10", "40.00");
    const creditSale = await sell(customerId, creditProduct, "10", [{ method: "CASH", amount: "700.00" }]);
    assert.equal(creditSale.status, 201, JSON.stringify(creditSale.body));
    const creditReturn = await authed(ownerToken, ownerShop)
      .post("/api/v1/sales/returns")
      .send({
        saleId: creditSale.body.data.id,
        items: [{ saleItemId: creditSale.body.data.items[0].id, quantity: "2" }],
      });
    assert.equal(creditReturn.status, 201, JSON.stringify(creditReturn.body));
    assert.equal(creditReturn.body.data.total, "200.00");
    assert.equal(creditReturn.body.data.receivableCredit, "200.00");
    assert.equal(creditReturn.body.data.refundAmount, "0.00");
    assert.equal(creditReturn.body.data.payments.length, 0);
    const owed = await admin.query<{ receivable: string; credit: string }>(
      `SELECT c.receivable_balance::text AS receivable,
              (SELECT credit_amount::text FROM customer_ledger
               WHERE reference_id = $2::uuid AND entry_type = 'SALE_RETURN') AS credit
       FROM customers c WHERE c.id = $1::uuid`,
      [customerId, creditReturn.body.data.id],
    );
    assert.equal(owed.rows[0]?.receivable, "100.00");
    assert.equal(owed.rows[0]?.credit, "200.00");

    const walkProduct = await createProduct("Biscuit", "50.00");
    await openStock(walkProduct, "4", "10.00");
    const walk = await authed(cashierToken, cashierShop)
      .post("/api/v1/sales")
      .send({
        items: [{ productId: walkProduct, quantity: "2" }],
        payments: [{ method: "UPI", amount: "100.00" }],
      });
    assert.equal(walk.status, 201, JSON.stringify(walk.body));
    const walkReturn = await authed(stockToken, stockShop)
      .post("/api/v1/sales/returns")
      .send({
        saleId: walk.body.data.id,
        items: [{ saleItemId: walk.body.data.items[0].id, quantity: "1" }],
      });
    assert.equal(walkReturn.status, 201, JSON.stringify(walkReturn.body));
    assert.equal(walkReturn.body.data.customer, null);
    assert.equal(walkReturn.body.data.refundAmount, "50.00");
    const walkLedger = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM customer_ledger WHERE reference_id = $1::uuid`,
      [walkReturn.body.data.id],
    );
    assert.equal(walkLedger.rows[0]?.count, "0");

    const left = await createProduct("Left", "20.00");
    const right = await createProduct("Right", "30.00");
    await openStock(left, "4", "5.00");
    await openStock(right, "4", "6.00");
    const both = await authed(ownerToken, ownerShop)
      .post("/api/v1/sales")
      .send({
        customerId,
        items: [
          { productId: left, quantity: "2" },
          { productId: right, quantity: "2" },
        ],
        payments: [{ method: "CASH", amount: "100.00" }],
      });
    assert.equal(both.status, 201, JSON.stringify(both.body));
    const multi = await authed(ownerToken, ownerShop)
      .post("/api/v1/sales/returns")
      .send({
        saleId: both.body.data.id,
        items: [
          { saleItemId: both.body.data.items[0].id, quantity: "1" },
          { saleItemId: both.body.data.items[1].id, quantity: "1" },
        ],
      });
    assert.equal(multi.status, 201, JSON.stringify(multi.body));
    assert.equal(multi.body.data.items.length, 2);
    assert.equal(multi.body.data.total, "50.00");
  });

  it("rejects quantities, roles, and shops that cannot return the sale", async () => {
    const customerId = await createCustomer("Partial");
    const productId = await createProduct("Atta", "100.00");
    await openStock(productId, "10", "50.00");
    const sold = await sell(customerId, productId, "10", [{ method: "CASH", amount: "1000.00" }]);
    assert.equal(sold.status, 201, JSON.stringify(sold.body));
    const saleItemId = sold.body.data.items[0].id as string;

    const first = await returnSale(sold.body.data.id as string, saleItemId, "3");
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const second = await returnSale(sold.body.data.id as string, saleItemId, "4");
    assert.equal(second.status, 201, JSON.stringify(second.body));
    const third = await returnSale(sold.body.data.id as string, saleItemId, "4");
    assert.equal(third.status, 409);
    assert.equal(third.body.error.code, "RETURN_QUANTITY_EXCEEDS_REMAINING");
    const remaining = await authed(ownerToken, ownerShop).get(`/api/v1/sales/${sold.body.data.id}`);
    assert.equal(remaining.body.data.items[0].returnedQuantity, "7.000");
    assert.equal(remaining.body.data.items[0].remainingQuantity, "3.000");
    assert.equal(remaining.body.data.total, "1000.00");

    const fullProduct = await createProduct("Full", "100.00");
    await openStock(fullProduct, "5", "20.00");
    const fullSale = await sell(customerId, fullProduct, "5", [{ method: "CASH", amount: "500.00" }]);
    const fullItem = fullSale.body.data.items[0].id as string;
    const full = await returnSale(fullSale.body.data.id as string, fullItem, "5");
    assert.equal(full.status, 201, JSON.stringify(full.body));
    await assertStock(fullProduct, "5.000", "20.00");
    const again = await returnSale(fullSale.body.data.id as string, fullItem, "1");
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "RETURN_QUANTITY_EXCEEDS_REMAINING");

    const zero = await returnSale(sold.body.data.id as string, saleItemId, "0");
    assert.equal(zero.status, 400);
    assert.equal(zero.body.error.code, "VALIDATION_ERROR");
    const negative = await returnSale(sold.body.data.id as string, saleItemId, "-1");
    assert.equal(negative.status, 400);
    assert.equal(negative.body.error.code, "VALIDATION_ERROR");
    const duplicate = await authed(ownerToken, ownerShop)
      .post("/api/v1/sales/returns")
      .send({
        saleId: sold.body.data.id,
        items: [
          { saleItemId, quantity: "1" },
          { saleItemId, quantity: "1" },
        ],
      });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, "DUPLICATE_RETURN_LINE");

    const otherSale = await sell(customerId, productId, "1", [{ method: "CASH", amount: "100.00" }]);
    const mismatch = await authed(ownerToken, ownerShop)
      .post("/api/v1/sales/returns")
      .send({
        saleId: sold.body.data.id,
        items: [{ saleItemId: otherSale.body.data.items[0].id, quantity: "1" }],
      });
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.body.error.code, "RETURN_SOURCE_MISMATCH");

    const missing = await authed(ownerToken, ownerShop)
      .post("/api/v1/sales/returns")
      .send({ saleId: randomUUID(), items: [{ saleItemId, quantity: "1" }] });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, "RETURN_SOURCE_NOT_FOUND");

    const foreign = await authed(otherToken, otherShop)
      .post("/api/v1/sales/returns")
      .send({ saleId: sold.body.data.id, items: [{ saleItemId, quantity: "1" }] });
    assert.equal(foreign.status, 404);
    assert.equal(foreign.body.error.code, "RETURN_SOURCE_NOT_FOUND");
    const hidden = await authed(otherToken, otherShop).get(`/api/v1/sales/returns/${first.body.data.id}`);
    assert.equal(hidden.status, 404);

    const cashier = await authed(cashierToken, cashierShop)
      .post("/api/v1/sales/returns")
      .send({ saleId: sold.body.data.id, items: [{ saleItemId, quantity: "1" }] });
    assert.equal(cashier.status, 403);
    assert.equal(cashier.body.error.code, "RETURN_NOT_ALLOWED");

    const wrongLocation = await authed(ownerToken, ownerShop)
      .post("/api/v1/sales/returns")
      .send({
        saleId: sold.body.data.id,
        locationId: otherLocationId,
        items: [{ saleItemId, quantity: "1" }],
      });
    assert.equal(wrongLocation.status, 404);
    assert.equal(wrongLocation.body.error.code, "RETURN_LOCATION_INVALID");

    const inactiveProduct = await createProduct("Old soap", "10.00");
    await openStock(inactiveProduct, "2", "4.00");
    const inactiveSale = await sell(customerId, inactiveProduct, "1", [{ method: "CASH", amount: "10.00" }]);
    const off = await authed(ownerToken, ownerShop)
      .post(`/api/v1/catalog/products/${inactiveProduct}/deactivate`)
      .send({});
    assert.equal(off.status, 200);
    const blocked = await returnSale(
      inactiveSale.body.data.id as string,
      inactiveSale.body.data.items[0].id as string,
      "1",
    );
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, "PRODUCT_INACTIVE");
  });

  it("rolls the whole return back and does not duplicate an idempotent replay", async () => {
    const customerId = await createCustomer("Atomic");
    const alpha = await createProduct("Alpha", "10.00");
    const beta = await createProduct("Beta", "10.00");
    await openStock(alpha, "10", "4.00");
    await openStock(beta, "2", "4.00");
    const sold = await authed(ownerToken, ownerShop)
      .post("/api/v1/sales")
      .send({
        customerId,
        items: [
          { productId: alpha, quantity: "10" },
          { productId: beta, quantity: "2" },
        ],
        payments: [{ method: "CASH", amount: "120.00" }],
      });
    assert.equal(sold.status, 201, JSON.stringify(sold.body));
    const alphaItem = sold.body.data.items.find(
      (item: { product: { name: string } }) => item.product.name === "Alpha",
    ).id as string;
    const betaItem = sold.body.data.items.find(
      (item: { product: { name: string } }) => item.product.name === "Beta",
    ).id as string;
    const returnsBefore = await countReturns();
    const auditsBefore = await auditCount();
    const failed = await authed(ownerToken, ownerShop)
      .post("/api/v1/sales/returns")
      .send({
        saleId: sold.body.data.id,
        items: [
          { saleItemId: alphaItem, quantity: "3" },
          { saleItemId: betaItem, quantity: "3" },
        ],
      });
    assert.equal(failed.status, 409);
    assert.equal(failed.body.error.code, "RETURN_QUANTITY_EXCEEDS_REMAINING");
    assert.equal(await countReturns(), returnsBefore);
    assert.equal(await auditCount(), auditsBefore);
    await assertStock(alpha, "0.000", "4.00");
    await assertStock(beta, "0.000", "4.00");
    const movements = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_movements
       WHERE product_id = $1::uuid AND movement_type = 'SALE_RETURN'`,
      [alpha],
    );
    assert.equal(movements.rows[0]?.count, "0");

    const key = randomUUID();
    const body = {
      saleId: sold.body.data.id,
      items: [{ saleItemId: alphaItem, quantity: "2" }],
    };
    const first = await authed(ownerToken, ownerShop)
      .post("/api/v1/sales/returns")
      .set("Idempotency-Key", key)
      .send(body);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const replay = await authed(ownerToken, ownerShop)
      .post("/api/v1/sales/returns")
      .set("Idempotency-Key", key)
      .send(body);
    assert.equal(replay.status, 201, JSON.stringify(replay.body));
    assert.equal(replay.body.data.id, first.body.data.id);
    const copies = await admin.query<{ returns: string; movements: string; payments: string }>(
      `SELECT
         (SELECT count(*)::text FROM sale_returns WHERE id = $1::uuid) AS returns,
         (SELECT count(*)::text FROM inventory_movements WHERE reference_id = $1::uuid) AS movements,
         (SELECT count(*)::text FROM payments WHERE reference_id = $1::uuid) AS payments`,
      [first.body.data.id],
    );
    assert.equal(copies.rows[0]?.returns, "1");
    assert.equal(copies.rows[0]?.movements, "1");
    assert.equal(copies.rows[0]?.payments, "1");
    const conflict = await authed(ownerToken, ownerShop)
      .post("/api/v1/sales/returns")
      .set("Idempotency-Key", key)
      .send({ saleId: sold.body.data.id, items: [{ saleItemId: alphaItem, quantity: "1" }] });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, "IDEMPOTENCY_CONFLICT");

    const spec = await request(app.getHttpServer()).get("/api/docs-json");
    const paths = Object.keys(spec.body.paths as Record<string, unknown>);
    for (const path of ["/api/v1/sales/returns", "/api/v1/sales/returns/{returnId}"]) {
      assert.equal(paths.includes(path), true, path);
    }
  });

  it("lets only one of two concurrent returns exceed the sold quantity", async () => {
    const customerId = await createCustomer("Race");
    const productId = await createProduct("Race soap", "10.00");
    await openStock(productId, "10", "3.00");
    const sold = await sell(customerId, productId, "10", [{ method: "CASH", amount: "100.00" }]);
    assert.equal(sold.status, 201, JSON.stringify(sold.body));
    const saleItemId = sold.body.data.items[0].id as string;
    const [left, right] = await Promise.all([
      returnSale(sold.body.data.id as string, saleItemId, "6"),
      returnSale(sold.body.data.id as string, saleItemId, "6"),
    ]);
    const results = [left, right];
    const ok = results.filter((result) => result.status === 201);
    const denied = results.filter((result) => result.status === 409);
    assert.equal(ok.length, 1, JSON.stringify(results.map((result) => result.body)));
    assert.equal(denied.length, 1);
    assert.equal(denied[0]?.body.error.code, "RETURN_QUANTITY_EXCEEDS_REMAINING");
    const returned = await admin.query<{ quantity: string }>(
      `SELECT COALESCE(SUM(quantity), 0)::text AS quantity
       FROM sale_return_items WHERE original_sale_item_id = $1::uuid`,
      [saleItemId],
    );
    assert.equal(returned.rows[0]?.quantity, "6.000");
    await assertStock(productId, "6.000", "3.00");
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

  function sell(
    customerId: string,
    productId: string,
    quantity: string,
    payments: Array<{ method: string; amount: string }>,
  ) {
    return authed(ownerToken, ownerShop)
      .post("/api/v1/sales")
      .send({ customerId, items: [{ productId, quantity }], payments });
  }

  function returnSale(saleId: string, saleItemId: string, quantity: string) {
    return authed(ownerToken, ownerShop)
      .post("/api/v1/sales/returns")
      .send({ saleId, items: [{ saleItemId, quantity }] });
  }

  async function defaultLocation(tenantId: string): Promise<string> {
    const rows = await admin.query<{ id: string }>(
      `SELECT id FROM locations WHERE tenant_id = $1::uuid AND is_default = true`,
      [tenantId],
    );
    const id = rows.rows[0]?.id;
    assert.ok(id);
    return id;
  }

  async function assertStock(productId: string, quantity: string, averageCost: string): Promise<void> {
    const rows = await admin.query<{ quantity: string; average_cost: string }>(
      `SELECT quantity::text, average_cost::text FROM inventory_balances WHERE product_id = $1::uuid`,
      [productId],
    );
    assert.equal(rows.rows[0]?.quantity, quantity);
    assert.equal(rows.rows[0]?.average_cost, averageCost);
  }

  async function summaryFor(businessDate: string): Promise<{
    returns: string;
    netSales: string;
    quantity: string;
    profit: string;
    transactions: string;
  }> {
    const rows = await admin.query<{
      total_sales_returns: string;
      net_sales: string;
      products_sold: string;
      gross_profit: string;
      transaction_count: string;
    }>(
      `SELECT total_sales_returns::text, net_sales::text, products_sold::text,
              gross_profit::text, transaction_count::text
       FROM daily_summaries WHERE tenant_id = $1::uuid AND business_date = $2::date`,
      [shopId, businessDate],
    );
    return {
      returns: rows.rows[0]?.total_sales_returns ?? "0",
      netSales: rows.rows[0]?.net_sales ?? "0",
      quantity: rows.rows[0]?.products_sold ?? "0",
      profit: rows.rows[0]?.gross_profit ?? "0",
      transactions: rows.rows[0]?.transaction_count ?? "0",
    };
  }

  async function countReturns(): Promise<string> {
    const rows = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sale_returns WHERE tenant_id = $1::uuid`,
      [shopId],
    );
    return rows.rows[0]?.count ?? "0";
  }

  async function auditCount(): Promise<string> {
    const rows = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_logs
       WHERE tenant_id = $1::uuid AND action IN ('sale_return.created', 'sale_return.posted')`,
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
  const tenants = `(SELECT id FROM tenants WHERE name LIKE '[SRET]%')`;
  await admin.query("ALTER TABLE inventory_movements DISABLE TRIGGER inventory_movements_append_only");
  await admin.query("ALTER TABLE stock_adjustment_items DISABLE TRIGGER stock_adjustment_items_draft_only");
  await admin.query("ALTER TABLE stock_adjustments DISABLE TRIGGER stock_adjustments_no_delete");
  await admin.query("ALTER TABLE customer_ledger DISABLE TRIGGER customer_ledger_append_only");
  await admin.query("ALTER TABLE payments DISABLE TRIGGER payments_append_only");
  await admin.query("ALTER TABLE sale_return_items DISABLE TRIGGER sale_return_items_append_only");
  await admin.query("ALTER TABLE sale_returns DISABLE TRIGGER sale_returns_no_delete");
  await admin.query("ALTER TABLE sale_items DISABLE TRIGGER sale_items_append_only");
  await admin.query("ALTER TABLE sales DISABLE TRIGGER sales_no_delete");
  await admin.query("ALTER TABLE product_price_history DISABLE TRIGGER product_price_history_append_only");
  await admin.query("ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only");
  try {
    await admin.query(`DELETE FROM inventory_movements WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM inventory_balances WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM stock_adjustment_items WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM stock_adjustments WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM customer_ledger WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM payments WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM sale_return_items WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM sale_returns WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM sale_items WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM sales WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM daily_summaries WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM idempotency_keys WHERE tenant_id IN ${tenants}`);
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
    await admin.query("ALTER TABLE payments ENABLE TRIGGER payments_append_only");
    await admin.query("ALTER TABLE sale_return_items ENABLE TRIGGER sale_return_items_append_only");
    await admin.query("ALTER TABLE sale_returns ENABLE TRIGGER sale_returns_no_delete");
    await admin.query("ALTER TABLE sale_items ENABLE TRIGGER sale_items_append_only");
    await admin.query("ALTER TABLE sales ENABLE TRIGGER sales_no_delete");
    await admin.query("ALTER TABLE product_price_history ENABLE TRIGGER product_price_history_append_only");
    await admin.query("ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only");
  }
  await admin.query(`DELETE FROM products WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM units WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM customers WHERE tenant_id IN ${tenants}`);
  await admin.query(
    `DELETE FROM memberships
     WHERE tenant_id IN ${tenants}
        OR user_id IN (SELECT id FROM users WHERE phone = ANY($1::text[]))`,
    [numbers],
  );
  await admin.query(`UPDATE tenants SET default_location_id = NULL WHERE name LIKE '[SRET]%'`);
  await admin.query(`DELETE FROM locations WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM document_counters WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM expense_categories WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM tenants WHERE name LIKE '[SRET]%'`);
  await admin.query(
    `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE phone = ANY($1::text[]))`,
    [numbers],
  );
  await admin.query(`DELETE FROM otp_challenges WHERE phone = ANY($1::text[])`, [numbers]);
  await admin.query(`DELETE FROM users WHERE phone = ANY($1::text[])`, [numbers]);
}
