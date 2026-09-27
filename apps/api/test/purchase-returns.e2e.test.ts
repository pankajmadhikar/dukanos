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
  throw new Error("DATABASE_ADMIN_URL is required for purchase return tests.");
}

let serial = 7800001000;
const phones: string[] = [];

describe("purchase returns", () => {
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
    const created = await createShop(ownerToken, "[PRET] Shop A");
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
    const otherCreated = await createShop(other.token, "[PRET] Shop B");
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

  it("returns purchased goods at the original cost and reduces the supplier payable", async () => {
    const supplierId = await createSupplier("Mill");
    const productId = await createProduct("Atta");
    const purchased = await buy(supplierId, productId, "10", "80.00");
    assert.equal(purchased.status, 201, JSON.stringify(purchased.body));
    assert.equal(purchased.body.data.total, "800.00");
    await assertStock(productId, "10.000", "80.00");

    const returned = await authed(stockToken, stockShop)
      .post("/api/v1/purchases/returns")
      .send({
        purchaseId: purchased.body.data.id,
        reason: "Damaged bags",
        items: [{ purchaseItemId: purchased.body.data.items[0].id, quantity: "3" }],
      });
    assert.equal(returned.status, 201, JSON.stringify(returned.body));
    assert.match(returned.body.data.returnNumber, /^PR-\d{5}$/);
    assert.equal(returned.body.data.total, "240.00");
    assert.equal(returned.body.data.payableDebit, "240.00");
    assert.equal(returned.body.data.refundAmount, "0.00");
    assert.equal(returned.body.data.items[0].unitCost, "80.00");
    assert.equal(returned.body.data.items[0].lineTotal, "240.00");
    assert.equal(returned.body.data.payments.length, 0);
    await assertStock(productId, "7.000", "80.00");

    const movement = await admin.query<{
      movement_type: string;
      quantity_delta: string;
      unit_cost: string;
      reference_type: string;
      source_line_id: string;
    }>(
      `SELECT movement_type::text, quantity_delta::text, unit_cost::text,
              reference_type::text, source_line_id::text
       FROM inventory_movements WHERE reference_id = $1::uuid`,
      [returned.body.data.id],
    );
    assert.equal(movement.rows.length, 1);
    assert.equal(movement.rows[0]?.movement_type, "PURCHASE_RETURN");
    assert.equal(movement.rows[0]?.quantity_delta, "-3.000");
    assert.equal(movement.rows[0]?.unit_cost, "80.00");
    assert.equal(movement.rows[0]?.reference_type, "PURCHASE_RETURN");
    assert.equal(movement.rows[0]?.source_line_id, returned.body.data.items[0].id);

    const payable = await admin.query<{ payable: string; debit: string }>(
      `SELECT s.payable_balance::text AS payable,
              (SELECT debit_amount::text FROM supplier_ledger
               WHERE reference_id = $2::uuid AND entry_type = 'PURCHASE_RETURN') AS debit
       FROM suppliers s WHERE s.id = $1::uuid`,
      [supplierId, returned.body.data.id],
    );
    assert.equal(payable.rows[0]?.payable, "560.00");
    assert.equal(payable.rows[0]?.debit, "240.00");

    const original = await authed(ownerToken, ownerShop).get(`/api/v1/purchases/${purchased.body.data.id}`);
    assert.equal(original.body.data.total, "800.00");
    assert.equal(original.body.data.items[0].quantity, "10.000");
    assert.equal(original.body.data.items[0].unitCost, "80.00");
    assert.equal(original.body.data.items[0].returnedQuantity, "3.000");
    assert.equal(original.body.data.items[0].remainingQuantity, "7.000");

    const listed = await authed(ownerToken, ownerShop).get(
      `/api/v1/purchases/returns?purchaseId=${purchased.body.data.id}&supplierId=${supplierId}&returnNumber=${returned.body.data.returnNumber}`,
    );
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.data[0].id, returned.body.data.id);

    const mixed = await createProduct("Mixed");
    await openStock(mixed, "10", "50.00");
    const mixedBuy = await buy(supplierId, mixed, "10", "80.00");
    assert.equal(mixedBuy.status, 201, JSON.stringify(mixedBuy.body));
    await assertStock(mixed, "20.000", "65.00");
    const mixedReturn = await authed(ownerToken, ownerShop)
      .post("/api/v1/purchases/returns")
      .send({
        purchaseId: mixedBuy.body.data.id,
        items: [{ purchaseItemId: mixedBuy.body.data.items[0].id, quantity: "3" }],
      });
    assert.equal(mixedReturn.status, 201, JSON.stringify(mixedReturn.body));
    assert.equal(mixedReturn.body.data.items[0].unitCost, "80.00");
    await assertStock(mixed, "17.000", "65.00");

    const left = await createProduct("Left bag");
    const right = await createProduct("Right bag");
    const both = await authed(ownerToken, ownerShop)
      .post("/api/v1/purchases")
      .send({
        supplierId,
        items: [
          { productId: left, quantity: "4", unitCost: "10.00" },
          { productId: right, quantity: "4", unitCost: "15.00" },
        ],
      });
    assert.equal(both.status, 201, JSON.stringify(both.body));
    const multi = await authed(ownerToken, ownerShop)
      .post("/api/v1/purchases/returns")
      .send({
        purchaseId: both.body.data.id,
        items: [
          { purchaseItemId: both.body.data.items[0].id, quantity: "1" },
          { purchaseItemId: both.body.data.items[1].id, quantity: "2" },
        ],
      });
    assert.equal(multi.status, 201, JSON.stringify(multi.body));
    assert.equal(multi.body.data.total, "40.00");
    assert.equal(multi.body.data.items.length, 2);

    const purchasesInSummary = await admin.query<{ total: string }>(
      `SELECT COALESCE(SUM(total_purchase), 0)::text AS total
       FROM daily_summaries WHERE tenant_id = $1::uuid`,
      [shopId],
    );
    assert.equal(Number(purchasesInSummary.rows[0]?.total), 0);
  });

  it("rejects quantities, roles, and shops that cannot return the purchase", async () => {
    const supplierId = await createSupplier("Partial mill");
    const productId = await createProduct("Oil");
    const purchased = await buy(supplierId, productId, "10", "20.00");
    const itemId = purchased.body.data.items[0].id as string;
    const first = await returnPurchase(purchased.body.data.id as string, itemId, "3");
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const second = await returnPurchase(purchased.body.data.id as string, itemId, "4");
    assert.equal(second.status, 201, JSON.stringify(second.body));
    const third = await returnPurchase(purchased.body.data.id as string, itemId, "4");
    assert.equal(third.status, 409);
    assert.equal(third.body.error.code, "RETURN_QUANTITY_EXCEEDS_REMAINING");
    const detail = await authed(ownerToken, ownerShop).get(`/api/v1/purchases/${purchased.body.data.id}`);
    assert.equal(detail.body.data.items[0].returnedQuantity, "7.000");
    assert.equal(detail.body.data.items[0].remainingQuantity, "3.000");
    assert.equal(detail.body.data.total, "200.00");

    const fullProduct = await createProduct("Full tin");
    const fullBuy = await buy(supplierId, fullProduct, "5", "10.00");
    const fullItem = fullBuy.body.data.items[0].id as string;
    const full = await returnPurchase(fullBuy.body.data.id as string, fullItem, "5");
    assert.equal(full.status, 201, JSON.stringify(full.body));
    await assertStock(fullProduct, "0.000", "10.00");
    const again = await returnPurchase(fullBuy.body.data.id as string, fullItem, "1");
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "RETURN_QUANTITY_EXCEEDS_REMAINING");

    const zero = await returnPurchase(purchased.body.data.id as string, itemId, "0");
    assert.equal(zero.status, 400);
    assert.equal(zero.body.error.code, "VALIDATION_ERROR");
    const negative = await returnPurchase(purchased.body.data.id as string, itemId, "-1");
    assert.equal(negative.status, 400);
    const duplicate = await authed(ownerToken, ownerShop)
      .post("/api/v1/purchases/returns")
      .send({
        purchaseId: purchased.body.data.id,
        items: [
          { purchaseItemId: itemId, quantity: "1" },
          { purchaseItemId: itemId, quantity: "1" },
        ],
      });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, "DUPLICATE_RETURN_LINE");

    const otherBuy = await buy(supplierId, productId, "1", "20.00");
    const mismatch = await authed(ownerToken, ownerShop)
      .post("/api/v1/purchases/returns")
      .send({
        purchaseId: purchased.body.data.id,
        items: [{ purchaseItemId: otherBuy.body.data.items[0].id, quantity: "1" }],
      });
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.body.error.code, "RETURN_SOURCE_MISMATCH");

    const missing = await authed(ownerToken, ownerShop)
      .post("/api/v1/purchases/returns")
      .send({ purchaseId: randomUUID(), items: [{ purchaseItemId: itemId, quantity: "1" }] });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, "RETURN_SOURCE_NOT_FOUND");
    const foreign = await authed(otherToken, otherShop)
      .post("/api/v1/purchases/returns")
      .send({ purchaseId: purchased.body.data.id, items: [{ purchaseItemId: itemId, quantity: "1" }] });
    assert.equal(foreign.status, 404);
    const hidden = await authed(otherToken, otherShop).get(`/api/v1/purchases/returns/${first.body.data.id}`);
    assert.equal(hidden.status, 404);

    const cashier = await authed(cashierToken, cashierShop)
      .post("/api/v1/purchases/returns")
      .send({ purchaseId: purchased.body.data.id, items: [{ purchaseItemId: itemId, quantity: "1" }] });
    assert.equal(cashier.status, 403);
    assert.equal(cashier.body.error.code, "RETURN_NOT_ALLOWED");
    const wrongLocation = await authed(ownerToken, ownerShop)
      .post("/api/v1/purchases/returns")
      .send({
        purchaseId: purchased.body.data.id,
        locationId: otherLocationId,
        items: [{ purchaseItemId: itemId, quantity: "1" }],
      });
    assert.equal(wrongLocation.status, 404);
    assert.equal(wrongLocation.body.error.code, "RETURN_LOCATION_INVALID");

    const inactive = await createProduct("Closed");
    const inactiveBuy = await buy(supplierId, inactive, "2", "5.00");
    const off = await authed(ownerToken, ownerShop)
      .post(`/api/v1/catalog/products/${inactive}/deactivate`)
      .send({});
    assert.equal(off.status, 200);
    const blocked = await returnPurchase(
      inactiveBuy.body.data.id as string,
      inactiveBuy.body.data.items[0].id as string,
      "1",
    );
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, "PRODUCT_INACTIVE");
  });

  it("rolls the whole return back and does not duplicate an idempotent replay", async () => {
    const supplierId = await createSupplier("Atomic mill");
    const productId = await createProduct("Short stock");
    const purchased = await buy(supplierId, productId, "10", "8.00");
    assert.equal(purchased.status, 201, JSON.stringify(purchased.body));
    const sold = await authed(cashierToken, cashierShop)
      .post("/api/v1/sales")
      .send({
        items: [{ productId, quantity: "8" }],
        payments: [{ method: "CASH", amount: "80.00" }],
      });
    assert.equal(sold.status, 201, JSON.stringify(sold.body));
    await assertStock(productId, "2.000", "8.00");
    const returnsBefore = await countReturns();
    const auditsBefore = await auditCount();
    const failed = await returnPurchase(
      purchased.body.data.id as string,
      purchased.body.data.items[0].id as string,
      "5",
    );
    assert.equal(failed.status, 409);
    assert.equal(failed.body.error.code, "INSUFFICIENT_STOCK");
    assert.equal(await countReturns(), returnsBefore);
    assert.equal(await auditCount(), auditsBefore);
    await assertStock(productId, "2.000", "8.00");
    const ledger = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM supplier_ledger
       WHERE supplier_id = $1::uuid AND entry_type = 'PURCHASE_RETURN'`,
      [supplierId],
    );
    assert.equal(ledger.rows[0]?.count, "0");

    const key = randomUUID();
    const body = {
      purchaseId: purchased.body.data.id,
      items: [{ purchaseItemId: purchased.body.data.items[0].id, quantity: "2" }],
    };
    const first = await authed(ownerToken, ownerShop)
      .post("/api/v1/purchases/returns")
      .set("Idempotency-Key", key)
      .send(body);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const replay = await authed(ownerToken, ownerShop)
      .post("/api/v1/purchases/returns")
      .set("Idempotency-Key", key)
      .send(body);
    assert.equal(replay.status, 201);
    assert.equal(replay.body.data.id, first.body.data.id);
    const copies = await admin.query<{ returns: string; movements: string; ledger: string }>(
      `SELECT
         (SELECT count(*)::text FROM purchase_returns WHERE id = $1::uuid) AS returns,
         (SELECT count(*)::text FROM inventory_movements WHERE reference_id = $1::uuid) AS movements,
         (SELECT count(*)::text FROM supplier_ledger WHERE reference_id = $1::uuid) AS ledger`,
      [first.body.data.id],
    );
    assert.equal(copies.rows[0]?.returns, "1");
    assert.equal(copies.rows[0]?.movements, "1");
    assert.equal(copies.rows[0]?.ledger, "1");
    const conflict = await authed(ownerToken, ownerShop)
      .post("/api/v1/purchases/returns")
      .set("Idempotency-Key", key)
      .send({
        purchaseId: purchased.body.data.id,
        items: [{ purchaseItemId: purchased.body.data.items[0].id, quantity: "1" }],
      });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, "IDEMPOTENCY_CONFLICT");

    const spec = await request(app.getHttpServer()).get("/api/docs-json");
    const paths = Object.keys(spec.body.paths as Record<string, unknown>);
    for (const path of ["/api/v1/purchases/returns", "/api/v1/purchases/returns/{returnId}"]) {
      assert.equal(paths.includes(path), true, path);
    }
  });

  it("lets only one of two concurrent returns exceed the purchased quantity", async () => {
    const supplierId = await createSupplier("Race mill");
    const productId = await createProduct("Race oil");
    const purchased = await buy(supplierId, productId, "10", "6.00");
    const itemId = purchased.body.data.items[0].id as string;
    const [left, right] = await Promise.all([
      returnPurchase(purchased.body.data.id as string, itemId, "6"),
      returnPurchase(purchased.body.data.id as string, itemId, "6"),
    ]);
    const results = [left, right];
    const ok = results.filter((result) => result.status === 201);
    const denied = results.filter((result) => result.status === 409);
    assert.equal(ok.length, 1, JSON.stringify(results.map((result) => result.body)));
    assert.equal(denied.length, 1);
    assert.equal(denied[0]?.body.error.code, "RETURN_QUANTITY_EXCEEDS_REMAINING");
    const returned = await admin.query<{ quantity: string }>(
      `SELECT COALESCE(SUM(quantity), 0)::text AS quantity
       FROM purchase_return_items WHERE original_purchase_item_id = $1::uuid`,
      [itemId],
    );
    assert.equal(returned.rows[0]?.quantity, "6.000");
    await assertStock(productId, "4.000", "6.00");
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

  async function createSupplier(name: string): Promise<string> {
    const response = await authed(ownerToken, ownerShop).post("/api/v1/suppliers").send({ name });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.data.id as string;
  }

  async function createProduct(name: string): Promise<string> {
    const response = await authed(ownerToken, ownerShop)
      .post("/api/v1/catalog/products")
      .send({ name, unitId, defaultSellingPrice: "10.00" });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.data.id as string;
  }

  async function openStock(productId: string, quantity: string, unitCost: string): Promise<void> {
    const response = await authed(ownerToken, ownerShop)
      .post("/api/v1/inventory/opening")
      .send({ productId, quantity, unitCost });
    assert.equal(response.status, 201, JSON.stringify(response.body));
  }

  function buy(supplierId: string, productId: string, quantity: string, unitCost: string) {
    return authed(ownerToken, ownerShop)
      .post("/api/v1/purchases")
      .send({ supplierId, items: [{ productId, quantity, unitCost }] });
  }

  function returnPurchase(purchaseId: string, purchaseItemId: string, quantity: string) {
    return authed(ownerToken, ownerShop)
      .post("/api/v1/purchases/returns")
      .send({ purchaseId, items: [{ purchaseItemId, quantity }] });
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

  async function countReturns(): Promise<string> {
    const rows = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM purchase_returns WHERE tenant_id = $1::uuid`,
      [shopId],
    );
    return rows.rows[0]?.count ?? "0";
  }

  async function auditCount(): Promise<string> {
    const rows = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_logs
       WHERE tenant_id = $1::uuid AND action IN ('purchase_return.created', 'purchase_return.posted')`,
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
  const tenants = `(SELECT id FROM tenants WHERE name LIKE '[PRET]%')`;
  await admin.query("ALTER TABLE inventory_movements DISABLE TRIGGER inventory_movements_append_only");
  await admin.query("ALTER TABLE stock_adjustment_items DISABLE TRIGGER stock_adjustment_items_draft_only");
  await admin.query("ALTER TABLE stock_adjustments DISABLE TRIGGER stock_adjustments_no_delete");
  await admin.query("ALTER TABLE supplier_ledger DISABLE TRIGGER supplier_ledger_append_only");
  await admin.query("ALTER TABLE customer_ledger DISABLE TRIGGER customer_ledger_append_only");
  await admin.query("ALTER TABLE payments DISABLE TRIGGER payments_append_only");
  await admin.query("ALTER TABLE purchase_return_items DISABLE TRIGGER purchase_return_items_append_only");
  await admin.query("ALTER TABLE purchase_returns DISABLE TRIGGER purchase_returns_no_delete");
  await admin.query("ALTER TABLE purchase_items DISABLE TRIGGER purchase_items_draft_only");
  await admin.query("ALTER TABLE purchases DISABLE TRIGGER purchases_no_delete");
  await admin.query("ALTER TABLE sale_items DISABLE TRIGGER sale_items_append_only");
  await admin.query("ALTER TABLE sales DISABLE TRIGGER sales_no_delete");
  await admin.query("ALTER TABLE product_price_history DISABLE TRIGGER product_price_history_append_only");
  await admin.query("ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only");
  try {
    await admin.query(`DELETE FROM inventory_movements WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM inventory_balances WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM stock_adjustment_items WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM stock_adjustments WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM supplier_ledger WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM customer_ledger WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM payments WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM purchase_return_items WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM purchase_returns WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM purchase_items WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM purchases WHERE tenant_id IN ${tenants}`);
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
    await admin.query("ALTER TABLE supplier_ledger ENABLE TRIGGER supplier_ledger_append_only");
    await admin.query("ALTER TABLE customer_ledger ENABLE TRIGGER customer_ledger_append_only");
    await admin.query("ALTER TABLE payments ENABLE TRIGGER payments_append_only");
    await admin.query("ALTER TABLE purchase_return_items ENABLE TRIGGER purchase_return_items_append_only");
    await admin.query("ALTER TABLE purchase_returns ENABLE TRIGGER purchase_returns_no_delete");
    await admin.query("ALTER TABLE purchase_items ENABLE TRIGGER purchase_items_draft_only");
    await admin.query("ALTER TABLE purchases ENABLE TRIGGER purchases_no_delete");
    await admin.query("ALTER TABLE sale_items ENABLE TRIGGER sale_items_append_only");
    await admin.query("ALTER TABLE sales ENABLE TRIGGER sales_no_delete");
    await admin.query("ALTER TABLE product_price_history ENABLE TRIGGER product_price_history_append_only");
    await admin.query("ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only");
  }
  await admin.query(`DELETE FROM products WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM units WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM suppliers WHERE tenant_id IN ${tenants}`);
  await admin.query(
    `DELETE FROM memberships
     WHERE tenant_id IN ${tenants}
        OR user_id IN (SELECT id FROM users WHERE phone = ANY($1::text[]))`,
    [numbers],
  );
  await admin.query(`UPDATE tenants SET default_location_id = NULL WHERE name LIKE '[PRET]%'`);
  await admin.query(`DELETE FROM locations WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM document_counters WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM expense_categories WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM tenants WHERE name LIKE '[PRET]%'`);
  await admin.query(
    `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE phone = ANY($1::text[]))`,
    [numbers],
  );
  await admin.query(`DELETE FROM otp_challenges WHERE phone = ANY($1::text[])`, [numbers]);
  await admin.query(`DELETE FROM users WHERE phone = ANY($1::text[])`, [numbers]);
}
