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
  throw new Error("DATABASE_ADMIN_URL is required for purchase tests.");
}

let serial = 7500001000;
const phones: string[] = [];

describe("purchases", () => {
  let app: INestApplication;
  let admin: Client;
  let sender: CapturingOtpSender;
  let ownerToken = "";
  let ownerShop = "";
  let shopId = "";
  let locationId = "";
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
    const created = await createShop(ownerToken, "[PUR] Shop A");
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
    const otherCreated = await createShop(other.token, "[PUR] Shop B");
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
    if (admin) {
      await cleanup(admin, phones);
      await admin.end();
    }
    if (app) {
      await app.close();
    }
  });

  it("creates, lists, and deactivates suppliers inside the shop", async () => {
    const denied = await authed(cashierToken, cashierShop)
      .post("/api/v1/suppliers")
      .send({ name: "Cashier supplier" });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, "SUPPLIER_ACCESS_DENIED");

    const created = await authed(stockToken, stockShop)
      .post("/api/v1/suppliers")
      .send({ name: "  ABC Distributors  ", phone: "9876543210" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.name, "ABC Distributors");
    assert.equal(created.body.data.isActive, true);
    assert.equal(created.body.data.payableBalance, "0.00");

    const cashierView = await authed(cashierToken, cashierShop).get(
      `/api/v1/suppliers/${created.body.data.id}`,
    );
    assert.equal(cashierView.status, 200);
    assert.equal("payableBalance" in cashierView.body.data, false);

    const listed = await authed(ownerToken, ownerShop).get("/api/v1/suppliers?search=abc");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.data[0].id, created.body.data.id);

    const otherList = await authed(otherToken, otherShop).get("/api/v1/suppliers");
    assert.equal(
      otherList.body.data.some((row: { id: string }) => row.id === created.body.data.id),
      false,
    );
    const otherGet = await authed(otherToken, otherShop).get(`/api/v1/suppliers/${created.body.data.id}`);
    assert.equal(otherGet.status, 404);
    const otherPatch = await authed(otherToken, otherShop)
      .patch(`/api/v1/suppliers/${created.body.data.id}`)
      .send({ name: "Stolen" });
    assert.equal(otherPatch.status, 404);

    const renamed = await authed(ownerToken, ownerShop)
      .patch(`/api/v1/suppliers/${created.body.data.id}`)
      .send({ notes: "Weekly" });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.data.notes, "Weekly");

    const off = await authed(ownerToken, ownerShop)
      .patch(`/api/v1/suppliers/${created.body.data.id}`)
      .send({ isActive: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.data.isActive, false);
    const activeOnly = await authed(ownerToken, ownerShop).get("/api/v1/suppliers");
    assert.equal(
      activeOnly.body.data.some((row: { id: string }) => row.id === created.body.data.id),
      false,
    );
    const including = await authed(ownerToken, ownerShop).get("/api/v1/suppliers?isActive=all");
    assert.equal(
      including.body.data.some((row: { id: string }) => row.id === created.body.data.id),
      true,
    );
  });

  it("posts a purchase through the inventory ledger and keeps historical cost", async () => {
    const supplierId = await createSupplier("Fresh Mart");
    const productId = await createProduct("Parle-G", { defaultPurchasePrice: "1.00", defaultSellingPrice: "12.00" });
    const before = await countForProduct(productId);
    const purchased = await authed(stockToken, stockShop)
      .post("/api/v1/purchases")
      .send({
        supplierId,
        purchaseDate: "2026-09-24",
        invoiceNumber: "INV-1042",
        items: [{ productId, quantity: "20", unitCost: "8.00" }],
      });
    assert.equal(purchased.status, 201, JSON.stringify(purchased.body));
    assert.match(purchased.body.data.purchaseNumber, /^P-\d{5}$/);
    assert.equal(purchased.body.data.businessDate, "2026-09-24");
    assert.equal(purchased.body.data.total, "160.00");
    assert.equal(purchased.body.data.status, "CONFIRMED");
    assert.equal(purchased.body.data.items[0].quantity, "20.000");
    assert.equal(purchased.body.data.items[0].unitCost, "8.00");
    assert.equal(purchased.body.data.items[0].lineTotal, "160.00");
    assert.equal(purchased.body.data.location.id, locationId);

    await assertStock(productId, "20.000", "8.00");
    const after = await countForProduct(productId);
    assert.equal(Number(after.movements) - Number(before.movements), 1);
    assert.equal(after.movementType, "PURCHASE");
    assert.equal(after.referenceType, "PURCHASE");
    assert.equal(after.referenceId, purchased.body.data.id);
    assert.equal(after.sourceLineId, purchased.body.data.items[0].id);

    const priced = await authed(ownerToken, ownerShop)
      .patch(`/api/v1/catalog/products/${productId}`)
      .send({ defaultPurchasePrice: "99.00" });
    assert.equal(priced.status, 200);
    const detail = await authed(ownerToken, ownerShop).get(`/api/v1/purchases/${purchased.body.data.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.items[0].unitCost, "8.00");

    const history = await authed(ownerToken, ownerShop).get(
      `/api/v1/catalog/products/${productId}/purchases`,
    );
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.equal(history.body.data[0].unitCost, "8.00");
    assert.equal(history.body.data[0].purchaseNumber, purchased.body.data.purchaseNumber);

    const supplierPurchases = await authed(ownerToken, ownerShop).get(
      `/api/v1/suppliers/${supplierId}/purchases?search=INV-1042`,
    );
    assert.equal(supplierPurchases.body.data[0].purchaseNumber, purchased.body.data.purchaseNumber);
    assert.equal(supplierPurchases.body.data[0].total, "160.00");
    const summary = await authed(ownerToken, ownerShop).get(`/api/v1/suppliers/${supplierId}/summary`);
    assert.equal(summary.body.data.purchaseCount, 1);
    assert.equal(summary.body.data.totalPurchaseValue, "160.00");

    const payable = await admin.query<{ payable: string; credit: string; payments: string }>(
      `SELECT s.payable_balance::text AS payable,
              (SELECT COALESCE(SUM(credit_amount), 0)::text FROM supplier_ledger
               WHERE supplier_id = s.id AND entry_type = 'PURCHASE') AS credit,
              (SELECT count(*)::text FROM payments WHERE tenant_id = $1::uuid) AS payments
       FROM suppliers s WHERE s.id = $2::uuid`,
      [shopId, supplierId],
    );
    assert.equal(payable.rows[0]?.payable, "160.00");
    assert.equal(payable.rows[0]?.credit, "160.00");
    assert.equal(payable.rows[0]?.payments, "0");
  });

  it("calculates weighted average from successive purchases", async () => {
    const supplierId = await createSupplier("Cost House");
    const productId = await createProduct("Sugar bag");
    const first = await buy(supplierId, productId, "100", "50.00");
    assert.equal(first.status, 201, JSON.stringify(first.body));
    await assertStock(productId, "100.000", "50.00");
    const second = await buy(supplierId, productId, "20", "55.00");
    assert.equal(second.status, 201, JSON.stringify(second.body));
    await assertStock(productId, "120.000", "50.83");
    const third = await buy(supplierId, productId, "20", "65.00");
    assert.equal(third.status, 201, JSON.stringify(third.body));
    await assertStock(productId, "140.000", "52.85");
  });

  it("posts every line or none, and rejects bad purchases", async () => {
    const supplierId = await createSupplier("Line Mart");
    const good = await createProduct("Good soap");
    const bad = await createProduct("Bad soap");
    await authed(ownerToken, ownerShop).post(`/api/v1/catalog/products/${bad}/deactivate`).send({});
    const purchasesBefore = await countPurchases();
    const movementsBefore = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_movements WHERE tenant_id = $1::uuid`,
      [shopId],
    );
    const auditsBefore = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_logs
       WHERE tenant_id = $1::uuid AND action IN ('purchase.created', 'purchase.posted', 'inventory.adjustment_created')`,
      [shopId],
    );
    const mixed = await authed(ownerToken, ownerShop)
      .post("/api/v1/purchases")
      .send({
        supplierId,
        items: [
          { productId: good, quantity: "2", unitCost: "4.00" },
          { productId: bad, quantity: "2", unitCost: "4.00" },
        ],
      });
    assert.equal(mixed.status, 409);
    assert.equal(mixed.body.error.code, "PRODUCT_INACTIVE");
    assert.equal(await countPurchases(), purchasesBefore);
    const auditsAfter = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_logs
       WHERE tenant_id = $1::uuid AND action IN ('purchase.created', 'purchase.posted', 'inventory.adjustment_created')`,
      [shopId],
    );
    assert.equal(auditsAfter.rows[0]?.count, auditsBefore.rows[0]?.count);
    const movementsAfter = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_movements WHERE tenant_id = $1::uuid`,
      [shopId],
    );
    assert.equal(movementsAfter.rows[0]?.count, movementsBefore.rows[0]?.count);
    await assertNoBalance(good);

    const inactiveSupplier = await createSupplier("Sleeping supplier");
    await authed(ownerToken, ownerShop)
      .patch(`/api/v1/suppliers/${inactiveSupplier}`)
      .send({ isActive: false });
    const asleep = await authed(ownerToken, ownerShop)
      .post("/api/v1/purchases")
      .send({
        supplierId: inactiveSupplier,
        items: [{ productId: good, quantity: "1", unitCost: "3.00" }],
      });
    assert.equal(asleep.status, 409);
    assert.equal(asleep.body.error.code, "SUPPLIER_INACTIVE");

    const zero = await authed(ownerToken, ownerShop)
      .post("/api/v1/purchases")
      .send({ supplierId, items: [{ productId: good, quantity: "0", unitCost: "3.00" }] });
    assert.equal(zero.status, 400);
    const negative = await authed(ownerToken, ownerShop)
      .post("/api/v1/purchases")
      .send({ supplierId, items: [{ productId: good, quantity: "1", unitCost: "-1" }] });
    assert.equal(negative.status, 400);
    const duplicate = await authed(ownerToken, ownerShop)
      .post("/api/v1/purchases")
      .send({
        supplierId,
        items: [
          { productId: good, quantity: "1", unitCost: "3.00" },
          { productId: good, quantity: "2", unitCost: "3.00" },
        ],
      });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, "DUPLICATE_PURCHASE_LINE");

    const foreignProduct = await authed(otherToken, otherShop)
      .post("/api/v1/catalog/units")
      .send({ name: "Other piece", shortCode: "op", decimalPlaces: 0 });
    const otherProduct = await authed(otherToken, otherShop)
      .post("/api/v1/catalog/products")
      .send({ name: "Other biscuit", unitId: foreignProduct.body.data.id });
    const foreign = await authed(ownerToken, ownerShop)
      .post("/api/v1/purchases")
      .send({
        supplierId,
        items: [{ productId: otherProduct.body.data.id, quantity: "1", unitCost: "1.00" }],
      });
    assert.equal(foreign.status, 404);
    assert.equal(foreign.body.error.code, "PRODUCT_NOT_FOUND");
    const foreignLocation = await authed(ownerToken, ownerShop)
      .post("/api/v1/purchases")
      .send({
        supplierId,
        locationId: otherLocationId,
        items: [{ productId: good, quantity: "1", unitCost: "1.00" }],
      });
    assert.equal(foreignLocation.status, 404);
    const otherSupplier = await authed(otherToken, otherShop)
      .post("/api/v1/suppliers")
      .send({ name: "Other supplier" });
    const stolenSupplier = await authed(ownerToken, ownerShop)
      .post("/api/v1/purchases")
      .send({
        supplierId: otherSupplier.body.data.id,
        items: [{ productId: good, quantity: "1", unitCost: "1.00" }],
      });
    assert.equal(stolenSupplier.status, 404);
    assert.equal(stolenSupplier.body.error.code, "SUPPLIER_NOT_FOUND");
    await assertNoBalance(good);
  });

  it("keeps multi-item purchases, retries, and concurrent bills consistent", async () => {
    const supplierId = await createSupplier("Bulk House");
    const oil = await createProduct("Oil");
    const tea = await createProduct("Tea");
    const rice = await createProduct("Rice");
    const bill = await authed(ownerToken, ownerShop)
      .post("/api/v1/purchases")
      .send({
        supplierId,
        items: [
          { productId: oil, quantity: "5", unitCost: "100.00" },
          { productId: tea, quantity: "10", unitCost: "15.00" },
          { productId: rice, quantity: "2", unitCost: "40.00" },
        ],
      });
    assert.equal(bill.status, 201, JSON.stringify(bill.body));
    assert.equal(bill.body.data.total, "730.00");
    assert.equal(bill.body.data.items.length, 3);
    assert.equal(await movementCount(oil), "1");
    assert.equal(await movementCount(tea), "1");
    assert.equal(await movementCount(rice), "1");

    const replayProduct = await createProduct("Replay salt");
    const key = `buy-${replayProduct}`;
    const first = await authed(ownerToken, ownerShop)
      .post("/api/v1/purchases")
      .set("Idempotency-Key", key)
      .send({ supplierId, items: [{ productId: replayProduct, quantity: "4", unitCost: "10.00" }] });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const second = await authed(ownerToken, ownerShop)
      .post("/api/v1/purchases")
      .set("Idempotency-Key", key)
      .send({ supplierId, items: [{ productId: replayProduct, quantity: "4", unitCost: "10.00" }] });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.equal(second.body.data.id, first.body.data.id);
    assert.equal(second.body.data.purchaseNumber, first.body.data.purchaseNumber);
    assert.equal(await movementCount(replayProduct), "1");
    await assertStock(replayProduct, "4.000", "10.00");
    const changed = await authed(ownerToken, ownerShop)
      .post("/api/v1/purchases")
      .set("Idempotency-Key", key)
      .send({ supplierId, items: [{ productId: replayProduct, quantity: "9", unitCost: "10.00" }] });
    assert.equal(changed.status, 409);
    assert.equal(changed.body.error.code, "IDEMPOTENCY_CONFLICT");

    const left = await createProduct("Left concurrent");
    const right = await createProduct("Right concurrent");
    const [a, b] = await Promise.all([
      authed(ownerToken, ownerShop)
        .post("/api/v1/purchases")
        .send({ supplierId, items: [{ productId: left, quantity: "10", unitCost: "40.00" }] }),
      authed(stockToken, stockShop)
        .post("/api/v1/purchases")
        .send({ supplierId, items: [{ productId: right, quantity: "5", unitCost: "40.00" }] }),
    ]);
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(b.status, 201, JSON.stringify(b.body));
    assert.notEqual(a.body.data.purchaseNumber, b.body.data.purchaseNumber);
    assert.match(a.body.data.purchaseNumber, /^P-\d{5}$/);
    assert.match(b.body.data.purchaseNumber, /^P-\d{5}$/);

    const shared = await createProduct("Shared sack");
    const [firstShare, secondShare] = await Promise.all([
      authed(ownerToken, ownerShop)
        .post("/api/v1/purchases")
        .send({ supplierId, items: [{ productId: shared, quantity: "10", unitCost: "100.00" }] }),
      authed(stockToken, stockShop)
        .post("/api/v1/purchases")
        .send({ supplierId, items: [{ productId: shared, quantity: "5", unitCost: "40.00" }] }),
    ]);
    assert.equal(firstShare.status, 201, JSON.stringify(firstShare.body));
    assert.equal(secondShare.status, 201, JSON.stringify(secondShare.body));
    await assertStock(shared, "15.000", "80.00");
    assert.equal(await movementCount(shared), "2");

    const stack = await createProduct("Stack");
    assert.equal((await buy(supplierId, stack, "10", "50.00")).status, 201);
    assert.equal((await buy(supplierId, stack, "20", "60.00")).status, 201);
    assert.equal((await buy(supplierId, stack, "5", "70.00")).status, 201);
    await assertStock(stack, "35.000", "58.57");
    const moved = await admin.query<{ moved: string }>(
      `SELECT COALESCE(SUM(quantity_delta), 0)::text AS moved
       FROM inventory_movements WHERE product_id = $1::uuid`,
      [stack],
    );
    assert.equal(moved.rows[0]?.moved, "35.000");

    const audits = await admin.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE tenant_id = $1::uuid AND entity_id = $2::uuid`,
      [shopId, first.body.data.id],
    );
    const actions = audits.rows.map((row) => row.action);
    assert.equal(actions.includes("purchase.created"), true);
    assert.equal(actions.includes("purchase.posted"), true);

    const side = await admin.query<{ sales: string; expenses: string; customer_ledger: string }>(
      `SELECT
         (SELECT count(*)::text FROM sales WHERE tenant_id = $1::uuid) AS sales,
         (SELECT count(*)::text FROM expenses WHERE tenant_id = $1::uuid) AS expenses,
         (SELECT count(*)::text FROM customer_ledger WHERE tenant_id = $1::uuid) AS customer_ledger`,
      [shopId],
    );
    assert.equal(side.rows[0]?.sales, "0");
    assert.equal(side.rows[0]?.expenses, "0");
    assert.equal(side.rows[0]?.customer_ledger, "0");

    const cashierBuy = await authed(cashierToken, cashierShop)
      .post("/api/v1/purchases")
      .send({ supplierId, items: [{ productId: oil, quantity: "1", unitCost: "1.00" }] });
    assert.equal(cashierBuy.status, 403);
    assert.equal(cashierBuy.body.error.code, "PURCHASE_ACCESS_DENIED");
    const cashierList = await authed(cashierToken, cashierShop).get("/api/v1/purchases");
    assert.equal(cashierList.status, 403);
    const cashierHistory = await authed(cashierToken, cashierShop).get(
      `/api/v1/suppliers/${supplierId}/purchases`,
    );
    assert.equal(cashierHistory.status, 403);

    const freeProduct = await createProduct("Promo sample");
    const free = await buy(supplierId, freeProduct, "10", "0.00");
    assert.equal(free.status, 201, JSON.stringify(free.body));
    assert.equal(free.body.data.total, "0.00");
    await assertStock(freeProduct, "10.000", "0.00");
    const freeLedger = await admin.query<{ credits: string }>(
      `SELECT count(*)::text AS credits FROM supplier_ledger WHERE reference_id = $1::uuid`,
      [free.body.data.id],
    );
    assert.equal(freeLedger.rows[0]?.credits, "0");

    const listed = await authed(ownerToken, ownerShop).get(
      `/api/v1/purchases?supplierId=${supplierId}&locationId=${locationId}&search=${bill.body.data.purchaseNumber}`,
    );
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(
      listed.body.data.some((row: { id: string }) => row.id === bill.body.data.id),
      true,
    );

    const duplicateName = await authed(ownerToken, ownerShop)
      .post("/api/v1/suppliers")
      .send({ name: "Bulk House" });
    assert.equal(duplicateName.status, 201);

    const hidden = await authed(otherToken, otherShop).get(`/api/v1/purchases/${bill.body.data.id}`);
    assert.equal(hidden.status, 404);

    const spec = await request(app.getHttpServer()).get("/api/docs-json");
    const paths = Object.keys(spec.body.paths as Record<string, unknown>);
    for (const path of [
      "/api/v1/suppliers",
      "/api/v1/suppliers/{supplierId}",
      "/api/v1/suppliers/{supplierId}/purchases",
      "/api/v1/purchases",
      "/api/v1/purchases/{purchaseId}",
      "/api/v1/catalog/products/{productId}/purchases",
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

  async function createSupplier(name: string): Promise<string> {
    const response = await authed(ownerToken, ownerShop).post("/api/v1/suppliers").send({ name });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.data.id as string;
  }

  async function createProduct(
    name: string,
    extra: { defaultPurchasePrice?: string; defaultSellingPrice?: string } = {},
  ): Promise<string> {
    const response = await authed(ownerToken, ownerShop)
      .post("/api/v1/catalog/products")
      .send({ name, unitId, ...extra });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.data.id as string;
  }

  function buy(supplierId: string, productId: string, quantity: string, unitCost: string) {
    return authed(ownerToken, ownerShop)
      .post("/api/v1/purchases")
      .send({ supplierId, items: [{ productId, quantity, unitCost }] });
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
    const rows = await admin.query<{ quantity: string; average_cost: string; moved: string }>(
      `SELECT b.quantity::text, b.average_cost::text,
              (SELECT COALESCE(SUM(m.quantity_delta), 0)::text
               FROM inventory_movements m
               WHERE m.product_id = b.product_id AND m.location_id = b.location_id) AS moved
       FROM inventory_balances b WHERE b.product_id = $1::uuid`,
      [productId],
    );
    assert.equal(rows.rows[0]?.quantity, quantity);
    assert.equal(rows.rows[0]?.average_cost, averageCost);
    assert.equal(rows.rows[0]?.moved, quantity);
  }

  async function assertNoBalance(productId: string): Promise<void> {
    const rows = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_balances WHERE product_id = $1::uuid`,
      [productId],
    );
    assert.equal(rows.rows[0]?.count, "0");
  }

  async function countForProduct(productId: string): Promise<{
    movements: string;
    movementType: string | null;
    referenceType: string | null;
    referenceId: string | null;
    sourceLineId: string | null;
  }> {
    const rows = await admin.query<{
      movements: string;
      movement_type: string | null;
      reference_type: string | null;
      reference_id: string | null;
      source_line_id: string | null;
    }>(
      `SELECT count(*)::text AS movements,
              max(movement_type)::text AS movement_type,
              max(reference_type)::text AS reference_type,
              max(reference_id::text) AS reference_id,
              max(source_line_id::text) AS source_line_id
       FROM inventory_movements WHERE product_id = $1::uuid`,
      [productId],
    );
    return {
      movements: rows.rows[0]?.movements ?? "0",
      movementType: rows.rows[0]?.movement_type ?? null,
      referenceType: rows.rows[0]?.reference_type ?? null,
      referenceId: rows.rows[0]?.reference_id ?? null,
      sourceLineId: rows.rows[0]?.source_line_id ?? null,
    };
  }

  async function movementCount(productId: string): Promise<string> {
    const rows = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_movements WHERE product_id = $1::uuid`,
      [productId],
    );
    return rows.rows[0]?.count ?? "0";
  }

  async function countPurchases(): Promise<string> {
    const rows = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM purchases WHERE tenant_id = $1::uuid`,
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
  const tenants = `(SELECT id FROM tenants WHERE name LIKE '[PUR]%')`;
  await admin.query("ALTER TABLE inventory_movements DISABLE TRIGGER inventory_movements_append_only");
  await admin.query("ALTER TABLE supplier_ledger DISABLE TRIGGER supplier_ledger_append_only");
  await admin.query("ALTER TABLE purchase_items DISABLE TRIGGER purchase_items_draft_only");
  await admin.query("ALTER TABLE purchases DISABLE TRIGGER purchases_no_delete");
  await admin.query("ALTER TABLE product_price_history DISABLE TRIGGER product_price_history_append_only");
  await admin.query("ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only");
  try {
    await admin.query(`DELETE FROM inventory_movements WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM inventory_balances WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM supplier_ledger WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM purchase_items WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM purchases WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM idempotency_keys WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM product_price_history WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM product_barcodes WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM products WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM units WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM suppliers WHERE tenant_id IN ${tenants}`);
    await admin.query(
      `DELETE FROM audit_logs
       WHERE tenant_id IN ${tenants}
          OR actor_user_id IN (SELECT id FROM users WHERE phone = ANY($1::text[]))`,
      [numbers],
    );
  } finally {
    await admin.query("ALTER TABLE inventory_movements ENABLE TRIGGER inventory_movements_append_only");
    await admin.query("ALTER TABLE supplier_ledger ENABLE TRIGGER supplier_ledger_append_only");
    await admin.query("ALTER TABLE purchase_items ENABLE TRIGGER purchase_items_draft_only");
    await admin.query("ALTER TABLE purchases ENABLE TRIGGER purchases_no_delete");
    await admin.query("ALTER TABLE product_price_history ENABLE TRIGGER product_price_history_append_only");
    await admin.query("ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only");
  }
  await admin.query(
    `DELETE FROM memberships
     WHERE tenant_id IN ${tenants}
        OR user_id IN (SELECT id FROM users WHERE phone = ANY($1::text[]))`,
    [numbers],
  );
  await admin.query(`UPDATE tenants SET default_location_id = NULL WHERE name LIKE '[PUR]%'`);
  await admin.query(`DELETE FROM locations WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM document_counters WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM expense_categories WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM tenants WHERE name LIKE '[PUR]%'`);
  await admin.query(
    `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE phone = ANY($1::text[]))`,
    [numbers],
  );
  await admin.query(`DELETE FROM otp_challenges WHERE phone = ANY($1::text[])`, [numbers]);
  await admin.query(`DELETE FROM users WHERE phone = ANY($1::text[])`, [numbers]);
}
