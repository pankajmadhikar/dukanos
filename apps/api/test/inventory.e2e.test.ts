import "dotenv/config";
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, it } from "@jest/globals";
import { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Prisma } from "@prisma/client";
import { Client } from "pg";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { CapturingOtpSender } from "../src/auth/capturing-otp-sender";
import { OTP_SENDER } from "../src/auth/otp-sender";
import { normalizeIndianPhone } from "../src/auth/phone";
import { configureApp } from "../src/configure-app";
import { TenantTransactionService } from "../src/database/tenant-transaction.service";

jest.setTimeout(60_000);
process.env.PRISMA_CONNECTION_LIMIT = "2";
process.env.OTP_IP_LIMIT = "500";

const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) {
  throw new Error("DATABASE_ADMIN_URL is required for inventory tests.");
}

let serial = 7400001000;
const phones: string[] = [];

describe("inventory", () => {
  let app: INestApplication;
  let admin: Client;
  let sender: CapturingOtpSender;
  let transactions: TenantTransactionService;
  let ownerToken = "";
  let ownerShop = "";
  let ownerId = "";
  let shopId = "";
  let locationId = "";
  let cashierToken = "";
  let cashierShop = "";
  let stockToken = "";
  let stockShop = "";
  let otherToken = "";
  let otherShop = "";
  let otherShopId = "";
  let otherLocationId = "";
  let unitId = "";

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.init();
    sender = app.get<CapturingOtpSender>(OTP_SENDER);
    transactions = app.get(TenantTransactionService);

    const owner = await login(nextNational());
    ownerToken = owner.token;
    ownerId = owner.userId;
    const created = await createShop(ownerToken, "[INV] Shop A");
    shopId = created.id;
    ownerShop = created.shopContext;
    locationId = await defaultLocation(shopId);

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
    const otherCreated = await createShop(other.token, "[INV] Shop B");
    otherShopId = otherCreated.id;
    otherShop = otherCreated.shopContext;
    otherLocationId = await defaultLocation(otherShopId);

    const unit = await authed(ownerToken, ownerShop)
      .post("/api/v1/catalog/units")
      .send({ name: "Piece", shortCode: "pcs", decimalPlaces: 0 });
    assert.equal(unit.status, 201, JSON.stringify(unit.body));
    unitId = unit.body.data.id as string;
  });

  afterAll(async () => {
    delete process.env.PRISMA_CONNECTION_LIMIT;
    if (admin) {
      await cleanup(admin, phones);
      await admin.end();
    }
    if (app) {
      await app.close();
    }
  });

  it("records opening stock and rejects a second opening", async () => {
    const productId = await createProduct("Rice", { defaultSellingPrice: "70.00" });
    const before = await authed(ownerToken, ownerShop).get(`/api/v1/inventory/products/${productId}`);
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.equal(before.body.data.locations[0].quantity, "0.000");
    assert.equal(before.body.data.locations[0].location.name.length > 0, true);

    const opened = await authed(ownerToken, ownerShop)
      .post("/api/v1/inventory/opening")
      .send({ productId, quantity: "10.000", unitCost: "80.00" });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    assert.equal(opened.body.data.movementType, "OPENING_STOCK");
    assert.equal(opened.body.data.quantityAfter, "10.000");
    assert.equal(opened.body.data.averageCostAfter, "80.00");
    assert.equal(opened.body.data.locationId, locationId);

    const again = await authed(ownerToken, ownerShop)
      .post("/api/v1/inventory/opening")
      .send({ productId, quantity: "1.000", unitCost: "80.00" });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "OPENING_STOCK_EXISTS");

    const zeroProduct = await createProduct("Zero bag");
    const zero = await authed(ownerToken, ownerShop)
      .post("/api/v1/inventory/opening")
      .send({ productId: zeroProduct, quantity: "0", unitCost: "1.00" });
    assert.equal(zero.status, 400);
    const negativeProduct = await createProduct("Negative bag");
    const negative = await authed(ownerToken, ownerShop)
      .post("/api/v1/inventory/opening")
      .send({ productId: negativeProduct, quantity: "-5", unitCost: "1.00" });
    assert.equal(negative.status, 400);

    const missing = await authed(ownerToken, ownerShop)
      .post("/api/v1/inventory/opening")
      .send({ productId: randomUUID(), quantity: "1.000", unitCost: "1.00" });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, "PRODUCT_NOT_FOUND");

    const foreignProduct = await createProduct("Foreign location");
    const foreignLocation = await authed(ownerToken, ownerShop)
      .post("/api/v1/inventory/opening")
      .send({
        productId: foreignProduct,
        locationId: otherLocationId,
        quantity: "1.000",
        unitCost: "1.00",
      });
    assert.equal(foreignLocation.status, 404);

    const inactiveId = await createProduct("Sleeping stock");
    await authed(ownerToken, ownerShop)
      .post(`/api/v1/catalog/products/${inactiveId}/deactivate`)
      .send({});
    const inactive = await authed(ownerToken, ownerShop)
      .post("/api/v1/inventory/opening")
      .send({ productId: inactiveId, quantity: "1.000", unitCost: "1.00" });
    assert.equal(inactive.status, 409);
    assert.equal(inactive.body.error.code, "PRODUCT_INACTIVE");
  });

  it("recalculates weighted average and keeps it on outbound stock", async () => {
    const productId = await createProduct("Sugar", { minimumStockLevel: "4.000", defaultSellingPrice: "12.00" });
    const first = await authed(stockToken, stockShop)
      .post("/api/v1/inventory/opening")
      .send({ locationId, productId, quantity: "10.000", unitCost: "100.00" });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.data.averageCostAfter, "100.00");

    const second = await authed(stockToken, stockShop)
      .post("/api/v1/inventory/adjustments")
      .send({
        locationId,
        productId,
        type: "IN",
        quantity: "10.000",
        unitCost: "120.00",
        reason: "Found stock",
      });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.equal(second.body.data.quantityAfter, "20.000");
    assert.equal(second.body.data.averageCostAfter, "110.00");
    assert.equal(second.body.data.movementType, "ADJUSTMENT");

    const outbound = await authed(ownerToken, ownerShop)
      .post("/api/v1/inventory/adjustments")
      .send({ locationId, productId, type: "OUT", quantity: "5.000", reason: "Physical count mismatch" });
    assert.equal(outbound.status, 201, JSON.stringify(outbound.body));
    assert.equal(outbound.body.data.quantityAfter, "15.000");
    assert.equal(outbound.body.data.averageCostAfter, "110.00");

    const third = await authed(ownerToken, ownerShop)
      .post("/api/v1/inventory/adjustments")
      .send({ locationId, productId, type: "IN", quantity: "5.000", unitCost: "130.00" });
    assert.equal(third.status, 201, JSON.stringify(third.body));
    assert.equal(third.body.data.quantityAfter, "20.000");
    assert.equal(third.body.data.averageCostAfter, "115.00");

    await assertBalance(productId, "20.000", "115.00");
  });

  it("rounds an uneven average to the money scale and records damage and expiry", async () => {
    const productId = await createProduct("Oil");
    const opened = await authed(ownerToken, ownerShop)
      .post("/api/v1/inventory/opening")
      .send({ productId, quantity: "100.000", unitCost: "50.00" });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));

    const added = await authed(ownerToken, ownerShop)
      .post("/api/v1/inventory/adjustments")
      .send({ productId, type: "IN", quantity: "20.000", unitCost: "55.00", reason: "Opening correction" });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body.data.quantityAfter, "120.000");
    assert.equal(added.body.data.averageCostAfter, "50.83");

    const damage = await authed(ownerToken, ownerShop)
      .post("/api/v1/inventory/adjustments")
      .send({ productId, type: "DAMAGE", quantity: "10.000", reason: "Damaged" });
    assert.equal(damage.status, 201, JSON.stringify(damage.body));
    assert.equal(damage.body.data.movementType, "DAMAGE");
    assert.equal(damage.body.data.quantityAfter, "110.000");
    assert.equal(damage.body.data.averageCostAfter, "50.83");

    const expiry = await authed(ownerToken, ownerShop)
      .post("/api/v1/inventory/adjustments")
      .send({ productId, type: "EXPIRY", quantity: "20.000", reason: "Expired" });
    assert.equal(expiry.status, 201, JSON.stringify(expiry.body));
    assert.equal(expiry.body.data.movementType, "EXPIRY");
    assert.equal(expiry.body.data.quantityAfter, "90.000");
    assert.equal(expiry.body.data.averageCostAfter, "50.83");

    const short = await authed(ownerToken, ownerShop)
      .post("/api/v1/inventory/adjustments")
      .send({ productId, type: "OUT", quantity: "91.000", reason: "Too many" });
    assert.equal(short.status, 409);
    assert.equal(short.body.error.code, "INSUFFICIENT_STOCK");
    await assertBalance(productId, "90.000", "50.83");
    const movementCount = await countMovements(productId);
    assert.equal(movementCount, "4");
  });

  it("lets only one of two concurrent outbound requests succeed", async () => {
    const productId = await createProduct("Concurrent soap");
    const opened = await authed(ownerToken, ownerShop)
      .post("/api/v1/inventory/opening")
      .send({ productId, quantity: "10.000", unitCost: "20.00" });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    const before = await countMovements(productId);

    const [first, second] = await Promise.all([
      authed(ownerToken, ownerShop)
        .post("/api/v1/inventory/adjustments")
        .set("Idempotency-Key", `out-7-${productId}`)
        .send({ productId, type: "OUT", quantity: "7.000", reason: "Count A" }),
      authed(stockToken, stockShop)
        .post("/api/v1/inventory/adjustments")
        .set("Idempotency-Key", `out-6-${productId}`)
        .send({ productId, type: "OUT", quantity: "6.000", reason: "Count B" }),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [201, 409]);
    const failed = first.status === 409 ? first : second;
    assert.equal(failed.body.error.code, "INSUFFICIENT_STOCK");
    await assertBalance(productId, "3.000", "20.00");
    const after = await countMovements(productId);
    assert.equal(Number(after) - Number(before), 1);
  });

  it("replays an idempotent post and rejects a different body", async () => {
    const productId = await createProduct("Idempotent tea");
    const key = `open-${productId}`;
    const first = await authed(ownerToken, ownerShop)
      .post("/api/v1/inventory/opening")
      .set("Idempotency-Key", key)
      .send({ productId, quantity: "4.000", unitCost: "15.00" });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const second = await authed(ownerToken, ownerShop)
      .post("/api/v1/inventory/opening")
      .set("Idempotency-Key", key)
      .send({ productId, quantity: "4.000", unitCost: "15.00" });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.equal(second.body.data.movementId, first.body.data.movementId);
    assert.equal(second.body.data.quantityAfter, "4.000");
    await assertBalance(productId, "4.000", "15.00");
    assert.equal(await countMovements(productId), "1");

    const changed = await authed(ownerToken, ownerShop)
      .post("/api/v1/inventory/opening")
      .set("Idempotency-Key", key)
      .send({ productId, quantity: "9.000", unitCost: "15.00" });
    assert.equal(changed.status, 409);
    assert.equal(changed.body.error.code, "IDEMPOTENCY_CONFLICT");
    await assertBalance(productId, "4.000", "15.00");
  });

  it("hides cost from cashiers and keeps shops apart", async () => {
    const productId = await createProduct("Parle-G 250g", {
      sku: "PG250",
      defaultSellingPrice: "12.00",
      minimumStockLevel: "30.000",
    });
    const opened = await authed(ownerToken, ownerShop)
      .post("/api/v1/inventory/opening")
      .send({ productId, quantity: "25.000", unitCost: "10.00" });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));

    const cashierPost = await authed(cashierToken, cashierShop)
      .post("/api/v1/inventory/adjustments")
      .send({ productId, type: "OUT", quantity: "1.000" });
    assert.equal(cashierPost.status, 403);
    assert.equal(cashierPost.body.error.code, "INVENTORY_ACCESS_DENIED");

    const listed = await authed(cashierToken, cashierShop).get("/api/v1/inventory?search=PG250");
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const row = listed.body.data.find((item: { product: { id: string } }) => item.product.id === productId);
    assert.ok(row);
    assert.equal(row.quantity, "25.000");
    assert.equal(row.sellingPrice, "12.00");
    assert.equal(row.lowStock, true);
    assert.equal(row.outOfStock, false);
    assert.equal("averageCost" in row, false);
    assert.equal("stockValue" in row, false);

    const ownerList = await authed(ownerToken, ownerShop).get(
      `/api/v1/inventory?productId=${productId}&lowStock=true`,
    );
    assert.equal(ownerList.body.data[0].averageCost, "10.00");
    assert.equal(ownerList.body.data[0].stockValue, "250.00");

    const history = await authed(cashierToken, cashierShop).get(
      `/api/v1/inventory/products/${productId}/movements`,
    );
    assert.equal(history.status, 200);
    assert.equal(history.body.data[0].movementType, "OPENING_STOCK");
    assert.equal(history.body.data[0].quantity, "25.000");
    assert.equal("unitCost" in history.body.data[0], false);

    const ownerHistory = await authed(ownerToken, ownerShop).get(
      `/api/v1/inventory/products/${productId}/movements?movementType=OPENING_STOCK`,
    );
    assert.equal(ownerHistory.body.data[0].unitCost, "10.00");
    assert.equal(ownerHistory.body.data[0].reason, "Opening stock");

    const summary = await authed(cashierToken, cashierShop).get("/api/v1/inventory/summary");
    assert.equal(summary.status, 200);
    assert.equal("totalStockValue" in summary.body.data, false);
    const ownerSummary = await authed(ownerToken, ownerShop).get("/api/v1/inventory/summary");
    assert.equal(typeof ownerSummary.body.data.totalStockValue, "string");

    const otherList = await authed(otherToken, otherShop).get("/api/v1/inventory");
    assert.equal(
      otherList.body.data.some((item: { product: { id: string } }) => item.product.id === productId),
      false,
    );
    const otherDetail = await authed(otherToken, otherShop).get(`/api/v1/inventory/products/${productId}`);
    assert.equal(otherDetail.status, 404);
    const otherHistory = await authed(otherToken, otherShop).get(
      `/api/v1/inventory/products/${productId}/movements`,
    );
    assert.equal(otherHistory.status, 404);
    const otherOpening = await authed(otherToken, otherShop)
      .post("/api/v1/inventory/opening")
      .send({ productId, locationId, quantity: "1.000", unitCost: "1.00" });
    assert.equal(otherOpening.status, 404);
    const otherAdjust = await authed(otherToken, otherShop)
      .post("/api/v1/inventory/adjustments")
      .send({ productId, locationId, type: "OUT", quantity: "1.000" });
    assert.equal(otherAdjust.status, 404);
  });

  it("writes audit with the movement and rolls both back when stock is short", async () => {
    const productId = await createProduct("Audit biscuit");
    const opened = await authed(ownerToken, ownerShop)
      .post("/api/v1/inventory/opening")
      .send({ productId, quantity: "2.000", unitCost: "5.00" });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    const audits = await admin.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE tenant_id = $1::uuid AND entity_id = $2::uuid`,
      [shopId, opened.body.data.adjustmentId],
    );
    assert.equal(audits.rows.some((row) => row.action === "inventory.opening_created"), true);

    const before = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_logs WHERE tenant_id = $1::uuid AND action = 'inventory.adjustment_created'`,
      [shopId],
    );
    const failed = await authed(ownerToken, ownerShop)
      .post("/api/v1/inventory/adjustments")
      .send({ productId, type: "OUT", quantity: "9.000", reason: "Too many" });
    assert.equal(failed.status, 409);
    const after = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_logs WHERE tenant_id = $1::uuid AND action = 'inventory.adjustment_created'`,
      [shopId],
    );
    assert.equal(after.rows[0]?.count, before.rows[0]?.count);
    assert.equal(await countMovements(productId), "1");

    const side = await admin.query<{
      sales: string;
      purchases: string;
      payments: string;
      expenses: string;
      customer_ledger: string;
      supplier_ledger: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM sales WHERE tenant_id = $1::uuid) AS sales,
         (SELECT count(*)::text FROM purchases WHERE tenant_id = $1::uuid) AS purchases,
         (SELECT count(*)::text FROM payments WHERE tenant_id = $1::uuid) AS payments,
         (SELECT count(*)::text FROM expenses WHERE tenant_id = $1::uuid) AS expenses,
         (SELECT count(*)::text FROM customer_ledger WHERE tenant_id = $1::uuid) AS customer_ledger,
         (SELECT count(*)::text FROM supplier_ledger WHERE tenant_id = $1::uuid) AS supplier_ledger`,
      [shopId],
    );
    assert.equal(side.rows[0]?.sales, "0");
    assert.equal(side.rows[0]?.purchases, "0");
    assert.equal(side.rows[0]?.payments, "0");
    assert.equal(side.rows[0]?.expenses, "0");
    assert.equal(side.rows[0]?.customer_ledger, "0");
    assert.equal(side.rows[0]?.supplier_ledger, "0");

    await assert.rejects(() =>
      transactions.run({ tenantId: shopId, userId: ownerId }, (tx) =>
        tx.inventoryMovement.update({
          where: { id: opened.body.data.movementId as string },
          data: { quantityDelta: new Prisma.Decimal(1) },
        }),
      ),
    );
    await assert.rejects(() =>
      transactions.run({ tenantId: shopId, userId: ownerId }, (tx) =>
        tx.inventoryMovement.delete({ where: { id: opened.body.data.movementId as string } }),
      ),
    );
    assert.equal(await countMovements(productId), "1");

    const spec = await request(app.getHttpServer()).get("/api/docs-json");
    const paths = Object.keys(spec.body.paths as Record<string, unknown>);
    for (const path of [
      "/api/v1/inventory/opening",
      "/api/v1/inventory/adjustments",
      "/api/v1/inventory",
      "/api/v1/inventory/summary",
      "/api/v1/inventory/products/{productId}",
      "/api/v1/inventory/products/{productId}/movements",
    ]) {
      assert.equal(paths.includes(path), true, path);
    }
  });

  function authed(token: string, shopContext: string) {
    const http = request(app.getHttpServer());
    const headers = (method: "get" | "post" | "patch" | "delete") => (path: string) =>
      http[method](path).set("Authorization", `Bearer ${token}`).set("x-dukaan-shop", shopContext);
    return { get: headers("get"), post: headers("post"), patch: headers("patch"), delete: headers("delete") };
  }

  async function login(national: string): Promise<{ token: string; userId: string }> {
    const requested = await request(app.getHttpServer())
      .post("/api/v1/auth/request-otp")
      .send({ phone: national });
    assert.equal(requested.status, 200, JSON.stringify(requested.body));
    const code = sender.latest(normalizeIndianPhone(national));
    assert.ok(code);
    const verified = await request(app.getHttpServer())
      .post("/api/v1/auth/verify-otp")
      .send({ phone: national, code });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    return {
      token: verified.body.data.token as string,
      userId: verified.body.data.user.id as string,
    };
  }

  async function createShop(token: string, name: string): Promise<{ id: string; shopContext: string }> {
    const response = await request(app.getHttpServer())
      .post("/api/v1/tenants")
      .set("Authorization", `Bearer ${token}`)
      .send({ name, businessType: "GROCERY" });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return {
      id: response.body.data.id as string,
      shopContext: response.body.data.shopContext as string,
    };
  }

  async function selectShop(token: string, tenantId: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/tenants/${tenantId}/select`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.data.shopContext as string;
  }

  async function createProduct(
    name: string,
    extra: { sku?: string; defaultSellingPrice?: string; minimumStockLevel?: string } = {},
  ): Promise<string> {
    const response = await authed(ownerToken, ownerShop)
      .post("/api/v1/catalog/products")
      .send({ name, unitId, ...extra });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.data.id as string;
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

  async function countMovements(productId: string): Promise<string> {
    const rows = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_movements WHERE product_id = $1::uuid`,
      [productId],
    );
    return rows.rows[0]?.count ?? "0";
  }

  async function assertBalance(productId: string, quantity: string, averageCost: string): Promise<void> {
    const rows = await admin.query<{ quantity: string; average_cost: string; moved: string }>(
      `SELECT b.quantity::text, b.average_cost::text,
              (SELECT COALESCE(SUM(quantity_delta), 0)::text
               FROM inventory_movements m
               WHERE m.tenant_id = b.tenant_id
                 AND m.product_id = b.product_id
                 AND m.location_id = b.location_id) AS moved
       FROM inventory_balances b
       WHERE b.product_id = $1::uuid`,
      [productId],
    );
    assert.equal(rows.rows[0]?.quantity, quantity);
    assert.equal(rows.rows[0]?.average_cost, averageCost);
    assert.equal(rows.rows[0]?.moved, quantity);
  }
});

function nextNational(): string {
  serial += 1;
  const national = String(serial);
  phones.push(normalizeIndianPhone(national));
  return national;
}

async function cleanup(admin: Client, numbers: string[]): Promise<void> {
  const tenants = `(SELECT id FROM tenants WHERE name LIKE '[INV]%')`;
  await admin.query("ALTER TABLE inventory_movements DISABLE TRIGGER inventory_movements_append_only");
  await admin.query("ALTER TABLE stock_adjustment_items DISABLE TRIGGER stock_adjustment_items_draft_only");
  await admin.query("ALTER TABLE stock_adjustments DISABLE TRIGGER stock_adjustments_no_delete");
  try {
    await admin.query(`DELETE FROM inventory_movements WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM inventory_balances WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM stock_adjustment_items WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM stock_adjustments WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM idempotency_keys WHERE tenant_id IN ${tenants}`);
  } finally {
    await admin.query("ALTER TABLE inventory_movements ENABLE TRIGGER inventory_movements_append_only");
    await admin.query("ALTER TABLE stock_adjustment_items ENABLE TRIGGER stock_adjustment_items_draft_only");
    await admin.query("ALTER TABLE stock_adjustments ENABLE TRIGGER stock_adjustments_no_delete");
  }
  await admin.query("ALTER TABLE product_price_history DISABLE TRIGGER product_price_history_append_only");
  try {
    await admin.query(`DELETE FROM product_price_history WHERE tenant_id IN ${tenants}`);
  } finally {
    await admin.query("ALTER TABLE product_price_history ENABLE TRIGGER product_price_history_append_only");
  }
  await admin.query(`DELETE FROM product_barcodes WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM products WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM units WHERE tenant_id IN ${tenants}`);
  await admin.query("ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only");
  try {
    await admin.query(
      `DELETE FROM audit_logs
       WHERE tenant_id IN ${tenants}
          OR actor_user_id IN (SELECT id FROM users WHERE phone = ANY($1::text[]))`,
      [numbers],
    );
  } finally {
    await admin.query("ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only");
  }
  await admin.query(
    `DELETE FROM memberships
     WHERE tenant_id IN ${tenants}
        OR user_id IN (SELECT id FROM users WHERE phone = ANY($1::text[]))`,
    [numbers],
  );
  await admin.query(`UPDATE tenants SET default_location_id = NULL WHERE name LIKE '[INV]%'`);
  await admin.query(`DELETE FROM locations WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM document_counters WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM expense_categories WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM tenants WHERE name LIKE '[INV]%'`);
  await admin.query(
    `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE phone = ANY($1::text[]))`,
    [numbers],
  );
  await admin.query(`DELETE FROM otp_challenges WHERE phone = ANY($1::text[])`, [numbers]);
  await admin.query(`DELETE FROM users WHERE phone = ANY($1::text[])`, [numbers]);
}
